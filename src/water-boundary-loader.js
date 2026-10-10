import {waterBoundaryTiles,freezeWaterBoundary,validateWaterBoundary,WATER_BOUNDARY_LIMITS,WaterBoundaryError} from './water-boundary.js';
export {validateWaterBoundary} from './water-boundary.js';
import {maskChunksForBounds,maskChunkBounds,countMaskBits,MASK_CELL_METRES,MASK_CHUNK_SIZE} from './consumption-mask.js';
const abortError=()=>new DOMException('Подготовка береговой линии отменена.','AbortError');
/** One complete, immutable boundary before play. This borrows the native source;
 * cancellation removes only its subscriptions and never disposes a shared source. */
export class WaterBoundaryLoader{
  constructor({manifest,source,onStatus=()=>{},workerFactory=()=>new Worker(new URL('./water-boundary.worker.js',import.meta.url),{type:'module'})}){
    if(!source)throw new TypeError('WaterBoundaryLoader needs the shared tile source.');
    Object.assign(this,{manifest,source,onStatus,workerFactory});this.controller=new AbortController();this.disposed=false;this.pending=null;this.error=null;this.boundary=null;this.worker=null;this.workerJob=null;this.requestId=0;this.queue=Promise.resolve();
    this.stats={requiredTiles:0,loadedTiles:0,fullMvtBytes:0,sharedSourceBytesDelta:0,startupMs:null};
  }
  check(){if(this.disposed||this.controller.signal.aborted)throw abortError();}
  async prepare(){
    this.check();if(this.boundary)return this.boundary;if(this.error)throw this.error;if(this.pending)return this.pending;
    // Preflight runs before even metadata is requested for an unsupported area.
    const coords=waterBoundaryTiles(this.manifest);this.stats.requiredTiles=coords.length;
    const operation=this.load(coords);this.pending=operation;
    try{return await operation;}catch(error){if(error.name!=='AbortError')this.error=error;throw error;}finally{if(this.pending===operation)this.pending=null;}
  }
  async load(coords){
    const started=performance.now(),beforeBytes=this.source.stats?.bytes??0;
    const metadata=await this.source.getMetadata({signal:this.controller.signal});this.check();
    if(!metadata.vectorLayers?.includes('water'))throw new WaterBoundaryError('WATER_LAYER','Источник не подтвердил слой воды. Суша пока неизвестна.');
    this.onStatus('Проверяем береговую линию района…',{phase:'water',loaded:0,total:coords.length});
    const tiles=new Array(coords.length);let next=0,bytes=0,failure=null;
    const load=async()=>{while(!failure&&next<coords.length){const index=next++,coord=coords[index];try{
      this.check();const tile=await this.source.loadNativeTile(coord.z,coord.x,coord.y,this.controller.signal);this.check();
      bytes+=tile.buffer.byteLength;if(bytes>WATER_BOUNDARY_LIMITS.bytes)throw new WaterBoundaryError('WATER_BYTE_LIMIT','Полные тайлы карты превышают безопасный предел береговой линии.');
      tiles[index]=tile;this.stats.loadedTiles++;this.stats.fullMvtBytes=bytes;
      this.onStatus(`Береговая линия: ${this.stats.loadedTiles} из ${coords.length} тайлов`,{phase:'water',loaded:this.stats.loadedTiles,total:coords.length,fullMvtBytes:bytes});
    }catch(error){failure??=error;}}};
    await Promise.all([load(),load()]);this.check();if(failure)throw failure;
    const result=await this.submit({type:'water-boundary',tiles,manifest:this.manifest},tiles.map(tile=>tile.buffer));this.check();
    if(result.type!=='water-boundary'||result.boundary?.complete!==true)throw new WaterBoundaryError('WATER_INCOMPLETE','Береговая линия не подтверждена.');
    Object.assign(this.stats,result.boundary.stats,{sharedSourceBytesDelta:(this.source.stats?.bytes??beforeBytes)-beforeBytes,startupMs:performance.now()-started});
    this.boundary=freezeWaterBoundary({...result.boundary,stats:{...result.boundary.stats,...this.stats}});
    this.onStatus('Береговая линия подтверждена.',{phase:'water-ready',...this.stats});return this.boundary;
  }
  submit(message,transfer=[]){const operation=this.queue.then(()=>{this.check();return this.runWorker(message,transfer);});this.queue=operation.catch(()=>{});return operation;}
  runWorker(message,transfer){
    if(!this.worker)this.worker=this.workerFactory();const worker=this.worker,requestId=++this.requestId;
    return new Promise((resolve,reject)=>{
      const finish=(error,result)=>{if(this.workerJob?.requestId!==requestId)return;clearTimeout(this.workerJob.timer);this.workerJob=null;error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{worker.terminate();if(this.worker===worker)this.worker=null;finish(new WaterBoundaryError('WATER_TIMEOUT','Проверка береговой линии заняла слишком много времени.'));},WATER_BOUNDARY_LIMITS.workerTimeoutMs);
      this.workerJob={requestId,timer,finish};
      worker.onmessage=event=>{const result=event.data;if(result?.requestId!==requestId)return;result.type==='error'?finish(new WaterBoundaryError(result.code||'WATER_WORKER',result.message||'Ошибка береговой линии.')):finish(null,result);};
      worker.onerror=event=>{worker.terminate();if(this.worker===worker)this.worker=null;finish(new WaterBoundaryError('WATER_WORKER',event.message||'Ошибка береговой линии.'));};
      try{worker.postMessage({...message,requestId},transfer);}catch(error){finish(error);}
    });
  }
  async validate(boundary){
    this.check();const result=await this.submit({type:'water-validate',boundary,manifest:this.manifest});this.check();
    if(result.type!=='water-validate'||result.boundary?.complete!==true)throw new WaterBoundaryError('WATER_SAVED_INVALID','Сохранённая береговая линия не подтверждена.');
    return freezeWaterBoundary(result.boundary);
  }
  async rasterizeRegion(boundary,regionId){
    this.check();const region=boundary?.regions?.find(region=>region.id===regionId);
    if(!region)throw new WaterBoundaryError('WATER_REGION','Выбранный участок суши не найден.');
    const expected=new Set(maskChunksForBounds(region.bounds));
    const result=await this.submit({type:'water-region',boundary,regionId,manifest:this.manifest});this.check();
    const invalid=()=>{throw new WaterBoundaryError('WATER_REGION','Некорректная маска суши.');};
    if(result.type!=='water-region'||result.regionId!==regionId||!Array.isArray(result.chunks)||result.chunks.length!==expected.size||result.chunks.length>36||!Number.isSafeInteger(result.scoreAreaM2)||result.scoreAreaM2<0||result.scoreAreaM2%4)invalid();
    const seen=new Set();let area=0;
    for(const item of result.chunks){
      if(!Array.isArray(item)||item.length!==2)invalid();const[key,bits]=item;
      if(!expected.has(key)||seen.has(key)||!(bits instanceof Uint8Array)||bits.byteLength!==8192)invalid();seen.add(key);
      const b=maskChunkBounds(key),width=(b.maxX-b.minX)/MASK_CELL_METRES,height=(b.maxY-b.minY)/MASK_CELL_METRES;
      if(width<MASK_CHUNK_SIZE||height<MASK_CHUNK_SIZE)for(let y=0;y<MASK_CHUNK_SIZE;y++)for(let byte=0;byte<32;byte++){
        const remaining=width-byte*8,allowed=y>=height||remaining<=0?0:remaining>=8?255:(1<<remaining)-1;
        if(bits[y*32+byte]&~allowed)invalid();
      }
      area+=countMaskBits(bits)*4;
    }
    if(area!==result.scoreAreaM2)invalid();
    return{chunks:result.chunks,scoreAreaM2:area,preparedGeometry:result.preparedGeometry?freezeWaterBoundary(result.preparedGeometry):undefined};
  }
  async retry(){if(this.pending)try{await this.pending;}catch{}this.check();this.error=null;this.boundary=null;this.source.retryFailures({clearCache:true});this.stats.loadedTiles=0;this.stats.fullMvtBytes=0;return this.prepare();}
  dispose(){if(this.disposed)return;this.disposed=true;this.controller.abort();this.workerJob?.finish(abortError());this.worker?.terminate();this.worker=null;this.boundary=null;}
}
