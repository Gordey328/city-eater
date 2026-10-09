import '@fontsource/manrope/400.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/800.css';
import '@fontsource/unbounded/700.css';
import '@fontsource/unbounded/900.css';
import './style.css';
import {MapRenderer} from './renderer.js';
import {BuildingRepository} from './repository.js';
import {HoleController} from './input.js';
import {AudioSystem} from './audio.js';
import {SaveSystem} from './storage.js';
import {createRun,consumeBuilding,serializeRun,progressPercent,compatibleSave,mergeRecord} from './state.js';
import {polygonFitsCircle,resolveMotion} from './geometry.js';
const $=s=>document.querySelector(s);
const icon={pause:'<span class="pause-icon"><i></i><i></i></span>',play:'<span>↗</span>',sound:'♪',arrow:'↗'};
$('#app').innerHTML=`
  <header id="topbar"><a class="brand" href="#" aria-label="CITY EATER, главное меню"><span class="brand-orbit"></span>CITY EATER<span class="brand-dot">05</span></a><div class="top-right"><span class="edition">REAL CITY. REAL APPETITE.</span><button id="pause" class="icon-button" aria-label="Пауза">${icon.pause}</button></div></header>
  <section id="hud" class="hidden" aria-label="Игровые показатели"><div class="progress-card"><div class="progress-label"><span>ПОГЛОЩЕНО</span><span>ЦЕЛЬ <b id="target-value">80</b>%</span></div><div class="progress-number"><span id="progress-value">0.00</span><small>%</small></div><div class="progress-track"><i id="progress-fill"></i><span></span></div><div class="hud-location"><i></i><span id="hud-level"></span><span>100 КМ²</span></div></div><div class="stats-card"><div><span>РАДИУС</span><b id="radius-value">18 <small>м</small></b></div><div><span>ЗДАНИЯ</span><b id="count-value">0</b></div><div><span>ОЧКИ</span><b id="score-value">0</b></div><div><span>ВРЕМЯ</span><b id="time-value">00:00</b></div></div></section>
  <div id="game-bottom" class="hidden"><div class="controls-help"><span class="keys">W A S D</span><span class="desktop-help">Двигайся и поглощай</span><span class="touch-help">Коснись карты и тяни</span></div><div id="target-hint"></div><div class="arena-mini"><span class="north">N ↑</span><div><i id="mini-player"></i></div><small>10 × 10 КМ</small></div></div>
  <section id="menu" class="screen"><div class="menu-copy"><div class="eyebrow"><i></i>ОДИНОЧНАЯ АРКАДА · OPENSTREETMAP</div><h1>ГОРОД.<br>НА ОБЕД<span>.</span></h1><p class="lead">Начни с малого.<br>Вырастай до немыслимого.</p><p class="description">Настоящие улицы. Настоящие здания.<br>Одна очень голодная чёрная дыра.</p><div class="menu-actions"><button id="play" class="primary" disabled>Загружаем город… <span class="button-arrow">↗</span></button><div class="menu-proof"><span class="proof-dot"></span><span>Без таймера. В своём ритме.</span></div></div></div><aside class="level-panel panel"><div class="section-label"><span>ВЫБЕРИ СВОЮ КАРТУ</span><span id="level-number">01 / 02</span></div><div id="levels"></div><div class="level-facts"><div><b>100</b><span>КМ² АРЕНЫ</span></div><div><b>80<span>%</span></b><span>ЦЕЛЬ УРОВНЯ</span></div><div><b>∞</b><span>ВРЕМЕНИ</span></div></div><div class="how"><span class="how-number">01</span><p>Двигайся к светлым зданиям.<br><strong>Они уже тебе по размеру.</strong></p></div><div class="how"><span class="how-number">02</span><p>Поглощай, расти, исследуй.<br><strong>Большие здания подождут.</strong></p></div><div class="settings"><label>Звук <button id="sound-toggle" class="toggle" aria-label="Переключить звук" aria-pressed="true">Вкл</button></label><label>Графика <select id="quality" aria-label="Качество графики"><option value="high">Высокая</option><option value="low">Экономная</option></select></label></div></aside><div class="menu-footer"><span>САНКТ-ПЕТЕРБУРГ И ОБЛАСТЬ</span><button id="about-open" class="text-button">О картах и игре ↗</button></div></section>
  <section id="pause-screen" class="screen modal-screen hidden" role="dialog" aria-modal="true" aria-labelledby="pause-title"><div class="modal panel"><div class="eyebrow">МОЖНО НЕ СПЕШИТЬ</div><h2 id="pause-title">Город подождёт.</h2><p id="pause-note">Прогресс сохраняется автоматически.</p><button id="resume" class="primary">Продолжить <span>↗</span></button><button id="to-menu" class="secondary">Выбор уровня</button><button id="restart" class="text-button">Начать заново</button></div></section>
  <section id="result" class="screen modal-screen hidden" role="dialog" aria-modal="true" aria-labelledby="result-title"><div class="modal result-modal panel"><div class="victory-orbit"></div><div class="eyebrow">ПРЕКРАСНЫЙ АППЕТИТ</div><h2 id="result-title">Город съеден.</h2><p id="result-place"></p><div class="result-grid" id="result-stats"></div><div class="record" id="record"></div><button id="next-level" class="primary">Следующий город <span>↗</span></button><button id="replay" class="secondary">Ещё раз</button><button id="result-menu" class="text-button">Выбор уровня</button></div></section>
  <section id="about" class="screen modal-screen hidden" role="dialog" aria-modal="true" aria-labelledby="about-title"><div class="modal about-modal panel"><div class="eyebrow">СОЗДАНО ИЗ НАСТОЯЩЕГО</div><h2 id="about-title">Это реальный город.</h2><p>Каждое игровое здание взято из OpenStreetMap. Никаких сгенерированных домов или соперников. Игровой квадрат — ровно 10 000 × 10 000 метров в локальных координатах.</p><p>Карта доставляется с этого сайта в формате PMTiles. Контуры загружаются участками; съеденные здания хранятся в IndexedDB только в твоём браузере.</p><p class="fine-print">Данные © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL 1.0</a>. MapLibre GL JS · PMTiles.<br>Полнота карты зависит от OSM. Прототип v0.5. Баланс ещё настраивается.</p><a class="data-link" href="./data/README.md" target="_blank">Источники и версия данных ↗</a><button id="about-close" class="primary">Понятно <span>↗</span></button></div></section>
  <div id="loading" class="loading hidden"><span></span><p id="loading-text">Собираем настоящий город…</p></div><div id="toast" role="status" aria-live="polite"></div><div id="network" class="hidden">Подгружаем район…</div><div id="joystick"><div id="joystick-knob"></div></div><div id="fps" class="hidden"></div>`;

