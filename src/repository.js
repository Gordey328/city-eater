import {SpatialIndex} from './geometry.js';
import {streamingExtent} from './camera.js';
const featureFor=b=>({type:'Feature',id:b.id,properties:{id:b.id,radius:b.radius,area:b.area},geometry:b.geometry});
export class BuildingRepository {
  constructor(manifest,baseUrl,consumed,onChange=()=>{},options={}) {
    this.manifest=manifest;this.baseUrl=baseUrl;this.consumed=consumed;this.onChange=onChange;this.loadChunk=options.loadChunk;
    this.viewport=[1024,768];this.chunks=new Map();this.pending=new Map();this.buildings=new Map();this.index=new SpatialIndex(150);this.generation=0;this.disposed=false;this.errors=new Map();
    this.revision=0;this.reserved=new Set();this.added=new Map();this.removed=new Set();this.wanted=null;
  }
  setViewport(width,height){this.viewport=[Math.max(1,width),Math.max(1,height)];}
  chunkBounds(c){return c.bbox || [-5000+c.x*this.manifest.chunkSize,-5000+c.y*this.manifest.chunkSize,-5000+(c.x+1)*this.manifest.chunkSize,-5000+(c.y+1)*this.manifest.chunkSize];}
  required(position,radius,direction=[0,0]) {
    const view=streamingExtent(radius,...this.viewport,(this.manifest.center?.[1]??60)+position[1]/(6378137*Math.PI/180),this.manifest.projectionLatitude??this.manifest.center?.[1]??60),lead=Math.min(400,Math.max(view.x,view.y)*.2),bounds=[position[0]-view.x+Math.min(0,direction[0]*lead),position[1]-view.y+Math.min(0,direction[1]*lead),position[0]+view.x+Math.max(0,direction[0]*lead),position[1]+view.y+Math.max(0,direction[1]*lead)];
    return this.manifest.chunks.filter(c=>{const box=this.chunkBounds(c);return box[0]<=bounds[2]&&box[2]>=bounds[0]&&box[1]<=bounds[3]&&box[3]>=bounds[1];});
  }
  async update(position,radius,direction=[0,0]) {
    if(this.disposed)return;
    const generation=++this.generation,required=this.required(position,radius,direction),wanted=new Set(required.map(c=>c.id));this.wanted=wanted;
    const results=await Promise.allSettled(required.map(c=>this.load(c)));
    if(this.disposed||generation!==this.generation)return;
    // Evict only after required chunks settle; retain IDs, never consumed geometry.
    let evicted=false;
    for(const [id,ids] of this.chunks)if(!wanted.has(id)){for(const buildingId of ids)this.removeActive(buildingId);this.chunks.delete(id);evicted=true;}
    if(evicted)this.onChange();
    const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  }
  async load(chunk) {
    if(this.chunks.has(chunk.id))return;
    if(this.pending.has(chunk.id))return this.pending.get(chunk.id);
    const p=(async()=>{
      let data;
      if(this.loadChunk)data=await this.loadChunk(chunk);
      else {const response=await fetch(new URL(chunk.url,this.baseUrl));if(!response.ok)throw new Error(`Не удалось загрузить участок карты (${response.status}).`);data=await response.json();}
      if(this.disposed||this.wanted&&!this.wanted.has(chunk.id))return;
      if(this.manifest.version&&data.version!==this.manifest.version)throw new Error('Версия участка карты изменилась. Обнови страницу, чтобы продолжить безопасно.');
      const ids=[];
      for(const b of data.buildings){
        ids.push(b.id);
        if(this.consumed.has(b.id)||this.reserved.has(b.id)||this.buildings.has(b.id))continue;
        this.buildings.set(b.id,b);this.index.insert(b);this.revision++;this.added.set(b.id,featureFor(b));this.removed.delete(b.id);
      }
      this.chunks.set(chunk.id,ids);this.errors.delete(chunk.id);this.onChange();
    })().catch(e=>{this.errors.set(chunk.id,e);throw e;}).finally(()=>this.pending.delete(chunk.id));
    this.pending.set(chunk.id,p);return p;
  }
  covers(position,radius){return this.manifest.chunks.every(c=>{const b=this.chunkBounds(c);return b[0]>position[0]+radius||b[2]<position[0]-radius||b[1]>position[1]+radius||b[3]<position[1]-radius||this.chunks.has(c.id);});}
  removeActive(id){this.index.remove(id);if(this.buildings.delete(id)){this.revision++;this.added.delete(id);this.removed.add(id);}}
  reserve(id){if(this.consumed.has(id)||this.reserved.has(id)||!this.buildings.has(id))return false;this.reserved.add(id);this.removeActive(id);return true;}
  consume(id){this.reserved.delete(id);this.removeActive(id);}
  near(position,radius,result=[]){return this.index.query([position[0]-radius,position[1]-radius,position[0]+radius,position[1]+radius],result);}
  /** Drain a coalesced stable-ID delta only when the renderer is ready to send it. */
  takeRenderChanges(){
    if(!this.added.size&&!this.removed.size)return null;
    const diff={};if(this.added.size)diff.add=[...this.added.values()];if(this.removed.size)diff.remove=[...this.removed];
    this.added.clear();this.removed.clear();return diff;
  }
  // Full snapshots are diagnostics only, never a per-frame rendering operation.
  features(absorbing=new Set()){return {type:'FeatureCollection',features:[...this.buildings.values()].filter(b=>!this.consumed.has(b.id)&&!absorbing.has(b.id)).map(featureFor)};}
  dispose(){this.disposed=true;this.generation++;this.chunks.clear();this.buildings.clear();this.index.clear();this.reserved.clear();this.added.clear();this.removed.clear();this.pending.clear();}
}
