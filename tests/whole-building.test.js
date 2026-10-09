import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {GeoJSONVT} from '@maplibre/geojson-vt';
import {reconstructWholeBuildings,rasterizeWholeBuildings} from '../src/whole-building.js';
import {WholeBuildingProcessor} from '../src/whole-building.worker.js';
import {WholeBuildingStream,wholeNativeTiles} from '../src/whole-building-stream.js';
import {ConsumptionMask,countMaskBits} from '../src/consumption-mask.js';
import {localToLonLat,lonLatToLocal,polygonsArea,polygonFitsCircle} from '../src/geometry.js';

const manifest={id:'whole-fixture',center:[0,0],projectionLatitude:0,arenaSize:5000};
const rectangle=(l,t,r,b)=>[[l,t],[r,t],[r,b],[l,b],[l,t]];
const encode=(features=[])=>{const bytes=fromGeojsonVt({building:{features:features.map((geometry,id)=>({type:3,id:7,tags:{render_height:6},geometry}))}},{extent:4096});return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);};
const tile=(x,y,features=[])=>({x,y,z:14,sourceKey:'fixture',buffer:encode(features)});
class FixtureWorker{
  constructor(){this.processor=new WholeBuildingProcessor();this.terminated=false;}
  terminate(){this.terminated=true;}
  postMessage(input,transfer){const message=structuredClone(input,{transfer});queueMicrotask(()=>{if(this.terminated)return;try{this.onmessage({data:{requestId:message.requestId,...this.processor.process(message)}});}catch(error){this.onmessage({data:{requestId:message.requestId,type:'error',message:error.message}});}});}
}
function sourceFixture(handler=(x,y)=>tile(x,y)){
  let calls=0,active=0,maxActive=0,disposed=false;
  return{get calls(){return calls;},get maxActive(){return maxActive;},get disposed(){return disposed;},
    async getMetadata(){return{sourceKey:'fixture'};},async loadNativeTile(z,x,y,signal){calls++;active++;maxActive=Math.max(active,maxActive);try{return await handler(x,y,signal);}finally{active--;}}
    ,retryFailures(){},dispose(){disposed=true;}};
}
function pbfTilesForGeometry(geometry,m,position,radius){
  const index=new GeoJSONVT({type:'Feature',properties:{render_height:6},geometry},{maxZoom:14,indexMaxZoom:14,indexMaxPoints:0,extent:4096,buffer:64,tolerance:0});
  return wholeNativeTiles(m,position,radius).map(coord=>{const data=index.getTile(coord.z,coord.x,coord.y)||{features:[]};const bytes=fromGeojsonVt({building:data},{extent:4096});return{...coord,sourceKey:'fixture',buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};});
}

test('packed touching houses stay separate; positive overlaps and repeated IDs union only real overlap',()=>{
  const a=rectangle(100,100,150,150),b=rectangle(150,100,200,150),c=rectangle(110,110,140,140);
  const result=reconstructWholeBuildings([tile(8192,8192,[[a,b],[c],[a]])],manifest);
  assert.equal(result.buildings.length,2);assert.equal(result.stats.overlapJoins,3);
  assert.ok(result.buildings.every(building=>building.complete&&building.radius>0));
});

test('buffered seam reconstruction retains courtyard and incomplete neighbors cannot be edible',()=>{
  const rings=[rectangle(-50,100,50,200),rectangle(-20,120,20,180).reverse()];
  const left=rings.map(ring=>ring.map(([x,y])=>[x+4096,y]));
  const a=tile(8191,8192,[left]),b=tile(8192,8192,[rings]);
  const result=reconstructWholeBuildings([a,b],manifest);
  assert.equal(result.buildings.length,1);assert.equal(result.buildings[0].polygons[0].length,2);
  assert.equal(reconstructWholeBuildings([a],manifest).buildings.length,0);
  assert.equal(reconstructWholeBuildings([a,tile(8192,8192)],manifest).buildings.length,0);
  const mask=new ConsumptionMask(),chunks=rasterizeWholeBuildings(result.buildings);
  for(const[key,bits]of chunks)mask.ingestCoverage(key,bits);
  assert.ok(mask.consumeBuildingChunks(chunks).areaM2>0);assert.equal(mask.consumeBuildingChunks(chunks).areaM2,0);
});

test('a 900m border house keeps its full outside footprint and awards only its 50m in-square strip',()=>{
  const polygon=[rectangle(2450,-40,3350,40)];
  const geometry={type:'Polygon',coordinates:polygon.map(ring=>ring.map(p=>localToLonLat(p,manifest.center,0)))};
  const tiles=pbfTilesForGeometry(geometry,manifest,[2900,0],500),result=reconstructWholeBuildings(tiles,manifest);
  assert.equal(result.buildings.length,1);const building=result.buildings[0];
  assert.ok(building.bounds[2]>3349&&building.bounds[0]<2451);assert.ok(building.radius>449&&building.radius<453);
  assert.equal(polygonFitsCircle(building.polygons,[2900,0],500,1),true);
  assert.equal(polygonFitsCircle(building.polygons,[2490,0],100,1),false);
  const chunks=rasterizeWholeBuildings([building]);assert.ok(chunks.length>0);
  assert.ok(chunks.every(([key])=>key.startsWith('9,')));
  const awarded=chunks.reduce((n,[,bits])=>n+countMaskBits(bits)*4,0);
  assert.ok(awarded>=3800&&awarded<=4200,`in-square area ${awarded}`);assert.ok(building.area>71000);
  assert.throws(()=>wholeNativeTiles(manifest,[3000.1,0],500));
});

