import {localToLonLat} from './geometry.js';
const empty=()=>({type:'FeatureCollection',features:[]});

/** Pure style construction, independently validated against the installed MapLibre spec. */
export function createMapStyle(manifest,base){
    const sources=manifest.sourceLayers || {roads:'roads',water:'water',parks:'parks'};
    const pmUrl=new URL(manifest.pmtiles||'map.pmtiles',base).href;
    const corners=[[-5000,-5000],[5000,-5000],[5000,5000],[-5000,5000],[-5000,-5000]].map(p=>localToLonLat(p,manifest.center));
    const style={version:8,sources:{basemap:{type:'vector',url:`pmtiles://${pmUrl}`,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'},buildings:{type:'geojson',data:empty()},bounds:{type:'geojson',data:{type:'Feature',geometry:{type:'Polygon',coordinates:[corners]}}}},layers:[
      {id:'ground',type:'background',paint:{'background-color':'#e7e9d9'}},
      {id:'parks',type:'fill',source:'basemap','source-layer':sources.parks,paint:{'fill-color':'#c4d3b3','fill-opacity':.7}},
      {id:'water',type:'fill',source:'basemap','source-layer':sources.water,paint:{'fill-color':'#a9cad0'}},
      {id:'road-case',type:'line',source:'basemap','source-layer':sources.roads,filter:['!=',['get','kind'],'waterway'],paint:{'line-color':'#d3d5c5','line-width':['interpolate',['linear'],['zoom'],11,1,18,10]}},
      {id:'roads',type:'line',source:'basemap','source-layer':sources.roads,filter:['!=',['get','kind'],'waterway'],paint:{'line-color':'#fffdef','line-width':['interpolate',['linear'],['zoom'],11,.5,18,6]}},
      {id:'waterway',type:'line',source:'basemap','source-layer':sources.roads,filter:['==',['get','kind'],'waterway'],paint:{'line-color':'#a9cad0','line-width':2}},
      {id:'buildings-shadow',type:'fill',source:'buildings',paint:{'fill-color':'#152115','fill-opacity':.13,'fill-translate':[2,3]}},
      {id:'buildings',type:'fill',source:'buildings',paint:{'fill-color':'#82927f','fill-opacity':.92}},
      {id:'building-edge',type:'line',source:'buildings',paint:{'line-color':'#61715d','line-width':1,'line-opacity':.8}},
      {id:'arena',type:'line',source:'bounds',paint:{'line-color':'#e2734b','line-width':3,'line-dasharray':[3,2]}}
    ]};
    if(manifest.background?.type==='geojson'){
      style.sources.basemap={type:'geojson',data:manifest.background.data,attribution:style.sources.basemap.attribution};
      const groups={parks:'parks',water:'water','road-case':'roads',roads:'roads',waterway:'water'};
      for(const layer of style.layers)if(groups[layer.id]){
        delete layer['source-layer'];
        const groupFilter=['==',['get','kindGroup'],groups[layer.id]];
        layer.filter=layer.id==='waterway'?['all',groupFilter,['==',['geometry-type'],'LineString']]:layer.id==='water'?['all',groupFilter,['==',['geometry-type'],'Polygon']]:layer.filter?['all',groupFilter,layer.filter]:groupFilter;
      }
    }
    return style;
}
