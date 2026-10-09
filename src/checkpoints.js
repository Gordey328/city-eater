import {serializeRun} from './state.js';

/** Coalesce frequent rewards before cloning the growing consumed-ID history. */
export class CheckpointQueue {
  constructor(save,{delay=2000,setTimer=setTimeout,clearTimer=clearTimeout,
    requestIdle=globalThis.requestIdleCallback?.bind(globalThis),cancelIdle=globalThis.cancelIdleCallback?.bind(globalThis)}={}){
    this.save=save;this.delay=delay;this.setTimer=setTimer;this.clearTimer=clearTimer;this.requestIdle=requestIdle;this.cancelIdle=cancelIdle;
    this.pending=new Map();this.timer=null;this.idle=null;this.inFlight=null;this.writes=0;
  }
  request(run){if(!run)return;this.pending.set(run.levelId,run);this.schedule();}
  schedule(){if(this.timer!==null||this.idle!==null||this.inFlight||!this.pending.size)return;
    this.timer=this.setTimer(()=>{this.timer=null;if(this.requestIdle)this.idle=this.requestIdle(()=>{this.idle=null;this.flush().catch(()=>{});},{timeout:500});else this.flush().catch(()=>{});},this.delay);
  }
  async flush(run=null){
    if(run)this.pending.set(run.levelId,run);
    if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}
    if(this.idle!==null){this.cancelIdle?.(this.idle);this.idle=null;}
    if(this.inFlight){await this.inFlight;return this.flush();}
    if(!this.pending.size)return;
    const batch=[...this.pending.values()];this.pending.clear();
    this.inFlight=(async()=>{for(const value of batch){const snapshot=serializeRun(value);await this.save(snapshot);this.writes++;}})();
    try{await this.inFlight;}finally{this.inFlight=null;this.schedule();}
  }
}
