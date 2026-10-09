import test from 'node:test';
import assert from 'node:assert/strict';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {TileSource,TILEJSON_URL} from '../src/tile-source.js';
import {decodeVisualTile,drawVisualTile,VISUAL_TILE_SIZE} from '../src/visual-tile-drawing.js';
import {prepareVisualTile} from '../src/visual-tile.worker.js';
import {VisualTileLayer} from '../src/visual-tile-source.js';

const metadata={tiles:['https://tiles.openfreemap.org/planet/fixture/{z}/{x}/{y}.pbf'],minzoom:0,maxzoom:14,vector_layers:[{id:'building'}]};
const rectangle=(left,top,right,bottom)=>[[left,top],[right,top],[right,bottom],[left,bottom],[left,top]];
const buffer=(layers={},extent=4096)=>{const bytes=fromGeojsonVt(layers,{extent});return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);};
const fixture=()=>buffer({water:{features:[{type:3,tags:{},geometry:[rectangle(-64,0,4096,4096),rectangle(1024,1024,2048,2048).reverse()]}]},transportation:{features:[{type:2,tags:{class:'primary'},geometry:[[[0,100],[4096,100]]]}]},building:{features:[{type:3,tags:{},geometry:[rectangle(0,0,4000,4000)]}]}});
const mockFetch=handler=>async(url,options)=>url===TILEJSON_URL?new Response(JSON.stringify(metadata)):handler(url,options);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function context(){const calls=[];return new Proxy({calls},{get(target,key){if(key in target)return target[key];return (...args)=>{calls.push([key,...args]);};},set(target,key,value){target[key]=value;return true;}});}
const canvas=()=>({width:512,height:512,context:context(),getContext(){return this.context;}});
class WorkerFixture {
  constructor(){this.terminated=false;}
  terminate(){this.terminated=true;}
  postMessage(message,transfer) {
    const value=structuredClone(message,{transfer});
    queueMicrotask(()=>{
      if(this.terminated)return;
      try { this.onmessage({data:{type:'visual',requestId:value.requestId,key:value.key,...prepareVisualTile(value.buffer,null)}}); }
      catch(error) { this.onmessage({data:{type:'error',requestId:value.requestId,message:error.message}}); }
    });
  }

}
function layerFixture(sourceOverrides={}){
  const source={calls:[],async loadVisualTile(z,x,y){this.calls.push([z,x,y]);return{buffer:fixture()};},retryFailures(){},dispose(){throw Error('Visual layer must not dispose shared source');},...sourceOverrides};
  const changes=[],errors=[],layer=new VisualTileLayer({source,workerFactory:()=>new WorkerFixture(),canvasFactory:canvas,onChange:key=>changes.push(key),onError:error=>errors.push(error)});
  return{source,changes,errors,layer};
}

test('visual zoom range expands only visual reads, native gameplay remains strict14',async()=>{
 const source=new TileSource({fetchImpl:mockFetch(async()=>new Response(buffer()))});
 for(const z of [0,5,13,14])assert.equal((await source.loadVisualTile(z,0,0)).z,z);
 await assert.rejects(source.loadNativeTile(13,0,0));await assert.rejects(source.loadVisualTile(15,0,0));
 assert.equal(source.stats.visualRequests,4);assert.equal(source.stats.nativeRequests,0);source.dispose();
});

test('cancelling visual subscriber cannot abort native subscriber of the same z14 response',async()=>{
 let release,started,underlyingSignal;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);let calls=0;
 const source=new TileSource({fetchImpl:mockFetch(async(url,{signal})=>{calls++;underlyingSignal=signal;started();await gate;return new Response(buffer());})});
 await source.getMetadata();const controller=new AbortController();
 const visual=source.loadVisualTile(14,1,2,controller.signal),native=source.loadNativeTile(14,1,2);await began;await tick();
 controller.abort();await assert.rejects(visual,error=>error.name==='AbortError');assert.equal(underlyingSignal.aborted,false);
 release();assert.ok((await native).buffer instanceof ArrayBuffer);assert.equal(calls,1);source.dispose();
});

test('last subscriber cancellation aborts shared underlying request and later retry can start afresh',async()=>{
 let started,underlyingSignal;const began=new Promise(resolve=>started=resolve);
 const source=new TileSource({fetchImpl:mockFetch(async(url,{signal})=>{underlyingSignal=signal;started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));})});
 await source.getMetadata();const controller=new AbortController(),pending=source.loadVisualTile(14,1,2,controller.signal);await began;
 controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');await tick();assert.equal(underlyingSignal.aborted,true);assert.equal(source.errors.size,0);source.dispose();
});

test('queued native request takes priority over an earlier queued visual request',async()=>{
 const releases=new Map(),order=[];
 const source=new TileSource({fetchImpl:mockFetch(async url=>{const x=Number(url.split('/').at(-2));order.push(x);return new Promise(resolve=>releases.set(x,()=>resolve(new Response(buffer()))));})});
 await source.getMetadata();const a=source.loadVisualTile(14,1,2),b=source.loadVisualTile(14,2,2);await tick();
 const visual=source.loadVisualTile(14,3,2),native=source.loadNativeTile(14,4,2);await tick();releases.get(1)();await a;await tick();
 assert.deepEqual(order.slice(0,3),[1,2,4]);releases.get(2)();releases.get(4)();await tick();releases.get(3)();await Promise.all([b,visual,native]);assert.ok(source.stats.maxConcurrent<=2);source.dispose();
});

