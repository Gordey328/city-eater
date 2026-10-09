import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ConsumptionMask, createConsumptionMask, rasterizeCoverageChunk, countMaskBits,
  maskCellAt, maskChunkKey, parseMaskChunkKey, maskChunkBounds, maskChunksForBounds,
  MASK_CHUNK_BYTES, MASK_CELL_METRES, MASK_CELL_AREA_M2, MASK_GRID_SIZE,
  MASK_CHUNKS_PER_AXIS, MASK_CHUNK_COUNT, MASK_TOTAL_CELLS, MASK_ARENA_HALF, MASK_VERSION,
} from '../src/consumption-mask.js';
import {pointInPolygons} from '../src/geometry.js';

const rectangle=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
const full=()=>new Uint8Array(MASK_CHUNK_BYTES).fill(255);
const cellCentre=(gx,gy)=>[-2499+gx*2,-2499+gy*2];
function bitAt(bits,lx,ly) {const bit=ly*256+lx;return !!(bits[bit>>>3]&(1<<(bit&7)));}
function ingestPolygons(mask,polygons,bounds) {
  for(const key of maskChunksForBounds(bounds)) mask.ingestCoverage(key,rasterizeCoverageChunk(key,polygons));
}
function bruteCapsuleCount(from,to,radius,bounds) {
  const dx=to[0]-from[0],dy=to[1]-from[1],length2=dx*dx+dy*dy;
  let count=0;
  for(let gy=0;gy<2500;gy++) {
    const y=-2499+gy*2;if(y<bounds.minY||y>bounds.maxY) continue;
    for(let gx=Math.max(0,Math.ceil((bounds.minX+2499)/2));gx<=Math.min(2499,Math.floor((bounds.maxX+2499)/2));gx++) {
      const x=-2499+gx*2,t=length2?Math.max(0,Math.min(1,((x-from[0])*dx+(y-from[1])*dy)/length2)):0;
      if((x-from[0]-t*dx)**2+(y-from[1]-t*dy)**2<=radius**2+1e-9) count++;
    }
  }
  return count;
}

test('fixed 2 m cells use stable origin, canonical keys and half-open arena boundaries',()=>{
  assert.equal(MASK_CELL_METRES,2);assert.equal(MASK_CELL_AREA_M2,4);
  assert.deepEqual(maskCellAt([-2500,-2500]),{gx:0,gy:0,cx:0,cy:0,localX:0,localY:0,key:'0,0',bit:0});
  assert.equal(maskCellAt([-1988,-1988]).key,'1,1');
  assert.equal(maskCellAt([-0.001,-0.001]).gx,1249);assert.equal(maskCellAt([0,0]).gx,1250);
  assert.equal(maskCellAt([2499.999,2499.999]).key,'9,9');
  assert.equal(maskCellAt([2500,0]),null);assert.equal(maskCellAt([-2500.001,0]),null);
  assert.deepEqual(maskChunkBounds('9,9'),{minX:2108,minY:2108,maxX:2500,maxY:2500});
  assert.equal(maskChunkKey(8,9),'8,9');assert.equal(parseMaskChunkKey('8,9').index,98);
  for(const key of ['-1,0','0,-1','10,0','0,10','20,0','00,0','1,2junk','1.0,2']) assert.throws(()=>parseMaskChunkKey(key));
  assert.throws(()=>maskChunkKey(-1,0));assert.throws(()=>maskCellAt([NaN,0]));
  assert.deepEqual(maskChunksForBounds([6000,6000,7000,7000]),[]);
});

test('unknown coverage never earns area, known empty differs from unknown',()=>{
  const mask=createConsumptionMask();let result=mask.consumeCircle([0,0],20);
  assert.equal(result.newCells,0);assert.ok(result.unknownChunks.length);assert.equal(mask.consumedBytes,0);
  assert.equal(mask.isCoveredAt([0,0]),null);
  const key=maskCellAt([0,0]).key;mask.ingestCoverage(key,new Uint8Array(MASK_CHUNK_BYTES));
  assert.equal(mask.isCoveredAt([0,0]),false);assert.equal(mask.consumeCircle([0,0],20).newCells,0);
});

