import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {SaveSystem} from '../src/storage.js';
test('IndexedDB survives a new SaveSystem instance, retains records and unlocks monotonically',async()=>{const a=await new SaveSystem().init();await a.saveRun({levelId:'qa',version:'osm-v1',consumed:['way/1'],mass:12});await a.saveRecord('qa',{elapsed:40});await a.selectLevel('gatchina');await a.unlock(2);await a.unlock(1);const b=await new SaveSystem().init();assert.deepEqual(await b.getRun('qa'),{levelId:'qa',version:'osm-v1',consumed:['way/1'],mass:12});assert.equal((await b.getRecord('qa')).elapsed,40);assert.equal(await b.unlocked(),2);assert.equal(await b.lastLevel(),'gatchina');await b.deleteRun('qa');assert.equal(await a.getRun('qa'),undefined);assert.equal((await a.getRecord('qa')).elapsed,40);a.db.close();b.db.close();});