test('visual decoder preserves real background holes and dynamic extent, omits all buildings',()=>{
 const decoded=decodeVisualTile(fixture());assert.equal(decoded.commands.length,2);assert.equal(decoded.commands[0].paint,'water');assert.equal(decoded.commands[0].paths.length,2);assert.equal(decoded.commands[1].paint,'road');
 const a=buffer({park:{features:[{type:3,tags:{},geometry:[rectangle(0,0,4096,4096)]}]}},4096),b=buffer({park:{features:[{type:3,tags:{},geometry:[rectangle(0,0,8192,8192)]}]}},8192);
 assert.deepEqual(decodeVisualTile(a).commands,decodeVisualTile(b).commands);
 assert.equal(decodeVisualTile(buffer({building:{features:[{type:3,tags:{},geometry:[rectangle(0,0,4096,4096)]}]}})).commands.length,0);
});

test('canvas rasterization clips to native tile core and retains courtyard fill rule',()=>{
 const ctx=context();drawVisualTile(ctx,decodeVisualTile(fixture()).commands);
 assert.ok(ctx.calls.some(call=>call[0]==='rect'&&call.slice(1).join(',')==='0,0,512,512'));
 assert.ok(ctx.calls.findIndex(call=>call[0]==='clip')<ctx.calls.findIndex(call=>call[0]==='lineTo'));
 assert.ok(ctx.calls.some(call=>call[0]==='fill'&&call[1]==='evenodd'));
 assert.equal(ctx.calls.filter(call=>call[0]==='stroke').length,2);
});

test('offscreen raster result and unavailable-offscreen fallback are both bounded',()=>{
 const result=prepareVisualTile(fixture(),()=>({getContext:()=>context(),transferToImageBitmap:()=>({kind:'bitmap'})}));assert.equal(result.bitmap.kind,'bitmap');assert.equal(result.stats.offscreen,true);assert.equal(result.commands,undefined);
 const fallback=prepareVisualTile(fixture(),()=>{throw Error('Offscreen unavailable');});assert.equal(fallback.stats.offscreen,false);assert.equal(fallback.commands.length,2);
 assert.throws(()=>prepareVisualTile(new TextEncoder().encode('<html>bad</html>').buffer,null));
});

test('visual layer rasterizes once, returns drawable canvas, and does not dispose shared source',async()=>{
 const {layer,source,changes}=layerFixture();await layer.ensure([{z:12,x:2,y:3}]);
 const drawable=layer.get(12,2,3);assert.equal(drawable.width,VISUAL_TILE_SIZE);assert.ok(drawable.context.calls.length>0);
 await layer.ensure([{z:12,x:2,y:3}]);assert.equal(source.calls.length,1);assert.equal(layer.stats.fallbackTiles,1);assert.deepEqual(changes,['12/2/3']);
 layer.dispose();assert.equal(drawable.width,0);assert.equal(layer.stats.retainedTiles,0);
});

test('visual pan discards stale output without aborting shared tile, then draws newest target',async()=>{
 let release,started;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);let first=true;
 const {layer,changes}=layerFixture({async loadVisualTile(z,x,y){if(first){first=false;started();await gate;}return{buffer:fixture()};}});
 const a=layer.ensure([{z:12,x:2,y:3}]);await began;const b=layer.ensure([{z:12,x:4,y:3}]);release();await Promise.all([a,b]);
 assert.deepEqual(changes,['12/4/3']);assert.equal(layer.get(12,2,3),null);assert.ok(layer.get(12,4,3));assert.equal(layer.stats.discarded,1);layer.dispose();
});

test('visual disposal during a shared fetch never attaches or disposes the shared source',async()=>{
 let release,started;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const {layer,changes}=layerFixture({async loadVisualTile(){started();await gate;return{buffer:fixture()};}});
 const pending=layer.ensure([{z:12,x:2,y:3}]);await began;layer.dispose();release();await assert.rejects(pending,error=>error.name==='AbortError');assert.deepEqual(changes,[]);
});

test('visual cache stays at16 tiles and one visual request; failed tiles do not auto-retry',async()=>{
 const {layer,source}=layerFixture();for(let x=0;x<25;x++)await layer.ensure([{z:12,x,y:3}]);
 assert.equal(layer.stats.retainedTiles,16);assert.equal(layer.stats.retainedPixelBytes,16*512*512*4);assert.equal(layer.stats.maxConcurrent,1);assert.equal(layer.get(12,0,3),null);
 await assert.rejects(layer.ensure(Array.from({length:17},(_,x)=>({z:12,x,y:3}))));layer.dispose();
 const broken=layerFixture({async loadVisualTile(){this.calls.push('request');throw Error('HTTP403');}});
 await assert.rejects(broken.layer.ensure([{z:12,x:2,y:3}]));await assert.rejects(broken.layer.ensure([{z:12,x:2,y:3}]));assert.equal(broken.source.calls.length,1);assert.equal(broken.errors.length,1);broken.layer.dispose();
});
