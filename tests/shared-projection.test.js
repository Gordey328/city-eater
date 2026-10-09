import test from 'node:test';
import assert from 'node:assert/strict';
import {lonLatToLocal,localToLonLat} from '../src/geometry.js';
import {createMapStyle,mapCoordinates} from '../src/map-style.js';
import {cameraMetrics,streamingExtent} from '../src/camera.js';
import {mercatorPoint,prepareAnimationGeometry} from '../src/animation-geometry.js';
import {BuildingRepository} from '../src/repository.js';
const close=(a,b,tolerance=1e-6)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);
test('common city projection round trips and preserves sector dimensions across rows',()=>{
 for(const origin of [[30,60],[179.99,70],[0,-82]]){
  const latitude=origin[1],south=localToLonLat([5000,-5000],origin,latitude),north=localToLonLat([5000,5000],origin,latitude);
  const sEdge=localToLonLat([5000,5000],south,latitude),nEdge=localToLonLat([5000,-5000],north,latitude);
  close(sEdge[0],nEdge[0],1e-10);close(sEdge[1],nEdge[1],1e-10);
  for(const center of [south,north])for(const point of [[-5000,-5000],[5000,5000],[123,-345]]){const result=lonLatToLocal(localToLonLat(point,center,latitude),center,latitude);close(result[0],point[0]);close(result[1],point[1]);}
  const west=localToLonLat([-5000,0],north,latitude),east=localToLonLat([5000,0],north,latitude);close(lonLatToLocal(east,west,latitude)[0],10000);
 }
});
test('prepared-map projection defaults remain identical to explicit origin latitude',()=>{for(const c of [[30,60],[179.99,-40],[0,0]]){assert.deepEqual(localToLonLat([123,456],c),localToLonLat([123,456],c,c[1]));assert.deepEqual(lonLatToLocal([c[0]+.01,c[1]+.02],c),lonLatToLocal([c[0]+.01,c[1]+.02],c,c[1]));}});
test('arena outlines and animation offsets use the same imported metric basis',()=>{
 const manifest={center:[30,63],projectionLatitude:60},style=createMapStyle(manifest,'https://example.invalid/');const expected=[[-5000,-5000],[5000,-5000],[5000,5000],[-5000,5000],[-5000,-5000]];
 style.sources.bounds.data.geometry.coordinates[0].forEach((p,i)=>{const local=lonLatToLocal(p,manifest.center,manifest.projectionLatitude);close(local[0],expected[i][0]);close(local[1],expected[i][1]);});
 const building={center:[100,200],polygons:[[[[90,190],[110,190],[110,210],[90,210]]]]},cached=prepareAnimationGeometry(building,manifest.center,manifest.projectionLatitude),origin=mercatorPoint(localToLonLat(building.center,manifest.center,manifest.projectionLatitude));
 building.polygons[0][0].forEach((p,i)=>{const projected=mercatorPoint(localToLonLat(p,manifest.center,manifest.projectionLatitude));close(cached[0][0][i*2],projected[0]-origin[0],1e-14);close(cached[0][0][i*2+1],projected[1]-origin[1],1e-14);});
});
test('common-basis camera fits both axes and streaming covers exact inverse-Mercator viewport',()=>{
 for(const projectionLatitude of [0,60,82,-82])for(const latitude of [projectionLatitude-1,projectionLatitude,projectionLatitude+1])for(const radius of [18,500,3000]){
  const m=cameraMetrics(radius,390,844,latitude,projectionLatitude),s=streamingExtent(radius,390,844,latitude,projectionLatitude);
  assert.ok(m.radiusPixels<=390*.21/2+1e-9);
  const origin=mercatorPoint([0,latitude]),world=512*2**m.zoom;
  for(const extent of [m.northExtent,-m.southExtent]){const ll=localToLonLat([0,extent],[0,latitude],projectionLatitude),projected=mercatorPoint(ll);close(Math.abs(projected[1]-origin[1])*world,844/2,1e-6);}
  assert.ok(s.x>=m.halfWidth+249.999);assert.ok(s.y>=m.northExtent+249.999);assert.ok(s.y>=m.southExtent+249.999);
 }
});
test('shared-basis hole ellipse encloses the projected metric circle at high latitude',()=>{
 for(const center of [[30,60],[30,83],[30,-83]])for(const projectionLatitude of [center[1]-2,center[1]+1])for(const radius of [18,500,5000]){
  const origin=mercatorPoint(center),point=p=>{const q=mercatorPoint(localToLonLat(p,center,projectionLatitude));return[q[0]-origin[0],q[1]-origin[1]];},rx=Math.abs(point([radius,0])[0]),ry=Math.max(Math.abs(point([0,radius])[1]),Math.abs(point([0,-radius])[1]));
  for(let i=0;i<720;i++){const a=i*Math.PI/360,p=point([radius*Math.cos(a),radius*Math.sin(a)]);assert.ok((p[0]/rx)**2+(p[1]/ry)**2<=1+1e-7);}
 }
});
test('repository selects chunks using common-basis viewport coverage at the player latitude',()=>{
 const manifest={center:[30,83],projectionLatitude:80,chunkSize:1000,chunks:[]},position=[0,-4500],latitude=83+position[1]/(6378137*Math.PI/180),view=streamingExtent(500,390,844,latitude,80),y=position[1]+view.y-1;
 manifest.chunks=[{id:'visible-edge',bbox:[-1,y,1,y+1]}];const repo=new BuildingRepository(manifest,'https://example.invalid/',new Set());repo.setViewport(390,844);assert.equal(repo.required(position,500).length,1);
});

