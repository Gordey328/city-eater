import test from 'node:test';
import assert from 'node:assert/strict';
import {createStreamRun,rewardStreamArea,STREAM_RADIUS_CAP,STREAM_MODE,STREAM_SCHEMA_VERSION,streamTarget,streamProgress,sameStreamFrame,serializeStreamRun,boundaryOverrun,clampArenaPosition} from '../src/streaming-state.js';
import {ARENA_SIZE_METRES,ARENA_HALF_METRES,DISTRICT_GOAL_AREA_M2} from '../src/game-config.js';
const sector={id:'square',center:[30,60]};

test('district progress has a fixed, clamped area goal with no unknown-building denominator',()=>{
  const run=createStreamRun(sector);
  assert.equal(run.targetArea,100000);assert.equal(run.goalArea,DISTRICT_GOAL_AREA_M2);assert.equal(run.progress,0);assert.equal(run.completed,false);
  assert.equal(rewardStreamArea(run,10000),false);assert.equal(run.targetArea,100000);assert.equal(run.milestones,1);assert.equal(run.progress,10);
  assert.equal(streamTarget(5000000),100000);assert.equal('totalBuildingArea' in run,false);
  assert.deepEqual(streamProgress(-100),{goalArea:100000,consumedArea:0,progress:0,completed:false});
  assert.deepEqual(streamProgress(99996),{goalArea:100000,consumedArea:99996,progress:99.996,completed:false});
  assert.deepEqual(streamProgress(100000),{goalArea:100000,consumedArea:100000,progress:100,completed:true});
  assert.deepEqual(streamProgress(100004),{goalArea:100000,consumedArea:100004,progress:100,completed:true});
  for(const value of [NaN,Infinity,-Infinity,'100'])assert.throws(()=>streamProgress(value));
});
test('completing the goal does not stop rewards, scoring, play or growth',()=>{
  const run=createStreamRun(sector);rewardStreamArea(run,100000);const radius=run.radius;
  assert.equal(run.completed,true);assert.equal(run.progress,100);assert.ok(radius<STREAM_RADIUS_CAP);
  rewardStreamArea(run,100000);assert.ok(run.radius>radius);assert.equal(run.consumedArea,200000);assert.equal(run.score,20000);assert.equal(run.progress,100);
});
test('radius cap is explicit and never caps earned area or score',()=>{
  const run=createStreamRun(sector);rewardStreamArea(run,8000000);
  assert.equal(run.radius,STREAM_RADIUS_CAP);assert.equal(run.consumedArea,8000000);assert.equal(run.score,800000);assert.equal(run.radiusCapped,true);
});
test('new stream identity and 3km frame reject old geometry/schema without mutating save',()=>{
  const saved=createStreamRun(sector);assert.equal(saved.frame.arenaSize,ARENA_SIZE_METRES);assert.equal(ARENA_SIZE_METRES,3000);assert.equal(ARENA_HALF_METRES,1500);
  assert.equal(STREAM_MODE,'tile-mask-land-3km-v4');assert.equal(STREAM_SCHEMA_VERSION,4);
  assert.throws(()=>createStreamRun({...sector,center:[31,60]},saved),/несовместимы/);assert.equal(saved.frame.center[0],30);
  assert.equal(createStreamRun(sector,saved).mode,STREAM_MODE);assert.equal(saved.schemaVersion,STREAM_SCHEMA_VERSION);
  for(const patch of [{mode:'tile-mask-v1'},{mode:'tile-mask-5km-v2'},{schemaVersion:1},{schemaVersion:2},{frame:{...saved.frame,arenaSize:10000}},{frame:{...saved.frame,arenaSize:5000}},{position:[2000.001,0]},{consumedArea:9000004}])
    assert.throws(()=>createStreamRun(sector,{...saved,...patch}),/несовместимы/);
  assert.equal(sameStreamFrame(saved.frame,{...saved.frame,arenaSize:10000}),false);
});
test('area rewards must use whole 2m cells and cannot exceed the complete active square',()=>{
  const run=createStreamRun(sector);
  for(const area of [-4,3,NaN,Infinity,9000004,Number.MAX_SAFE_INTEGER])assert.throws(()=>rewardStreamArea(run,area));
  assert.equal(run.consumedArea,0);rewardStreamArea(run,9000000);assert.equal(run.consumedArea,9000000);
  assert.throws(()=>rewardStreamArea(run,4));assert.equal(run.consumedArea,9000000);
});
test('radius-sized boundary halo lets the hole reach edge/corner buildings',()=>{
  assert.equal(boundaryOverrun(-1),0);assert.equal(boundaryOverrun(0),0);assert.equal(boundaryOverrun(18),18);assert.equal(boundaryOverrun(1000),500);
  assert.throws(()=>boundaryOverrun(NaN));assert.throws(()=>clampArenaPosition([Infinity,0],18));
  assert.deepEqual(clampArenaPosition([9999,-9999],18),[1518,-1518]);assert.deepEqual(clampArenaPosition([9999,-9999],500),[2000,-2000]);
  const saved=createStreamRun(sector);saved.position=[2000,-2000];
  assert.deepEqual(createStreamRun(sector,saved).position,[1518,-1518]);
  saved.consumedArea=5000000;assert.deepEqual(createStreamRun(sector,saved).position,[2000,-2000]);
  const run=createStreamRun(sector);run.position=[9999,-9999];rewardStreamArea(run,5000000);assert.deepEqual(run.position,[2000,-2000]);
});
test('restored and serialized runs detach frame and position and recompute goal truth',()=>{
  const saved=createStreamRun(sector);saved.consumedArea=100000;saved.completed=false;saved.progress=-10;saved.goalArea=100000;
  const run=createStreamRun(sector,saved);assert.equal(run.completed,true);assert.equal(run.progress,100);assert.equal(run.goalArea,100000);
  run.position[0]=20;run.frame.center[0]=31;assert.equal(saved.position[0],0);assert.equal(saved.frame.center[0],30);
  const snapshot=serializeStreamRun(run);snapshot.position[0]=99;snapshot.frame.center[0]=32;
  assert.equal(run.position[0],20);assert.equal(run.frame.center[0],31);
});

 test("fixed-goal notification fires once at100k, never intermediate milestones",()=>{const run=createStreamRun(sector);assert.equal(rewardStreamArea(run,10000),false);assert.equal(rewardStreamArea(run,40000),false);assert.equal(rewardStreamArea(run,49996),false);assert.equal(rewardStreamArea(run,4),true);assert.equal(rewardStreamArea(run,4),false);});
