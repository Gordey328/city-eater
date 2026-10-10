import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {GeoJSONVT} from '@maplibre/geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {waterBoundaryPlan,waterBoundaryTiles,reconstructWaterBoundary,validateWaterBoundary,rasterizeWaterRegion,WATER_BOUNDARY_LIMITS} from '../src/water-boundary.js';
import {WaterBoundaryProcessor} from '../src/water-boundary.worker.js';
import {WaterBoundaryLoader} from '../src/water-boundary-loader.js';
import {validateTileMetadata} from '../src/tile-source.js';
import {localToLonLat,lonLatToLocal,polygonsArea,unwrapLongitude,pointInPolygon} from '../src/geometry.js';
import {countMaskBits} from '../src/consumption-mask.js';

const manifest={id:'water-fixture',center:[0,0],projectionLatitude:0,arenaSize:3000};
const rectangle=(l,b,r,t)=>[[l,b],[r,b],[r,t],[l,t],[l,b]];
function feature(rings,properties={class:'lake'},m=manifest){return{type:'Feature',properties,geometry:{type:'Polygon',coordinates:rings.map(ring=>ring.map(point=>{const ll=localToLonLat(point,m.center,m.projectionLatitude);ll[0]=unwrapLongitude(ll[0],m.center[0]);return ll;}))}};}
function sourceTiles(features=[],m=manifest){
  const index=new GeoJSONVT({type:'FeatureCollection',features},{maxZoom:14,indexMaxZoom:14,indexMaxPoints:0,extent:4096,buffer:64,tolerance:0});
  return waterBoundaryTiles(m).map(coord=>{const bytes=fromGeojsonVt({water:index.getTile(14,coord.x,coord.y)||{features:[]}},{extent:4096});return{...coord,sourceKey:'water-fixture-source',buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};});
}
class FixtureWorker{
  constructor(){this.processor=new WaterBoundaryProcessor();this.terminated=false;}
  terminate(){this.terminated=true;}
  postMessage(input,transfer){const message=structuredClone(input,{transfer});queueMicrotask(async()=>{if(this.terminated)return;try{const result=await this.processor.process(message);if(!this.terminated)this.onmessage({data:{requestId:message.requestId,...structuredClone(result)}});}catch(error){if(!this.terminated)this.onmessage({data:{requestId:message.requestId,type:'error',code:error.code,message:error.message}});}});}
}
function mockSource(tiles,handler=null){
  let calls=0,active=0,maxActive=0,disposed=false;const byKey=new Map(tiles.map(tile=>[`${tile.x}/${tile.y}`,tile]));
  return{stats:{bytes:0},get calls(){return calls;},get maxActive(){return maxActive;},get disposed(){return disposed;},async getMetadata(){return{sourceKey:'water-fixture-source',vectorLayers:['water','building']};},async loadNativeTile(z,x,y,signal){calls++;active++;maxActive=Math.max(maxActive,active);try{if(handler)return await handler(z,x,y,signal);const tile=byKey.get(`${x}/${y}`);this.stats.bytes+=tile.buffer.byteLength;return{...tile,buffer:tile.buffer.slice(0)};}finally{active--;}},retryFailures(){},dispose(){disposed=true;}};
}

test('native14 full-window plan is bounded, alignment-aware and wraps the dateline',()=>{
  assert.equal(waterBoundaryPlan({center:[30,60]}).tileCount,16);
  assert.equal(waterBoundaryPlan({center:[30,84.9]}).tileCount,361);
  assert.throws(()=>waterBoundaryTiles({center:[30,84.9]}),error=>error.code==='WATER_TILE_LIMIT'&&error.requiredTiles===361);
  for(const lng of [179.999,-179.999]){const tiles=waterBoundaryTiles({center:[lng,60]});assert.ok(tiles.some(t=>t.x===0));assert.ok(tiles.some(t=>t.x===16383));assert.equal(new Set(tiles.map(t=>`${t.x}/${t.y}`)).size,tiles.length);}
});

