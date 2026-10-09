import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBoundaryQuery, makeSectorQuery, parseBoundaryCandidates, makeCampaign, deriveManualBounds, summarizeCampaign, coverageDimensions } from '../src/city-campaign.js';
import { lonLatToLocal } from '../src/geometry.js';

// Independent test oracle for the shared city latitude, relative to each cell.
const inSector = (point, sector) => {
  const d = Math.PI / 180, r = 6378137;
  const longitudeDelta = ((point[0] - sector.center[0] + 180) % 360 + 360) % 360 - 180;
  return [longitudeDelta * d * r * Math.cos((sector.projectionLatitude ?? sector.center[1]) * d), (point[1] - sector.center[1]) * d * r];
};

test('bounded city query asks metadata rather than all worldwide geometry', () => {
  const q = makeBoundaryQuery([30.4158,59.7229]);
  assert.match(q,/is_in\(59.7229,30.4158\)/);
  assert.match(q,/out tags bb/);
  assert.match(q,/timeout:20/);
  assert.throws(()=>makeBoundaryQuery(['bad',40]));
});
test('sector query uses full geometry, fixed finite budget and split date-line boxes',()=>{
  const q=makeSectorQuery({center:[30,60],arenaSize:10000});
  assert.match(q,/timeout:60/); assert.match(q,/maxsize:134217728/); assert.match(q,/out body geom;/);
  assert.equal((q.match(/way\["highway"\]/g)||[]).length,1);assert.ok(!q.includes('out meta'));
  const crossing=makeSectorQuery({center:[179.99,60],arenaSize:10000});assert.equal((crossing.match(/way\["highway"\]/g)||[]).length,2);
  assert.throws(()=>makeSectorQuery({center:[30,60],arenaSize:100000}));
});
test('real administrative candidates remain explicitly bounding boxes', () => {
  const relation={type:'relation',id:359179,tags:{name:'Пушкин',boundary:'administrative',admin_level:'8'},bounds:{minlon:30.2182227,minlat:59.6337832,maxlon:30.4626647,maxlat:59.7617962}};
  const result=parseBoundaryCandidates({elements:[relation,relation]},'Пушкин');
  assert.equal(result.length,1); assert.equal(result[0].source,'osm-boundary-bbox');assert.equal(result[0].exactNameMatch,true);
  assert.throws(()=>parseBoundaryCandidates({remark:'timeout',elements:[relation]}));
});
test('campaign arenas are 10km under gameplay projection, shared edges and stable IDs',()=>{
  const args={name:'Пушкин',center:[30.4158,59.7229],bounds:[30.2182227,59.6337832,30.4626647,59.7617962],boundaryId:'r359179',source:'osm-boundary-bbox'};
  const c=makeCampaign(args);
  assert.equal(c.sectors.length,4); assert.equal(c.boundaryIsPolygon,false);
  const recliked=makeCampaign({...args,name:'Pushkin',center:[30.4,59.7]});
  assert.equal(c.id,recliked.id,'A new click within the same boundary must preserve progress');
  assert.equal(c.projectionLatitude,recliked.projectionLatitude);
  assert.deepEqual(c.sectors.map(s=>[s.id,s.center,s.bounds]).sort(),recliked.sectors.map(s=>[s.id,s.center,s.bounds]).sort());
  for(const sector of c.sectors){
    const [w,s,e,n]=sector.bounds, sw=inSector([w,s],sector), ne=inSector([e,n],sector);
    assert.ok(Math.abs(ne[0]-sw[0]-10000)<1e-6); assert.ok(Math.abs(ne[1]-sw[1]-10000)<1e-6);
    assert.ok(Math.abs(sw[0]+5000)<1e-6);assert.ok(Math.abs(ne[1]-5000)<1e-6);
    const next=c.sectors.find(v=>v.row===sector.row&&v.col===sector.col+1); if(next)assert.equal(sector.bounds[2],next.bounds[0]);
  }
  const row0=c.sectors.filter(v=>v.row===0),row1=c.sectors.filter(v=>v.row===1);assert.equal(row0[0].bounds[3],row1[0].bounds[1]);
});
test('manual bounds are not presented as official city extents, oversized bounds fail',()=>{
  const bounds=deriveManualBounds([30,60],20,20),c=makeCampaign({name:'Test',center:[30,60],bounds});
  assert.equal(c.source,'manual');assert.match(c.extentLabel,/вручную/);
  assert.throws(()=>makeCampaign({name:'country',center:[0,0],bounds:[-40,-20,40,20]}),/больше|большая/);
  assert.throws(()=>makeCampaign({center:[0,0],bounds:[0,0,1,1],source:'osm-boundary-bbox'}));
});
test('exact 10km manual selections produce one sector at the selected center',()=>{
  const centers = [
    [29.84683,58.73721], // Luga: previously expanded because of rounded edges.
    [0,0], [139.6917,35.6895], [36.8219,-1.2921], [-73.9857,40.7484],
    [179.999,16], [-179.999,-16], [15.6333,78.2167], [30,-78.2167],
  ];
  for(const center of centers){
    const bounds=deriveManualBounds(center,10,10);
    const campaign=makeCampaign({title:'Manual 10 km',center,bounds});
    assert.equal(campaign.sectorCount,1,JSON.stringify(center));
    const offset=lonLatToLocal(campaign.sectors[0].center,center);
    assert.ok(Math.hypot(...offset)<1e-6,`Sector moved from ${center}: ${offset}`);
    const sw=lonLatToLocal(bounds.slice(0,2),center);
    const ne=lonLatToLocal(bounds.slice(2),center);
    assert.ok(Math.abs(sw[0]+5000)<1e-6&&Math.abs(sw[1]+5000)<1e-6);
    assert.ok(Math.abs(ne[0]-5000)<1e-6&&Math.abs(ne[1]-5000)<1e-6);
  }
});
test('date-line campaign is bounded and metric',()=>{
  const c=makeCampaign({name:'Dateline',center:[179.98,-16],bounds:deriveManualBounds([179.98,-16],30,20)});
  assert.ok(c.sectors.length<20);
  for(const sector of c.sectors){const sw=inSector(sector.bounds.slice(0,2),sector);assert.ok(Math.abs(sw[0]+5000)<1e-6);}
});
test('10/20/30km manual rectangles use a single city basis without sliver sectors',()=>{
  const centers=[[29.84683,58.73721],[0,0],[139.6917,35.6895],[179.999,16],[-179.999,-16],[15.6333,78.2167],[30,-78.2167]];
  for(const center of centers)for(const width of [10,20,30])for(const height of [10,20,30]){
    const c=makeCampaign({center,bounds:deriveManualBounds(center,width,height)});
    assert.equal(c.sectorCount,width*height/100,`${center}, ${width}×${height}km`);
    assert.equal(c.rows,height/10);assert.equal(c.columns,width/10);
    assert.equal(c.schemaVersion,2);assert.match(c.id,/^city-v2-/);
    for(const sector of c.sectors){
      assert.equal(sector.projectionLatitude,center[1]);
      const sw=inSector(sector.bounds.slice(0,2),sector),ne=inSector(sector.bounds.slice(2),sector);
      for(const [actual,expected] of [[sw[0],-5000],[sw[1],-5000],[ne[0],5000],[ne[1],5000]])assert.ok(Math.abs(actual-expected)<1e-6);
      const right=c.sectors.find(v=>v.row===sector.row&&v.col===sector.col+1);
      const above=c.sectors.find(v=>v.row===sector.row+1&&v.col===sector.col);
      if(right){assert.equal(sector.bounds[2],right.bounds[0]);const delta=inSector(right.center,sector);assert.ok(Math.abs(delta[0]-10000)<1e-6&&Math.abs(delta[1])<1e-6);}
      if(above){assert.equal(sector.bounds[3],above.bounds[1]);assert.equal(sector.bounds[0],above.bounds[0]);assert.equal(sector.bounds[2],above.bounds[2]);const delta=inSector(above.center,sector);assert.ok(Math.abs(delta[0])<1e-6&&Math.abs(delta[1]-10000)<1e-6);}
    }
  }
});
test('sector query honors shared projection latitude and legacy local projection',()=>{
  for(const sector of [{center:[30,60.4],projectionLatitude:60,arenaSize:10000},{center:[30,60.4],arenaSize:10000}]){
    const q=makeSectorQuery(sector),bbox=q.match(/way\["highway"\]\(([^)]+)\)/)[1].split(',').map(Number);
    const sw=inSector([bbox[1],bbox[0]],sector),ne=inSector([bbox[3],bbox[2]],sector);
    assert.ok(Math.abs(sw[0]+5100)<1e-6&&Math.abs(ne[0]-5100)<1e-6);
    assert.ok(Math.abs(sw[1]+5100)<1e-6&&Math.abs(ne[1]-5100)<1e-6);
  }
  assert.throws(()=>makeSectorQuery({center:[30,60],projectionLatitude:90}));
});
test('old campaign objects remain readable and are never rewritten to the v2 grid',()=>{
  const legacy={id:'city-manual-old',schemaVersion:1,sectors:[{id:'city-manual-old/s0-0',center:[30,60],arenaSize:10000}]};
  const original=structuredClone(legacy),summary=summarizeCampaign(legacy,{[legacy.sectors[0].id]:{completed:true,totalBuildingArea:100,consumedArea:80}});
  makeSectorQuery(legacy.sectors[0]);
  assert.equal(summary.completed,1);assert.deepEqual(legacy,original);
  const next=makeCampaign({center:[30,60],bounds:deriveManualBounds([30,60],10,10)});
  assert.notEqual(next.id,legacy.id);assert.equal(next.schemaVersion,2);
});
test('progress does not pretend unknown sectors have a known whole-city mass',()=>{
  const c=makeCampaign({center:[0,0],bounds:deriveManualBounds([0,0],20,20)});
  const summary=summarizeCampaign(c,{[c.sectors[0].id]:{completed:true,totalBuildingArea:100,consumedArea:80}});
  assert.equal(summary.completed,1);assert.equal(summary.prepared,1);assert.equal(summary.wholeCityAreaKnown,false);assert.equal(summary.knownAreaPercent,80);
});
test('reopened campaign coverage form reflects stored10km bounds rather than20km defaults',async()=>{const {coverageDimensions}=await import('../src/city-campaign.js');const center=[29.84756,58.73876],bounds=deriveManualBounds(center,10,10),size=coverageDimensions(bounds,center);assert.ok(Math.abs(size.widthKm-10)<1e-8);assert.ok(Math.abs(size.heightKm-10)<1e-8);});
test('coverage form can use saved city basis independently of the selected point',()=>{
  const bounds=deriveManualBounds([30,60],20,30),clicked=[30,60.1];
  const size=coverageDimensions(bounds,clicked,60);
  assert.ok(Math.abs(size.widthKm-20)<1e-8);assert.ok(Math.abs(size.heightKm-30)<1e-8);
  assert.notEqual(coverageDimensions(bounds,clicked).widthKm,size.widthKm);
  assert.throws(()=>coverageDimensions(bounds,clicked,90));
});
