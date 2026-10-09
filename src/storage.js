const DB_NAME = 'city-eater-v1';
export class SaveSystem {
  constructor(onError = ()=>{}) { this.db=null; this.onError=onError; this.fallback=new Map(); }
  async init() {
    try {
      this.db = await new Promise((resolve,reject)=>{
        const request=indexedDB.open(DB_NAME,1);
        request.onupgradeneeded=()=>{for(const store of ['runs','records','meta']) if(!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);};
        request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
      });
    } catch(error) {this.onError('Сохранения недоступны в этом браузере. Не закрывай вкладку.');}
    return this;
  }
  async transact(store,method,key,value) {
    if(!this.db) {const k=`${store}:${key}`; if(method==='get')return this.fallback.get(k); if(method==='delete')this.fallback.delete(k);else this.fallback.set(k,value);return;}
    return new Promise((resolve,reject)=>{
      const tx=this.db.transaction(store,method==='get'?'readonly':'readwrite');
      const req=method==='put'?tx.objectStore(store).put(value,key):tx.objectStore(store)[method](key);
      let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    }).catch(error=>{this.onError('Не удалось записать прогресс. Освободи место в хранилище браузера.'); throw error;});
  }
  getRun(id){return this.transact('runs','get',id);} saveRun(run){return this.transact('runs','put',run.levelId,run);} deleteRun(id){return this.transact('runs','delete',id);}
  getRecord(id){return this.transact('records','get',id);} saveRecord(id,record){return this.transact('records','put',id,record);}
  async lastLevel(){return this.transact('meta','get','lastLevel');}
  async selectLevel(id){return this.transact('meta','put','lastLevel',id);}
  async unlocked(){return (await this.transact('meta','get','unlocked'))??0;}
  async unlock(index){return this.transact('meta','put','unlocked',Math.max(index,await this.unlocked()));}
}
