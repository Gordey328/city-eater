import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {createLandRegion,prepareLandGeometry,LAND_REGION_LIMITS} from '../src/land-region.js';
import {MASK_CHUNK_BYTES,maskCellAt,maskChunkKey,countMaskBits,ConsumptionMask,rasterizeCoverageChunk} from '../src/consumption-mask.js';
import {polygonFitsCircle,pointInRing} from '../src/geometry.js';

const box=(x0,y0,x1,y1)=>[[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]];
const square=box(-1500,-1500,1500,1500),domain=box(-2000,-2000,2000,2000);
const bounds=[-2000,-2000,2000,2000];
const near=(actual,expected,tolerance=1e-7)=>{
  assert.equal(actual.length,expected.length);
  actual.forEach((value,i)=>assert.ok(Math.abs(value-expected[i])<=tolerance,`${actual} differs from ${expected}`));
};
function region(water=[],selector=()=>true,domainBounds=bounds) {
  const components=polygonClipping.difference(square,water);
  const selected=components.find(selector);
  return createLandRegion({polygons:[selected],waterPolygons:water,domainBounds});
}
function assertPathOnLand(region,result,radius) {
  for (let i=1;i<result.path.length;i++) {
    const a=result.path[i-1],b=result.path[i];
    for (let n=0;n<=100;n++) assert.equal(region.contains([a[0]+(b[0]-a[0])*n/100,a[1]+(b[1]-a[1])*n/100],radius),true);
  }
}
function bitAt(bits,position) {
  const cell=maskCellAt(position);return !!(bits[cell.bit>>>3]&(1<<(cell.bit&7)));
}

test('worker-prepared geometry is detached, structured-clone-safe and avoids constructor Boolean work',()=>{
  const waterPolygons=box(-20,-20,20,20),polygons=polygonClipping.difference(square,waterPolygons);
  const input={polygons,waterPolygons,domainBounds:bounds},originalInput=JSON.stringify(input);
  const prepared=prepareLandGeometry(input),transferred=structuredClone(prepared),direct=createLandRegion(input);
  assert.deepEqual(transferred,prepared);
  assert.deepEqual(prepared.domainBounds,{minX:-2000,minY:-2000,maxX:2000,maxY:2000});
  assert.notEqual(prepared.polygons,polygons);assert.notEqual(prepared.polygons[0][0][0],polygons[0][0][0]);
  let fromWorker;
  const originals={difference:polygonClipping.difference,intersection:polygonClipping.intersection,union:polygonClipping.union};
  try {
    for (const key of Object.keys(originals)) polygonClipping[key]=()=>{throw new Error('Unexpected UI-thread Boolean clipping');};
    fromWorker=createLandRegion({...input,preparedGeometry:transferred});
    assert.deepEqual(fromWorker.resolveMotion([-100,-10],[200,20],80),direct.resolveMotion([-100,-10],[200,20],80));
    assert.deepEqual(fromWorker.scoreChunk('2,2'),direct.scoreChunk('2,2'));
  } finally { Object.assign(polygonClipping,originals); }
  const before=fromWorker.resolveMotion([-100,-10],[200,20],80);
  transferred.polygons[0][0][0][0]=1e9;transferred.allowedPolygons[0][0][0][0]=1e9;
  assert.deepEqual(fromWorker.resolveMotion([-100,-10],[200,20],80),before);
  assert.equal(fromWorker.isReachable([1550,0],50),true);
  assert.equal(JSON.stringify(input),originalInput);
});

test('prepared geometry rejects wrong or unknown bounds, open/nonfinite rings and complexity overflow',()=>{
  const input={polygons:square,waterPolygons:[],domainBounds:bounds},prepared=prepareLandGeometry(input);
  const bad=change=>{const value=structuredClone(prepared);change(value);return()=>createLandRegion({...input,preparedGeometry:value});};
  assert.throws(bad(value=>{value.domainBounds.maxX=2001;}),/does not match/);
  assert.throws(bad(value=>{value.allowedPolygons[0][0][0][0]=-2001;}),/known bounds/);
  assert.throws(bad(value=>{value.polygons[0][0][0][0]=-1501;}),/known bounds/);
  assert.throws(bad(value=>{value.allowedPolygons[0][0][0][0]=Infinity;}),/finite/);
  assert.throws(bad(value=>{value.allowedPolygons[0][0].pop();}),/closed/);
  assert.throws(bad(value=>{value.allowedPolygons=[];}),/no certified movement/);
  assert.throws(bad(value=>{value.allowedPolygons=Array(LAND_REGION_LIMITS.polygons+1).fill(value.allowedPolygons[0]);}),/polygon limit/);
  assert.throws(bad(value=>{value.allowedPolygons=[[Array(LAND_REGION_LIMITS.vertices+1).fill([0,0])]];}),/vertex limit/);
  assert.throws(()=>prepareLandGeometry({...input,waterPolygons:[[Array(LAND_REGION_LIMITS.vertices+1).fill([0,0])]]}),/vertex limit/);
  assert.throws(()=>prepareLandGeometry({...input,domainBounds:[-2000,-2000,2000,2000,3000]}),/four known-domain/);
  const narrow={...input,domainBounds:[-1500,-1500,1550,1600]},narrowPrepared=prepareLandGeometry(narrow);
  assert.equal(createLandRegion({...narrow,preparedGeometry:narrowPrepared}).contains([1551,0],500),false);
});

