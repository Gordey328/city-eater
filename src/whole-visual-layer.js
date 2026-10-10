import {SpatialIndex} from './geometry.js';
import {prepareBuildingModel,drawBuildingModels,releaseBuildingModel} from './building-models.js';
export const WHOLE_VISUAL_LIMITS=Object.freeze({buildings:128,vertices:24000,footprintBytes:2*1024*1024,batch:8,preparedVertices:96000,preparePerFrame:4,prepareVerticesPerFrame:6000});
export function visualSourceVertexCount(building){
  const geometries=[...new Set([building.polygons,...(building.modelParts||[]).map(p=>p.polygons)])];
  let count=0;for(const polygons of geometries){if(!Array.isArray(polygons))return Infinity;for(const polygon of polygons)for(const ring of polygon)count+=ring.length;}return count;
}
/** The saved world mask remains authoritative. A model replaces occupancy only
 * when every nonzero original footprint cell is known and still untouched. */
export function classifyFootprint(chunks,mask){
  let nonempty=false,eaten=false,remaining=false;
  if(!Array.isArray(chunks)||!chunks.length)return'unknown';
  for(const [key,bits] of (mask.clipFootprintChunks?.(chunks)||chunks)){const coverage=mask.getCoverageChunk(key),consumed=mask.getConsumedChunk(key);if(!(bits instanceof Uint8Array)||bits.length!==8192||!coverage)return'unknown';
    for(let i=0;i<bits.length;i++){const value=bits[i];if(!value)continue;nonempty=true;if(value&~coverage[i])return'unknown';if(value&(consumed?.[i]||0))eaten=true;if(value&~(consumed?.[i]||0))remaining=true;}
  }
  return !nonempty?'unknown':!remaining?'gone':eaten?'partial':'untouched';
}
export class WholeVisualLayer{
  constructor({mask,display,manifest,prepareModel=prepareBuildingModel,drawModels=drawBuildingModels,releaseModel=releaseBuildingModel,prepareClock=()=>performance.now()}){Object.assign(this,{mask,display,manifest,prepareModel,drawModels,releaseModel,prepareClock});this.cache=new Map();this.gone=new Set();this.failed=new Set();this.budgetBlocked=new Set();this.querySignature='';this.bytes=0;this.preparedVertices=0;this.pending=null;this.generation=0;this.catalog=null;this.whole=null;this.candidates=[];this.lastSelection='';this.lastQuery=-Infinity;this.disposed=false;this.stats={cachedBuildings:0,footprintBytes:0,drawnBuildings:0,drawnVertices:0,partialFallbacks:0,unknownFallbacks:0,preparedModels:0};}
  releaseEntry(entry){if(entry.model){this.preparedVertices-=entry.model.preparedVertexCost||entry.model.sourceVertices||0;this.releaseModel(entry.building);}}
  reset(){this.generation++;for(const entry of this.cache.values())this.releaseEntry(entry);this.preparedVertices=0;this.cache.clear();this.gone.clear();this.failed.clear();this.budgetBlocked.clear();this.querySignature='';this.bytes=0;this.candidates=[];this.catalog=null;this.whole=null;this.index=null;this.lastQuery=-Infinity;this.lastSelection='';Object.assign(this.stats,{cachedBuildings:0,footprintBytes:0,preparedVertices:0,drawnBuildings:0,drawnVertices:0,selectedIds:[]});this.display.setReplacements?.(new Map());}
  sync(game,renderer,now=performance.now()){
    const whole=game.whole;
    if(this.disposed||game.mode!=='whole'||!whole?.ready){if(this.catalog||this.cache.size)this.reset();return[];}
    if(this.catalog!==whole.buildings){this.reset();this.whole=whole;this.catalog=whole.buildings;this.index=new SpatialIndex(128);for(const b of this.catalog)if(b.complete&&b.bounds)this.index.insert(b,b.bounds);}
    if(now-this.lastQuery>200){this.lastQuery=now;const bounds=renderer.localViewBounds(180),p=game.run.position;
      this.candidates=this.index.query(bounds).filter(b=>{if(this.gone.has(b.id)||this.failed.has(b.id))return false;if(visualSourceVertexCount(b)>WHOLE_VISUAL_LIMITS.prepareVerticesPerFrame){this.failed.add(b.id);return false;}return true;}).sort((a,b)=>(a.center[0]-p[0])**2+(a.center[1]-p[1])**2-((b.center[0]-p[0])**2+(b.center[1]-p[1])**2)).slice(0,WHOLE_VISUAL_LIMITS.buildings);
      const signature=this.candidates.map(b=>b.id).join('|');if(signature!==this.querySignature){this.budgetBlocked.clear();this.querySignature=signature;}const wanted=new Set(this.candidates.map(b=>b.id));for(const [id,entry] of this.cache)if(!wanted.has(id)){this.bytes-=entry.bytes;this.releaseEntry(entry);this.cache.delete(id);this.budgetBlocked.clear();}
    }
    this.stats.partialFallbacks=0;this.stats.unknownFallbacks=0;const models=[];let prepared=0,prepareVertices=0;const prepareStarted=this.prepareClock();
    for(const b of this.candidates){if(this.failed.has(b.id))continue;const entry=this.cache.get(b.id);if(!entry)continue;
      if(entry.consumedRevision!==this.mask.consumedRevision||entry.coverageRevision!==this.mask.coverageRevision){entry.state=classifyFootprint(entry.chunks,this.mask);entry.consumedRevision=this.mask.consumedRevision;entry.coverageRevision=this.mask.coverageRevision;}
      if(entry.state==='gone'){this.gone.add(b.id);this.cache.delete(b.id);this.bytes-=entry.bytes;this.releaseEntry(entry);this.budgetBlocked.clear();continue;}if(entry.state==='partial'){this.stats.partialFallbacks++;continue;}if(entry.state!=='untouched'){this.stats.unknownFallbacks++;continue;}
      if(!entry.model){
        if(this.budgetBlocked.has(b.id))continue;
        entry.sourceCost??=visualSourceVertexCount(b);
        if(entry.sourceCost>WHOLE_VISUAL_LIMITS.prepareVerticesPerFrame){this.failed.add(b.id);continue;}
        if(prepared>=WHOLE_VISUAL_LIMITS.preparePerFrame||prepareVertices+entry.sourceCost>WHOLE_VISUAL_LIMITS.prepareVerticesPerFrame||this.prepareClock()-prepareStarted>2)continue;
        prepared++;prepareVertices+=entry.sourceCost;try{const model=this.prepareModel(b,this.manifest);this.stats.preparedModels++;if(!model){this.failed.add(b.id);continue;}const cost=model.preparedVertexCost||model.sourceVertices||0;
          if(this.preparedVertices+cost>WHOLE_VISUAL_LIMITS.preparedVertices){this.releaseModel(b);this.budgetBlocked.add(b.id);continue;}entry.model=model;this.preparedVertices+=cost;
        }catch{this.failed.add(b.id);continue;}
      }
      models.push(entry.model);
    }
    this.schedule();this.stats.cachedBuildings=this.cache.size;this.stats.footprintBytes=this.bytes;this.stats.preparedVertices=this.preparedVertices;this.stats.preparedThisFrame=prepared;this.stats.preparedSourceVerticesThisFrame=prepareVertices;return models;
  }
  schedule(){if(this.pending||!this.whole?.ready||this.disposed)return;const buildings=this.candidates.filter(b=>!this.cache.has(b.id)&&!this.failed.has(b.id)&&!this.gone.has(b.id)&&!this.budgetBlocked.has(b.id)).slice(0,WHOLE_VISUAL_LIMITS.batch);if(!buildings.length)return;
    const whole=this.whole,generation=this.generation,promise=whole.rasterizeSeparately(buildings);this.pending=promise;
    promise.then(results=>{if(this.disposed||generation!==this.generation||whole!==this.whole||!whole.ready)return;
      const current=new Set(this.candidates.map(b=>b.id)),wanted=new Map(buildings.map(b=>[b.id,b]));for(const result of results){const building=wanted.get(result.id);if(!building||!current.has(result.id)||this.cache.has(result.id)||!whole.buildings.includes(building)||!Array.isArray(result.chunks))continue;const bytes=result.chunks.reduce((n,[,bits])=>n+bits.byteLength,0);if(bytes>WHOLE_VISUAL_LIMITS.footprintBytes||this.bytes+bytes>WHOLE_VISUAL_LIMITS.footprintBytes||this.cache.size>=WHOLE_VISUAL_LIMITS.buildings){this.budgetBlocked.add(building.id);continue;}this.cache.set(building.id,{building,chunks:this.mask.clipFootprintChunks?.(result.chunks)||result.chunks,bytes,state:'unknown',consumedRevision:-1,coverageRevision:-1,model:null});this.bytes+=bytes;}
    }).catch(error=>{if(generation===this.generation&&error.name!=='AbortError')for(const b of buildings)this.failed.add(b.id);}).finally(()=>{if(this.pending===promise)this.pending=null;});
  }
  plan(models,frame,options={}){
    const plan=this.drawModels(null,models,frame,{...options,maxBuildings:WHOLE_VISUAL_LIMITS.buildings,maxVertices:WHOLE_VISUAL_LIMITS.vertices}),ids=plan.selectedIds||[],signature=[...ids].sort().join('|');
    if(signature!==this.lastSelection){const replacement=new Map();for(const id of ids){const entry=this.cache.get(id);if(!entry||entry.state!=='untouched')continue;for(const [key,bits] of entry.chunks){let combined=replacement.get(key);if(!combined){combined=new Uint8Array(8192);replacement.set(key,combined);}for(let i=0;i<bits.length;i++)combined[i]|=bits[i];}}this.display.setReplacements(replacement);this.lastSelection=signature;}
    const {plan:drawPlan,...stats}=plan;Object.assign(this.stats,stats);return plan;
  }
  draw(context,models,frame,options={}){return this.drawModels(context,models,frame,{...options,maxBuildings:WHOLE_VISUAL_LIMITS.buildings,maxVertices:WHOLE_VISUAL_LIMITS.vertices});}
  dispose(){this.disposed=true;this.reset();}
}