test('rasterization preserves holes and union of overlapping or duplicate footprints',()=>{
  const key='4,4',outer=rectangle(-30,-30,30,30),hole=rectangle(-10,-10,10,10);
  const donut=rasterizeCoverageChunk(key,[[outer,hole]]);
  assert.equal(countMaskBits(donut),900-100);
  const nestedHouse=[rectangle(-6,-6,6,6)];
  const union=rasterizeCoverageChunk(key,[[outer,hole],[outer,hole],nestedHouse]);
  assert.equal(countMaskBits(union),836);
  const reversed=rasterizeCoverageChunk(key,[[[...outer].reverse(),[...hole].reverse()],nestedHouse]);
  assert.deepEqual(union,reversed);
  const objects=[outer.map(([x,y])=>({x,y})),hole.map(([x,y])=>({x,y}))];
  assert.deepEqual(rasterizeCoverageChunk(key,[objects]),donut);
});

test('negative/chunk border polygons produce seamless half-open cells without duplicates',()=>{
  const polygons=[[rectangle(-1992,-1992,-1984,-1984)]];
  let count=0;
  for(const key of ['0,0','1,0','0,1','1,1']) count+=countMaskBits(rasterizeCoverageChunk(key,polygons));
  assert.equal(count,16);
  const halfOpen=rasterizeCoverageChunk('4,4',[[rectangle(-1,-1,3,3)]]);
  assert.equal(countMaskBits(halfOpen),4);
  const mask=new ConsumptionMask();mask.ingestCoverage('4,4',halfOpen);
  assert.equal(mask.isCoveredAt([-1,-1]),true);assert.equal(mask.isCoveredAt([3,3]),false);
});

test('partial building consumption rewards just new covered cells and exact dirty cell bounds',()=>{
  const mask=new ConsumptionMask(),polygons=[[rectangle(-40,-20,40,20)]];
  ingestPolygons(mask,polygons,[-40,-20,40,20]);
  const result=mask.consumeCircle([-30,0],6);
  const expected=bruteCapsuleCount([-30,0],[-30,0],6,{minX:-36,maxX:-24,minY:-6,maxY:6});
  assert.equal(result.newCells,expected);assert.ok(result.newCells<800);
  assert.equal(result.areaM2,expected*4);assert.equal(mask.consumedAreaM2,expected*4);
  assert.deepEqual(result.dirtyBounds,{minX:-36,minY:-6,maxX:-24,maxY:6});
  assert.equal(mask.isConsumedAt([-29,1]),true);assert.equal(mask.isConsumedAt([29,1]),false);
  assert.equal(mask.consumeCircle([-30,0],6).newCells,0);
  const rest=mask.consumeCircle([0,0],100);
  assert.equal(rest.newCells+result.newCells,800);
});

test('eviction/reload/source expansion cannot reward the same world cell twice',()=>{
  const mask=new ConsumptionMask();const key='4,4';
  mask.ingestCoverage(key,rasterizeCoverageChunk(key,[[rectangle(-10,-10,10,10)]]));
  assert.equal(mask.consumeCircle([0,0],100).newCells,100);
  mask.evictCoverage(key);assert.equal(mask.getCoverageChunk(key),null);
  assert.equal(mask.isConsumedAt([1,1]),true);assert.equal(mask.consumeCircle([0,0],100).newCells,0);
  mask.ingestCoverage(key,rasterizeCoverageChunk(key,[[rectangle(-20,-20,20,20)]]));
  assert.equal(mask.consumeCircle([0,0],100).newCells,300);
  mask.ingestCoverage(key,rasterizeCoverageChunk(key,[[rectangle(-20,-20,20,20)],[rectangle(-20,-20,20,20)]]));
  assert.equal(mask.consumeCircle([0,0],100).newCells,0);assert.equal(mask.consumedCells,400);
});

test('coverage input ownership and edge padding are safe even with unaligned arrays',()=>{
  const owner=new Uint8Array(MASK_CHUNK_BYTES+1).fill(255),input=owner.subarray(1);
  const mask=new ConsumptionMask();mask.ingestCoverage('9,9',input);input.fill(0);
  assert.equal(countMaskBits(mask.getCoverageChunk('9,9')),196*196);
  assert.equal(mask.consumeCircle([2499,2499],1000).newCells,196*196);
  assert.equal(mask.consumedBytes,MASK_CHUNK_BYTES);
});