test('complete valid dry tiles create one exact frozen land square; missing tiles never become land',async()=>{
  const tiles=sourceTiles(),boundary=await reconstructWaterBoundary(tiles,manifest);
  assert.equal(boundary.envelopeId,manifest.id);assert.equal(boundary.regions.length,1);assert.equal(boundary.regions[0].areaM2,9_000_000);assert.deepEqual(boundary.waterPolygons,[]);
  assert.ok(Object.isFrozen(boundary.regions[0].polygons[0][0][0]));assert.equal(boundary.knownTileCount,tiles.length);
  await assert.rejects(reconstructWaterBoundary(tiles.slice(1),manifest),error=>error.code==='WATER_INCOMPLETE');
  await assert.rejects(reconstructWaterBoundary([tiles[0],...tiles.slice(0,-1)],manifest),error=>error.code==='WATER_INCOMPLETE');
  const result=await rasterizeWaterRegion(boundary,boundary.regions[0].id,manifest);
  assert.equal(result.scoreAreaM2,9_000_000);assert.equal(result.chunks.length,36);assert.equal(result.chunks.reduce((sum,[,bits])=>sum+countMaskBits(bits)*4,0),result.scoreAreaM2);
});

test('river seam fragments union into two true land components, stable under tile order and duplicates',async()=>{
  const river=feature([rectangle(-50,-3000,50,3000)],{class:'river'}),tiles=sourceTiles([river]),boundary=await reconstructWaterBoundary(tiles,manifest);
  assert.equal(boundary.regions.length,2);assert.equal(boundary.waterPolygons.length,1);
  for(const region of boundary.regions){assert.ok(pointInPolygon(region.representativePoint,region.polygons[0]));assert.ok(Math.abs(region.areaM2-4_350_000)<4000);}
  assert.equal((await reconstructWaterBoundary([...tiles].reverse(),manifest)).hash,boundary.hash);
  assert.equal((await reconstructWaterBoundary(sourceTiles([river,river]),manifest)).hash,boundary.hash);
  const saved=await validateWaterBoundary(JSON.parse(JSON.stringify(boundary)),manifest);assert.equal(saved.hash,boundary.hash);assert.notEqual(saved,boundary);
});

test('lake holes preserve islands, ocean can leave no land, and representatives never spawn in water',async()=>{
  const lake=feature([rectangle(-700,-700,700,700),rectangle(-100,-100,100,100).reverse()]),boundary=await reconstructWaterBoundary(sourceTiles([lake]),manifest);
  assert.equal(boundary.regions.length,2);assert.ok(boundary.regions.some(region=>region.polygons[0].length===2));
  for(const region of boundary.regions)assert.ok(pointInPolygon(region.representativePoint,region.polygons[0]));
  const ocean=await reconstructWaterBoundary(sourceTiles([feature([rectangle(-4000,-4000,4000,4000)],{class:'ocean'})]),manifest);
  assert.equal(ocean.regions.length,0);assert.ok(ocean.waterPolygons.length>0);
});

test('explicit pools, mixed wet/dry docks and grade-separated water do not cut surface land; unknown classes reject',async()=>{
  const excluded=[{class:'swimming_pool'},{class:'dock'},{class:'river',brunnel:'tunnel'},{class:'river',brunnel:'bridge'},{class:'river',brunnel:'aqueduct'}].map(properties=>feature([rectangle(-500,-500,500,500)],properties));
  const boundary=await reconstructWaterBoundary(sourceTiles(excluded),manifest);assert.equal(boundary.regions[0].areaM2,9_000_000);assert.ok(boundary.stats.excludedFeatures>0);
  await assert.rejects(reconstructWaterBoundary(sourceTiles([feature([rectangle(-500,-500,500,500)],{class:'mystery'})]),manifest),error=>error.code==='WATER_CLASS');
  assert.equal(boundary.policy.fountainAmbiguity,true);
});