let catalog=[],levelIndex=0,manifest=null,run=null,repo=null,state='boot',unlocked=0,animations=[],simulationTime=0,lastTime=performance.now(),lastUI=0,lastStream=0,lastSave=0,streaming=false,generation=0,previewRadius=18,mapErrorCount=0,toastTimer,completing=false,fpsSamples=[];
const num=v=>Math.round(v).toLocaleString('ru-RU');
const time=v=>`${String(Math.floor(v/60)).padStart(2,'0')}:${String(Math.floor(v%60)).padStart(2,'0')}`;
function toast(text,long=false){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),long?8000:4000);}
const saves=new SaveSystem(text=>toast(text,true));
const renderer=new MapRenderer(message=>{if(++mapErrorCount<3)toast('Не удалось загрузить часть фоновой карты. Проверь соединение.',true);console.warn(message);});
const audio=new AudioSystem();
let settings={sound:true,quality:'high'};try{settings={...settings,...JSON.parse(localStorage.getItem('city-eater-settings')||'{}')};}catch{}
function saveSettings(){try{localStorage.setItem('city-eater-settings',JSON.stringify(settings));}catch{}}
function applySettings(){audio.enabled=settings.sound;$('#sound-toggle').textContent=settings.sound?'Вкл':'Выкл';$('#sound-toggle').setAttribute('aria-pressed',String(settings.sound));$('#quality').value=settings.quality;renderer.setQuality(settings.quality);}
const input=new HoleController(()=>state==='playing',()=>{if(state==='playing')pause();else if(state==='paused')resume();});
function showScreen(id){for(const el of document.querySelectorAll('.screen'))el.classList.toggle('hidden',el.id!==id);const playing=['playing','paused','result'].includes(state);$('#hud').classList.toggle('hidden',!playing);$('#game-bottom').classList.toggle('hidden',state!=='playing');$('#pause').classList.toggle('hidden',!['playing','paused'].includes(state));document.body.dataset.state=state;}
function renderLevels(){
  $('#levels').innerHTML=catalog.map((level,i)=>`<button class="level ${i===levelIndex?'selected':''}" data-index="${i}" ${i>unlocked?'disabled':''}><span class="level-index">${String(i+1).padStart(2,'0')}</span><span class="level-name"><strong>${level.title}</strong><small>${i>unlocked?'Пройди предыдущий город':level.subtitle||'Настоящий город · 100 км²'}</small></span><span class="level-symbol">${i>unlocked?'⊗':i===levelIndex?'↗':'→'}</span></button>`).join('');
  $('#level-number').textContent=`${String(levelIndex+1).padStart(2,'0')} / ${String(catalog.length).padStart(2,'0')}`;
  for(const button of document.querySelectorAll('.level'))button.onclick=()=>{if(Number(button.dataset.index)!==levelIndex)selectLevel(Number(button.dataset.index));};
}
async function fetchJSON(url){const response=await fetch(url);if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}`);return response.json();}
async function selectLevel(index,{restart=false,start=false}={}){
  const token=++generation;levelIndex=index;state='loading';input.reset();showScreen('menu');renderLevels();$('#loading').classList.remove('hidden');$('#play').disabled=true;document.querySelector('#startup-error')?.remove();animations=[];repo?.dispose();
  try{
    const entry=catalog[index],manifestUrl=new URL(entry.manifest||`./${entry.id}/manifest.json`,new URL('./data/',location.href));
    const nextManifest=await fetchJSON(manifestUrl);if(token!==generation)return;
    nextManifest.id??=entry.id;nextManifest.title??=entry.title;const base=new URL('.',manifestUrl);
    let saved=restart?null:await saves.getRun(nextManifest.id);
    if(saved&&!compatibleSave(saved,nextManifest)){toast('Карта обновилась. Это прохождение сброшено, личные рекорды сохранены.',true);await saves.deleteRun(nextManifest.id);saved=null;}
    manifest=nextManifest;run=createRun(manifest,saved);simulationTime=run.elapsed*1000;previewRadius=run.radius;completing=false;
    repo=new BuildingRepository(manifest,base,run.consumed,()=>renderer.setBuildings(repo?.features(new Set(animations.map(a=>a.building.id)))));
    await renderer.load(manifest,base);if(token!==generation)return;
    await repo.update(run.position,run.radius);if(token!==generation)return;
    renderer.setBuildings(repo.features());renderer.setRadius(run.radius);$('#hud-level').textContent=manifest.title;$('#target-value').textContent=manifest.targetPercent??manifest.target??80;
    state='menu';showScreen('menu');$('#play').disabled=false;$('#play').innerHTML=`${saved&&!run.completed?'Продолжить':'Поглотить город'} <span class="button-arrow">↗</span>`;
    updateHUD();await saves.selectLevel(manifest.id).catch(()=>{});if(restart)await persist();if(start)await play();
  }catch(error){console.error(error);state='menu';showScreen('menu');const webgl=/webgl|graphics context|initialize.*gl/i.test(error.message||'');$('#play').disabled=webgl;$('#play').innerHTML=webgl?'WebGL недоступен':'Повторить загрузку <span>↻</span>';if(webgl){const note=document.createElement('p');note.id='startup-error';note.className='startup-error';note.setAttribute('role','alert');note.textContent='В этом браузере отключена или недоступна 3D-графика WebGL. Для карты нужен WebGL 2. Открой игру в другом современном браузере или на устройстве, где WebGL доступен.';$('.menu-actions').append(note);}else toast('Город не загрузился. Проверь соединение и повтори попытку.',true);repo=null;}
  finally{if(token===generation)$('#loading').classList.add('hidden');}
}
async function play(){if(!repo||!renderer.ready){await selectLevel(levelIndex,{start:true});return;}if(run.completed){await selectLevel(levelIndex,{restart:true,start:true});return;}audio.unlock();state='playing';input.reset();showScreen(null);lastTime=performance.now();$('#pause').focus({preventScroll:true});}
function pause(note='Прогресс сохраняется автоматически.'){if(state!=='playing')return;state='paused';input.reset();$('#pause-note').textContent=note;showScreen('pause-screen');persist();$('#resume').focus({preventScroll:true});}
function resume(){if(state!=='paused')return;audio.unlock();state='playing';showScreen(null);lastTime=performance.now();}
async function persist(){if(run&&manifest){try{await saves.saveRun(serializeRun(run));}catch{}}}
function updateHUD(){if(!run||!manifest)return;const percent=progressPercent(run,manifest);$('#progress-value').textContent=percent.toFixed(2);$('#progress-fill').style.width=`${Math.min(100,percent)}%`;$('#radius-value').innerHTML=`${num(run.radius)} <small>м</small>`;$('#count-value').textContent=num(run.consumed.size);$('#score-value').textContent=num(run.score);$('#time-value').textContent=time(run.elapsed);$('#mini-player').style.left=`${(run.position[0]+5000)/100}%`;$('#mini-player').style.top=`${(5000-run.position[1])/100}%`;
  if(state==='playing'&&repo){let nearest=null,distance=Infinity;for(const b of repo.buildings.values()){if(b.radius>run.radius*1.06)continue;const d=Math.hypot(b.center[0]-run.position[0],b.center[1]-run.position[1]);if(d<distance){nearest=b;distance=d;}}
  $('#target-hint').innerHTML=nearest&&distance>run.radius*1.8?`<span style="transform:rotate(${Math.atan2(nearest.center[0]-run.position[0],nearest.center[1]-run.position[1])*180/Math.PI}deg)">↑</span> ЦЕЛЬ · ${num(distance)} М`:run.consumed.size<4?'Светлые здания уже тебе по размеру':'';}
}
async function complete(){if(completing)return;completing=true;state='result';input.reset();showScreen('result');await persist();unlocked=Math.max(unlocked,levelIndex+1);await saves.unlock(unlocked).catch(()=>{});const old=await saves.getRecord(manifest.id).catch(()=>null),record=mergeRecord(old,run,manifest);await saves.saveRecord(manifest.id,record).catch(()=>{});$('#result-place').textContent=`${manifest.title} · ${progressPercent(run,manifest).toFixed(2)}% площади зданий`;
  $('#result-stats').innerHTML=[['ПОГЛОЩЕНО',`${(run.consumedArea/1e6).toFixed(2)} км²`],['ЗДАНИЯ',num(run.consumed.size)],['ВРЕМЯ',time(run.elapsed)],['ОЧКИ',num(run.score)],['МАКС. РАДИУС',`${num(run.radius)} м`],['ПРОГРЕСС',`${progressPercent(run,manifest).toFixed(2)}%`]].map(([label,value])=>`<div><span>${label}</span><b>${value}</b></div>`).join('');$('#record').textContent=!old||run.elapsed<old.elapsed?`✦ Новый личный рекорд · ${time(run.elapsed)}`:`Личный рекорд · ${time(record.elapsed)}`;
  $('#next-level').classList.toggle('hidden',levelIndex+1>=catalog.length);$('#next-level').textContent=levelIndex+1<catalog.length?`Дальше: ${catalog[levelIndex+1].title} ↗`:'';renderLevels();
}
function tick(now){const rawDelta=Math.max(0,(now-lastTime)/1000),dt=Math.min(.04,rawDelta);lastTime=now;fpsSamples.push(rawDelta);if(fpsSamples.length>60)fpsSamples.shift();
  if(state==='playing'&&run&&repo){simulationTime+=dt*1000;run.elapsed+=dt;const direction=input.direction();
    const speed=95+Math.min(1400,run.radius*.75),delta=[direction[0]*speed*dt,direction[1]*speed*dt];
    const nearby=repo.near(run.position,run.radius+Math.hypot(...delta)+100);
    const proposed=[run.position[0]+delta[0],run.position[1]+delta[1]];
    const covered=repo.covers(proposed,run.radius+30);
    const next=resolveMotion(run.position,covered?delta:[0,0],run.radius,nearby,5000);run.position=next.position;
    $('#network').classList.toggle('hidden',covered);
    const absorbed=new Set(animations.map(a=>a.building.id));let didStart=false;
    if(!run.completed)for(const b of repo.near(run.position,run.radius*1.06)){
      if(animations.length>=(settings.quality==='low'?10:28))break;
      if(!absorbed.has(b.id)&&b.radius<=run.radius*1.06&&polygonFitsCircle(b.polygons,run.position,run.radius,1.06)){animations.push({building:b,started:simulationTime,duration:420});absorbed.add(b.id);didStart=true;}
    }
    let changed=false;animations=animations.filter(animation=>{if(simulationTime-animation.started<animation.duration)return true;if(consumeBuilding(run,animation.building,manifest)){repo.consume(animation.building.id);audio.absorb(run.radius);changed=true;}return false;});
    if(changed){renderer.setRadius(run.radius);renderer.setBuildings(repo.features(new Set(animations.map(a=>a.building.id))));persist();}
    else if(didStart)renderer.setBuildings(repo.features(absorbed));
    if(run.completed&&animations.length===0)complete();
    if(now-lastStream>450&&!streaming){lastStream=now;streaming=true;const current=repo;current.update(run.position,run.radius,direction).catch(error=>{if(current===repo){pause('Часть района не загрузилась. Проверь интернет и продолжи.');toast(error.message,true);}}).finally(()=>{streaming=false;$('#network').classList.add('hidden');});}
    if(now-lastSave>2000){lastSave=now;persist();}
    renderer.camera(run.position,run.radius,dt);renderer.render(run,animations,simulationTime,direction);
  }else if(run&&renderer.ready){if(state==='menu')renderer.camera(run.position,run.radius,dt);renderer.render(run,animations,simulationTime);}
  if(now-lastUI>120){lastUI=now;updateHUD();if(new URLSearchParams(location.search).has('test'))$('#fps').textContent=`${Math.round(fpsSamples.length/(fpsSamples.reduce((a,b)=>a+b,0)||1))} fps | ${repo?.buildings.size||0} objects | ${repo?.chunks.size||0} chunks`;}
  requestAnimationFrame(tick);
}
$('#play').onclick=play;$('#pause').onclick=()=>state==='playing'?pause():resume();$('#resume').onclick=resume;
$('#to-menu').onclick=()=>{state='menu';showScreen('menu');renderLevels();$('#play').innerHTML='Продолжить <span>↗</span>';persist();};
$('#restart').onclick=()=>{if(confirm('Начать этот город заново? Текущее прохождение будет заменено. Рекорд останется.'))selectLevel(levelIndex,{restart:true,start:true});};
$('#replay').onclick=()=>selectLevel(levelIndex,{restart:true,start:true});$('#next-level').onclick=()=>selectLevel(levelIndex+1,{start:true});$('#result-menu').onclick=()=>{state='menu';showScreen('menu');$('#play').innerHTML='Поглотить город <span>↗</span>';renderLevels();};
$('.brand').onclick=e=>{e.preventDefault();if(state==='playing')pause();else if(state==='paused'){$('#to-menu').click();}};
$('#sound-toggle').onclick=()=>{settings.sound=!settings.sound;applySettings();saveSettings();audio.unlock();};$('#quality').onchange=e=>{settings.quality=e.target.value;applySettings();saveSettings();};
$('#about-open').onclick=()=>{$('#about').classList.remove('hidden');};$('#about-close').onclick=()=>$('#about').classList.add('hidden');
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause('Игра была приостановлена, пока вкладка была скрыта.');});
window.addEventListener('pagehide',()=>persist());
window.addEventListener('keydown',e=>{if(e.code==='Escape'&&!$('#about').classList.contains('hidden'))$('#about').classList.add('hidden');});
applySettings();showScreen('menu');requestAnimationFrame(tick);
(async()=>{try{await saves.init();unlocked=await saves.unlocked();const data=await fetchJSON(new URL('./data/catalog.json',location.href));catalog=data.levels;const lastLevel=await saves.lastLevel(),lastIndex=catalog.findIndex(level=>level.id===lastLevel);renderLevels();await selectLevel(lastIndex>=0&&lastIndex<=unlocked?lastIndex:0);}catch(error){console.error(error);toast('Данные города недоступны. Обнови страницу после проверки интернета.',true);$('#play').textContent='Обновить страницу';$('#play').disabled=false;$('#play').onclick=()=>location.reload();}})();
// Explicit query-gated diagnostics, useful for verifying real-data persistence and geometry.
if(new URLSearchParams(location.search).has('test')){window.__cityEater={snapshot:()=>({state,levelIndex,manifest,run:run?serializeRun(run):null,loadedIds:repo?[...repo.buildings.keys()]:[],chunks:repo?[...repo.chunks.keys()]:[],animations:animations.length}),get game(){return{run,repo,manifest,renderer};},pause,resume,persist,selectLevel,play,async moveTo(position){if(!run)return;run.position=position;await repo.update(position,run.radius);renderer.camera(position,run.radius,10);renderer.setBuildings(repo.features());},async absorb(id){const b=repo.buildings.get(id);if(b&&consumeBuilding(run,b,manifest)){repo.consume(id);renderer.setBuildings(repo.features());renderer.setRadius(run.radius);await persist();return true;}return false;}};$('#fps').classList.remove('hidden');}
if(new URLSearchParams(location.search).has('test')){
  const panel=document.createElement('details');panel.id='qa-panel';panel.className='panel';panel.innerHTML='<summary>QA controls</summary><small>Test mode changes this browser’s progress using real OSM IDs.</small><button data-qa="nearest">Nearest edible</button><button data-qa="stream">Stream away / back</button><button data-qa="save">Save checkpoint</button><button data-qa="goal">Reach goal (real IDs)</button><pre id="qa-status">Ready</pre>';$('#app').append(panel);
  panel.addEventListener('click',async event=>{const action=event.target.dataset.qa;if(!action||!run||!repo)return;const button=event.target;button.disabled=true;const status=$('#qa-status');try{
    if(action==='nearest'){const b=[...repo.buildings.values()].filter(b=>b.radius<=run.radius*1.06).sort((a,b)=>Math.hypot(a.center[0]-run.position[0],a.center[1]-run.position[1])-Math.hypot(b.center[0]-run.position[0],b.center[1]-run.position[1]))[0];if(!b)throw new Error('No edible building loaded');await window.__cityEater.moveTo([...b.center]);if(state==='paused')resume();if(state==='menu')await play();status.textContent=`Target ${b.id}, ${b.area} m²`;}
    if(action==='stream'){const p=[...run.position],s=state;if(s==='playing')pause();await window.__cityEater.moveTo([-4200,-4200]);await window.__cityEater.moveTo(p);if(s==='playing')resume();status.textContent=`Streamed away/back. Consumed: ${run.consumed.size}. Loaded: ${repo.buildings.size}`;}
    if(action==='save'){await persist();status.textContent=JSON.stringify({level:run.levelId,consumed:run.consumed.size,area:run.consumedArea,score:run.score,radius:run.radius,version:run.version},null,2);}
    if(action==='goal'){if(state==='playing')pause();for(const chunk of manifest.chunks){const data=await fetchJSON(new URL(chunk.url,repo.baseUrl));for(const b of data.buildings){consumeBuilding(run,b,manifest);if(run.completed)break;}status.textContent=`Real OSM IDs consumed: ${run.consumed.size}`;if(run.completed)break;}animations=[];renderer.setRadius(run.radius);renderer.setBuildings(repo.features());await complete();status.textContent=`Goal ${progressPercent(run,manifest).toFixed(2)}%; ${run.consumed.size} real OSM buildings`;}
  }catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
}
