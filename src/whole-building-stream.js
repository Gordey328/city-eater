import {nativeTilesForBounds} from './tile-stream.js';
import {ARENA_HALF_METRES, RADIUS_CAP_METRES} from './game-config.js';

const LIMITS = Object.freeze({tiles:64,bytes:32*1024*1024,margin:150,workerTimeoutMs:30000});
const abortError=()=>new DOMException('Каталог домов изменился или закрыт.','AbortError');
const coordinates=p=>Array.isArray(p)?p:[p?.x,p?.y];
export function wholeNativeTiles(manifest,position,radius){
  const p=coordinates(position);
  if(p.length!==2||!p.every(Number.isFinite)||!Number.isFinite(radius)||radius<0||radius>RADIUS_CAP_METRES||p.some(v=>Math.abs(v)>ARENA_HALF_METRES+radius))throw new RangeError('Некорректная область целых домов.');
  const span=radius+LIMITS.margin,box=[p[0]-span,p[1]-span,p[0]+span,p[1]+span],tiles=new Map();
  // Unlike reward-mask coverage, this source window is deliberately NOT clipped
  // to the arena. A border house must fit its complete original footprint.
  for(let x=box[0];x<box[2];x+=512)for(let y=box[1];y<box[3];y+=512){
    for(const tile of nativeTilesForBounds(manifest,[x,y,Math.min(x+512,box[2]),Math.min(y+512,box[3])])){
      tiles.set(`${tile.x}/${tile.y}`,tile);
      if(tiles.size>LIMITS.tiles)throw new Error('Слишком много тайлов для целого контура.');
    }
  }
  return [...tiles.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
}

/** Bounded native mosaic for whole-house eligibility. This object borrows its
 * source, never disposes it, and never expands an open seam with an unbounded
 * neighbor crawl. An incomplete component simply remains ineligible. */
export class WholeBuildingStream{
  constructor({manifest,source,onStatus=()=>{},workerFactory=()=>new Worker(new URL('./whole-building.worker.js',import.meta.url),{type:'module'})}){
    if(!source)throw new TypeError('WholeBuildingStream needs the shared native source.');
    this.manifest=manifest;this.source=source;this.onStatus=onStatus;this.workerFactory=workerFactory;
    this.controller=new AbortController();this.disposed=false;this.ready=false;this.buildings=[];
    this.generation=0;this.signature=null;this.desired=null;this.completed=null;this.failed=new Map();this.pending=null;
    this.worker=null;this.workerJob=null;this.requestId=0;this.queue=Promise.resolve();
    this.stats={catalogs:0,sourceTiles:0,buildings:0,incomplete:0,oversize:0,reconstructMs:0};
  }
  check(){if(this.disposed||this.controller.signal.aborted)throw abortError();}
  async update(position,radius){
    this.check();const tiles=wholeNativeTiles(this.manifest,position,radius);
    const metadata=await this.source.getMetadata({signal:this.controller.signal});this.check();
    const signature=`${metadata.sourceKey}:${tiles.map(tile=>`${tile.x}/${tile.y}`).join(',')}`;
    if(signature!==this.signature){
      this.signature=signature;this.desired={tiles,signature,generation:++this.generation};this.ready=false;this.buildings=[];
    }
    if(this.completed===signature&&this.ready)return this.buildings;
    if(this.failed.has(signature))throw this.failed.get(signature);
    if(this.pending)return this.pending;
    const pending=this.fill();this.pending=pending;
    try{return await pending;}finally{if(this.pending===pending)this.pending=null;}
  }
  async fill(){
    for(;;){
      this.check();const desired=this.desired;
      if(!desired)return[];
      if(this.failed.has(desired.signature))throw this.failed.get(desired.signature);
      try{
        this.onStatus('Проверяем полные контуры ближайших домов…',{phase:'whole-catalog'});
        const tiles=await this.loadTiles(desired.tiles);this.check();
        if(this.desired!==desired)continue;
        const result=await this.submit({type:'catalog',generation:desired.generation,tiles,manifest:this.manifest},tiles.map(tile=>tile.buffer));
        this.check();if(this.desired!==desired)continue;
        if(result.type!=='catalog'||result.generation!==desired.generation||!Array.isArray(result.buildings))throw new Error('Неполный каталог домов.');
        this.buildings=result.buildings;this.ready=true;this.completed=desired.signature;
        Object.assign(this.stats,result.stats,{catalogs:this.stats.catalogs+1});
        this.onStatus('Полные контуры проверены.',{phase:'whole-ready',...this.stats});return this.buildings;
      }catch(error){
        if(error.name!=='AbortError'){this.failed.set(desired.signature,error);while(this.failed.size>16)this.failed.delete(this.failed.keys().next().value);}
        if(!this.disposed&&this.desired!==desired)continue;
        this.ready=false;this.buildings=[];throw error;
      }
    }
  }
  async loadTiles(coords){
    const tiles=new Array(coords.length);let next=0,bytes=0,error=null;
    const load=async()=>{while(!error&&next<coords.length){const index=next++,tile=coords[index];try{
      this.check();const result=await this.source.loadNativeTile(tile.z,tile.x,tile.y,this.controller.signal);
      bytes+=result.buffer.byteLength;if(bytes>LIMITS.bytes)throw new Error('Слишком большой пакет целых домов.');tiles[index]=result;
    }catch(failure){error??=failure;}}};
    await Promise.all([load(),load()]);if(error)throw error;return tiles;
  }
  submit(message,transfer=[]){
    const operation=this.queue.then(()=>{this.check();return this.runWorker(message,transfer);});
    this.queue=operation.catch(()=>{});return operation;
  }
  runWorker(message,transfer){
    if(!this.worker)this.worker=this.workerFactory();
    const worker=this.worker,requestId=++this.requestId;
    return new Promise((resolve,reject)=>{
      const finish=(error,result)=>{if(this.workerJob?.requestId!==requestId)return;clearTimeout(this.workerJob.timer);this.workerJob=null;error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{worker.terminate();if(this.worker===worker)this.worker=null;finish(new Error('Проверка целого дома заняла слишком много времени.'));},LIMITS.workerTimeoutMs);
      this.workerJob={requestId,timer,finish};
      worker.onmessage=event=>{const result=event.data;if(result?.requestId!==requestId)return;result.type==='error'?finish(new Error(result.message||'Не удалось проверить контур.')):finish(null,result);};
      worker.onerror=event=>{worker.terminate();if(this.worker===worker)this.worker=null;finish(new Error(event.message||'Ошибка проверки дома.'));};
      try{worker.postMessage({...message,requestId},transfer);}catch(error){finish(error);}
    });
  }
  async rasterize(buildings){
    this.check();if(!this.ready||!Array.isArray(buildings)||buildings.length>256)throw abortError();
    const generation=this.generation,catalog=new Set(this.buildings);
    if(buildings.some(building=>!catalog.has(building)||building.complete!==true))throw abortError();
    let result;
    try{result=await this.submit({type:'whole-raster',generation,ids:buildings.map(building=>building.id)});}
    catch(error){if(this.disposed||!this.ready||this.generation!==generation)throw abortError();throw error;}
    this.check();if(!this.ready||this.generation!==generation||result.generation!==generation||result.type!=='whole-raster'||!Array.isArray(result.chunks))throw abortError();
    return result.chunks;
  }
  async rasterizeSeparately(buildings){
    this.check();if(!this.ready||!Array.isArray(buildings)||buildings.length>16)throw abortError();
    const generation=this.generation,catalog=new Set(this.buildings);
    if(buildings.some(building=>!catalog.has(building)||building.complete!==true))throw abortError();
    let result;
    try{result=await this.submit({type:'whole-raster-separate',generation,ids:buildings.map(building=>building.id)});}
    catch(error){if(this.disposed||!this.ready||this.generation!==generation)throw abortError();throw error;}
    this.check();if(!this.ready||this.generation!==generation||result.generation!==generation||result.type!=='whole-raster-separate'||!Array.isArray(result.items))throw abortError();
    let bytes=0;const expected=new Set(buildings.map(building=>building.id)),seen=new Set();
    if(result.items.length!==expected.size)throw new Error('Неполный набор отдельных масок домов.');
    for(const item of result.items){
      if(!expected.has(item.id)||seen.has(item.id)||!Array.isArray(item.chunks))throw new Error('Некорректная отдельная маска дома.');
      seen.add(item.id);
      for(const[,bits]of item.chunks){if(!(bits instanceof Uint8Array)||bits.byteLength!==8192)throw new Error('Некорректная отдельная маска дома.');bytes+=bits.byteLength;}
    }
    if(bytes>1024*1024)throw new Error('Отдельные маски домов превышают безопасный предел.');
    return result.items;
  }
  async retry(position,radius){
    if(this.pending)try{await this.pending;}catch{}
    this.check();this.failed.clear();this.source.retryFailures({clearCache:true});
    this.ready=false;this.buildings=[];this.completed=null;this.signature=null;
    return this.update(position,radius);
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;this.generation++;this.ready=false;this.buildings=[];this.desired=null;this.failed.clear();
    this.controller.abort();this.workerJob?.finish(abortError());this.worker?.terminate();this.worker=null;
  }
}
