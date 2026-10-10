import {validateWaterBoundary,freezeWaterBoundary} from './water-boundary.js';
const abort=()=>new DOMException('Проверка сохранённого берега отменена.','AbortError');
/** No network. Production validates saved polygon topology/hash in a short-lived
 * worker; obsolete overview requests can stop that work immediately. */
export async function validateBoundaryAsync(boundary,manifest,{signal,workerFactory=typeof Worker==='function'?()=>new Worker(new URL('./water-boundary.worker.js',import.meta.url),{type:'module'}):null}={}){
 if(signal?.aborted)throw abort();
 if(!workerFactory){const value=await validateWaterBoundary(boundary,manifest);if(signal?.aborted)throw abort();return value;}
 return new Promise((resolve,reject)=>{let worker,timer,done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);worker?.terminate();error?reject(error):resolve(value);},cancel=()=>finish(abort());
  try{worker=workerFactory();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}timer=setTimeout(()=>finish(new Error('Проверка сохранённого берега заняла слишком много времени.')),30000);
   worker.onmessage=event=>{const result=event.data;if(result?.requestId!==1)return;if(result.type==='error'){const error=new Error(result.message||'Сохранённый берег повреждён.');error.code=result.code;finish(error);}else if(result.type==='water-validate'&&result.boundary?.complete===true)finish(null,freezeWaterBoundary(result.boundary));else finish(new Error('Проверка берега не подтверждена.'));};
   worker.onerror=event=>finish(new Error(event.message||'Не удалось проверить сохранённый берег.'));worker.postMessage({requestId:1,type:'water-validate',boundary,manifest});
  }catch(error){finish(error);}
 });
}
