import test from 'node:test';
import assert from 'node:assert/strict';
import {VisualTileLayer,visualTileSource,VISUAL_CACHE_BYTE_LIMIT} from '../src/visual-tile-source.js';
import {visibleVisualTiles} from '../src/canvas-tile-map.js';
import {cameraMetrics} from '../src/camera.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const canvas=()=>({width:512,height:512,getContext:()=>new Proxy({},{get:()=>()=>{}})});
class FixtureWorker {
  constructor(){this.messages=[];this.dead=false;}
  postMessage(message,transfer){const m=structuredClone(message,{transfer});this.messages.push(m);queueMicrotask(()=>{if(!this.dead)this.onmessage({data:{type:'visual',requestId:m.requestId,key:m.key,commands:[],view:m.view}});});}
  terminate(){this.dead=true;}
}
function fixture({load,workerFactory}={}){const calls=[],workers=[];const source={async loadVisualTile(z,x,y){calls.push([z,x,y]);return load?load(z,x,y):{buffer:new ArrayBuffer(0),sourceKey:'verified-source'};}};const layer=new VisualTileLayer({source,canvasFactory:canvas,workerFactory:workerFactory||(()=>{const w=new FixtureWorker();workers.push(w);return w;})});return{layer,calls,workers};}
test('sharp display children use the same native parent and exact crop coordinates',async()=>{
 const f=fixture();const tiles=[{z:17,x:100*8+2,y:200*8+3},{z:17,x:100*8+3,y:200*8+3}];await f.layer.ensure(tiles);
 assert.deepEqual(f.calls,[[14,100,200],[14,100,200]]);
 const [a,b]=f.workers[0].messages;assert.equal(a.sourceKey,b.sourceKey);assert.equal(a.sourceKey,'verified-source/14/100/200');assert.deepEqual(a.view,{scale:8,x:2,y:3});assert.deepEqual(b.view,{scale:8,x:3,y:3});
 const count=f.workers[0].messages.length;await f.layer.ensure(tiles);assert.equal(f.workers[0].messages.length,count);assert.equal(f.layer.stats.retainedPixelBytes,2*512*512*4);f.layer.dispose();
});
test('display mapping wraps longitude but never sends source requests above z14',()=>{
 for(let z=0;z<=19;z++){const n=2**z;for(const x of [-1,0,n-1,n]){const p=visualTileSource({z,x,y:n-1});assert.ok(p.z<=14);assert.ok(p.x>=0&&p.x<2**p.z);assert.ok(p.y>=0&&p.y<2**p.z);assert.ok(p.view.x>=0&&p.view.x<p.view.scale);assert.ok(p.view.y>=0&&p.view.y<p.view.scale);}}
 assert.throws(()=>visualTileSource({z:20,x:0,y:0}));
});
test('newest view is drained after empty or cached same-tick ensure',async()=>{
 const f=fixture(),a={z:17,x:10,y:10},b={z:17,x:11,y:10};await Promise.all([f.layer.ensure([]),f.layer.ensure([a])]);assert.ok(f.layer.get(a.z,a.x,a.y));
 await Promise.all([f.layer.ensure([a]),f.layer.ensure([b])]);assert.ok(f.layer.get(b.z,b.x,b.y));assert.equal(f.layer.pending,null);f.layer.dispose();
});
test('reserve bitmap slot before rasterizing replacement; fixed cache byte budget',async()=>{
 let layer,atRaster=[];class Worker extends FixtureWorker{postMessage(m,t){atRaster.push(layer.cache.size);super.postMessage(m,t);}}
 const f=fixture({workerFactory:()=>new Worker()});layer=f.layer;
 for(let x=0;x<25;x++)await layer.ensure([{z:17,x,y:10}]);assert.ok(atRaster.every(n=>n<=15));assert.equal(layer.stats.retainedPixelBytes,VISUAL_CACHE_BYTE_LIMIT);assert.equal(layer.stats.retainedTiles,16);assert.equal(layer.stats.maxConcurrent,1);layer.dispose();
});
test('oversized bitmap output is rejected and released, never admitted into cache',async()=>{
 const bitmap={width:1024,height:1024,closed:false,close(){this.closed=true;}};const f=fixture({workerFactory:()=>({postMessage(m){queueMicrotask(()=>this.onmessage({data:{type:'visual',key:m.key,requestId:m.requestId,bitmap}}));},terminate(){}})});
 await assert.rejects(f.layer.ensure([{z:17,x:1,y:1}]),/размер/);assert.equal(bitmap.closed,true);assert.equal(f.layer.cache.size,0);f.layer.dispose();
});
test('stale display detail does not attach after navigation or disposal',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=fixture({load:async()=>{await gate;return{buffer:new ArrayBuffer(0)};}});
 const first=f.layer.ensure([{z:17,x:1,y:1}]);await tick();const next=f.layer.ensure([{z:18,x:7,y:7}]);release();await Promise.all([first,next]);assert.equal(f.layer.get(17,1,1),null);assert.ok(f.layer.get(18,7,7));assert.equal(f.workers[0].messages.length,1);f.layer.dispose();
});
test('close-up road pixels are near display resolution without changing native source detail',()=>{
 for(const [w,h,dpr] of [[390,844,2],[1188,761,1]]){const camera=cameraMetrics(20,w,h,60),tiles=visibleVisualTiles([30,60],camera.zoom,w,h,16,dpr),z=tiles[0].z;assert.ok(z>14);assert.ok(tiles.length<=16);assert.ok(2**(camera.zoom-z)*dpr<=2);assert.ok(visualTileSource(tiles[0]).z===14);}
});
test('LOD remains stable while panning across a tile edge and mask zoom is untouched',()=>{
 for(const [width,height,dpr] of [[390,844,2],[1188,761,1],[1920,1080,2]]){const levels=new Set();for(let i=0;i<100;i++){const tiles=visibleVisualTiles([30+i*.0001,60],16.3,width,height,16,dpr);levels.add(tiles[0].z);assert.ok(tiles.length<=16);}assert.equal(levels.size,1);}
});
test('error-envelope bitmaps and failed fallback surfaces are explicitly released',async()=>{
 const bitmap={width:512,height:512,closed:false,close(){this.closed=true;}};const f=fixture({workerFactory:()=>({postMessage(m){queueMicrotask(()=>this.onmessage({data:{type:'error',requestId:m.requestId,message:'Raster failed',bitmap}}));},terminate(){}})});
 await assert.rejects(f.layer.ensure([{z:17,x:1,y:1}]),/Raster failed/);assert.equal(bitmap.closed,true);f.layer.dispose();
 for(const failContext of [true,false]){const image={width:512,height:512,getContext(){if(failContext)return null;return new Proxy({},{get(){return()=>{throw Error('Draw failed');};}});}};const layer=new VisualTileLayer({source:{loadVisualTile:async()=>({buffer:new ArrayBuffer(0)})},workerFactory:()=>new FixtureWorker(),canvasFactory:()=>image});await assert.rejects(layer.ensure([{z:17,x:1,y:1}]));assert.equal(image.width,0);assert.equal(image.height,0);assert.equal(layer.cache.size,0);layer.dispose();}
});
test('obsolete failed view cannot reject or strand a new view requested by its error callback',async()=>{
 let layer,newer;const calls=[];
 layer=new VisualTileLayer({source:{async loadVisualTile(z,x,y){calls.push(x);if(x===1)throw Error('old failed');return{buffer:new ArrayBuffer(0)};}},workerFactory:()=>new FixtureWorker(),canvasFactory:canvas,onError(){newer=layer.ensure([{z:14,x:2,y:3}]);}});
 await layer.ensure([{z:14,x:1,y:3}]);await newer;assert.deepEqual(calls,[1,2]);assert.ok(layer.get(14,2,3));assert.equal(layer.pending,null);
 await assert.rejects(layer.ensure([{z:14,x:1,y:3}]),/old failed/);assert.deepEqual(calls,[1,2]);layer.dispose();
});
test('new view drains even when it first observes an already-rejected preceding job',async()=>{
 const f=fixture(),error=Error('preceding view failed');f.layer.errors.set('14/1/3',error);const rejected=Promise.reject(error);rejected.catch(()=>{});f.layer.pending=rejected;
 await f.layer.ensure([{z:14,x:2,y:3}]);assert.ok(f.layer.get(14,2,3));assert.deepEqual(f.calls,[[14,2,3]]);f.layer.dispose();
});
