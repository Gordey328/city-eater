import test from 'node:test';
import assert from 'node:assert/strict';
import {sectorPageBounds} from '../src/sector-pagination.js';
test('every sector is reachable in pages of at most nine, including a1600-sector campaign',()=>{
 for(const total of [0,1,4,9,10,18,19,1600]){
  const seen=[];
  for(let p=0;p<Math.max(1,Math.ceil(total/9));p++){const b=sectorPageBounds(total,p);assert.equal(b.page,p);assert.ok(b.end-b.start<=9);for(let i=b.start;i<b.end;i++)seen.push(i);}
  assert.deepEqual(seen,Array.from({length:total},(_,i)=>i));
 }
});
test('page bounds clamp safely and first-unfinished page remains deterministic',()=>{
 assert.deepEqual(sectorPageBounds(14,0),{page:0,pages:2,start:0,end:9,total:14});
 assert.deepEqual(sectorPageBounds(14,1),{page:1,pages:2,start:9,end:14,total:14});
 assert.equal(sectorPageBounds(14,-3).page,0);assert.equal(sectorPageBounds(14,99).page,1);
 assert.equal(sectorPageBounds(100,Math.floor(27/9)).start,27);
 assert.equal(sectorPageBounds(0,99).start,0);
});
