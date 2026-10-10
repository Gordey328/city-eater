import {prepareGameLand,defaultBoundaryFactory} from './land-session.js';
import {createConsumptionMask} from './consumption-mask.js';
import {TileStream} from './tile-stream.js';
import {WholeBuildingStream} from './whole-building-stream.js';
import {createStreamRun,rewardStreamArea,serializeStreamRun} from './streaming-state.js';
import {MaskDisplay} from './mask-display.js';
import {clampArenaPosition,ARENA_HALF_METRES as HALF} from './game-config.js';
import {polygonFitsCircle,SpatialIndex} from './geometry.js';

export class StreamingGame {
  constructor({sector,store,mode='parts',goalChoice='auto',onBoundary=()=>{},landPreparation=prepareGameLand,boundaryFactory=defaultBoundaryFactory,onStatus=()=>{},onMilestone=()=>{},source,streamFactory=options=>new TileStream(options),wholeFactory=options=>new WholeBuildingStream(options),displayFactory=mask=>new MaskDisplay(mask)}){
    Object.assign(this,{sector,store,onStatus,onMilestone,wholeFactory,goalChoice,onBoundary,landPreparation,boundaryFactory});this.mode=mode==='whole'?'whole':'parts';this.mask=createConsumptionMask();this.display=displayFactory(this.mask);this.entryController=new AbortController();this.disposed=false;this.suspended=false;this.lastStream=-Infinity;this.lastSave=0;this.lastScan=null;this.job=null;this.saving=null;this.lastError=null;this.saveStatus='idle';this.savedAt=null;this.run=null;this.consumeGeneration=0;this.whole=null;this.wholeLoading=null;this.wholePending=null;this.wholeResult=null;this.wholeProcessed=new Set();this.outlineCache=new Map();this.outlinePending=null;
    this.stream=streamFactory({manifest:sector,mask:this.mask,source,onChange:key=>this.display.changed(key),onStatus});
  }
  async prepare(entryPoint=null,{restart=false}={}){
    if(this.landPreparation)await this.landPreparation(this,entryPoint);this.check();
    if(restart)await this.store.reset(this.sector.id);this.check();const saved=await this.store.load(this.sector.id);this.check();this.run=createStreamRun(this.sector,saved.run);this.run.consumptionMode=this.mode;this.run.title=this.sector.title;this.mask.restoreConsumed(saved.masks.map(item=>[item.key,item.bits]));if(this.run.consumedArea!==this.mask.consumedAreaM2)throw new Error('Сохранение района неполное.');if(!saved.run&&entryPoint)this.run.position=clampArenaPosition(entryPoint,this.run.radius);
    if(this.land){if(saved.run&&!(this.land.isReachable?.(this.run.position,this.run.radius)??this.land.contains(this.run.position,this.run.radius)))throw new Error('Сохранённая позиция находится вне активной суши.');if(!saved.run)this.run.position=this.land.nearestPoint(entryPoint||this.region.representativePoint,this.run.radius);}
    this.onStatus('Подготавливаем ближайшие здания…',{phase:'nearby'});await this.stream.prepare(this.run.position,this.run.radius);this.check();if(this.mode==='whole')await this.prepareWhole();this.check();return this.run;
  }
  check(){if(this.disposed)throw new DOMException('Загрузка отменена','AbortError');}
  setMode(mode){const next=mode==='whole'?'whole':'parts';if(next===this.mode)return;this.mode=next;if(this.run)this.run.consumptionMode=next;this.invalidateConsumption();this.whole?.dispose();this.whole=null;this.wholeLoading=null;this.wholeProcessed.clear();this.outlineCache.clear();}
  invalidateConsumption(){this.consumeGeneration++;this.job=null;this.lastScan=null;this.wholePending=null;this.wholeResult=null;}
  suspend(){this.suspended=true;this.invalidateConsumption();}
  resume(){this.suspended=false;this.lastScan=null;}
  async prepareWhole(){
    if(this.wholeLoading)return this.wholeLoading;this.check();this.whole??=this.wholeFactory({manifest:this.sector,source:this.stream.source,onStatus:this.onStatus});const whole=this.whole;
    const promise=whole.update(this.run.position,this.run.radius);this.wholeLoading=promise;
    try{await promise;this.check();}finally{if(this.wholeLoading===promise)this.wholeLoading=null;}
  }
  wholeFits(building){const p=this.run.position,r=this.run.radius,b=building.bounds;if(building.complete===false)return false;if(b&&(b[0]<p[0]-r||b[2]>p[0]+r||b[1]<p[1]-r||b[3]>p[1]+r))return false;return polygonFitsCircle(building.polygons,p,r,1);}
  consumeWhole(){
    let area=0;const whole=this.whole;if(!whole?.ready)return area;
    if(this.wholeCatalog!==whole.buildings){this.wholeCatalog=whole.buildings;this.wholeProcessed.clear();this.wholeIndex=new SpatialIndex(128);for(const b of whole.buildings){const box=b.bounds;if(box&&box[2]-box[0]<=1000&&box[3]-box[1]<=1000)this.wholeIndex.insert(b,box);}this.wholeCandidates=[];this.outlineCache.clear();this.boundaryBuildings=whole.buildings.filter(b=>b.bounds&&(b.bounds[0]<-HALF||b.bounds[1]<-HALF||b.bounds[2]>HALF||b.bounds[3]>HALF)&&b.bounds[2]>=-HALF&&b.bounds[0]<=HALF&&b.bounds[3]>=-HALF&&b.bounds[1]<=HALF&&b.bounds[2]-b.bounds[0]<=1000&&b.bounds[3]-b.bounds[1]<=1000);}
    const ready=this.wholeResult;this.wholeResult=null;
    if(ready&&ready.generation===this.consumeGeneration&&ready.whole===whole&&ready.buildings.every(b=>whole.buildings.includes(b)&&this.wholeFits(b))){
      const result=this.mask.consumeBuildingChunks(ready.chunks);if(result.complete){for(const b of ready.buildings){this.wholeProcessed.add(b.id);this.wholeIndex.remove(b.id);}for(const key of result.changedChunks)this.display.changed(key);area=result.areaM2;}
    }
    if(!this.wholePending){const p=this.run.position,r=this.run.radius,candidates=[];for(const b of this.wholeIndex.query([p[0]-r,p[1]-r,p[0]+r,p[1]+r],this.wholeCandidates)){if(this.wholeFits(b))candidates.push(b);if(candidates.length===4)break;}if(candidates.length){const generation=this.consumeGeneration,promise=whole.rasterize(candidates);this.wholePending=promise;promise.then(chunks=>{if(!this.disposed&&!this.suspended&&this.mode==='whole'&&generation===this.consumeGeneration&&whole===this.whole)this.wholeResult={generation,whole,buildings:candidates,chunks};}).catch(error=>{if(error.name!=='AbortError'&&!this.disposed&&generation===this.consumeGeneration){this.lastError=error;this.onStatus(error.message,{phase:'error'});}}).finally(()=>{if(this.wholePending===promise)this.wholePending=null;});}}
    this.prepareOutline();return area;
  }
  prepareOutline(){
    if(this.outlinePending||!this.whole?.ready)return;const p=this.run.position,range=this.run.radius*2+150,near=(this.boundaryBuildings||[]).filter(b=>b.bounds[0]<=p[0]+range&&b.bounds[2]>=p[0]-range&&b.bounds[1]<=p[1]+range&&b.bounds[3]>=p[1]-range).slice(0,4),wanted=new Set(near.map(b=>b.id));for(const key of this.outlineCache.keys())if(!wanted.has(key))this.outlineCache.delete(key);const building=near.find(b=>!this.outlineCache.has(b.id));if(!building)return;const whole=this.whole,generation=this.consumeGeneration,promise=whole.rasterize([building]);this.outlinePending=promise;promise.then(chunks=>{if(!this.disposed&&this.mode==='whole'&&generation===this.consumeGeneration&&whole===this.whole&&whole.buildings.includes(building))this.outlineCache.set(building.id,{building,chunks:this.mask.clipFootprintChunks(chunks),revision:-1});}).catch(error=>{if(error.name!=='AbortError')this.report(error);}).finally(()=>{if(this.outlinePending===promise)this.outlinePending=null;});
  }
  boundaryOutlines(){if(this.mode!=='whole')return[];const out=[];for(const entry of this.outlineCache.values()){if(entry.revision!==this.mask.consumedRevision){entry.remaining=entry.chunks.some(([key,bits])=>{const eaten=this.mask.getConsumedChunk(key);for(let i=0;i<bits.length;i++)if(bits[i]&~(eaten?.[i]||0))return true;return false;});entry.revision=this.mask.consumedRevision;}if(entry.remaining)out.push({...entry.building,fits:this.wholeFits(entry.building)});}return out;
  }
  tick(dt,now,direction){
    const run=this.run;if(!run||this.disposed||this.suspended)return{blocked:true,area:0};run.elapsed+=dt;const speed=95+Math.min(155,run.radius*.4),old=[...run.position],delta=direction.map(v=>v*speed*dt),motion=this.land?this.land.resolveMotion(old,delta,run.radius):{position:clampArenaPosition(old.map((v,i)=>v+delta[i]),run.radius),path:null},next=motion.position,covered=this.stream.covers(next,Math.min(500,run.radius+2));if(covered&&!this.job)run.position=next;
    let area=0;
    if(this.mode==='parts'){
      if(!this.job&&(old[0]!==run.position[0]||old[1]!==run.position[1]||this.lastScan?.radius!==run.radius||this.lastScan?.revision!==this.mask.coverageRevision))this.job={from:old,to:[...run.position],radius:run.radius,cursor:null,segments:(covered&&motion.path?.length?(motion.path.length>1?motion.path:[motion.path[0],motion.path[0]]):[old,[...run.position]]).slice(1).map((p,i)=>[(covered&&motion.path?.length?(motion.path.length>1?motion.path:[motion.path[0],motion.path[0]]):[old,[...run.position]])[i],p])};
      if(this.job){const job=this.job,segment=job.segments?.[0]||[job.from,job.to],result=this.mask.consumeSweep(segment[0],segment[1],job.radius,{maxRows:640,maxMilliseconds:3,cursor:job.cursor});area=result.areaM2;for(const key of result.changedChunks)this.display.changed(key);if(result.complete){job.segments?.shift();job.cursor=null;if(!job.segments?.length){this.lastScan={radius:job.radius,revision:this.mask.coverageRevision};this.job=null;}}else job.cursor=result.cursor;}
    }else area=this.consumeWhole();
    if(area){const before=run.completed;rewardStreamArea(run,area);if(!before&&run.completed)this.onMilestone(run);}
    if(now-this.lastStream>250){this.lastStream=now;Promise.resolve(this.stream.update(run.position,run.radius,direction)).catch(error=>this.report(error));if(this.mode==='whole')this.prepareWhole().catch(error=>this.report(error));}
    if(now-this.lastSave>2000){this.lastSave=now;this.persist().catch(error=>{if(!this.disposed)this.onStatus(error.message,{phase:'save-error'});});}
    return{blocked:!covered,area,pending:Boolean(this.job||this.wholePending),preparing:this.mode==='whole'&&!this.whole?.ready};
  }
  report(error){if(error.name!=='AbortError'&&!this.disposed){this.lastError=error;this.onStatus(error.message,{phase:'error'});}}
  async persist(){if(!this.run)return;if(this.saving){await this.saving;return this.persist();}const chunks=this.mask.takeDirtyChunks(),snapshot=serializeStreamRun(this.run);this.saveStatus='saving';this.saving=this.store.save(snapshot,chunks);try{await this.saving;this.saveStatus='saved';this.savedAt=Date.now();}catch(error){this.saveStatus='error';this.mask.markChunksDirty(chunks.keys());throw error;}finally{this.saving=null;}}
  async retry(){this.lastError=null;await this.stream.retry(this.run.position,this.run.radius);if(this.mode==='whole'){this.whole?.dispose();this.whole=null;this.wholeLoading=null;await this.prepareWhole();}}
  dispose(){this.disposed=true;this.entryController.abort();this.invalidateConsumption();this.boundaryLoader?.dispose();this.whole?.dispose();this.stream.dispose();this.display.dispose();}
}
