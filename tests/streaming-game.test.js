import test from 'node:test';import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {StreamingGame} from '../src/streaming-game.js';
import {StreamStore} from '../src/stream-store.js';
import {createStreamRun,rewardStreamArea} from '../src/streaming-state.js';
import {rasterizeCoverageChunk,maskChunksForBounds} from '../src/consumption-mask.js';
import {TileStream} from '../src/tile-stream.js';
globalThis.indexedDB=indexedDB;
const sector={id:'stream-test',center:[30,60],arenaSize:10000};
const rect=[[[-5000,-5000],[5000,-5000],[5000,5000],[-5000,5000],[-5000,-5000]]];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
function fixture({store=new StreamStore(),id=sector.id}={}){
 const changed=[],game=new StreamingGame({sector:{...sector,id},store,displayFactory:()=>({changed:key=>changed.push(key),dispose(){}}),streamFactory:({mask})=>({metadata:{tiles:[]},source:{stats:{}},stats:{},async prepare(p,r){for(const key of maskChunksForBounds([p[0]-r-100,p[1]-r-100,p[0]+r+100,p[1]+r+100]))mask.ingestCoverage(key,rasterizeCoverageChunk(key,[rect]));},async update(){},covers:()=>true,dispose(){},async retry(){}})});return{game,changed};
}
test('stream game atomically saves masks and run; a cold instance cannot reward the same ground',async()=>{
 const {game}=fixture({id:'cold'});await game.prepare();const result=game.tick(.02,100,[0,0]);assert.ok(result.area>0);await game.persist();const area=game.run.consumedArea;game.dispose();
 const next=fixture({id:'cold'}).game;await next.prepare();assert.equal(next.mask.consumedAreaM2,area);assert.equal(next.run.consumedArea,area);const original=next.run.radius;next.run.radius=18;assert.equal(next.tick(.02,100,[0,0]).area,0);next.run.radius=original;next.dispose();
});
test('no scan for stationary unchanged coverage/radius after current shape completes',async()=>{
 const {game}=fixture({id:'stationary'});await game.prepare();game.tick(.02,1,[0,0]);game.tick(.02,2,[0,0]);game.tick(.02,3,[0,0]);game.lastScan={radius:game.run.radius,revision:game.mask.coverageRevision};let calls=0;game.mask.consumeSweep=()=>{calls++;throw new Error('Unnecessary scan');};game.tick(.02,4,[0,0]);assert.equal(calls,0);game.dispose();
});
test('maximum radius uses actual TileStream coverage contract without exceeding its cap',async()=>{
 const {game}=fixture({id:'cap'});await game.prepare();rewardStreamArea(game.run,5000000);const coverage=new Map(maskChunksForBounds([-600,-600,600,600]).map(key=>[key,true]));game.stream.covers=(p,r)=>TileStream.prototype.covers.call({disposed:false,coverage},p,r);assert.doesNotThrow(()=>game.tick(.02,1,[1,0]));assert.equal(game.run.radius,500);game.dispose();
});
test('unknown frontier stops motion without awarding missing building coverage',async()=>{
 const {game}=fixture({id:'unknown'});await game.prepare();for(const key of game.mask.coverage.keys())game.mask.evictCoverage(key);game.stream.covers=()=>false;const p=[...game.run.position],result=game.tick(.02,1,[1,0]);assert.deepEqual(game.run.position,p);assert.equal(result.area,0);assert.equal(result.blocked,true);game.dispose();
});
test('cancel during save readback never prepares native tiles',async()=>{
 const wait=deferred();let prepared=0;const {game}=fixture({store:{load:()=>wait.promise}});game.stream.prepare=async()=>prepared++;const pending=game.prepare();game.dispose();wait.resolve({run:null,masks:[]});await assert.rejects(pending,{name:'AbortError'});assert.equal(prepared,0);
});
test('failed checkpoint restores dirty chunks for a later atomic retry',async()=>{
 let fail=true,writes=[];const store={load:async()=>({run:null,masks:[]}),save:async(run,chunks)=>{writes.push({run,chunks});if(fail)throw new Error('quota');}};const {game}=fixture({store});await game.prepare();game.tick(.02,1,[0,0]);await assert.rejects(game.persist(),/quota/);assert.ok(game.mask.dirtyConsumed.size>0);fail=false;await game.persist();assert.equal(game.mask.dirtyConsumed.size,0);assert.equal(writes[1].run.consumedArea,game.mask.consumedAreaM2);assert.ok(writes[1].chunks.size>0);game.dispose();
});
test('save snapshots are detached before asynchronous database initialization',async()=>{
 const store=new StreamStore(),wait=deferred(),init=store.init.bind(store);store.init=async()=>{await wait.promise;return init();};const run=createStreamRun({...sector,id:'snapshot'}),bits=new Uint8Array(8192);bits[0]=1;run.consumedArea=4;const pending=store.save(run,new Map([['0,0',bits]]));run.consumedArea=8;bits[0]=3;wait.resolve();await pending;const saved=await store.load('snapshot');assert.equal(saved.run.consumedArea,4);assert.equal(saved.masks[0].bits[0],1);
});
test('new-mode DB does not create or modify legacy game stores',async()=>{
 const databases=await indexedDB.databases();assert.ok(databases.some(db=>db.name==='city-eater-stream-v1'));assert.ok(!databases.some(db=>db.name==='city-eater-v1'));
});
test('restore rejects future schemas, malformed coordinates and corrupt area',()=>{
 const saved=createStreamRun(sector);for(const patch of [{schemaVersion:2},{position:[0]},{position:[NaN,0]},{consumedArea:-4},{consumedArea:1},{consumedArea:Infinity},{elapsed:-1},{frame:{...saved.frame,center:[]}}])assert.throws(()=>createStreamRun(sector,{...saved,...patch}),/несовместимы/);
});