test('saved partial, wrong-frame, altered-hash and altered-component records are rejected atomically',async()=>{
  const boundary=await reconstructWaterBoundary(sourceTiles(),manifest);
  for(const change of [{envelopeId:'wrong-envelope'},{complete:false},{knownTileCount:0},{hash:'0'.repeat(64)},{detailZoom:13},{domainBounds:[-1500,-1500,1500,1500]},{regions:[]}])await assert.rejects(validateWaterBoundary({...boundary,...change},manifest));
  await assert.rejects(validateWaterBoundary(boundary,{...manifest,center:[.01,0]}));
  assert.equal(boundary.regions.length,1);
  await assert.rejects(reconstructWaterBoundary(sourceTiles().map((tile,i)=>({...tile,sourceKey:i?'other':'one'})),manifest),error=>error.code==='WATER_SOURCE');
});

test('genuine saved OSM Silver Lake survives native PBF clipping and land subtraction',async()=>{
  const lake=JSON.parse(fs.readFileSync(new URL('./fixtures/gatchina-silver-lake.geojson',import.meta.url))),m={...manifest,center:[30.111,59.565],projectionLatitude:59.565};
  const tiles=sourceTiles([lake],m),boundary=await reconstructWaterBoundary(tiles,m),original=[lake.geometry.coordinates.map(ring=>ring.map(p=>lonLatToLocal(p,m.center,m.projectionLatitude)))];
  const originalArea=polygonsArea(original),waterArea=polygonsArea(boundary.waterPolygons);
  assert.ok(originalArea>1000);assert.ok(Math.abs(waterArea/originalArea-1)<.005);assert.equal(boundary.regions.length,1);assert.equal(boundary.regions[0].polygons[0].length,2);
  assert.equal(boundary.stats.fullMvtBytes,tiles.reduce((sum,tile)=>sum+tile.buffer.byteLength,0));assert.ok(boundary.stats.decodeMs>=0);
});

test('loader requires water capability, completes all contributors, and returns separate selected-region mask',async()=>{
  const tiles=sourceTiles(),source=mockSource(tiles),loader=new WaterBoundaryLoader({manifest,source,workerFactory:()=>new FixtureWorker()});
  const boundary=await loader.prepare();assert.equal(source.calls,tiles.length);assert.ok(source.maxActive<=2);assert.equal(loader.stats.fullMvtBytes,boundary.stats.fullMvtBytes);
  assert.equal(await loader.prepare(),boundary);assert.equal(source.calls,tiles.length);
  const selected=await loader.rasterizeRegion(boundary,boundary.regions[0].id);assert.equal(selected.scoreAreaM2,9_000_000);assert.ok(selected.preparedGeometry.allowedPolygons.length);assert.ok(Object.isFrozen(selected.preparedGeometry));loader.dispose();assert.equal(source.disposed,false);
  const missing=mockSource(tiles);missing.getMetadata=async()=>({vectorLayers:['building']});
  const bad=new WaterBoundaryLoader({manifest,source:missing,workerFactory:()=>new FixtureWorker()});await assert.rejects(bad.prepare(),error=>error.code==='WATER_LAYER');assert.equal(missing.calls,0);bad.dispose();
  const meta=validateTileMetadata({tiles:['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'],maxzoom:14,vector_layers:[{id:'building'},{id:'water'}]});assert.deepEqual(meta.vectorLayers,['building','water']);
});

test('unsupported full windows issue zero source requests and failed contributors remain latched',async()=>{
  const source=mockSource([]);source.getMetadata=async()=>{throw new Error('must not request metadata');};
  const unsupported=new WaterBoundaryLoader({manifest:{...manifest,center:[30,84.9],projectionLatitude:84.9},source,workerFactory:()=>new FixtureWorker()});await assert.rejects(unsupported.prepare(),error=>error.code==='WATER_TILE_LIMIT');assert.equal(source.calls,0);unsupported.dispose();
  const failed=mockSource(sourceTiles(),()=>{throw new Error('fixture404');}),loader=new WaterBoundaryLoader({manifest,source:failed,workerFactory:()=>new FixtureWorker()});
  await assert.rejects(loader.prepare(),/fixture404/);const calls=failed.calls;await assert.rejects(loader.prepare(),/fixture404/);assert.equal(failed.calls,calls);assert.equal(loader.boundary,null);loader.dispose();
});

