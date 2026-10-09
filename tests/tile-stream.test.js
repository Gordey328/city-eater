import test from 'node:test';
import assert from 'node:assert/strict';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {TileSource, TILEJSON_URL, validateTileMetadata, TILE_SOURCE_LIMITS} from '../src/tile-source.js';
import {TileStream, nativeTilesForBounds} from '../src/tile-stream.js';
import {decodeBuildingTile, TileCoverageProcessor} from '../src/tile-coverage.worker.js';
import {ConsumptionMask, countMaskBits, rasterizeCoverageChunk, maskChunkBounds} from '../src/consumption-mask.js';
import {lonLatToLocal} from '../src/geometry.js';

const metadata = {tiles: ['https://tiles.openfreemap.org/planet/fixture/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14, vector_layers: [{id: 'building'}]};
const manifest = {id: 'tile-fixture', center: [0, 0], projectionLatitude: 0, arenaSize: 10000};
const rectangle = (l,t,r,b) => [[l,t],[r,t],[r,b],[l,b],[l,t]];
const encode = (features = [], extent = 4096) => {
  const bytes = fromGeojsonVt({building: {features: features.map((geometry, index) => ({type: 3, id: index, tags: {}, geometry}))}}, {extent});
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const tile = (x,y,buffer) => ({x,y,z:14,buffer,sourceKey:'fixture',key:`fixture/14/${x}/${y}`});
function mockFetch(handler = () => new Response(encode())) {
  return async (url, options) => url === TILEJSON_URL ? new Response(JSON.stringify(metadata)) : handler(url, options);
}
class FixtureWorker {
  constructor() { this.processor = new TileCoverageProcessor(); this.terminated = false; }
  terminate() { this.terminated = true; }
  postMessage(value, transfer) {
    const message = structuredClone(value, {transfer});
    queueMicrotask(() => {
      if (this.terminated) return;
      try { this.onmessage({data: {type: 'coverage', requestId: message.requestId, ...this.processor.process(message)}}); }
      catch (error) { this.onmessage({data: {type: 'error', requestId: message.requestId, message: error.message}}); }
    });
  }
}
function streamWith(fetchImpl = mockFetch()) {
  const source = new TileSource({fetchImpl}), mask = new ConsumptionMask(), changes = [];
  const stream = new TileStream({manifest, mask, source, workerFactory: () => new FixtureWorker(), onChange: (key,bits) => changes.push([key,bits])});
  return {source,mask,stream,changes};
}

test('metadata requires confirmed native14 and the documented host, no source rotation or external templates', () => {
  assert.equal(validateTileMetadata(metadata).nativeZoom, 14);
  assert.equal(validateTileMetadata(metadata).sourceRevisionImmutable, false);
  const attribution=validateTileMetadata({...metadata,attribution:'<script>untrusted</script>'}).attribution;
  assert.match(attribution,/href="https:\/\/www\.openstreetmap\.org\/copyright"/);
  assert.match(attribution,/href="https:\/\/openfreemap\.org\/"/);
  assert.match(attribution,/href="https:\/\/www\.openmaptiles\.org\/"/);
  assert.doesNotMatch(attribution,/untrusted|script/);
  for (const change of [{maxzoom:13},{maxzoom:15},{maxzoom:'14'},{tiles:['https://evil.invalid/planet/{z}/{x}/{y}.pbf']},{tiles:['http://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf']},{vector_layers:[{id:'water'}]},{tiles:[]}]) assert.throws(() => validateTileMetadata({...metadata,...change}));
});

test('source deduplicates pending requests, retains transferable copies and limits concurrency to two', async () => {
  let active = 0, maxActive = 0, requests = 0;
  const source = new TileSource({fetchImpl: mockFetch(async () => {
    requests++; active++; maxActive = Math.max(maxActive,active); await new Promise(resolve=>setImmediate(resolve)); active--;
    return new Response(encode());
  })});
  const [a,b] = await Promise.all([source.loadNativeTile(14,1,2),source.loadNativeTile(14,1,2)]);
  assert.equal(requests,1); assert.notEqual(a.buffer,b.buffer);
  structuredClone(a.buffer,{transfer:[a.buffer]}); assert.equal(a.buffer.byteLength,0);
  assert.ok((await source.loadNativeTile(14,1,2)).buffer.byteLength>0);
  await Promise.all(Array.from({length:10},(_,x)=>source.loadNativeTile(14,x+10,2)));
  assert.ok(maxActive<=2); assert.equal(source.stats.maxConcurrent,2); assert.equal(source.stats.metadataRequests,1);
  source.dispose();
});

test('failed native tile is never empty and stays latched until explicit retry', async () => {
  let requests=0, fail=true;
  const source = new TileSource({fetchImpl:mockFetch(async()=>{requests++;return fail?new Response('blocked',{status:403}):new Response(encode());})});
  await assert.rejects(source.loadNativeTile(14,1,2),error=>error.code==='HTTP_ERROR'&&error.status===403);
  await assert.rejects(source.loadNativeTile(14,1,2)); assert.equal(requests,1); assert.equal(source.cache.size,0);
  fail=false;source.retryFailures();assert.ok((await source.loadNativeTile(14,1,2)).buffer.byteLength>0);assert.equal(requests,2);source.dispose();
});

test('oversize metadata/tile bodies are cancelled and never decoded', async () => {
  let cancelled=false;
  const source = new TileSource({fetchImpl:mockFetch(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':String(TILE_SOURCE_LIMITS.tileBytes+1)}}))});
  await assert.rejects(source.loadNativeTile(14,1,2),error=>error.code==='BYTE_LIMIT');assert.equal(cancelled,true);assert.equal(source.cache.size,0);source.dispose();
});

test('source raw LRU has fixed tile count and byte limits', async () => {
  const source=new TileSource({fetchImpl:mockFetch()});
  for(let x=0;x<30;x++)await source.loadNativeTile(14,x,100);
  assert.equal(source.stats.retainedTiles,24);assert.ok(source.stats.retainedBytes<=32*1024*1024);source.dispose();
});

test('native source selection is bounded, projection-aware, and wraps antimeridian canonically', () => {
  for(const origin of [[0,0],[30,60],[179.999,60],[-179.999,-60],[10,84.8]]){
    const m={...manifest,center:origin,projectionLatitude:origin[1]},tiles=nativeTilesForBounds(m,[-500,-500,12,12]);
    assert.ok(tiles.length>=1&&tiles.length<=64);assert.equal(new Set(tiles.map(t=>`${t.x}/${t.y}`)).size,tiles.length);
    for(const t of tiles){assert.equal(t.z,14);assert.ok(t.x>=0&&t.x<16384&&t.y>=0&&t.y<16384);}
  }
  assert.throws(()=>nativeTilesForBounds({...manifest,center:[0,86]},[-100,-100,100,100]));
  assert.throws(()=>nativeTilesForBounds(manifest,[-5000,-5000,5000,5000]));
});

test('decoder honors dynamic extent, courtyard holes and no feature-ID dependence', () => {
  const rings=[rectangle(0,0,1000,1000),rectangle(200,200,800,800).reverse()];
  const a=decodeBuildingTile(tile(8192,8192,encode([rings],4096)),manifest);
  const doubled=rings.map(ring=>ring.map(([x,y])=>[x*2,y*2]));
  const b=decodeBuildingTile(tile(8192,8192,encode([doubled],8192)),manifest);
  assert.deepEqual(a.polygons,b.polygons);assert.equal(a.polygons[0].length,2);
  const bits=rasterizeCoverageChunk('10,9',a.polygons);assert.ok(countMaskBits(bits)>0);
  const solid=rasterizeCoverageChunk('10,9',a.polygons.map(p=>[p[0]]));assert.ok(countMaskBits(bits)<countMaskBits(solid));
});

test('canonical tile clipping and union raster produce one seam-spanning courtyard, never duplicate reward coverage', () => {
  const rings=[rectangle(-16,20,16,120),rectangle(-8,40,8,100).reverse()];
  const left=rings.map(ring=>ring.map(([x,y])=>[x+4096,y]));
  const tiles=[tile(8191,8192,encode([left,left])),tile(8192,8192,encode([rings,rings]))];
  const processor=new TileCoverageProcessor(),result=processor.process({key:'9,9',tiles,manifest});
  const toLocal=([x,y])=>lonLatToLocal([x/4096/16384*360,Math.atan(Math.sinh(Math.PI*(1-2*(8192+y/4096)/16384)))*180/Math.PI],manifest.center,0);
  const expected=rasterizeCoverageChunk('9,9',[rings.map(ring=>ring.map(toLocal))]);
  assert.deepEqual(result.bits,expected);assert.ok(countMaskBits(result.bits)>0);
  const reversed=processor.process({key:'9,9',tiles:[...tiles].reverse(),manifest});assert.deepEqual(reversed.bits,result.bits);
});

test('malformed PBF cannot be interpreted as successful empty coverage', () => {
  assert.throws(()=>decodeBuildingTile(tile(8192,8192,new TextEncoder().encode('<html>blocked</html>').buffer),manifest));
  assert.throws(()=>decodeBuildingTile(tile(8192,8192,new Uint8Array([26,255,255,255,255,255,255]).buffer),manifest));
  const empty=decodeBuildingTile(tile(8192,8192,encode()),manifest);assert.deepEqual(empty.polygons,[]);
});

test('stream publishes only after all contributors succeed; valid empty is authoritative', async () => {
  const {stream,mask,source}=streamWith();
  assert.equal(stream.covers([0,0],18),false);
  await stream.prepare([0,0],18);
  assert.equal(stream.covers([0,0],18),true);assert.ok(mask.coverage.size>0);
  assert.ok([...mask.coverage.values()].every(c=>countMaskBits(c.bits)===0));
  assert.ok(source.stats.tileRequests<=4);assert.equal(stream.metadata.nativeZoom,14);assert.ok(stream.stats.startupMs>=0);
  stream.dispose();assert.equal(mask.coverage.size,0);assert.equal(stream.covers([0,0],18),false);
});

test('one missing source tile leaves its mask chunk unknown and update does not auto-retry', async () => {
  let requests=0;
  const {stream,mask}=streamWith(mockFetch(async()=>{requests++;return new Response('',{status:403});}));
  await assert.rejects(stream.prepare([0,0],18));assert.equal(mask.coverage.size,0);assert.equal(stream.covers([0,0],18),false);
  const count=requests;await assert.rejects(stream.update([0,0],18));assert.equal(requests,count);stream.dispose();
});

test('dispose while source pending aborts and cannot attach stale masks', async () => {
  let started;
  const began=new Promise(resolve=>started=resolve);
  const {stream,mask,changes}=streamWith(mockFetch(async(url,{signal})=>{started();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});}));
  const pending=stream.prepare([0,0],18);await began;stream.dispose();await assert.rejects(pending,error=>error.name==='AbortError');
  assert.equal(mask.coverage.size,0);assert.equal(changes.length,0);
});

test('coverage residency stays bounded and renderer receives eviction notifications', async () => {
  const {stream,mask,changes}=streamWith();
  for(const x of [-4000,-2500,-1000,500,2000,3500])await stream.update([x,0],500,[1,0]);
  assert.ok(stream.stats.maxCoverageChunks<=36);assert.ok(mask.coverage.size<=36);assert.ok(changes.some(([,bits])=>bits===null));
  assert.ok(stream.source.stats.retainedTiles<=24);assert.ok(stream.stats.retainedDecodedTiles<=24);stream.dispose();
});

test('radius cap and arena clipping prevent whole-sector or impossible outside loads', async () => {
  const {stream}=streamWith();
  await assert.rejects(stream.prepare([0,0],501));
  await stream.prepare([4990,4990],500);assert.equal(stream.covers([4990,4990],500),true);
  for(const key of stream.coverage.keys()){const b=maskChunkBounds(key);assert.ok(b.maxX<=5000&&b.maxY<=5000);}
  assert.ok(stream.coverage.size<=9);stream.dispose();
});

test('frequent update calls do not starve useful in-flight coverage', async () => {
  let release, started;
  const began=new Promise(resolve=>started=resolve), gate=new Promise(resolve=>release=resolve);
  let first=true;
  const {stream,mask}=streamWith(mockFetch(async()=>{if(first){first=false;started();await gate;}return new Response(encode());}));
  const initial=stream.prepare([0,0],18);await began;
  const updates=Array.from({length:20},()=>stream.update([0,0],18));
  release();await Promise.all([initial,...updates]);
  assert.equal(stream.covers([0,0],18),true);assert.ok(mask.coverage.size>0);assert.ok(stream.source.stats.tileRequests<=4);stream.dispose();
});

test('changed desired region never receives obsolete in-flight chunks', async () => {
  let release,started;
  const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);let first=true;
  const {stream,changes}=streamWith(mockFetch(async()=>{if(first){first=false;started();await gate;}return new Response(encode());}));
  const old=stream.update([-4000,-4000],18);await began;
  const newest=stream.update([4000,4000],18);release();await Promise.all([old,newest]);
  assert.equal(stream.covers([4000,4000],18),true);assert.equal(stream.covers([-4000,-4000],18),false);
  assert.ok(changes.every(([key])=>stream.desired.has(key)));stream.dispose();
});

test('existing real Gatchina courtyard geometry survives local GeoJSON-to-PBF adapter replay', async () => {
  const fs=await import('node:fs/promises'),{GeoJSONVT}=await import('@maplibre/geojson-vt');
  const realManifest=JSON.parse(await fs.readFile(new URL('../public/data/gatchina/manifest.json',import.meta.url),'utf8'));
  const data=JSON.parse(await fs.readFile(new URL('../public/data/gatchina/chunks/3-4.json',import.meta.url),'utf8'));
  const building=data.buildings.find(b=>b.id==='r1659230');assert.ok(building);assert.equal(building.polygons[0].length,3);
  const index=new GeoJSONVT({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:building.geometry}]},{maxZoom:14,indexMaxZoom:14,tolerance:0,extent:4096,buffer:64});
  const {maskChunksForBounds}=await import('../src/consumption-mask.js');
  const keys=maskChunksForBounds(building.bbox),processor=new TileCoverageProcessor();let actualCount=0,expectedCount=0,differences=0,solidCount=0;
  for(const key of keys){
    const tiles=nativeTilesForBounds(realManifest,maskChunkBounds(key)).map(({z,x,y})=>{
      const encoded=fromGeojsonVt({building:index.getTile(z,x,y)||{features:[]}},{extent:4096});
      return {...tile(x,y,encoded.buffer.slice(encoded.byteOffset,encoded.byteOffset+encoded.byteLength)),sourceKey:'offline-real-gatchina-r1659230'};
    });
    const result=processor.process({key,tiles,manifest:realManifest}),expected=rasterizeCoverageChunk(key,building.polygons);
    actualCount+=countMaskBits(result.bits);expectedCount+=countMaskBits(expected);
    const delta=new Uint8Array(8192);for(let i=0;i<8192;i++)delta[i]=result.bits[i]^expected[i];differences+=countMaskBits(delta);
    const solid=rasterizeCoverageChunk(key,building.polygons.map(p=>[p[0]]));
    solidCount+=countMaskBits(solid);
  }
  assert.ok(actualCount>1000);assert.ok(actualCount<solidCount,'Real courtyard holes must survive the PBF path');assert.ok(differences/expectedCount<0.02,`Native tile quantization changed ${differences}/${expectedCount} cells`);
});

test('explicit retry after malformed PBF fetches fresh bytes instead of replaying corrupt cache', async () => {
  let bad=true,requests=0;
  const {stream}=streamWith(mockFetch(async()=>{requests++;return new Response(bad?'not a PBF':encode());}));
  await assert.rejects(stream.prepare([0,0],18));const first=requests;
  await assert.rejects(stream.update([0,0],18));assert.equal(requests,first);
  bad=false;await stream.retry([0,0],18);assert.ok(requests>first);assert.equal(stream.covers([0,0],18),true);stream.dispose();
});
