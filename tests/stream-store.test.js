import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {StreamStore,STREAM_DB_NAME} from '../src/stream-store.js';
import {createStreamRun,STREAM_MODE,STREAM_SCHEMA_VERSION,rewardStreamArea} from '../src/streaming-state.js';
import {MASK_CHUNK_BYTES,countMaskBits} from '../src/consumption-mask.js';

const sector={id:'square',center:[30,60]};
const cell=()=>{const bits=new Uint8Array(MASK_CHUNK_BYTES);bits[0]=1;return bits;};
const fresh=()=>{globalThis.indexedDB=new IDBFactory();return new StreamStore();};
const open=(name)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('legacy');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const write=(db,key,value)=>new Promise((resolve,reject)=>{const t=db.transaction('legacy','readwrite');t.objectStore('legacy').put(value,key);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});
const read=(db,key)=>new Promise((resolve,reject)=>{const t=db.transaction('legacy','readonly'),r=t.objectStore('legacy').get(key);t.oncomplete=()=>resolve(r.result);t.onerror=()=>reject(t.error);});

test('3km store leaves 5km and 10km saves intact and starts progress in a separate database',async()=>{
  const store=fresh(),oldStream=await open('city-eater-stream-v1'),oldGame=await open('city-eater-v1');
  const oldFiveKm=await open('city-eater-stream-5km-v2'),oldBytes=new Uint8Array(MASK_CHUNK_BYTES).fill(165);
  const oldSave={mode:'tile-mask-5km-v2',schemaVersion:2,area:400,position:[2500,-2500],bits:oldBytes};
  await write(oldStream,'square',{area:42,version:'10km'});await write(oldGame,'square',{buildingIds:['w1']});
  await write(oldFiveKm,'square',oldSave);
  assert.equal(STREAM_DB_NAME,'city-eater-land-3km-v4');
  assert.deepEqual(await store.progress(),[]);assert.deepEqual(await store.load(sector.id),{run:null,masks:[]});
  const run=createStreamRun(sector);rewardStreamArea(run,4);await store.save(run,[['0,0',cell()]]);await store.reset(sector.id);
  assert.deepEqual(await read(oldStream,'square'),{area:42,version:'10km'});assert.deepEqual(await read(oldGame,'square'),{buildingIds:['w1']});
  assert.deepEqual(await read(oldFiveKm,'square'),oldSave);
  const names=(await indexedDB.databases()).map(db=>db.name);
  for(const name of [STREAM_DB_NAME,'city-eater-stream-5km-v2','city-eater-stream-v1','city-eater-v1'])assert.ok(names.includes(name));
  oldStream.close();oldGame.close();oldFiveKm.close();store.db.close();
});
test('store persists fixed-goal progress and detaches masks/run before asynchronous init',async()=>{
  const store=fresh(),init=store.init.bind(store);let resolve;const wait=new Promise(r=>resolve=r);store.init=async()=>{await wait;return init();};
  const run=createStreamRun(sector),bits=cell();rewardStreamArea(run,4);
  const save=store.save(run,[['0,0',bits]]);run.consumedArea=8;run.position[0]=50;run.frame.center[0]=31;bits[0]=3;resolve();await save;
  const saved=await store.load(sector.id);assert.equal(saved.run.consumedArea,4);assert.equal(saved.run.position[0],0);assert.equal(saved.run.frame.center[0],30);assert.equal(saved.masks[0].bits[0],1);
  assert.equal(saved.run.mode,STREAM_MODE);assert.equal(saved.run.schemaVersion,STREAM_SCHEMA_VERSION);assert.equal(saved.run.goalArea,100000);assert.equal(saved.run.completed,false);
  assert.equal((await store.progress()).length,1);store.db.close();
});
test('invalid mode, schema or any later mask rejects save before overwriting persisted state',async()=>{
  const store=fresh(),run=createStreamRun(sector);rewardStreamArea(run,4);await store.save(run,[['0,0',cell()]]);
  const changed={...run,consumedArea:8};
  for(const [snapshot,chunks] of [
    [{...changed,mode:'tile-mask-v1'},[['0,0',cell()]]],
    [{...changed,schemaVersion:1},[['0,0',cell()]]],
    [{...changed,mode:'tile-mask-5km-v2',schemaVersion:2},[['0,0',cell()]]],
    [{...changed,frame:{...changed.frame,arenaSize:10000}},[['0,0',cell()]]],
    [changed,[['0,0',cell()],['0,0',cell()]]],
    [changed,[['0,0',cell()],['10,0',cell()]]],
    [changed,[['0,0',cell()],['6,0',cell()]]],
    [changed,[['0,0',cell()],['9,9',cell()]]],
    [changed,[['0,0',cell()],['1,0',new Uint8Array(10)]]],
  ]){
    await assert.rejects(store.save(snapshot,chunks));const saved=await store.load(sector.id);assert.equal(saved.run.consumedArea,4);assert.equal(saved.masks.length,1);assert.equal(saved.masks[0].bits[0],1);
  }
  store.db.close();
});
test('saved edge masks have zero padding and reset affects only its own district',async()=>{
  const store=fresh(),a=createStreamRun(sector),b=createStreamRun({...sector,id:'other'});
  await store.save(a,[['5,5',new Uint8Array(MASK_CHUNK_BYTES).fill(255)]]);await store.save(b,[['0,0',cell()]]);
  const loaded=await store.load(sector.id);assert.equal(countMaskBits(loaded.masks[0].bits),220*220);
  await store.reset(sector.id);assert.deepEqual(await store.load(sector.id),{run:null,masks:[]});assert.equal((await store.load('other')).masks.length,1);assert.equal((await store.progress()).length,1);store.db.close();
});

test('a transaction failure after queuing the run rolls back both run and mask',async()=>{
  const store=fresh(),run=createStreamRun(sector);rewardStreamArea(run,4);await store.save(run,[['0,0',cell()]]);
  const transaction=store.db.transaction.bind(store.db);
  store.db.transaction=(names,mode)=>{
    const t=transaction(names,mode);
    if(mode==='readwrite'){
      const objectStore=t.objectStore.bind(t);
      t.objectStore=name=>{
        if(name==='masks')throw new DOMException('Simulated disk failure','QuotaExceededError');
        return objectStore(name);
      };
    }
    return t;
  };
  rewardStreamArea(run,4);await assert.rejects(store.save(run,[['0,0',new Uint8Array(MASK_CHUNK_BYTES).fill(3)]]),{name:'QuotaExceededError'});
  store.db.transaction=transaction;const old=await store.load(sector.id);assert.equal(old.run.consumedArea,4);assert.equal(old.masks[0].bits[0],1);
  await store.save(run,[['0,0',cell()]]);assert.equal((await store.load(sector.id)).run.consumedArea,8);store.db.close();
});