test('cancellation aborts only boundary subscribers and cannot publish a late boundary',async()=>{
  let begun;const started=new Promise(resolve=>begun=resolve),source=mockSource(sourceTiles(),(z,x,y,signal)=>new Promise((resolve,reject)=>{begun();signal.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true});}));
  const loader=new WaterBoundaryLoader({manifest,source,workerFactory:()=>new FixtureWorker()}),pending=loader.prepare();await started;loader.dispose();await assert.rejects(pending,{name:'AbortError'});assert.equal(source.disposed,false);assert.equal(loader.boundary,null);
});

test('native river reconstruction at both date-line copies preserves separate banks',async()=>{
  for(const longitude of [179.999,-179.999]){
    const m={...manifest,id:`date-${longitude}`,center:[longitude,60],projectionLatitude:60};
    const river=feature([rectangle(-50,-3000,50,3000)],{class:'river'},m),boundary=await reconstructWaterBoundary(sourceTiles([river],m),m);
    assert.equal(boundary.regions.length,2);assert.equal(boundary.waterPolygons.length,1);
    assert.ok(boundary.waterPolygons.every(polygon=>polygon.every(ring=>ring.every(([x,y])=>Math.abs(x)<=2000&&Math.abs(y)<=2000))));
    for(const region of boundary.regions)assert.ok(Math.abs(region.areaM2-4_350_000)<4000);
  }
});

test('a malformed contributing PBF rejects rather than becoming a dry tile',async()=>{
  const tiles=sourceTiles();tiles[0]={...tiles[0],buffer:new TextEncoder().encode('<html>blocked</html>').buffer};
  await assert.rejects(reconstructWaterBoundary(tiles,manifest),error=>error.code==='WATER_PBF');
});

test('loader refuses malformed separate-region replies before mask installation',async()=>{
  const boundary=await reconstructWaterBoundary(sourceTiles(),manifest),regionId=boundary.regions[0].id,correct=await rasterizeWaterRegion(boundary,regionId,manifest);
  const variants=[
    value=>({...value,chunks:[]}),
    value=>({...value,chunks:[value.chunks[0],...value.chunks.slice(0,-1)]}),
    value=>{value.chunks[0][0]='9,9';return value;},
    value=>({...value,scoreAreaM2:value.scoreAreaM2-4}),
    value=>{value.chunks.find(([key])=>key==='5,5')[1][8191]=128;return value;},
    value=>{value.chunks[0]=null;return value;},
  ];
  for(const change of variants){
    class InvalidReplyWorker{terminate(){}postMessage(message){queueMicrotask(()=>this.onmessage({data:{type:'water-region',regionId,requestId:message.requestId,...change(structuredClone(correct))}}));}}
    const loader=new WaterBoundaryLoader({manifest,source:mockSource(sourceTiles()),workerFactory:()=>new InvalidReplyWorker()});
    await assert.rejects(loader.rasterizeRegion(boundary,regionId),error=>error.code==='WATER_REGION');loader.dispose();
  }
});


test('cached validation runs in the worker without metadata or tile requests',async()=>{
  const boundary=await reconstructWaterBoundary(sourceTiles(),manifest),source=mockSource([]);
  source.getMetadata=async()=>{throw new Error('validation must not fetch');};
  const loader=new WaterBoundaryLoader({manifest,source,workerFactory:()=>new FixtureWorker()});
  const result=await loader.validate(boundary);assert.equal(result.hash,boundary.hash);assert.equal(source.calls,0);assert.ok(Object.isFrozen(result));assert.notEqual(result,boundary);
  await assert.rejects(loader.validate({...boundary,hash:'wrong'}),error=>error.code==='WATER_SAVED_INVALID');loader.dispose();
});


test('saved geometry limits apply across all components, not individually per region',async()=>{
  const boundary=await reconstructWaterBoundary(sourceTiles(),manifest),ring=Array.from({length:160001},()=>[0,0]);
  const region={...boundary.regions[0],polygons:[[ring]]};
  await assert.rejects(validateWaterBoundary({...boundary,regions:[region,{...region,id:'other'}]},manifest),error=>error.code==='WATER_GEOMETRY_LIMIT');
});