for(const [from,to,radius] of [
  [[-90,0],[90,0],5], [[0,-90],[0,90],5], [[-85,-65],[79,53],7],
  [[79,53],[-85,-65],7], [[-5,-6],[2,15],0.5], [[1,1],[1,1],0],
  [[-91,-91],[91,91],0], [[-91,17],[13,17],0],
]) test(`continuous sweep agrees with point/segment distance: ${from} to ${to} r=${radius}`,()=>{
  const mask=new ConsumptionMask();
  const bounds={minX:Math.min(from[0],to[0])-radius,maxX:Math.max(from[0],to[0])+radius,
    minY:Math.min(from[1],to[1])-radius,maxY:Math.max(from[1],to[1])+radius};
  for(const key of maskChunksForBounds(bounds))mask.ingestCoverage(key,full());
  const result=mask.consumeSweep(from,to,radius);
  assert.equal(result.newCells,bruteCapsuleCount(from,to,radius,bounds));
  assert.equal(mask.consumeSweep(to,from,radius).newCells,0);
});

test('row/time budgets resume the exact sweep without missed or repeated rewards',()=>{
  const one=new ConsumptionMask(),batched=new ConsumptionMask();
  for(const key of maskChunksForBounds([-550,-550,550,550])) {one.ingestCoverage(key,full());batched.ingestCoverage(key,full());}
  const from=[-50,-30],to=[50,90],radius=500;
  const expected=one.consumeSweep(from,to,radius);let cursor=null,cells=0,batches=0;
  do {
    const result=batched.consumeSweep(from,to,radius,{maxRows:7,cursor});
    assert.ok(result.rows<=7);cells+=result.newCells;cursor=result.cursor;batches++;
    assert.equal(result.complete,cursor===null);
  } while(cursor);
  assert.ok(batches>50);assert.equal(cells,expected.newCells);assert.deepEqual(batched.serialize(),one.serialize());
  const timed=new ConsumptionMask();timed.ingestCoverage('4,4',full());
  const result=timed.consumeCircle([0,0],100,{maxMilliseconds:0});
  assert.equal(result.rows,1);assert.equal(result.complete,false);
  assert.throws(()=>timed.consumeCircle([1,0],100,{cursor:result.cursor}),/Cursor/);
  assert.throws(()=>timed.consumeCircle([0,0],100,{maxRows:0}));
});

test('dirty binary chunks are incremental independent snapshots and failed writes can retry',()=>{
  const mask=new ConsumptionMask();mask.ingestCoverage('4,4',full());
  mask.consumeCircle([-30,0],5);const revision=mask.consumedRevision,first=mask.takeDirtyChunks();
  assert.equal(first.size,1);assert.equal(mask.takeDirtyChunks().size,0);
  const count=countMaskBits(first.get('4,4'));mask.consumeCircle([30,0],5);
  assert.equal(countMaskBits(first.get('4,4')),count);assert.ok(mask.consumedRevision>revision);
  const second=mask.takeDirtyChunks();assert.equal(countMaskBits(second.get('4,4')),count*2);
  mask.markChunksDirty(second.keys());assert.equal(mask.takeDirtyChunks().size,1);
  const copy=new ConsumptionMask();copy.restoreConsumed(second);
  assert.equal(copy.consumedCells,mask.consumedCells);assert.equal(copy.takeDirtyChunks().size,0);
});

test('JSON restore is stable, source-independent and validates atomically',()=>{
  const mask=new ConsumptionMask();mask.ingestCoverage('4,4',full());mask.consumeCircle([0,0],10);
  const snapshot=JSON.parse(JSON.stringify(mask.serialize())),copy=createConsumptionMask(snapshot);
  assert.deepEqual(copy.serialize(),snapshot);assert.equal(copy.consumedCells,mask.consumedCells);
  assert.equal(copy.coverage.size,0);copy.ingestCoverage('4,4',full());
  assert.equal(copy.consumeCircle([0,0],10).newCells,0);
  const bad={...snapshot,chunks:[snapshot.chunks[0],snapshot.chunks[0]]};
  assert.throws(()=>copy.restore(bad),/duplicate/);assert.deepEqual(copy.serialize(),snapshot);
  for(const bad of [{...snapshot,cellMetres:4},{...snapshot,chunks:[['4,4','AAAA']]},{...snapshot,chunks:[['20,0',snapshot.chunks[0][1]]]}])
    assert.throws(()=>copy.restore(bad));
  assert.throws(()=>copy.restoreConsumed([['4,4',full()],['4,4',full()]]));
  assert.deepEqual(copy.serialize(),snapshot);
});

