/** Real installed MapLibre worker tile-index CPU benchmark, without WebGL. */
import {GeoJSONVT} from '@maplibre/geojson-vt';
import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {BuildingRepository} from '../src/repository.js';
import {cameraMetrics} from '../src/camera.js';
import {mercatorPoint} from '../src/animation-geometry.js';
const round=n=>Math.round(n*1000)/1000,rows=[];
const options={buffer:2048,tolerance:6,extent:8192,maxZoom:18,lineMetrics:false,updateable:true};
for(const city of ['pushkin','gatchina']){
 const base=new URL(`../public/data/${city}/`,import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',base))),chunks=new Map();for(const c of manifest.chunks)chunks.set(c.id,JSON.parse(await readFile(new URL(c.url,base))));
 const all=[...chunks.values()].flatMap(c=>c.buildings);
 for(const radius of [18,500])for(const count of [0,6000]){
  const repo=new BuildingRepository(manifest,'https://benchmark.invalid/',new Set(all.slice(0,count).map(b=>b.id)),()=>{},{loadChunk:async c=>chunks.get(c.id)});repo.setViewport(390,844);await repo.update([0,0],radius);const features=repo.features().features,ids=features.slice(0,560).map(f=>f.id),batches=[];for(let i=0;i<ids.length;i+=28)batches.push(ids.slice(i,i+28));
  const center=mercatorPoint(manifest.center),zoom=Math.floor(cameraMetrics(radius,390,844,manifest.center[1]).zoom),x=Math.floor(center[0]*2**zoom),y=Math.floor(center[1]*2**zoom);let tileFeatures=0;
  const readTiles=index=>{for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)tileFeatures+=index.getTile(zoom,x+dx,y+dy)?.features?.length||0;};
  const before=[],after=[];
  for(let trial=0;trial<6;trial++)for(const mode of ['before','after']){
   const live=new Map(features.map(f=>[f.id,f]));let index=new GeoJSONVT({type:'FeatureCollection',features},options);readTiles(index);const start=performance.now();
   for(const batch of batches){if(mode==='before'){for(const id of batch)live.delete(id);index=new GeoJSONVT({type:'FeatureCollection',features:[...live.values()]},options);}else index.updateData({remove:batch});readTiles(index);}
   const duration=performance.now()-start;if(trial)(mode==='before'?before:after).push(duration);
  }
  before.sort((a,b)=>a-b);after.sort((a,b)=>a-b);rows.push({city,radius,consumed:count,resident:features.length,batches:batches.length,objectsRemoved:ids.length,medianTotalMsBefore:round(before[2]),medianTotalMsAfter:round(after[2]),tileFeatures});repo.dispose();
 }
}
const maplibreVersion=JSON.parse(await readFile(new URL('../node_modules/maplibre-gl/package.json',import.meta.url))).version;
const indexVersion=JSON.parse(await readFile(new URL('../node_modules/@maplibre/geojson-vt/package.json',import.meta.url))).version;
const report={generatedAt:new Date().toISOString(),maplibreVersion,indexVersion,method:'Installed MapLibre worker index kernel; identical resident features, removals and 3×3 tile reads at radius-derived zoom. 1 warmup plus 5 trials, medians over up to20 batches of28 removals. Excludes source cloning, WebGL and device FPS.',rows};if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
