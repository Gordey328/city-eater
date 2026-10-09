import {mapCoordinates} from './map-style.js';
export function streamMapStyle(metadata,{manifest=null,buildings=true}={}){
  const style={version:8,sources:{world:{type:'vector',tiles:metadata.tiles,minzoom:metadata.minzoom??0,maxzoom:metadata.maxzoom??14,attribution:metadata.attribution||'© OpenStreetMap contributors · OpenFreeMap'}},layers:[
    {id:'ground',type:'background',paint:{'background-color':'#e7e9d9'}},
    {id:'landcover',type:'fill',source:'world','source-layer':'landcover',paint:{'fill-color':'#cfdbbb','fill-opacity':.55}},
    {id:'park',type:'fill',source:'world','source-layer':'park',paint:{'fill-color':'#c4d3b3','fill-opacity':.75}},
    {id:'water',type:'fill',source:'world','source-layer':'water',paint:{'fill-color':'#a9cad0'}},
    {id:'waterway',type:'line',source:'world','source-layer':'waterway',paint:{'line-color':'#a9cad0','line-width':1.5}},
    {id:'road-case',type:'line',source:'world','source-layer':'transportation',filter:['!=',['get','class'],'rail'],paint:{'line-color':'#c8cbb9','line-width':['interpolate',['linear'],['zoom'],8,.6,14,2,18,14]}},
    {id:'roads',type:'line',source:'world','source-layer':'transportation',filter:['!=',['get','class'],'rail'],paint:{'line-color':'#fffdef','line-width':['interpolate',['linear'],['zoom'],8,.3,14,1,18,10]}},
    {id:'rail',type:'line',source:'world','source-layer':'transportation',filter:['==',['get','class'],'rail'],paint:{'line-color':'#aeb1a2','line-width':1,'line-dasharray':[3,2]}}
  ]};
  if(buildings)style.layers.push({id:'world-buildings',type:'fill',source:'world','source-layer':'building',minzoom:13,paint:{'fill-color':'#82927f','fill-opacity':.7}});
  if(manifest){const coordinates=[[-5000,-5000],[5000,-5000],[5000,5000],[-5000,5000],[-5000,-5000]].map(p=>mapCoordinates(p,manifest));style.sources.bounds={type:'geojson',data:{type:'Feature',geometry:{type:'Polygon',coordinates:[coordinates]}}};style.layers.push({id:'arena',type:'line',source:'bounds',paint:{'line-color':'#e2734b','line-width':3,'line-dasharray':[3,2]}});}
  // Existing renderer readiness hooks expect a buildings source. Tile-mask
  // geometry is drawn separately and this empty source never holds history.
  style.sources.buildings={type:'geojson',data:{type:'FeatureCollection',features:[]}};
  return style;
}
