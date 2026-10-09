/** Reproducible CPU/serialization microbenchmarks. No WebGL, phone FPS or network claims.
 * The legacy kernels below match the pre-optimization a6cd03e8 implementation.
 * Source-clone timings model the main-thread structured-clone payload, not MapLibre
 * worker tiling, rendering or driver cost. Each row isolates radius and ID count.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {BuildingRepository} from '../src/repository.js';
import {SpatialIndex,polygonFitsCircle,localToLonLat} from '../src/geometry.js';
import {createRun,serializeRun} from '../src/state.js';
import {CheckpointQueue} from '../src/checkpoints.js';
import {prepareAnimationGeometry,mercatorPoint} from '../src/animation-geometry.js';
let sink=0;
const rounded=n=>Math.round(n*10000)/10000;
function measure(fn,iterations=25){for(let i=0;i<5;i++)fn();const samples=[];for(let i=0;i<iterations;i++){const start=performance.now();fn();samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);return {medianMs:rounded(samples[Math.floor(samples.length/2)]),p95Ms:rounded(samples[Math.floor(samples.length*.95)])};}
function legacyFeatures(buildings,consumed,absorbed=new Set()){return {type:'FeatureCollection',features:[...buildings.values()].filter(b=>!consumed.has(b.id)&&!absorbed.has(b.id)).map(b=>({type:'Feature',id:b.id,properties:{id:b.id,radius:b.radius,area:b.area},geometry:b.geometry}))};}
function legacyQuery(index,box){const keys=new Set();for(const key of index.keysFor(box))for(const id of index.cells.get(key)||[])keys.add(id);return [...keys].map(id=>index.items.get(id)).filter(e=>e.bbox.minX<=box.maxX&&e.bbox.maxX>=box.minX&&e.bbox.minY<=box.maxY&&e.bbox.maxY>=box.minY).map(e=>e.item);}
function legacyFits(polygons,center,radius){const points=polygons.flatMap(p=>(p[0]||[]).filter(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1])));return points.length>0&&points.every(p=>Math.hypot(p[0]-center[0],p[1]-center[1])<=radius*1.06+1e-8);}
const datasets=[];
for(const city of ['pushkin','gatchina']){
  const base=new URL(`../public/data/${city}/`,import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',base))),chunks=new Map();
  for(const chunk of manifest.chunks)chunks.set(chunk.id,JSON.parse(await readFile(new URL(chunk.url,base))));
  datasets.push({name:city,manifest,chunks,all:[...chunks.values()].flatMap(c=>c.buildings)});
}
const synthetic=[];
for(let i=0;i<20000;i++){
  const x=(i%200-100)*30,y=(Math.floor(i/200)-50)*30,ring=[];
  for(let v=0;v<16;v++){const a=v*Math.PI/8;ring.push([x+5*Math.cos(a),y+5*Math.sin(a)]);}ring.push(ring[0]);
  synthetic.push({id:`synthetic-${i}`,radius:5,area:75,center:[x,y],bbox:[x-5,y-5,x+5,y+5],polygons:[[ring]],geometry:{type:'Polygon',coordinates:[ring.map(p=>localToLonLat(p,[30,60]))]}});
}
const syntheticManifest={id:'synthetic',version:'test',center:[30,60],spawn:[0,0],initialRadius:18,totalBuildingArea:1500000,chunkSize:1000,chunks:[]},syntheticChunks=new Map();
for(const building of synthetic){const x=Math.floor((building.center[0]+5000)/1000),y=Math.floor((building.center[1]+5000)/1000),id=`${x}-${y}`;if(!syntheticChunks.has(id)){syntheticManifest.chunks.push({id,x,y,bbox:[-5005+x*1000,-5005+y*1000,-3995+x*1000,-3995+y*1000]});syntheticChunks.set(id,{version:'test',buildings:[]});}syntheticChunks.get(id).buildings.push(building);}
datasets.push({name:'synthetic-20000',manifest:syntheticManifest,chunks:syntheticChunks,all:synthetic});
const rows=[];
for(const dataset of datasets)for(const radius of [18,100,250,500])for(const consumedCount of [0,1000,6000,12000]){
  const consumed=new Set(dataset.all.slice(0,consumedCount).map(b=>b.id)),repo=new BuildingRepository(dataset.manifest,'https://benchmark.invalid/',consumed,()=>{},{loadChunk:async c=>dataset.chunks.get(c.id)});repo.setViewport(390,844);await repo.update([0,0],radius);repo.takeRenderChanges();
  const buildings=repo.buildings,absorbIds=[...buildings.keys()].slice(0,28),absorbed=new Set(absorbIds),box={minX:-radius*1.06,minY:-radius*1.06,maxX:radius*1.06,maxY:radius*1.06},output=[];
  const oldData=legacyFeatures(buildings,consumed,absorbed),newData={remove:absorbIds};
  const oldClone=measure(()=>{sink+=structuredClone(legacyFeatures(buildings,consumed,absorbed)).features.length;},15),newClone=measure(()=>{sink+=structuredClone({remove:[...absorbIds]}).remove.length;},15);
  const oldQuery=measure(()=>{for(const b of legacyQuery(repo.index,box))if(b.radius<=radius*1.06)sink+=legacyFits(b.polygons,[0,0],radius)?1:0;});
  const newQuery=measure(()=>{for(const b of repo.near([0,0],radius*1.06,output))if(b.radius<=radius*1.06)sink+=polygonFitsCircle(b.polygons,[0,0],radius,1.06)?1:0;});
  rows.push({dataset:dataset.name,radius,consumed:consumed.size,residentBuildings:buildings.size,residentChunks:repo.chunks.size,changedIds:absorbIds.length,
    allocatedFeatureObjectsBefore:oldData.features.length,allocatedFeatureObjectsAfter:0,sourceCloneBefore:oldClone,sourceCloneAfter:newClone,payloadBytesBefore:Buffer.byteLength(JSON.stringify(oldData)),payloadBytesAfter:Buffer.byteLength(JSON.stringify(newData)),queryFitBefore:oldQuery,queryFitAfter:newQuery});repo.dispose();
}
const checkpoints=[];
for(const count of [0,1000,6000,12000,100000]){
  const run=createRun(syntheticManifest);run.consumed=new Set(Array.from({length:count},(_,i)=>`w${i}`));
  const before=measure(()=>{for(let i=0;i<120;i++)sink+=structuredClone(serializeRun(run)).consumed.length;},9);
  const samples=[];let writes=0;
  for(let n=0;n<9;n++){
    const queue=new CheckpointQueue(async snapshot=>{sink+=structuredClone(snapshot).consumed.length;writes++;},{setTimer:()=>1,clearTimer:()=>{},requestIdle:null});const start=performance.now();for(let i=0;i<120;i++)queue.request(run);await queue.flush();samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);checkpoints.push({consumed:count,batches:120,beforeWrites:120,afterWrites:writes/9,before,after:{medianMs:rounded(samples[4]),p95Ms:rounded(samples[8])}});
}
const animations=[];
for(const dataset of datasets){
  const candidates=[...dataset.all].sort((a,b)=>b.polygons.flat(2).length-a.polygons.flat(2).length).slice(0,28),cached=candidates.map(b=>prepareAnimationGeometry(b,dataset.manifest.center)),world=512*2**15;
  const vertices=candidates.reduce((s,b)=>s+b.polygons.reduce((n,p)=>n+p.reduce((m,r)=>m+r.length,0),0),0);
  const before=measure(()=>{for(const b of candidates)for(const p of b.polygons)for(const r of p)for(const point of r){const q=mercatorPoint(localToLonLat(point,dataset.manifest.center));sink+=q[0]*world+q[1]*world;}},35);
  const after=measure(()=>{for(const rings of cached)for(const p of rings)for(const r of p)for(let i=0;i<r.length;i+=2)sink+=r[i]*world+r[i+1]*world;},35);
  animations.push({dataset:dataset.name,buildings:candidates.length,vertices,before,after,note:'Same vertices, cached offsets only; production also caps effects at 16 / 1400 vertices, or 6 / 400 low quality.'});
}
const report={generatedAt:new Date().toISOString(),node:process.version,method:'Node CPU microbenchmarks; medians and p95, no WebGL/phone FPS. Legacy kernels from a6cd03e8. Source timings include structuredClone; worker tiling/GPU excluded. 390×844 viewport; radius and consumed history varied independently to isolate costs.',rows,checkpoints,animations,sink};
const output=process.argv[2];if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