test('real Gatchina OSM relation r1659230 with two courtyards matches independent geometry oracle',()=>{
  const {buildings}=JSON.parse(fs.readFileSync(new URL('../public/data/gatchina/chunks/3-4.json',import.meta.url)));
  const building=buildings.find(b=>b.id==='r1659230');assert.ok(building);assert.equal(building.polygons[0].length,3);
  const mask=new ConsumptionMask();let expected=0;
  for(const key of maskChunksForBounds(building.bbox)) {
    const bits=rasterizeCoverageChunk(key,building.polygons),{cx,cy}=parseMaskChunkKey(key);
    for(let ly=0;ly<256;ly++) for(let lx=0;lx<256;lx++) {
      const p=cellCentre(cx*256+lx,cy*256+ly),inside=pointInPolygons(p,building.polygons);
      assert.equal(bitAt(bits,lx,ly),inside,`${key}:${lx},${ly}`);if(inside) expected++;
    }
    mask.ingestCoverage(key,bits);
  }
  const first=mask.consumeCircle(building.polygons[0][0][0],35);assert.ok(first.newCells>0&&first.newCells<expected);
  const rest=mask.consumeCircle(building.center,400);assert.equal(first.newCells+rest.newCells,expected);
  assert.ok(Math.abs(mask.consumedAreaM2-building.area)/building.area<0.02);
});

test('bounded wordwise benchmark: starter, prototype radius cap, and full fixed arena',t=>{
  const mask=new ConsumptionMask();const populateStart=performance.now();
  for(let cy=0;cy<10;cy++) for(let cx=0;cx<10;cx++) mask.ingestCoverage(maskChunkKey(cx,cy),full());
  assert.equal(mask.coverageBytes,100*8192);
  let start=performance.now();const small=mask.consumeCircle([0,0],18);const smallMs=performance.now()-start;
  start=performance.now();const giant=mask.consumeCircle([0,0],500);const giantMs=performance.now()-start;
  assert.ok(small.wordsVisited<100);assert.ok(giant.wordsVisited<8000);
  start=performance.now();let cursor=null,batches=0;
  do {const result=mask.consumeCircle([0,0],7100,{maxRows:64,cursor});assert.ok(result.rows<=64);cursor=result.cursor;batches++;} while(cursor);
  const arenaMs=performance.now()-start;
  assert.equal(mask.consumedCells,6_250_000);assert.equal(mask.consumedAreaM2,25_000_000);
  assert.equal(mask.consumedBytes,100*8192);assert.equal(mask.consumeCircle([0,0],7100).newCells,0);
  t.diagnostic(`2m mask: starter r18 ${smallMs.toFixed(2)}ms/${small.wordsVisited} words; r500 ${giantMs.toFixed(2)}ms/${giant.wordsVisited} words; whole 5km arena ${arenaMs.toFixed(2)}ms in ${batches} <=64-row batches; setup ${(start-populateStart).toFixed(2)}ms.`);
});

