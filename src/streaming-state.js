import {ARENA_SIZE_METRES, ARENA_HALF_METRES, ARENA_AREA_M2, DISTRICT_GOAL_AREA_M2, RADIUS_CAP_METRES, clampArenaPosition} from './game-config.js';
export {boundaryOverrun,clampArenaPosition} from './game-config.js';

/** A fresh namespace deliberately leaves the old 5 km and 10 km runs untouched. */
export const STREAM_MODE = 'tile-mask-3km-v3';
export const STREAM_SCHEMA_VERSION = 3;
export const STREAM_RADIUS_CAP = RADIUS_CAP_METRES;
export const STREAM_CELL_METERS = 2;
const milestones = [10000, 50000, 100000, 500000, 1000000, 2500000, 5000000];

export function streamFrame(sector) {
  return {center:[...sector.center], projectionLatitude:sector.projectionLatitude??sector.center[1], arenaSize:ARENA_SIZE_METRES, cellMeters:STREAM_CELL_METERS};
}
export function sameStreamFrame(a,b) {
  const valid=f=>f&&f.arenaSize===ARENA_SIZE_METRES&&f.cellMeters===STREAM_CELL_METERS&&Number.isFinite(f.projectionLatitude)&&Math.abs(f.projectionLatitude)<=84.9&&Array.isArray(f.center)&&f.center.length===2&&f.center.every(Number.isFinite)&&Math.abs(f.center[0])<=180&&Math.abs(f.center[1])<=84.9;
  return Boolean(valid(a)&&valid(b)&&Math.abs(a.projectionLatitude-b.projectionLatitude)<1e-9&&a.center.every((v,i)=>Math.abs(v-b.center[i])<1e-7));
}
/** The district goal is eaten m², never a percentage of unknown building stock. */
export function streamProgress(area) {
  if (!Number.isFinite(area)) throw new RangeError('Expected finite consumed area');
  const consumedArea=Math.max(0,area);
  return {goalArea:DISTRICT_GOAL_AREA_M2,consumedArea,progress:Math.min(100,consumedArea/DISTRICT_GOAL_AREA_M2*100),completed:consumedArea>=DISTRICT_GOAL_AREA_M2};
}
export function streamTarget() {return DISTRICT_GOAL_AREA_M2;}
export function streamMilestones(area) {return milestones.filter(value=>area>=value).length+Math.max(0,Math.floor(area/5000000)-1);}

export function createStreamRun(sector,saved=null) {
  const frame=streamFrame(sector);
  if(!sameStreamFrame(frame,frame))throw new Error('Некорректные координаты района.');
  if(saved&&(saved.mode!==STREAM_MODE||saved.schemaVersion!==STREAM_SCHEMA_VERSION||saved.sectorId!==sector.id||!sameStreamFrame(saved.frame,frame)||!Array.isArray(saved.position)||saved.position.length!==2||!saved.position.every(v=>Number.isFinite(v)&&Math.abs(v)<=ARENA_HALF_METRES+RADIUS_CAP_METRES)||!Number.isSafeInteger(saved.consumedArea)||saved.consumedArea<0||saved.consumedArea>ARENA_AREA_M2||saved.consumedArea%4!==0||!Number.isFinite(saved.elapsed)||saved.elapsed<0))throw new Error('Координаты или формат сохранённого района несовместимы. Прежнее прохождение сохранено.');
  const run={mode:STREAM_MODE,schemaVersion:STREAM_SCHEMA_VERSION,levelId:sector.id,sectorId:sector.id,frame,position:[0,0],initialRadius:18,consumedArea:0,elapsed:0,score:0,mass:0,milestones:0,...saved};
  run.position=[...run.position];run.frame={...frame,center:[...frame.center]};updateStreamGrowth(run);return run;
}
export function updateStreamGrowth(run) {
  run.mass=run.consumedArea;run.radius=Math.min(STREAM_RADIUS_CAP,Math.sqrt(18**2+0.06*run.mass));
  run.position=clampArenaPosition(run.position,run.radius);
  run.score=Math.floor(run.consumedArea/10);run.milestones=streamMilestones(run.consumedArea);run.targetArea=streamTarget();run.radiusCapped=run.radius>=STREAM_RADIUS_CAP;
  Object.assign(run,streamProgress(run.consumedArea));
}
export function rewardStreamArea(run,area) {
  if(!Number.isSafeInteger(area)||area<0||area%4!==0||!Number.isSafeInteger(run.consumedArea+area)||run.consumedArea+area>ARENA_AREA_M2)throw new Error('Некорректная площадь маски.');
  const wasCompleted=run.completed;run.consumedArea+=area;updateStreamGrowth(run);return !wasCompleted&&run.completed;
}
export function serializeStreamRun(run){return {...run,position:[...run.position],frame:{...run.frame,center:[...run.frame.center]},updatedAt:Date.now()};}
