import maplibregl from 'maplibre-gl';
import {Protocol} from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {localToLonLat} from './geometry.js';
import {cameraMetrics} from './camera.js';
const protocol=new Protocol();maplibregl.addProtocol('pmtiles',protocol.tile);
const empty=()=>({type:'FeatureCollection',features:[]});
export class MapRenderer {
  constructor(onError){
    this.onError=onError;this.map=null;this.manifest=null;this.ready=false;
    this.canvas=document.querySelector('#effects');this.ctx=this.canvas.getContext('2d');this.quality='high';this.width=0;this.height=0;
    window.addEventListener('resize',()=>this.resize());this.resize();
  }
  resize(){this.width=innerWidth;this.height=innerHeight;const d=Math.min(devicePixelRatio||1,this.quality==='low'?1:2);this.canvas.width=this.width*d;this.canvas.height=this.height*d;this.canvas.style.width=`${this.width}px`;this.canvas.style.height=`${this.height}px`;this.ctx.setTransform(d,0,0,d,0,0);this.map?.resize();}
  async load(manifest,base,run=null){
    this.manifest=manifest;this.ready=false;clearTimeout(this.dataTimer);this.dataTimer=null;this.pendingFeatures=null;this.map?.remove();
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
    this.map=new maplibregl.Map({container:'map',style,center:localToLonLat(run?.position||manifest.spawn||[0,0],manifest.center),zoom:cameraMetrics(run?.radius||manifest.initialRadius||18,this.width,this.height,manifest.center[1]).zoom,minZoom:10,maxZoom:19,pitch:0,bearing:0,interactive:false,attributionControl:{compact:true},canvasContextAttributes:{antialias:true},fadeDuration:0});
    this.map.on('error',event=>this.onError(event.error?.message||'Ошибка фоновой карты'));
    await new Promise((resolve,reject)=>{this.map.once('load',resolve);setTimeout(()=>{if(!this.map?.loaded())resolve();},12000);});
    this.ready=!!this.map.getSource('buildings');this.resize();
  }
  setBuildings(features){if(!this.ready)return;this.pendingFeatures=features;if(this.dataTimer)return;const apply=()=>{this.dataTimer=null;if(this.ready&&this.pendingFeatures){this.map.getSource('buildings')?.setData(this.pendingFeatures);this.pendingFeatures=null;this.lastData=performance.now();}};const delay=Math.max(0,75-(performance.now()-(this.lastData||0)));if(delay)this.dataTimer=setTimeout(apply,delay);else apply();}
  setRadius(radius){if(!this.ready)return;this.map.setPaintProperty('buildings','fill-color',['case',['<=',['get','radius'],radius*1.06],'#b7cf66','#82927f']);this.map.setPaintProperty('building-edge','line-color',['case',['<=',['get','radius'],radius*1.06],'#798c3d','#61715d']);}
  setQuality(quality){this.quality=quality;this.resize();}
  camera(position,radius,dt=1/60,overview=false){
    if(!this.ready)return;
    const targetZoom=cameraMetrics(radius,this.width,this.height,this.manifest.center[1]).zoom;
    const factor=1-Math.exp(-dt*5),current=this.map.getCenter(),target=localToLonLat(position,this.manifest.center);
    this.map.jumpTo({center:[current.lng+(target[0]-current.lng)*factor,current.lat+(target[1]-current.lat)*factor],zoom:this.map.getZoom()+(targetZoom-this.map.getZoom())*factor});
  }
  project(position){const p=this.map.project(localToLonLat(position,this.manifest.center));return [p.x,p.y];}
  render(run,animations,now,direction=[0,0]){
    const c=this.ctx,w=this.width,h=this.height;c.clearRect(0,0,w,h);if(!this.ready||!run)return;
    const p=this.project(run.position),edge=this.project([run.position[0]+run.radius,run.position[1]]),r=Math.max(5,edge[0]-p[0]);
    // Original visual treatment; purely cosmetic hole rings, never synthetic map objects.
    const halo=c.createRadialGradient(p[0],p[1],r*.8,p[0],p[1],r*1.3);halo.addColorStop(0,'#a9d84c00');halo.addColorStop(.65,'#99bc4c33');halo.addColorStop(1,'#99bc4c00');
    c.fillStyle=halo;c.beginPath();c.arc(p[0],p[1],r*1.3,0,Math.PI*2);c.fill();
    c.save();c.shadowBlur=this.quality==='low'?0:18;c.shadowColor='#1b261777';c.fillStyle='#10170f';c.beginPath();c.arc(p[0],p[1],r,0,Math.PI*2);c.fill();c.restore();
    c.strokeStyle='#d8fa51';c.lineWidth=3;c.beginPath();c.arc(p[0],p[1],r+1,0,Math.PI*2);c.stroke();
    c.strokeStyle='#516837';c.lineWidth=1;c.beginPath();c.arc(p[0],p[1],r*.83,now*.0003,now*.0003+4.5);c.stroke();
    c.strokeStyle='#293822';c.beginPath();c.arc(p[0],p[1],r*.61,-now*.0005,-now*.0005+3.5);c.stroke();
    if(Math.hypot(...direction)>.15){const a=Math.atan2(-direction[1],direction[0]);c.fillStyle='#d8fa51';c.beginPath();c.arc(p[0]+Math.cos(a)*(r+9),p[1]+Math.sin(a)*(r+9),3,0,Math.PI*2);c.fill();}
    for(const anim of animations){
      const t=Math.min(1,(now-anim.started)/anim.duration),scale=1-t*t,origin=this.project(anim.building.center),target=p;
      c.save();c.globalAlpha=1-t;c.fillStyle='#cbdf7c';c.strokeStyle='#5a7333';c.lineWidth=1;
      const tx=origin[0]+(target[0]-origin[0])*t,ty=origin[1]+(target[1]-origin[1])*t;
      for(const polygon of anim.building.polygons){c.beginPath();for(const ring of polygon){ring.forEach((pt,i)=>{const q=this.project(pt),x=tx+(q[0]-origin[0])*scale,y=ty+(q[1]-origin[1])*scale;i?c.lineTo(x,y):c.moveTo(x,y);});c.closePath();}c.fill('evenodd');c.stroke();}c.restore();
    }
    c.save();c.fillStyle='#ebf6d6';c.textAlign='center';c.font=`600 ${Math.max(10,Math.min(15,r*.22))}px monospace`;c.fillText(`${Math.round(run.radius)} м`,p[0],p[1]+4);c.restore();
  }
}