test('5km mask has exactly 2500² real cells and 10² chunks with 196-cell edges',()=>{
  assert.equal(MASK_VERSION,2);assert.equal(MASK_ARENA_HALF,2500);assert.equal(MASK_GRID_SIZE,2500);
  assert.equal(MASK_CHUNKS_PER_AXIS,10);assert.equal(MASK_CHUNK_COUNT,100);assert.equal(MASK_TOTAL_CELLS,6250000);
  assert.equal(maskCellAt([2500-Number.EPSILON*2048,2500-Number.EPSILON*2048]).gx,2499);
  for(const key of ['1,2\n','1,2\r',' 1,2','1,2 ','10,0','0,10','99,99'])assert.throws(()=>parseMaskChunkKey(key));
  const mask=new ConsumptionMask();
  for(const [key,width,height] of [['9,4',196,256],['4,9',256,196],['9,9',196,196]]){
    const input=full();mask.ingestCoverage(key,input);const output=mask.getCoverageChunk(key);
    assert.equal(countMaskBits(output),width*height);assert.equal(countMaskBits(input),65536);
    for(let ly=0;ly<256;ly++)for(let lx=0;lx<256;lx++)assert.equal(bitAt(output,lx,ly),lx<width&&ly<height,`${key} ${lx},${ly}`);
  }
  const restored=new ConsumptionMask();restored.restoreConsumed([['9,9',full()]]);
  assert.equal(restored.consumedCells,196*196);assert.equal(restored.isConsumedAt([2501,2499]),false);
  assert.equal(countMaskBits(rasterizeCoverageChunk('9,9',[[rectangle(2000,2000,4000,4000)]])),196*196);
});

test('whole footprint consumption is exact, once-only, and leaves adjacent buildings intact',()=>{
  const mask=new ConsumptionMask(),target=[[rectangle(50,-10,70,10)]],neighbor=[[rectangle(90,-10,110,10)]];
  const keys=maskChunksForBounds([50,-10,70,10]);assert.equal(keys.length,2);
  const buildingChunks=new Map(keys.map(key=>[key,rasterizeCoverageChunk(key,target)]));
  for(const key of maskChunksForBounds([50,-10,110,10]))mask.ingestCoverage(key,rasterizeCoverageChunk(key,[...target,...neighbor]));
  const partial=mask.consumeCircle([55,0],3);assert.ok(partial.newCells>0);
  const result=mask.consumeBuildingChunks(buildingChunks);
  assert.equal(result.complete,true);assert.deepEqual(result.unknownChunks,[]);assert.equal(result.newCells+partial.newCells,100);
  assert.equal(result.areaM2+partial.areaM2,400);assert.equal(mask.consumedCells,100);
  assert.deepEqual(result.changedChunks,keys);assert.equal(mask.isConsumedAt([99,1]),false);assert.equal(mask.isCoveredAt([99,1]),true);
  assert.deepEqual(result.dirtyBounds,{minX:50,minY:-10,maxX:70,maxY:10});
  const revision=mask.consumedRevision;mask.takeDirtyChunks();
  assert.equal(mask.consumeBuildingChunks(buildingChunks).newCells,0);assert.equal(mask.consumedRevision,revision);assert.equal(mask.takeDirtyChunks().size,0);
  for(const key of keys)mask.evictCoverage(key);
  assert.equal(mask.consumeBuildingChunks(buildingChunks).complete,false);assert.equal(mask.consumedCells,100);
  for(const key of keys)mask.ingestCoverage(key,rasterizeCoverageChunk(key,[...target,...neighbor]));
  assert.equal(mask.consumeBuildingChunks(buildingChunks).areaM2,0);assert.equal(mask.isConsumedAt([99,1]),false);
  const cold=new ConsumptionMask(mask.serialize());for(const key of keys)cold.ingestCoverage(key,rasterizeCoverageChunk(key,[...target,...neighbor]));
  assert.equal(cold.consumeBuildingChunks(buildingChunks).areaM2,0);
});

test('whole consumption with any unknown required chunk is a zero-mutation incomplete operation',()=>{
  const mask=new ConsumptionMask(),polygons=[[rectangle(50,-10,70,10)]];
  const entries=maskChunksForBounds([50,-10,70,10]).map(key=>[key,rasterizeCoverageChunk(key,polygons)]);
  mask.ingestCoverage(...entries[0]);const before=mask.serialize(),revision=mask.consumedRevision;
  for(const records of [entries,[...entries].reverse()]){
    const result=mask.consumeBuildingChunks(records);
    assert.equal(result.complete,false);assert.equal(result.newCells,0);assert.equal(result.areaM2,0);assert.deepEqual(result.changedChunks,[]);
    assert.deepEqual(result.unknownChunks,[entries[1][0]]);assert.equal(result.dirtyBounds,null);
    assert.deepEqual(mask.serialize(),before);assert.equal(mask.consumedRevision,revision);assert.equal(mask.takeDirtyChunks().size,0);
  }
  mask.ingestCoverage(...entries[1]);assert.equal(mask.consumeBuildingChunks(entries).newCells,100);
});

