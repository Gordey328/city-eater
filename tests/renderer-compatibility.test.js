import test from 'node:test';
import assert from 'node:assert/strict';
import * as maplibre from 'maplibre-gl';
import {validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import {GeoJSONVT} from '@maplibre/geojson-vt';
import {createMapStyle} from '../src/map-style.js';
const manifest={center:[30,60],spawn:[0,0],pmtiles:'map.pmtiles'};
for(const imported of [false,true])test(`installed MapLibre validates ${imported?'imported GeoJSON':'prepared PMTiles'} style`,()=>{
  const m=imported?{...manifest,background:{type:'geojson',data:{type:'FeatureCollection',features:[]}}}:manifest;
  const style=createMapStyle(m,'https://example.invalid/data/');assert.deepEqual(validateStyleMin(style).map(e=>e.message),[]);
  assert.match(style.sources.basemap.attribution,/OpenStreetMap/);
  if(imported){assert.ok(style.layers.filter(l=>l.source==='basemap').every(l=>!('source-layer' in l)));assert.deepEqual(style.layers.find(l=>l.id==='waterway').filter,['all',['==',['get','kindGroup'],'water'],['==',['geometry-type'],'LineString']]);}
  assert.equal(style.sources.buildings.data.features.length,0);
});
test('MapLibre exports and actual source Promise API preserve stable-ID deltas with the installed worker kernel',async()=>{
  assert.equal(typeof maplibre.Map,'function');assert.equal(typeof maplibre.addProtocol,'function');
  const messages=[],errors=[];let index;
  const actor={sendAsync:async message=>{messages.push(message);const p=message.data;if(p.data)index=new GeoJSONVT(p.data,{...p.geojsonVtOptions,updateable:true});else if(p.dataDiff)index.updateData(p.dataDiff);return {};}};
  const source=new maplibre.GeoJSONSource('buildings',{type:'geojson',data:{type:'FeatureCollection',features:[]}},{getActor:()=>Promise.resolve(actor)},undefined);source.on('error',e=>errors.push(e.error));
  await source.load();
  const features=Array.from({length:100},(_,i)=>({type:'Feature',id:`w${i}`,properties:{radius:10},geometry:{type:'Polygon',coordinates:[[[30+i*.0001,60],[30.00001+i*.0001,60],[30.00001+i*.0001,60.00001],[30+i*.0001,60]]]}}));
  const added=source.updateData({add:features});assert.equal(typeof added.then,'function');await added;
  const removing=source.updateData({remove:['w1','w2']}),second=source.updateData({remove:['w3','unknown']});await Promise.all([removing,second]);
  const result=await source.getData();assert.equal(result.features.length,97);assert.equal(index.getData().features.length,97);assert.deepEqual(errors,[]);
  assert.equal(messages.filter(m=>m.data.data).length,1);assert.ok(messages.filter(m=>m.data.dataDiff).length>=2);
  assert.ok(result.features.every(f=>!['w1','w2','w3'].includes(f.id)));
});