test('an internal lake blocks the center continuously while allowing its rim over water',()=>{
  const land=region(box(-20,-20,20,20));
  assert.equal(land.contains([0,0],500),false);
  assert.equal(land.contains([-20,0],500),true);
  const result=land.resolveMotion([-100,0],[200,0],500);
  near(result.position,[-20,0]);assert.equal(result.blocked,true);assert.equal(result.recovered,false);
  const back=land.resolveMotion(result.position,[-80,0],500);
  near(back.position,[-100,0]);assert.equal(back.blocked,false);
});

test('movement slides on water boundaries and reports every actual sweep segment',()=>{
  const land=region(box(-20,-20,20,20));
  const result=land.resolveMotion([-100,-10],[200,20],80);
  near(result.position,[-20,10]);assert.equal(result.path.length,3);assertPathOnLand(land,result,80);
  near(result.path[1],[-20,-2]);
  const tangent=land.resolveMotion([-20,-10],[0,80],80);
  near(tangent.position,[-20,70]);assert.equal(tangent.blocked,false);
});

test('a coastline uses the center only and does not shrink land by hole radius',()=>{
  const land=region(box(0,-2000,2000,2000));
  for (const radius of [0,1,100,500]) {
    assert.equal(land.contains([-1,0],radius),true);
    near(land.resolveMotion([-100,0],[200,0],radius).position,[0,0]);
  }
  assert.equal(land.contains([1,0],500),false);
});

test('river-split components are independent even for a long step with a huge hole',()=>{
  const water=box(-4,-2000,4,2000),left=region(water,p=>p[0][0][0]<0);
  const right=region(water,p=>p[0][0][0]>0);
  assert.equal(left.contains([100,0],500),false);assert.equal(right.contains([-100,0],500),false);
  near(left.resolveMotion([-1400,0],[2800,0],500).position,[-4,0]);
  near(right.resolveMotion([1400,0],[-2800,0],500).position,[4,0]);
  near(left.nearestPoint([100,0]),[-4,0]);
});

test('an island cannot enter surrounding water or unrelated halo land',()=>{
  const island=box(-100,-100,100,100),farIsland=box(1600,-100,1800,100);
  const water=polygonClipping.difference(domain,island,farIsland);
  const land=createLandRegion({polygons:island,waterPolygons:water,domainBounds:bounds});
  near(land.resolveMotion([0,0],[1800,0],500).position,[100,0]);
  assert.equal(land.contains([1700,0],500),false);
  near(land.nearestPoint([1700,0]),[100,0]);
});

test('artificial square overrun is radius dependent and capped at 500 m including corners',()=>{
  const land=region();
  for (const radius of [0,2,25,200,500,5000]) {
    const limit=1500+Math.min(radius,500);
    near(land.resolveMotion([1490,1490],[1000,1000],radius).position,[limit,limit]);
    assert.equal(land.contains([limit,limit],radius),true);
    assert.equal(land.contains([limit+0.01,limit],radius),false);
  }
  const slide=land.resolveMotion([1490,0],[100,90],20);
  near(slide.position,[1520,90]);assertPathOnLand(land,slide,20);
});

