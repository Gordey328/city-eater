// One intentionally selected provider. Never rotate endpoints to evade a limit.
export const OSM_ENDPOINT='https://maps.mail.ru/osm/tools/overpass/api/interpreter';
export const MAX_RESPONSE_BYTES=40*1024*1024;
const cooldown=30000;
export class OverpassClient {
  constructor(){this.requestCount=0;this.busy=false;this.last=0;try{this.last=Number(localStorage.getItem('city-eater-osm-last')||0);}catch{}}
  async request(query,{signal,onStatus=()=>{},limit=MAX_RESPONSE_BYTES}={}){
    if(this.busy)throw new Error('Предыдущая загрузка ещё идёт. Дождись её завершения или отмени.');
    this.busy=true;const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();let timer;
    try{
      if(controller.signal.aborted)throw new DOMException('Загрузка отменена','AbortError');
      const wait=Math.max(0,cooldown-(Date.now()-this.last));
      if(wait){onStatus(`Пауза между запросами: ${Math.ceil(wait/1000)} с…`);await new Promise((resolve,reject)=>{const id=setTimeout(resolve,wait);controller.signal.addEventListener('abort',()=>{clearTimeout(id);reject(new DOMException('Загрузка отменена','AbortError'));},{once:true});});}
      if(controller.signal.aborted)throw new DOMException('Загрузка отменена','AbortError');
      this.last=Date.now();try{localStorage.setItem('city-eater-osm-last',String(this.last));}catch{}
      timer=setTimeout(()=>controller.abort('timeout'),110000);onStatus('Получаем реальные данные OpenStreetMap…');
      this.requestCount++;const response=await fetch(OSM_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:new URLSearchParams({data:query}),signal:controller.signal});
      if(!response.ok){if(response.status===429)throw new Error('Источник временно ограничил запросы. Попробуй позже; готовые карты доступны сразу.');if([502,503,504].includes(response.status))throw new Error('Источник OSM перегружен. Попробуй позже; готовые карты доступны сразу.');throw new Error(`Источник OSM ответил ${response.status}. Попробуй позже.`);}
      const announced=Number(response.headers.get('content-length')||0);if(announced>limit)throw new Error('Данных слишком много для безопасной загрузки на телефоне. Выбери менее плотный участок.');
      let text='';if(response.body?.getReader){const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){await reader.cancel();throw new Error('Превышен лимит 40 МБ для одного участка. Готовые карты доступны сразу.');}text+=decoder.decode(value,{stream:true});onStatus(`Загружаем участок: ${(bytes/1048576).toFixed(1)} МБ…`);}text+=decoder.decode();}finally{reader.releaseLock();}}else{text=await response.text();if(new TextEncoder().encode(text).byteLength>limit)throw new Error('Слишком большой ответ OSM.');}
      let data;try{data=JSON.parse(text);}catch{throw new Error('Источник вернул неполный ответ. Данные не сохранены; попробуй позже.');}
      if(data.remark)throw new Error('Источник не успел завершить запрос. Частичные данные не используются. Попробуй позже.');
      if(!Array.isArray(data.elements))throw new Error('Некорректный ответ OSM.');return data;
    }catch(error){if(controller.signal.aborted){if(signal?.aborted)throw new DOMException('Загрузка отменена','AbortError');throw new Error('Источник не ответил за отведённое время. Попробуй позже.');}throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.busy=false;}
  }
}
export function escapeHTML(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
