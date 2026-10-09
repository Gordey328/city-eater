import {compatibleSectorCache} from './import-contract.js';
import {OSM_ENDPOINT} from './overpass-client.js';
import {makeSectorQuery} from './city-campaign.js';
export class SectorLoader {
  constructor(cache,client){this.cache=cache;this.client=client;this.active=null;this.stats={cacheHits:0,imports:0};}
  cancel(){this.active?.abort();}
  async load(campaign,sector,onStatus=()=>{}){
    if(this.active)throw new Error('Сначала заверши текущую загрузку.');
    const controller=new AbortController();this.active=controller;
    const check=()=>{if(controller.signal.aborted)throw new DOMException('Загрузка отменена','AbortError');};
    try{
      const cached=await this.cache.getSector(sector.id);check();if(cached&&compatibleSectorCache(cached,sector)){this.stats.cacheHits++;return cached;}if(cached)onStatus('Формат сохранённой карты обновился. Подготовим участок заново; совместимость прохождения проверим перед запуском.');
      const payload=await this.client.request(makeSectorQuery(sector),{signal:controller.signal,onStatus});
      onStatus('Подготавливаем контуры зданий…');
      const result=await new Promise((resolve,reject)=>{
        check();const worker=new Worker(new URL('./osm-import.worker.js',import.meta.url),{type:'module'});
        let workerTimer;const finish=()=>{clearTimeout(workerTimer);worker.terminate();controller.signal.removeEventListener('abort',cancel);};
        const cancel=()=>{finish();reject(new DOMException('Загрузка отменена','AbortError'));};
        controller.signal.addEventListener('abort',cancel,{once:true});
        worker.onmessage=e=>{const message=e.data;if(message.type==='progress')onStatus(message.message||'Подготавливаем здания…');else if(message.type==='result'){finish();resolve(message.result);}else if(message.type==='error'){finish();reject(new Error(message.error?.message||message.message||'Ошибка подготовки карты.'));}};
        worker.onerror=e=>{finish();reject(new Error(e.message||'Не удалось подготовить карту.'));};workerTimer=setTimeout(()=>{finish();reject(new Error('Подготовка участка заняла слишком много времени. Выбери менее плотный сектор.'));},45000);
        worker.postMessage({type:'normalize',payload,sector,source:{endpoint:OSM_ENDPOINT,downloadedAt:new Date().toISOString()}});
      });
      if(controller.signal.aborted)throw new DOMException('Загрузка отменена','AbortError');
      // Persist first. A failed/quota-limited import is never advertised as cached.
      onStatus('Сохраняем участок на этом устройстве…');
      await this.cache.putSector(campaign.id,result);check();
      await this.cache.updateProgress(campaign.id,sector.id,{prepared:true,totalBuildingArea:result.manifest.totalBuildingArea,version:result.manifest.version});
      check();const stored=await this.cache.getSector(sector.id);check();this.stats.imports++;return stored;
    }catch(error){if(error.name==='QuotaExceededError')throw new Error('В браузере не хватает места для этого города. Готовые карты по-прежнему доступны.');throw error;}
    finally{if(this.active===controller)this.active=null;}
  }
}
