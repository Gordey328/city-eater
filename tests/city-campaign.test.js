import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBoundaryQuery, makeSectorQuery, parseBoundaryCandidates, makeCampaign, deriveManualBounds, summarizeCampaign } from '../src/city-campaign.js';
import { lonLatToLocal } from '../src/geometry.js';

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
  assert.deepEqual(c.sectors.map(s=>s.id).sort(),makeCampaign({...args,name:'Pushkin',center:[30.4,59.7]}).sectors.map(s=>s.id).sort());
  for(const sector of c.sectors){
    const [w,s,e,n]=sector.bounds, sw=lonLatToLocal([w,s],sector.center), ne=lonLatToLocal([e,n],sector.center);
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
  for(const sector of c.sectors){const sw=lonLatToLocal(sector.bounds.slice(0,2),sector.center);assert.ok(Math.abs(sw[0]+5000)<1e-6);}
});
test('progress does not pretend unknown sectors have a known whole-city mass',()=>{
  const c=makeCampaign({center:[0,0],bounds:deriveManualBounds([0,0],20,20)});
  const summary=summarizeCampaign(c,{[c.sectors[0].id]:{completed:true,totalBuildingArea:100,consumedArea:80}});
  assert.equal(summary.completed,1);assert.equal(summary.prepared,1);assert.equal(summary.wholeCityAreaKnown,false);assert.equal(summary.knownAreaPercent,80);
});