test('a broad high-latitude campaign fits the longest projected hole axis without an artificial zoom floor',()=>{
 for(const [latitude,projectionLatitude] of [[84,76],[-84,-76],[76,84]])for(const radius of [18,500,3000]){
  const m=cameraMetrics(radius,390,844,latitude,projectionLatitude),world=512*2**m.zoom,origin=mercatorPoint([30,latitude]);
  for(const p of [[radius,0],[0,radius],[0,-radius]]){const q=mercatorPoint(localToLonLat(p,[30,latitude],projectionLatitude));const extent=Math.max(Math.abs(q[0]-origin[0]),Math.abs(q[1]-origin[1]))*world;assert.ok(extent<=390*.21/2+1e-6);}
  if(radius>=500&&latitude===84)assert.ok(m.zoom<10.5);
 }
});

test('antimeridian arena and camera targets remain in one nearby world copy',()=>{
 for(const longitude of [179.99,-179.99]){
  const manifest={center:[longitude,70],projectionLatitude:65},style=createMapStyle(manifest,'https://example.invalid/'),ring=style.sources.bounds.data.geometry.coordinates[0];
  assert.ok(Math.max(...ring.map(p=>p[0]))-Math.min(...ring.map(p=>p[0]))<1);
  for(let i=1;i<ring.length;i++)assert.ok(Math.abs(ring[i][0]-ring[i-1][0])<1);
  const east=mapCoordinates([5000,0],manifest),west=mapCoordinates([-5000,0],manifest,east[0]);assert.ok(Math.abs(east[0]-west[0])<1);
  const normalizedEast=localToLonLat([5000,0],manifest.center,manifest.projectionLatitude);
  const target=mapCoordinates([-5000,0],manifest,normalizedEast[0]);assert.ok(Math.abs(target[0]-normalizedEast[0])<1);
  const b={center:[0,0],polygons:[[[[-5000,-100],[5000,-100],[5000,100],[-5000,100]]]]},cached=prepareAnimationGeometry(b,manifest.center,manifest.projectionLatitude);
  for(let i=0;i<cached[0][0].length;i+=2)assert.ok(Math.abs(cached[0][0][i])<1/360);
 }
});
