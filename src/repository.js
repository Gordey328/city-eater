import {SpatialIndex} from './geometry.js';
export class BuildingRepository {
  constructor(manifest,baseUrl,consumed,onChange=()=>{}) {
    this.manifest=manifest;this.baseUrl=baseUrl;this.consumed=consumed;this.onChange=onChange;
    this.chunks=new Map();this.pending=new Map();this.buildings=new Map();this.index=new SpatialIndex(150);this.generation=0;this.disposed=false;this.errors=new Map();
  }
  required(position,radius,direction=[0,0]) {
    const view=Math.max(750,radius*3.8), lead=Math.min(500,view*.4), p=[position[0]+direction[0]*lead,position[1]+direction[1]*lead];
    return this.manifest.chunks.filter(c=>{
      const box=c.bbox || [-5000+c.x*this.manifest.chunkSize,-5000+c.y*this.manifest.chunkSize,-5000+(c.x+1)*this.manifest.chunkSize,-5000+(c.y+1)*this.manifest.chunkSize];
      return box[0]<=p[0]+view && box[2]>=p[0]-view && box[1]<=p[1]+view && box[3]>=p[1]-view;
    });
  }
  async update(position,radius,direction=[0,0]) {
    if(this.disposed)return;
    const required=this.required(position,radius,direction),wanted=new Set(required.map(c=>c.id));
    const results=await Promise.allSettled(required.map(c=>this.load(c)));
    if(this.disposed)return;
    // Evict detailed geometry only after required chunks are resident; consumed IDs live independently.
    let evicted=false;for(const [id,buildings] of this.chunks) if(!wanted.has(id)) {for(const b of buildings){this.buildings.delete(b.id);this.index.remove(b.id);}this.chunks.delete(id);evicted=true;}
    if(evicted)this.onChange();
    const failure=results.find(r=>r.status==='rejected'); if(failure)throw failure.reason;
  }
  async load(chunk) {
    if(this.chunks.has(chunk.id))return;
    if(this.pending.has(chunk.id))return this.pending.get(chunk.id);
    const p=(async()=>{
      const response=await fetch(new URL(chunk.url,this.baseUrl));if(!response.ok)throw new Error(`Не удалось загрузить участок карты (${response.status}).`);
      const data=await response.json();if(this.disposed)return;
      if(this.manifest.version&&data.version!==this.manifest.version)throw new Error('Версия участка карты изменилась. Обнови страницу, чтобы продолжить безопасно.');
      const buildings=data.buildings;
      this.chunks.set(chunk.id,buildings);
      for(const b of buildings) if(!this.consumed.has(b.id)) {this.buildings.set(b.id,b);this.index.insert(b);}
      this.errors.delete(chunk.id);this.onChange();
    })().catch(e=>{this.errors.set(chunk.id,e);throw e;}).finally(()=>this.pending.delete(chunk.id));
    this.pending.set(chunk.id,p);return p;
  }
  covers(position,radius) {return this.manifest.chunks.every(c=>{const b=c.bbox || [-5000+c.x*this.manifest.chunkSize,-5000+c.y*this.manifest.chunkSize,-5000+(c.x+1)*this.manifest.chunkSize,-5000+(c.y+1)*this.manifest.chunkSize];return b[0]>position[0]+radius||b[2]<position[0]-radius||b[1]>position[1]+radius||b[3]<position[1]-radius||this.chunks.has(c.id);});}
  consume(id){this.index.remove(id);this.buildings.delete(id);}
  near(position,radius) {return this.index.query([position[0]-radius,position[1]-radius,position[0]+radius,position[1]+radius]);}
  features(absorbing=new Set()) {
    return {type:'FeatureCollection',features:[...this.buildings.values()].filter(b=>!this.consumed.has(b.id)&&!absorbing.has(b.id)).map(b=>({type:'Feature',id:b.id,properties:{id:b.id,radius:b.radius,area:b.area},geometry:b.geometry}))};
  }
  dispose(){this.disposed=true;this.chunks.clear();this.buildings.clear();this.pending.clear();}
}
