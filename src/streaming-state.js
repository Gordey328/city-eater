import {ARENA_SIZE_METRES, ARENA_HALF_METRES, ARENA_AREA_M2, DISTRICT_GOAL_AREA_M2, RADIUS_CAP_METRES, clampArenaPosition} from './game-config.js';
export {boundaryOverrun,clampArenaPosition} from './game-config.js';

/** A fresh namespace deliberately leaves the old 5 km and 10 km runs untouched. */
export const STREAM_MODE = 'tile-mask-land-3km-v4';
export const STREAM_SCHEMA_VERSION = 4;
export const STREAM_RADIUS_CAP = RADIUS_CAP_METRES;
export const STREAM_CELL_METERS = 2;
const milestones = [10000, 50000, 100000, 500000, 1000000, 2500000, 5000000];

export function streamFrame(sector) {
  return {center:[...sector.center], projectionLatitude:sector.projectionLatitude??sector.center[1], arenaSize:ARENA_SIZE_METRES, cellMeters:STREAM_CELL_METERS,boundaryId:sector.boundaryId??null,regionId:sector.regionId??null,scoreAreaM2:sector.scoreAreaM2??ARENA_AREA_M2};
}
export function sameStreamFrame(a,b) {
  const valid=f=>f&&f.arenaSize===ARENA_SIZE_METRES&&Number.isSafeInteger(f.scoreAreaM2??ARENA_AREA_M2)&&(f.scoreAreaM2??ARENA_AREA_M2)>=4&&(f.scoreAreaM2??ARENA_AREA_M2)<=ARENA_AREA_M2&&(f.scoreAreaM2??ARENA_AREA_M2)%4===0&&((f.boundaryId==null&&f.regionId==null)||(typeof f.boundaryId==='string'&&f.boundaryId.length>0&&typeof f.regionId==='string'&&f.regionId.length>0))&&f.cellMeters===STREAM_CELL_METERS&&Number.isFinite(f.projectionLatitude)&&Math.abs(f.projectionLatitude)<=84.9&&Array.isArray(f.center)&&f.center.length===2&&f.center.every(Number.isFinite)&&Math.abs(f.center[0])<=180&&Math.abs(f.center[1])<=84.9;
  return Boolean(valid(a)&&valid(b)&&(a.boundaryId??null)===(b.boundaryId??null)&&(a.regionId??null)===(b.regionId??null)&&(a.scoreAreaM2??ARENA_AREA_M2)===(b.scoreAreaM2??ARENA_AREA_M2)&&Math.abs(a.projectionLatitude-b.projectionLatitude)<1e-9&&a.center.every((v,i)=>Math.abs(v-b.center[i])<1e-7));
}
/** The district goal is eaten m², never a percentage of unknown building stock. */
export function streamProgress(area,goalArea=DISTRICT_GOAL_AREA_M2) {
  if(!Number.isSafeInteger(goalArea)||goalArea<4||goalArea%4!==0||goalArea>ARENA_AREA_M2)throw new RangeError('Invalid building-area goal');
  if (!Number.isFinite(area)) throw new RangeError('Expected finite consumed area');
  const consumedArea=Math.max(0,area);
  return {goalArea,consumedArea,progress:Math.min(100,consumedArea/goalArea*100),completed:consumedArea>=goalArea};
}
export function streamTarget() {return DISTRICT_GOAL_AREA_M2;}
export function landGoal(scoreAreaM2,choice='auto') {
  if(!Number.isSafeInteger(scoreAreaM2)||scoreAreaM2<4||scoreAreaM2%4)throw new RangeError('На этом участке нет доступных клеток суши.');
  const maximum=Math.min(DISTRICT_GOAL_AREA_M2,scoreAreaM2),automatic=[100000,10000,1000,100].find(v=>v<=scoreAreaM2*.05)??Math.min(100,maximum);
  const requested=choice==='auto'?automatic:Number(choice);
  if(![100,1000,10000,100000].includes(requested)&&choice!=='auto')throw new RangeError('Invalid goal option');
  return Math.max(4,Math.min(maximum,Math.floor(requested/4)*4));
}
export function streamMilestones(area) {return milestones.filter(value=>area>=value).length+Math.max(0,Math.floor(area/5000000)-1);}

