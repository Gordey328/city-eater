/** A renderer timeout is never proof that the preview can be played. */
export function waitForRenderer(map,{event='style.load',strict=true,timeoutMs=12000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let settle,timer,done=false;
  const promise=new Promise((resolve,reject)=>{
    settle=(kind)=>{
      if(done)return;done=true;clearTimer(timer);map.off(event,loaded);if(strict)map.off('webglcontextlost',lost);
      if(strict&&kind!=='loaded'){
        const error=kind==='cancelled'?new DOMException('Загрузка отменена','AbortError'):new Error(kind==='lost'?'WebGL 2: графический контекст потерян.':'Не удалось подготовить графическую карту за отведённое время. Повтори загрузку.');
        reject(error);
      }else resolve(kind==='loaded');
    };
    const loaded=()=>settle('loaded'),lost=()=>settle('lost');
    map.once(event,loaded);if(strict)map.on('webglcontextlost',lost);
    timer=setTimer(()=>settle('timeout'),timeoutMs);
  });
  return {promise,cancel:()=>settle('cancelled')};
}
export function previewEntryErrorMessage(error){
  if(error?.name==='AbortError')return 'Загрузка отменена.';
  if(/webgl|gpuinitialization|graphics context|initialize.*gl/i.test(`${error?.name||''} ${error?.message||''}`))return 'Для игры нужен WebGL 2. В этом браузере графика отключена или недоступна. Попробуй другой современный браузер с включённой аппаратной графикой.';
  return error?.message||'Не удалось открыть район. Повтори загрузку.';
}
