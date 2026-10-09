import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MapExplorer} from '../src/map-explorer.js';
import {lonLatToLocal,localToLonLat} from '../src/geometry.js';
import {advanceHole} from '../src/motion.js';

// Execute the actual application entry function, not a parallel model of it.
const source=fs.readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
const entrySource=source.slice(source.indexOf('async function selectLevel('),source.indexOf('\nasync function play()'));
const emptySource=source.slice(source.indexOf('async function showEmptySector('),source.indexOf('\napplySettings();'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(stage,{custom=true,restart=false,incompatible=false,empty=false,error=false}={}){
  const wait=deferred(),reached=deferred(),calls=[];let held=false,persists=0;
  const hold=(name,value)=>{calls.push(name);if(name===stage&&!held){held=true;reached.resolve();return wait.promise.then(()=>value);}return Promise.resolve(value);};
  const cls={add(){},remove(){},toggle(){}},node={classList:cls,setAttribute(){},append(){},remove(){},focus(){},style:{}};
  const manifest={id:'cell',title:'Test',center:[30,60],spawn:[0,0],initialRadius:18,buildingCount:empty?0:1,totalBuildingArea:100,version:'test',chunks:[],targetPercent:80};
  const campaign={id:'campaign',sectors:[{id:'cell'}]};
  const context={URL,DOMException,console:{error(){},warn(){}},location:{href:'https://example.test/game/'},performance:{now:()=>1},document:{hidden:false,body:node,querySelector:()=>node},$:()=>node,
    generation:0,state:'map',hintCandidates:[],levelIndex:0,manifest:null,run:null,repo:null,animations:[],simulationTime:0,previewRadius:18,completing:false,
    catalog:[{id:'cell',title:'Test',center:[30,60],custom}],activeCampaign:campaign,input:{reset(){}},absorption:{reset(){},animations:[]},
    persist:()=>hold(persists++?'restart-save':'previous-save'),showScreen(){},renderLevels(){},toast(){},updateHUD(){},updateNextButton(){},confirm:()=>true,
    fetchJSON:()=>hold('metadata',manifest),
    sectorLoader:{load:()=>hold('download-normalize-cache',{manifest})},
    cityCache:{getCampaign:()=>hold('campaign-readback',campaign),loadChunk(){},updateProgress:()=>hold(error?'error-progress':'empty-progress',campaign)},
    saves:{getRun:()=>hold('saved-run',incompatible?{version:'old'}:null),deleteRun:()=>hold('incompatible-delete'),selectLevel:()=>hold('selected-level-save')},
    compatibleSave:()=>!incompatible,
    createRun:()=>({levelId:'cell',position:[0,0],radius:18,elapsed:0,consumed:new Set(),completed:false}),
    lonLatToLocal,localToLonLat,advanceHole,cameraMetrics:()=>({zoom:16}),
    renderer:{width:390,height:844,ready:true,load:()=>error?Promise.reject(new Error('Renderer test error')):hold('renderer'),syncBuildings(){},setRadius(){},dispose(){}},
    mapExplorer:{setLoading(){},alignEntry(){},hide(){calls.push('hide');},cancelSelection(){},finishEntry:()=>hold('view-transition')},
    play:async()=>{calls.push('start-game');context.state='playing';},
  };
  context.BuildingRepository=class{setViewport(){}update(){return hold('nearby-chunks');}dispose(){}};
  vm.createContext(context);vm.runInContext(entrySource+'\n'+emptySource,context);
  return{context,calls,wait,reached,run:()=>context.selectLevel(0,{start:true,fromMap:true,restart,entryPoint:[30,60]})};
}
const cases=[
 ['previous-save',{}],['metadata',{custom:false}],['download-normalize-cache',{}],['campaign-readback',{}],['saved-run',{}],
 ['incompatible-delete',{incompatible:true}],['renderer',{}],['nearby-chunks',{}],['selected-level-save',{}],
 ['restart-save',{restart:true}],['view-transition',{}],['empty-progress',{empty:true}],['error-progress',{error:true}],
];
for(const [stage,options] of cases)test(`actual entry rejects stale results after ${stage}`,async()=>{
 const f=fixture(stage,options),pending=f.run();await f.reached.promise;
 f.context.generation++;const nextRun={id:'replacement-run'},nextManifest={id:'replacement-manifest'},nextCampaign={id:'replacement-campaign'};
 Object.assign(f.context,{state:'new-selection',run:nextRun,manifest:nextManifest,activeCampaign:nextCampaign});
 f.wait.resolve();await pending;
 assert.equal(f.context.state,'new-selection',stage);assert.equal(f.context.run,nextRun);assert.equal(f.context.manifest,nextManifest);assert.equal(f.context.activeCampaign,nextCampaign);
 assert.ok(!f.calls.includes('start-game'),`${stage}: old selection started gameplay`);
});
test('actual successful entry starts only after complete data, local chunks, checkpoint and transition',async()=>{
 const f=fixture(null);await f.run();assert.equal(f.context.state,'playing');
 for(const stage of ['download-normalize-cache','campaign-readback','saved-run','renderer','nearby-chunks','selected-level-save','view-transition'])assert.ok(f.calls.indexOf(stage)<f.calls.indexOf('start-game'));
});
test('cancelled delayed map fade cannot hide or disable a replacement selection',async()=>{
 const wait=deferred(),classes=new Set(),element={inert:false,classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v)}};let hides=0,current=true;
 const picker={selectionGeneration:1,element,setBusy(){},hide(){hides++;}};
 const pending=MapExplorer.prototype.finishEntry.call(picker,{isCurrent:()=>current,wait:()=>wait.promise});
 current=false;picker.selectionGeneration++;element.inert=false;classes.delete('leaving');wait.resolve();
 assert.equal(await pending,false);assert.equal(hides,0);assert.equal(element.inert,false);
});
test('completed delayed map fade hides exactly once when it still owns entry',async()=>{
 let hides=0;const picker={selectionGeneration:3,element:{classList:{add(){}},inert:false},setBusy(){},hide(){hides++;}};
 assert.equal(await MapExplorer.prototype.finishEntry.call(picker,{wait:async()=>{}}),true);assert.equal(hides,1);
});