test('radius growth unlocks only the artificial edge; invalid restored starts recover without a scored teleport',()=>{
  const land=region(box(-20,-20,20,20));
  const small=land.resolveMotion([1490,0],[100,0],10);near(small.position,[1510,0]);
  const grown=land.resolveMotion(small.position,[100,0],100);near(grown.position,[1600,0]);assert.equal(grown.recovered,false);
  near(land.resolveMotion([-100,0],[200,0],100).position,[-20,0]);
  const invalid=land.resolveMotion([1700,0],[0,0],10);
  assert.equal(invalid.recovered,true);near(invalid.position,[1500,0]);
  assert.deepEqual(invalid.path,[[1500,0]]);
  const waterRestore=land.resolveMotion([0,0],[0,0],500);
  assert.equal(waterRestore.recovered,true);assert.equal(land.contains(waterRestore.position,0),true);
  assert.deepEqual(waterRestore.path,[waterRestore.position]);
  // Explicit restore recovery chooses active in-square land even from valid halo.
  near(land.nearestPoint([1600,0]),[1500,0]);
});

test('cold restore preserves reachable halo points exactly and rejects a disconnected radius-clipped lobe',()=>{
  // The banks reconnect above y=1700 in the maximum halo. At radius100 the
  // right-hand exterior lobe exists but its connecting route is out of bounds.
  const land=region(box(-5,-2000,5,1700),p=>p[0][0][0]<0),saved=[1600,0];
  assert.equal(land.contains(saved,100),true);
  assert.equal(land.isReachable(saved,100),false);
  assert.equal(land.isReachable(saved,250),true);
  assert.equal(land.isReachable(saved,500),true);
  assert.equal(land.isReachable(saved,100),false);
  assert.deepEqual(saved,[1600,0]);
  assert.equal(land.isReachable([-1600,0],100),true);
  assert.equal(land.isReachable([-1600,0],99),false);
  assert.equal(land.isReachable([-100,0],0),true);
  assert.equal(land.isReachable([100,0],500),false);
  assert.equal(land.isReachable([0,0],500),false);
  const dry=region(),corner=[1510,1510];
  assert.equal(dry.isReachable(corner,10),true);
  assert.equal(dry.isReachable(corner,10),true);
  assert.deepEqual(corner,[1510,1510]);
  assert.throws(()=>dry.isReachable([0,0],Infinity),/finite radius/);
  assert.throws(()=>dry.isReachable([NaN,0],10),/finite/);
});

test('sub-cell and sub-millimetre water cannot be tunneled by a long valid-endpoint step',()=>{
  for (const width of [1,0.001,0.00001,0.0000001]) {
    const land=region(box(0,-100,width,100));
    assert.equal(land.contains([-1400,0],500),true);assert.equal(land.contains([1400,0],500),true);
    const result=land.resolveMotion([-1400,0],[2800,0],500);
    near(result.position,[0,0],1e-9);assert.equal(result.blocked,true);
    near(land.resolveMotion([1400,0],[-2800,0],500).position,[width,0],1e-9);
  }
});

test('an outside-square path cannot re-enter another in-square component',()=>{
  const land=region(box(-5,-1500,5,1500),p=>p[0][0][0]<0);
  let result=land.resolveMotion([-100,1400],[0,200],200);near(result.position,[-100,1600]);
  result=land.resolveMotion(result.position,[200,0],200);near(result.position,[100,1600]);
  result=land.resolveMotion(result.position,[0,-200],200);near(result.position,[100,1500]);
  assert.equal(land.contains([100,1499],200),false);
});

test('explicit known-domain bounds are hard limits and missing data never means land',()=>{
  assert.throws(()=>createLandRegion({polygons:square,waterPolygons:[]}),/known-domain/);
  assert.throws(()=>createLandRegion({polygons:square,domainBounds:bounds}),/water/);
  assert.throws(()=>createLandRegion({polygons:square,waterPolygons:[],domainBounds:[-1000,-1000,1000,1000]}),/complete active square/);
  const land=region([],()=>true,[-1700,-1600,1800,1900]);
  near(land.resolveMotion([0,0],[3000,0],500).position,[1800,0]);
  near(land.resolveMotion([0,0],[0,-3000],500).position,[0,-1600]);
  assert.equal(land.contains([1801,0],500),false);
  near(land.resolveMotion([0,0],[1e12,0],500).position,[1800,0]);
});

test('disconnected active selections and malformed coordinates are rejected',()=>{
  assert.throws(()=>createLandRegion({polygons:[],waterPolygons:[],domainBounds:bounds}),/empty/);
  assert.throws(()=>createLandRegion({polygons:[...box(-100,-100,-10,100),...box(10,-100,100,100)],waterPolygons:[],domainBounds:bounds}),/one nonempty connected/);
  const land=region();
  assert.throws(()=>land.contains([NaN,0],10),/finite/);
  assert.throws(()=>land.resolveMotion([0,0],[Infinity,0],10),/finite/);
  assert.throws(()=>land.contains([0,0],Infinity),/finite radius/);
});

