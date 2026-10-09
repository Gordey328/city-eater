/** The tile mode is deliberately separate from exact whole-building saves. */
export const STREAM_MODE = 'tile-mask-v1';
export const STREAM_RADIUS_CAP = 500;
export const STREAM_CELL_METERS = 2;
const milestones = [10000, 50000, 100000, 500000, 1000000, 2500000, 5000000];
export function streamFrame(sector) {
  return {center:[...sector.center], projectionLatitude:sector.projectionLatitude??sector.center[1], arenaSize:10000, cellMeters:STREAM_CELL_METERS};
}
export function sameStreamFrame(a,b) {
  const valid=f=>f&&f.arenaSize===10000&&f.cellMeters===2&&Number.isFinite(f.projectionLatitude)&&Math.abs(f.projectionLatitude)<=84.9&&Array.isArray(f.center)&&f.center.length===2&&f.center.every(Number.isFinite)&&Math.abs(f.center[0])<=180&&Math.abs(f.center[1])<=84.9;
  return Boolean(valid(a)&&valid(b)&&Math.abs(a.projectionLatitude-b.projectionLatitude)<1e-9&&a.center.every((v,i)=>Math.abs(v-b.center[i])<1e-7));
}
export function streamTarget(area) {return milestones.find(value=>value>area)??(Math.floor(area/5000000)+1)*5000000;}
export function streamMilestones(area) {return milestones.filter(value=>area>=value).length+Math.max(0,Math.floor(area/5000000)-1);}
export function createStreamRun(sector,saved=null) {
  const frame=streamFrame(sector);
  if(!sameStreamFrame(frame,frame))throw new Error('Некорректные координаты района.');
  if(saved&&(saved.mode!==STREAM_MODE||saved.schemaVersion!==1||saved.sectorId!==sector.id||!sameStreamFrame(saved.frame,frame)||!Array.isArray(saved.position)||saved.position.length!==2||!saved.position.every(v=>Number.isFinite(v)&&Math.abs(v)<=5000)||!Number.isSafeInteger(saved.consumedArea)||saved.consumedArea<0||saved.consumedArea>100000000||saved.consumedArea%4!==0||!Number.isFinite(saved.elapsed)||saved.elapsed<0))throw new Error('Координаты или формат сохранённого района несовместимы. Прежнее прохождение сохранено.');
  const run={mode:STREAM_MODE,schemaVersion:1,levelId:sector.id,sectorId:sector.id,frame,position:[0,0],initialRadius:18,consumedArea:0,elapsed:0,score:0,mass:0,milestones:0,...saved};
  run.position=[...run.position];updateStreamGrowth(run);return run;
}
export function updateStreamGrowth(run) {
  run.mass=run.consumedArea;run.radius=Math.min(STREAM_RADIUS_CAP,Math.sqrt(18**2+0.06*run.mass));
  const limit=5000-run.radius;run.position=run.position.map(value=>Math.max(-limit,Math.min(limit,value)));
  run.score=Math.floor(run.consumedArea/10);run.milestones=streamMilestones(run.consumedArea);run.targetArea=streamTarget(run.consumedArea);run.radiusCapped=run.radius>=STREAM_RADIUS_CAP;
}
export function rewardStreamArea(run,area) {
  if(!Number.isFinite(area)||area<0||area%4!==0)throw new Error('Некорректная площадь маски.');
  const old=run.milestones;run.consumedArea+=area;updateStreamGrowth(run);return run.milestones>old;
}
export function serializeStreamRun(run){return {...run,position:[...run.position],frame:{...run.frame,center:[...run.frame.center]},updatedAt:Date.now()};}