export function createStreamRun(sector,saved=null) {
  const frame=streamFrame(sector);
  if(!sameStreamFrame(frame,frame))throw new Error('Некорректные координаты района.');
  const goal=sector.goalArea??DISTRICT_GOAL_AREA_M2;if(!Number.isSafeInteger(goal)||goal<4||goal%4||goal>frame.scoreAreaM2)throw new Error('Некорректная цель участка.');
  if(saved&&(saved.mode!==STREAM_MODE||saved.schemaVersion!==STREAM_SCHEMA_VERSION||saved.sectorId!==sector.id||saved.envelopeId!==(sector.envelopeId||sector.id)||(saved.boundaryId??null)!==frame.boundaryId||(saved.regionId??null)!==frame.regionId||!sameStreamFrame(saved.frame,frame)||!Array.isArray(saved.position)||saved.position.length!==2||!saved.position.every(v=>Number.isFinite(v)&&Math.abs(v)<=ARENA_HALF_METRES+RADIUS_CAP_METRES)||!Number.isSafeInteger(saved.consumedArea)||saved.consumedArea<0||saved.consumedArea>frame.scoreAreaM2||saved.consumedArea%4!==0||!Number.isSafeInteger(saved.goalArea)||saved.goalArea<4||saved.goalArea%4||saved.goalArea>frame.scoreAreaM2||!Array.isArray(saved.regionPoint)||saved.regionPoint.length!==2||!saved.regionPoint.every(v=>Number.isFinite(v)&&Math.abs(v)<=ARENA_HALF_METRES)||!Number.isFinite(saved.elapsed)||saved.elapsed<0))throw new Error('Координаты или формат сохранённого района несовместимы. Прежнее прохождение сохранено.');
  const run={regionPoint:sector.region?.representativePoint?[...sector.region.representativePoint]:[0,0],envelopeId:sector.envelopeId||sector.id,boundaryId:sector.boundaryId??null,regionId:sector.regionId??null,goalArea:sector.goalArea??DISTRICT_GOAL_AREA_M2,mode:STREAM_MODE,schemaVersion:STREAM_SCHEMA_VERSION,levelId:sector.id,sectorId:sector.id,frame,position:[0,0],initialRadius:18,consumedArea:0,elapsed:0,score:0,mass:0,milestones:0,...saved};
  run.position=[...run.position];run.regionPoint=[...run.regionPoint];run.frame={...frame,center:[...frame.center]};updateStreamGrowth(run);return run;
}
export function updateStreamGrowth(run) {
  run.mass=run.consumedArea;run.radius=Math.min(STREAM_RADIUS_CAP,Math.sqrt(18**2+0.06*run.mass));
  run.position=clampArenaPosition(run.position,run.radius);
  run.score=Math.floor(run.consumedArea/10);run.milestones=streamMilestones(run.consumedArea);run.targetArea=run.goalArea;run.radiusCapped=run.radius>=STREAM_RADIUS_CAP;
  Object.assign(run,streamProgress(run.consumedArea,run.goalArea));
}
export function rewardStreamArea(run,area) {
  if(!Number.isSafeInteger(area)||area<0||area%4!==0||!Number.isSafeInteger(run.consumedArea+area)||run.consumedArea+area>(run.frame?.scoreAreaM2??ARENA_AREA_M2))throw new Error('Некорректная площадь маски.');
  const wasCompleted=run.completed;run.consumedArea+=area;updateStreamGrowth(run);return !wasCompleted&&run.completed;
}
export function serializeStreamRun(run){return {...run,position:[...run.position],regionPoint:[...run.regionPoint],frame:{...run.frame,center:[...run.frame.center]},updatedAt:Date.now()};}