test('immutable active score chunks match the existing 2 m grid and exclude water, halo and the other bank',()=>{
  const water=box(-4,-2000,4,2000),land=region(water,p=>p[0][0][0]<0);
  const at=maskCellAt([-1,1]),key=at.key,bits=land.scoreChunk(key);
  assert.equal(bits.byteLength,MASK_CHUNK_BYTES);
  assert.equal(bitAt(bits,[-5,1]),true);assert.equal(bitAt(bits,[-1,1]),false);assert.equal(bitAt(bits,[5,1]),false);
  bits.fill(255);assert.equal(bitAt(land.scoreChunk(key),[5,1]),false);
  assert.equal(Object.isFrozen(land),true);assert.equal(Object.isFrozen(land.polygons[0][0][0]),true);
  let count=0;
  for (let y=0;y<6;y++) for (let x=0;x<6;x++) count+=countMaskBits(land.scoreChunk(maskChunkKey(x,y)));
  assert.equal(count*4,1496*3000);
  assert.equal(land.scoreChunk('5,5').some(Boolean),false);
});

test('shared consumed mask scores only active land while original whole-footprint fit stays unchanged',()=>{
  const land=region(box(-4,-2000,4,2000),p=>p[0][0][0]<0),building=box(-20,-10,20,10);
  const key=maskCellAt([-1,1]).key,buildingBits=rasterizeCoverageChunk(key,building),activeBits=land.scoreChunk(key);
  const clipped=buildingBits.map((value,i)=>value&activeBits[i]),mask=new ConsumptionMask();
  mask.ingestCoverage(key,clipped);
  assert.equal(polygonFitsCircle(building,[-10,0],12),false);
  assert.equal(polygonFitsCircle(building,[-10,0],40),true);
  const first=mask.consumeBuildingChunks([[key,buildingBits]]);
  assert.equal(first.areaM2,16*20);assert.equal(mask.isConsumedAt([5,1]),false);
  assert.equal(mask.consumeCircle([-10,0],40).areaM2,0);
});

test('local coordinates near either dateline world copy obey identical geometry rules',()=>{
  // Projection/longitude unwrapping belongs to the source, never this module.
  const east=region(box(-5,-2000,5,2000),p=>p[0][0][0]<0),west=region(box(-5,-2000,5,2000),p=>p[0][0][0]<0);
  assert.deepEqual(east.resolveMotion([-10,0],[100,0],10),west.resolveMotion([-10,0],[100,0],10));
});

test('normal movement does not mutate source arrays or state and repeated boundary frames cannot leak',()=>{
  const water=box(-20,-20,20,20),polygons=polygonClipping.difference(square,water),saved=JSON.stringify({water,polygons});
  const land=createLandRegion({polygons,waterPolygons:water,domainBounds:bounds});
  let position=[-100,0];
  for (let i=0;i<200;i++) position=land.resolveMotion(position,[10,0],500).position;
  near(position,[-20,0]);assert.equal(JSON.stringify({water,polygons}),saved);
  const d=[10,1],p=[-100,0];land.resolveMotion(p,d,10);assert.deepEqual(p,[-100,0]);assert.deepEqual(d,[10,1]);
});

test('seeded concave shoreline sweeps stay on land, preserve movement length, and handle reentrant corners',()=>{
  const ring=[];
  for (let i=0;i<32;i++) {
    const angle=i*Math.PI/16,radius=i%2?90:240;
    ring.push([Math.cos(angle)*radius,Math.sin(angle)*radius]);
  }
  ring.push([...ring[0]]);
  const land=region([[ring]]);
  let seed=171;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  for (let i=0;i<250;i++) {
    const start=land.nearestPoint([(random()-.5)*1600,(random()-.5)*1600]);
    const displacement=[(random()-.5)*3500,(random()-.5)*3500],radius=500*random();
    const result=land.resolveMotion(start,displacement,radius);
    assert.equal(result.recovered,false);
    let traveled=0;
    for (let n=1;n<result.path.length;n++) {
      const a=result.path[n-1],b=result.path[n];traveled+=Math.hypot(b[0]-a[0],b[1]-a[1]);
      for (let t=0;t<=50;t++) {
        const p=[a[0]+(b[0]-a[0])*t/50,a[1]+(b[1]-a[1])*t/50];
        assert.equal(pointInRing(p,ring,false),false,`water entry at ${p}`);
        assert.equal(land.contains(p,radius),true);
      }
    }
    assert.ok(traveled<=Math.hypot(...displacement)+1e-7);
  }
});