test('invalid, duplicate, oversized or throwing whole-mask inputs cannot partially consume',()=>{
  const mask=new ConsumptionMask();mask.ingestCoverage('4,4',full());mask.consumeCircle([0,0],1);
  const before=mask.serialize(),revision=mask.consumedRevision,dirty=[...mask.dirtyConsumed];
  function* throwsLate(){yield ['4,4',full()];throw new Error('iteration failed');}
  for(const input of [null,{},[['4,4',full()],['4,4',full()]],[['4,4',full()],['10,0',full()]],[['4,4',full()],['5,4',new Uint8Array(8191)]],[['4,4',full()],['5,4',new Uint16Array(4096)]],[['4,4',full()],['5,4',full(),'extra']],throwsLate()]){
    assert.throws(()=>mask.consumeBuildingChunks(input));assert.deepEqual(mask.serialize(),before);assert.equal(mask.consumedRevision,revision);assert.deepEqual([...mask.dirtyConsumed],dirty);
  }
  const empty=mask.consumeBuildingChunks([]);assert.equal(empty.complete,true);assert.equal(empty.areaM2,0);
});

test('whole consumption intersects known coverage, preserves holes, and clears padding',()=>{
  const mask=new ConsumptionMask(),outer=rectangle(-30,-30,30,30),hole=rectangle(-10,-10,10,10);
  mask.ingestCoverage('4,4',rasterizeCoverageChunk('4,4',[[outer,hole]]));
  assert.equal(mask.consumeBuildingChunks([['4,4',full()]]).newCells,800);assert.equal(mask.isConsumedAt([1,1]),false);
  const edge=new ConsumptionMask(),owner=new Uint8Array(MASK_CHUNK_BYTES+1).fill(255),input=owner.subarray(1);
  edge.ingestCoverage('9,9',input);const result=edge.consumeBuildingChunks([['9,9',input]]);input.fill(0);
  assert.equal(result.newCells,196*196);assert.equal(result.areaM2,196*196*4);assert.deepEqual(result.dirtyBounds,{minX:2108,minY:2108,maxX:2500,maxY:2500});
  for(let ly=0;ly<256;ly++)for(let lx=0;lx<256;lx++)assert.equal(bitAt(edge.getConsumedChunk('9,9'),lx,ly),lx<196&&ly<196);
});

test('outside boundary halo positions can collect inside cells but never earn exterior area',()=>{
  const mask=new ConsumptionMask();mask.ingestCoverage('9,9',full());
  const result=mask.consumeCircle([2510,2510],30);assert.ok(result.newCells>0);
  assert.ok(result.dirtyBounds.maxX<=2500&&result.dirtyBounds.maxY<=2500);
  assert.equal(mask.isConsumedAt([2501,2499]),false);assert.equal(mask.isConsumedAt([2499,2501]),false);
  assert.equal(mask.consumeCircle([3000,3000],500).areaM2,0);
  const before=mask.consumedCells;assert.equal(mask.consumeCircle([3500,3500],500).areaM2,0);assert.equal(mask.consumedCells,before);
});

test('whole consumption of all chunks has the same strict total-cell ceiling as parts mode',()=>{
  const mask=new ConsumptionMask(),records=[];
  for(let cy=0;cy<10;cy++)for(let cx=0;cx<10;cx++){
    const key=maskChunkKey(cx,cy);mask.ingestCoverage(key,full());records.push([key,full()]);
  }
  const result=mask.consumeBuildingChunks(records);
  assert.equal(result.newCells,6250000);assert.equal(result.areaM2,25000000);assert.equal(result.changedChunks.length,100);
  assert.deepEqual(result.dirtyBounds,{minX:-2500,minY:-2500,maxX:2500,maxY:2500});
  assert.equal(mask.consumeBuildingChunks(records).newCells,0);assert.equal(mask.consumeCircle([0,0],4000).newCells,0);
  assert.equal(mask.consumedCells,MASK_TOTAL_CELLS);
});
