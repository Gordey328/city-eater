import {STREAM_MODE,STREAM_SCHEMA_VERSION,createStreamRun,serializeStreamRun} from './streaming-state.js';
import {ConsumptionMask,MASK_CHUNK_COUNT} from './consumption-mask.js';

export const STREAM_DB_NAME = 'city-eater-stream-5km-v2';
/** Separate DB: opening this mode never migrates or deletes old game saves. */
export class StreamStore {
  constructor(){this.db=null;this.opening=null;}
  async init(){
    if(this.db)return this;if(this.opening)return this.opening;
    this.opening=new Promise((resolve,reject)=>{
      const r=indexedDB.open(STREAM_DB_NAME,1);
      r.onupgradeneeded=()=>{
        r.result.createObjectStore('runs',{keyPath:'sectorId'});
        const masks=r.result.createObjectStore('masks',{keyPath:'id'});masks.createIndex('sectorId','sectorId');
      };
      r.onsuccess=()=>{this.db=r.result;this.db.onversionchange=()=>{this.db?.close();this.db=null;this.opening=null;};resolve(this);};
      r.onerror=()=>reject(r.error);
    });
    try{return await this.opening;}catch(error){this.opening=null;throw error;}
  }
  async load(sectorId){
    await this.init();return new Promise((resolve,reject)=>{
      const t=this.db.transaction(['runs','masks'],'readonly'),run=t.objectStore('runs').get(sectorId),masks=t.objectStore('masks').index('sectorId').getAll(sectorId);
      t.oncomplete=()=>resolve({run:run.result??null,masks:(masks.result||[]).map(item=>({key:item.key,bits:item.bits}))});
      t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);
    });
  }
  async progress(){
    await this.init();return new Promise((resolve,reject)=>{
      const t=this.db.transaction('runs','readonly'),r=t.objectStore('runs').getAll();
      t.oncomplete=()=>resolve(r.result||[]);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);
    });
  }
  async save(run,chunks){
    if(run.mode!==STREAM_MODE||run.schemaVersion!==STREAM_SCHEMA_VERSION)throw new Error('Неверный формат сохранения.');
    const sector={id:run.sectorId,center:run.frame?.center,projectionLatitude:run.frame?.projectionLatitude};
    const snapshot=serializeStreamRun(createStreamRun(sector,run));
    if(!chunks||typeof chunks[Symbol.iterator]!=='function')throw new TypeError('Expected iterable mask chunks');
    const copies=new ConsumptionMask(),records=[];
    for(const entry of chunks){
      if(records.length>=MASK_CHUNK_COUNT||!Array.isArray(entry)||entry.length!==2||copies.coverage.has(entry[0]))throw new TypeError('Invalid or duplicate saved mask chunk');
      const [key,bits]=entry;copies.ingestCoverage(key,bits);records.push([key,copies.getCoverageChunk(key)]);
    }
    // All snapshots/validation happen before the first await or database write.
    await this.init();return new Promise((resolve,reject)=>{
      const t=this.db.transaction(['runs','masks'],'readwrite');
      t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error??new DOMException('Save transaction aborted','AbortError'));
      try {
        t.objectStore('runs').put(snapshot);
        for(const [key,bits] of records)t.objectStore('masks').put({id:`${snapshot.sectorId}::${key}`,sectorId:snapshot.sectorId,key,bits});
      } catch(error) {
        // Even a synchronous error after the run write must roll everything back.
        t.abort();reject(error);
      }
    });
  }
  async reset(sectorId){
    await this.init();return new Promise((resolve,reject)=>{
      const t=this.db.transaction(['runs','masks'],'readwrite');t.objectStore('runs').delete(sectorId);
      const r=t.objectStore('masks').index('sectorId').openKeyCursor(sectorId);
      r.onsuccess=()=>{const c=r.result;if(c){t.objectStore('masks').delete(c.primaryKey);c.continue();}};
      t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);
    });
  }
}
