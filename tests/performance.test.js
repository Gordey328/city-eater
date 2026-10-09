import test from 'node:test';
import assert from 'node:assert/strict';
import {BuildingRepository} from '../src/repository.js';
import {AbsorptionSystem,animationLimits,MAX_PENDING_ABSORPTIONS} from '../src/absorption.js';
import {CheckpointQueue} from '../src/checkpoints.js';
import {createRun,serializeRun} from '../src/state.js';
import {localToLonLat,SpatialIndex} from '../src/geometry.js';
import {mercatorPoint,prepareAnimationGeometry} from '../src/animation-geometry.js';
const building=(id,x=0)=>({id,area:16,radius:3,center:[x,0],bbox:[x-2,-2,x+2,2],polygons:[[[[x-2,-2],[x+2,-2],[x+2,2],[x-2,2],[x-2,-2]]]],geometry:{type:'Polygon',coordinates:[]}});
const manifest={id:'perf',version:'v1',center:[30,60],spawn:[0,0],initialRadius:18,totalBuildingArea:1e9,chunkSize:1000,chunks:[{id:'near',bbox:[-100,-100,100,100]},{id:'far',bbox:[4000,4000,4100,4100]}]};
async function fixture(buildings){const run=createRun(manifest);const repo=new BuildingRepository(manifest,'https://example.invalid/',run.consumed,()=>{},{loadChunk:async c=>({version:'v1',buildings:c.id==='near'?buildings:[]})});await repo.update([0,0],18);return {run,repo};}
test('hundreds of simultaneous rewards remain exact while cosmetic animation count and vertices stay bounded',async()=>{
  const buildings=Array.from({length:400},(_,i)=>building(`w${i}`));const {run,repo}=await fixture(buildings),system=new AbsorptionSystem();
  let now=0;
  while(run.consumed.size<buildings.length){system.step(run,repo,manifest,now,'low');assert.ok(system.pendingCount<=MAX_PENDING_ABSORPTIONS);assert.ok(system.animations.length<=animationLimits('low').count);assert.ok(system.animations.reduce((n,a)=>n+a.vertices,0)<=animationLimits('low').vertices);now+=420;assert.ok(now<10000);}
  assert.equal(run.mass,6400);assert.equal(run.consumedArea,6400);assert.equal(run.score,800);assert.equal(repo.index.size,0);assert.equal(repo.reserved.size,0);assert.equal(repo.buildings.size,0);
  for(let i=0;i<100;i++)system.step(run,repo,manifest,now+i*16);
  assert.equal(run.consumed.size,400);assert.equal(run.mass,6400);assert.equal(system.animations.length,0);
});
test('reserved geometry cannot reappear after streaming out/back, and rewards wait for the full animation time',async()=>{
  const {run,repo}=await fixture([building('w1')]),system=new AbsorptionSystem();system.step(run,repo,manifest,0);
  assert.equal(run.consumed.size,0);assert.equal(repo.near([0,0],20).length,0);
  await repo.update([4050,4050],18);await repo.update([0,0],18);
  assert.equal(repo.buildings.size,0);assert.equal(repo.features().features.length,0);
  system.step(run,repo,manifest,419);assert.equal(run.consumed.size,0);system.step(run,repo,manifest,420);assert.equal(run.consumed.size,1);
  await repo.update([4050,4050],18);await repo.update([0,0],18);assert.equal(repo.buildings.size,0);
});
test('stationary unchanged frames do not rebuild the spatial candidate list',async()=>{
  const {run,repo}=await fixture([building('too-far',50)]),system=new AbsorptionSystem();system.step(run,repo,manifest,0);
  for(let i=1;i<=600;i++)system.step(run,repo,manifest,i*16);
  assert.equal(system.stats.scans,1);run.position=[1,0];system.step(run,repo,manifest,10000);assert.equal(system.stats.scans,2);
});
test('repository emits stable-ID removal deltas and reuses the caller query array',async()=>{
  const {repo}=await fixture([building('w1'),building('w2',8)]);const initial=repo.takeRenderChanges();assert.equal(initial.add.length,2);assert.equal(repo.takeRenderChanges(),null);
  const result=[];assert.equal(repo.near([0,0],100,result),result);assert.equal(result.length,2);
  assert.equal(repo.reserve('w1'),true);assert.equal(repo.reserve('w1'),false);assert.deepEqual(repo.takeRenderChanges(),{remove:['w1']});
  repo.consume('w1');assert.equal(repo.takeRenderChanges(),null);assert.equal(repo.near([0,0],100,result).length,1);
});
test('spatial stamps still deduplicate large objects shared by many grid cells',()=>{const index=new SpatialIndex(10);index.insert({id:'many',bbox:[-100,-100,100,100]});const output=[];for(let i=0;i<100;i++){assert.equal(index.query([-200,-200,200,200],output),output);assert.equal(output.length,1);}index.remove('many');assert.equal(index.query([-200,-200,200,200],output).length,0);});
test('late streamed chunks from superseded navigation are discarded',async()=>{
  let resolveNear;const repo=new BuildingRepository(manifest,'https://example.invalid/',new Set(),()=>{},{loadChunk:c=>c.id==='near'?new Promise(r=>resolveNear=r):Promise.resolve({version:'v1',buildings:[]})});
  const old=repo.update([0,0],18);await repo.update([4050,4050],18);resolveNear({version:'v1',buildings:[building('w1')]});await old;
  assert.equal(repo.chunks.has('near'),false);assert.equal(repo.buildings.size,0);assert.equal(repo.index.size,0);
});
test('checkpoints clone history only on flush and coalesce all pending rewards',async()=>{
  const writes=[],timers=new Map();let next=0;const queue=new CheckpointQueue(async value=>writes.push(value),{setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id),requestIdle:null});const run=createRun(manifest);
  for(let i=0;i<12000;i++){run.consumed.add(`w${i}`);queue.request(run);}
  assert.equal(writes.length,0);assert.equal(timers.size,1);await queue.flush();assert.equal(writes.length,1);assert.equal(writes[0].consumed.length,12000);assert.equal(timers.size,0);
  run.position[0]=999;assert.equal(writes[0].position[0],0);
});
test('checkpoint writes are sequential and explicit flush waits for the newest run',async()=>{
  let release;const writes=[];let active=0,maxActive=0;const queue=new CheckpointQueue(async value=>{active++;maxActive=Math.max(maxActive,active);writes.push(value);if(writes.length===1)await new Promise(r=>release=r);active--;},{setTimer:()=>1,clearTimer:()=>{},requestIdle:null});
  const run=createRun(manifest);queue.request(run);const first=queue.flush();run.consumed.add('w1');const latest=queue.flush(run);release();await Promise.all([first,latest]);assert.equal(writes.length,2);assert.equal(writes[1].consumed.length,1);assert.equal(maxActive,1);
});
test('cached animation offsets reproduce direct Mercator projection while retaining polygon holes',()=>{
  const b=building('w1',123);b.polygons[0].push([[122,-1],[124,-1],[124,1],[122,1]]);
  for(const center of [[30,60],[0,0],[179.999,60]]){
    const cached=prepareAnimationGeometry(b,center),origin=mercatorPoint(localToLonLat(b.center,center));assert.equal(cached[0].length,2);
    for(let p=0;p<b.polygons.length;p++)for(let r=0;r<b.polygons[p].length;r++)for(let i=0;i<b.polygons[p][r].length;i++){
      const projected=mercatorPoint(localToLonLat(b.polygons[p][r][i],center));let dx=projected[0]-origin[0];if(dx>.5)dx--;if(dx<-.5)dx++;
      assert.ok(Math.abs(cached[p][r][2*i]-dx)<1e-12);assert.ok(Math.abs(cached[p][r][2*i+1]-(projected[1]-origin[1]))<1e-12);
    }
  }
});
test('serialized run position is an independent snapshot',()=>{const run=createRun(manifest),snapshot=serializeRun(run);run.position[0]=5;assert.equal(snapshot.position[0],0);});
test('all simultaneous explicit flush callers wait until the newest write settles',async()=>{
  const releases=[],writes=[];const queue=new CheckpointQueue(async value=>{writes.push(value);await new Promise(resolve=>releases.push(resolve));},{setTimer:()=>1,clearTimer:()=>{},requestIdle:null});
  const run=createRun(manifest);const first=queue.flush(run);run.consumed.add('w1');let secondDone=false,thirdDone=false;
  const second=queue.flush(run).then(()=>secondDone=true),third=queue.flush(run).then(()=>thirdDone=true);
  releases.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,2);assert.equal(secondDone,false);assert.equal(thirdDone,false);
  releases.shift()();await Promise.all([first,second,third]);assert.equal(secondDone,true);assert.equal(thirdDone,true);
});
test('lowering quality immediately bounds visual work without dropping pending rewards',async()=>{
  const {run,repo}=await fixture(Array.from({length:100},(_,i)=>building(`q${i}`))),system=new AbsorptionSystem();system.step(run,repo,manifest,0,'high');assert.equal(system.animations.length,16);
  system.step(run,repo,manifest,16,'low');assert.equal(system.animations.length,6);assert.equal(system.pendingCount,100);
  system.step(run,repo,manifest,420,'low');assert.equal(run.consumed.size,100);assert.equal(run.consumedArea,1600);
});
