import {polygonFitsCircle} from './geometry.js';
import {consumeBuilding} from './state.js';

export const ABSORPTION_DURATION = 420;
export const MAX_PENDING_ABSORPTIONS = 128;
export const animationLimits = quality => quality === 'low'
  ? {count:6,vertices:400} : {count:16,vertices:1400};
const vertexCount = building => building.polygons.reduce((n,p)=>n+p.reduce((s,r)=>s+r.length,0),0);

/** Rewards and pending geometry are independent of the bounded cosmetic effects. */
export class AbsorptionSystem {
  constructor(){this.pending=[];this.animations=[];this.candidates=[];this.lastScan=-Infinity;this.lastRadius=0;this.lastPosition=[NaN,NaN];this.lastRevision=-1;this.stats={scans:0,fitTests:0,started:0,completed:0};}
  get pendingCount(){return this.pending.length;}
  reset(){this.pending.length=0;this.animations.length=0;this.candidates.length=0;this.lastScan=-Infinity;this.lastRadius=0;this.lastPosition=[NaN,NaN];this.lastRevision=-1;}
  step(run,repo,manifest,now,quality='high'){
    let changed=false,started=0,write=0;
    // In-place compaction: no per-frame Set/filter allocation or retained history.
    for(const animation of this.pending){
      if(now-animation.started<animation.duration){this.pending[write++]=animation;continue;}
      if(consumeBuilding(run,animation.building,manifest)){changed=true;this.stats.completed++;}
      repo.consume(animation.building.id);
    }
    this.pending.length=write;
    const limits=animationLimits(quality);
    write=0;let vertices=0;
    for(const animation of this.animations)if(now-animation.started<animation.duration&&write<limits.count&&vertices+animation.vertices<=limits.vertices){this.animations[write++]=animation;vertices+=animation.vertices;}
    this.animations.length=write;
    if(!run.completed&&this.pending.length<MAX_PENDING_ABSORPTIONS&&
      (changed||run.position[0]!==this.lastPosition[0]||run.position[1]!==this.lastPosition[1]||run.radius!==this.lastRadius||repo.revision!==this.lastRevision)){
      this.lastScan=now;this.lastRadius=run.radius;this.stats.scans++;
      repo.near(run.position,run.radius*1.06,this.candidates);
      for(const building of this.candidates){
        if(this.pending.length>=MAX_PENDING_ABSORPTIONS)break;
        if(building.radius>run.radius*1.06)continue;
        this.stats.fitTests++;
        if(!polygonFitsCircle(building.polygons,run.position,run.radius,1.06)||!repo.reserve(building.id))continue;
        const animation={building,started:now,duration:ABSORPTION_DURATION,vertices:vertexCount(building)};
        this.pending.push(animation);started++;this.stats.started++;
        if(this.animations.length<limits.count&&vertices+animation.vertices<=limits.vertices){this.animations.push(animation);vertices+=animation.vertices;}
      }
      // Do not retain geometry returned by the spatial query after chunks evict.
      this.candidates.length=0;
      this.lastPosition[0]=run.position[0];this.lastPosition[1]=run.position[1];this.lastRevision=repo.revision;
    }
    return {changed,started};
  }
}
