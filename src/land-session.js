import {WaterBoundaryLoader} from './water-boundary-loader.js';
import {createLandRegion} from './land-region.js';
import {pointInPolygons} from './geometry.js';
import {landGoal} from './streaming-state.js';

/** Boundary preparation precedes building streaming; a saved coastline never
 * depends on today's provider revision. Every async boundary is owner-checked. */
export async function prepareGameLand(game,entryPoint){
  const original=game.sector,envelopeId=original.envelopeId||original.id,manifest={...original,id:envelopeId};
  let boundary=await game.store.getBoundary(envelopeId,{signal:game.entryController?.signal});game.check();
  game.boundaryCached=Boolean(boundary);game.boundaryLoader=game.boundaryFactory({manifest,source:game.stream.source,onStatus:game.onStatus});
  if(!boundary){game.onStatus('Уточняем берег и участки суши…',{phase:'water-boundary'});boundary=await game.boundaryLoader.prepare();game.check();boundary={...boundary,envelopeId};await game.store.saveBoundary(boundary,manifest,{signal:game.entryController?.signal});game.check();}
  if(boundary.envelopeId!==envelopeId||JSON.stringify(boundary.center)!==JSON.stringify(manifest.center)||boundary.projectionLatitude!==(manifest.projectionLatitude??manifest.center[1]))throw new Error('Сохранённый берег не соответствует выбранной ячейке.');
  game.boundary=boundary;game.onBoundary(boundary);game.check();
  const selected=original.regionId?boundary.regions.find(r=>r.id===original.regionId):boundary.regions.find(r=>pointInPolygons(entryPoint||[0,0],r.polygons));
  if(!selected){const error=new Error(boundary.regions.length?'Здесь вода. Выбери выделенный участок суши.':'В этой ячейке нет подтверждённой суши. Выбери другой район.');error.code='WATER_SELECTION';error.boundary=boundary;throw error;}
  game.onStatus('Готовим выбранный участок суши…',{phase:'land-mask',regionId:selected.id});
  const scored=await game.boundaryLoader.rasterizeRegion(boundary,selected.id);game.check();
  if(!scored.scoreAreaM2){const error=new Error('Этот участок меньше игровой сетки 2 м. Выбери другой участок.');error.code='EMPTY_LAND';throw error;}
  game.land=createLandRegion({polygons:selected.polygons,waterPolygons:boundary.waterPolygons,domainBounds:boundary.domainBounds,preparedGeometry:scored.preparedGeometry});
  game.mask.setActiveRegion(scored.chunks);game.region=selected;
  game.sector={...manifest,id:`${envelopeId}/${selected.id}`,envelopeId,boundaryId:boundary.id,regionId:selected.id,region:selected,boundary,scoreAreaM2:scored.scoreAreaM2,goalArea:landGoal(scored.scoreAreaM2,game.goalChoice),envelopeTitle:original.envelopeTitle||original.title||'Район',title:`${original.envelopeTitle||original.title||'Район'} · суша ${boundary.regions.indexOf(selected)+1}`};
  game.stream.manifest=game.sector;return selected;
}
export const defaultBoundaryFactory=options=>new WaterBoundaryLoader(options);