test('genuine saved Gatchina OSM courtyard passes PBF encode, seam reconstruction and area check',()=>{
  const raw=JSON.parse(fs.readFileSync(new URL('../public/data/gatchina/chunks/3-4.json',import.meta.url))).buildings.find(building=>building.id==='r1659230');
  assert.ok(raw);const m={...manifest,center:[30.1075,59.5633],projectionLatitude:59.5633};
  const tiles=pbfTilesForGeometry(raw.geometry,m,[0,0],500),result=reconstructWholeBuildings(tiles,m);
  assert.equal(result.buildings.length,1);
  const building=result.buildings[0];assert.equal(building.polygons[0].length,3);
  const original=raw.geometry.coordinates.map(ring=>ring.map(p=>lonLatToLocal(p,m.center,m.projectionLatitude)));
  assert.ok(Math.abs(building.area/polygonsArea([original])-1)<0.005);
  const chunks=rasterizeWholeBuildings([building]);assert.ok(chunks.reduce((n,[,bits])=>n+countMaskBits(bits),0)>0);
});

test('whole stream bounds native loading, reuses same tile set and preserves shared source on disposal',async()=>{
  const source=sourceFixture(),stream=new WholeBuildingStream({manifest,source,workerFactory:()=>new FixtureWorker()});
  await stream.update([0,0],20);assert.equal(stream.ready,true);assert.ok(source.calls<=4);assert.ok(source.maxActive<=2);
  const calls=source.calls,generation=stream.generation;
  await stream.update([1,1],20);assert.equal(source.calls,calls);assert.equal(stream.generation,generation);assert.equal(stream.stats.catalogs,1);
  assert.deepEqual(await stream.rasterize([]),[]);
  stream.dispose();assert.equal(source.disposed,false);assert.equal(stream.ready,false);await assert.rejects(stream.update([0,0],20),{name:'AbortError'});
});

test('failed whole contributor stays unknown and same desired region does not auto-retry',async()=>{
  const source=sourceFixture(()=>{throw new Error('fixture network failure');}),stream=new WholeBuildingStream({manifest,source,workerFactory:()=>new FixtureWorker()});
  await assert.rejects(stream.update([0,0],20),/network failure/);const calls=source.calls;
  await assert.rejects(stream.update([0,0],20),/network failure/);assert.equal(source.calls,calls);assert.equal(stream.ready,false);assert.deepEqual(stream.buildings,[]);stream.dispose();
});

test('worker rejects stale raster IDs and mixed source revisions',()=>{
  const processor=new WholeBuildingProcessor(),a=tile(8192,8192,[[rectangle(100,100,150,150)]]);
  const result=processor.process({type:'catalog',generation:1,tiles:[a],manifest});assert.equal(result.buildings.length,1);
  assert.throws(()=>processor.process({type:'whole-raster',generation:2,ids:[result.buildings[0].id]}));
  assert.throws(()=>reconstructWholeBuildings([a,{...tile(8191,8192),sourceKey:'revision2'}],manifest),/версии/);
});

test('frequent update calls do not starve whole preparation and an obsolete region never attaches',async()=>{
  let release,started;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);let first=true;
  const source=sourceFixture(async(x,y)=>{if(first){first=false;started();await gate;}return tile(x,y);});
  const stream=new WholeBuildingStream({manifest,source,workerFactory:()=>new FixtureWorker()});
  const pending=stream.update([-2400,-2400],18);await began;
  const updates=Array.from({length:15},()=>stream.update([2400,2400],18));
  release();await Promise.all([pending,...updates]);
  assert.equal(stream.ready,true);assert.equal(stream.stats.catalogs,1);assert.equal(stream.generation,2);
  assert.deepEqual(stream.desired.tiles,wholeNativeTiles(manifest,[2400,2400],18));stream.dispose();
});

test('dispose aborts only its native subscriptions and ignores late worker output',async()=>{
  let began;const started=new Promise(resolve=>began=resolve);
  const source=sourceFixture((x,y,signal)=>new Promise((resolve,reject)=>{began();signal.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true});}));
  const stream=new WholeBuildingStream({manifest,source,workerFactory:()=>new FixtureWorker()});
  const pending=stream.update([0,0],20);await started;stream.dispose();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(stream.ready,false);assert.deepEqual(stream.buildings,[]);assert.equal(source.disposed,false);
});

test('a raster result from the previous catalog is a routine abort, never available for reward',async()=>{
  let release,started;const began=new Promise(resolve=>started=resolve);
  class DelayedRasterWorker extends FixtureWorker{
    postMessage(input,transfer){if(input.type==='whole-raster'){started();release=()=>super.postMessage(input,transfer);}else super.postMessage(input,transfer);}
  }
  const source=sourceFixture(),stream=new WholeBuildingStream({manifest,source,workerFactory:()=>new DelayedRasterWorker()});
  await stream.update([0,0],20);
  const stale=stream.rasterize([]);await began;
  const newer=stream.update([2400,2400],20);await new Promise(resolve=>setImmediate(resolve));release();
  await assert.rejects(stale,{name:'AbortError'});await newer;assert.equal(stream.ready,true);stream.dispose();
});
