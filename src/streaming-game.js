import {createConsumptionMask} from './consumption-mask.js';
import {TileStream} from './tile-stream.js';
import {createStreamRun,rewardStreamArea,serializeStreamRun} from './streaming-state.js';
import {MaskDisplay} from './mask-display.js';
import {advanceHole} from './motion.js';

export class StreamingGame {
  constructor({sector,store,onStatus=()=>{},onMilestone=()=>{},source,streamFactory=options=>new TileStream(options),displayFactory=mask=>new MaskDisplay(mask)}){
    this.sector=sector;this.store=store;this.onStatus=onStatus;this.onMilestone=onMilestone;this.mask=createConsumptionMask();this.display=displayFactory(this.mask);this.disposed=false;this.lastStream=-Infinity;this.lastSave=0;this.lastScan=null;this.job=null;this.saving=null;this.lastError=null;
    this.saveStatus='idle';this.savedAt=null;this.run=null;this.stream=streamFactory({manifest:sector,mask:this.mask,source,onChange:key=>this.display.changed(key),onStatus});
  }
  async prepare(entryPoint=null,{restart=false}={}){
    if(restart)await this.store.reset(this.sector.id);this.check();
    const saved=await this.store.load(this.sector.id);this.check();
    this.run=createStreamRun(this.sector,saved.run);this.mask.restoreConsumed(saved.masks.map(item=>[item.key,item.bits]));
    if(this.run.consumedArea!==this.mask.consumedAreaM2)throw new Error('Сохранение района неполное. Данные оставлены без изменений.');
    if(!saved.run&&entryPoint)this.run.position=advanceHole(entryPoint,[0,0],this.run.radius);
    this.onStatus('Подготавливаем только ближайшие здания…',{phase:'nearby'});
    await this.stream.prepare(this.run.position,this.run.radius);this.check();
    return this.run;
  }
  check(){if(this.disposed)throw new DOMException('Загрузка отменена','AbortError');}
  tick(dt,now,direction){
    const run=this.run;if(!run||this.disposed)return {blocked:true};
    run.elapsed+=dt;const speed=95+Math.min(155,run.radius*.4),delta=direction.map(value=>value*speed*dt);
    const next=advanceHole(run.position,delta,run.radius),covered=this.stream.covers(next,Math.min(500,run.radius+2));
    const old=[...run.position];if(covered&&!this.job)run.position=next;
    if(!this.job&&(old[0]!==run.position[0]||old[1]!==run.position[1]||this.lastScan?.radius!==run.radius||this.lastScan?.revision!==this.mask.coverageRevision))this.job={from:old,to:[...run.position],radius:run.radius,cursor:null};
    let area=0;
    if(this.job){const job=this.job,result=this.mask.consumeSweep(job.from,job.to,job.radius,{maxRows:640,maxMilliseconds:3,cursor:job.cursor});area=result.areaM2;for(const key of result.changedChunks)this.display.changed(key);if(area&&rewardStreamArea(run,area))this.onMilestone(run);if(result.complete){this.lastScan={radius:job.radius,revision:this.mask.coverageRevision};this.job=null;}else job.cursor=result.cursor;}
    if(now-this.lastStream>250){this.lastStream=now;Promise.resolve(this.stream.update(run.position,run.radius,direction)).catch(error=>{if(!this.disposed){this.lastError=error;this.onStatus(error.message,{phase:'error'});}});}
    if(now-this.lastSave>2000){this.lastSave=now;this.persist().catch(error=>{if(!this.disposed)this.onStatus(error.message,{phase:'save-error'});});}
    return {blocked:!covered,area,pending:Boolean(this.job)};
  }
  async persist(){
    if(!this.run)return;if(this.saving){await this.saving;return this.persist();}
    const chunks=this.mask.takeDirtyChunks(),snapshot=serializeStreamRun(this.run);
    this.saveStatus='saving';this.saving=this.store.save(snapshot,chunks);
    try{await this.saving;this.saveStatus='saved';this.savedAt=Date.now();}catch(error){this.saveStatus='error';this.mask.markChunksDirty(chunks.keys());throw error;}finally{this.saving=null;}
  }
  async retry(){this.lastError=null;await this.stream.retry(this.run.position,this.run.radius);}
  dispose(){this.disposed=true;this.stream.dispose();this.display.dispose();}
}
