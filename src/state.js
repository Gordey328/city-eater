export const BALANCE = Object.freeze({initialRadius:18, growth:0.06, tolerance:1.04, target:80});
export function createRun(manifest, saved = null) {
  const base = {levelId:manifest.id, version:manifest.version, position:[...(manifest.spawn || [0,0])], mass:0, score:0, consumedArea:0, elapsed:0, consumed:[], completed:false};
  const data = saved && saved.version === manifest.version ? {...base,...saved} : base;
  data.consumed = new Set(data.consumed);
  data.radius = Math.sqrt((manifest.initialRadius || BALANCE.initialRadius) ** 2 + BALANCE.growth * data.mass);
  return data;
}
export function consumeBuilding(run, building, manifest) {
  if (run.consumed.has(building.id)) return false;
  run.consumed.add(building.id);
  run.mass += building.mass_reward ?? building.area;
  run.score += building.score_reward ?? Math.max(1,Math.round(building.area/10));
  run.consumedArea += building.area;
  run.radius = Math.sqrt((manifest.initialRadius || BALANCE.initialRadius) ** 2 + BALANCE.growth * run.mass);
  run.completed = progressPercent(run,manifest) >= (manifest.targetPercent ?? manifest.target ?? BALANCE.target);
  return true;
}
export const progressPercent = (run,manifest) => manifest.totalBuildingArea ? Math.min(100,run.consumedArea / manifest.totalBuildingArea * 100) : 0;
export function serializeRun(run) { return {...run, consumed:[...run.consumed],updatedAt:new Date().toISOString()}; }
export function compatibleSave(saved, manifest) { return !saved || saved.version === manifest.version; }
export function mergeRecord(record,run,manifest) {
  const candidate={levelId:manifest.id,score:run.score,elapsed:run.elapsed,percent:progressPercent(run,manifest),count:run.consumed.size,radius:run.radius,completedAt:new Date().toISOString()};
  if (!record || candidate.elapsed < record.elapsed) return candidate;
  return {...record,score:Math.max(record.score,candidate.score)};
}
