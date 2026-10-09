import {canvasPixelRatio} from './canvas-budget.js';
import * as maplibregl from 'maplibre-gl';
import {Protocol} from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {cameraMetrics} from './camera.js';
import {prepareAnimationGeometry} from './animation-geometry.js';
import {createMapStyle,mapCoordinates} from './map-style.js';
import {streamMapStyle} from './stream-map-style.js';
import {waitForRenderer} from './renderer-readiness.js';
import {CanvasTileMap} from './canvas-tile-map.js';
const protocol=new Protocol();maplibregl.addProtocol('pmtiles',protocol.tile);
export class MapRenderer {
  constructor(onError){
    this.onError=onError;this.map=null;this.manifest=null;this.ready=false;
    this.canvas=document.querySelector('#effects');this.ctx=this.canvas.getContext('2d');this.quality='high';this.width=0;this.height=0;
    window.addEventListener('resize',()=>this.resize());this.resize();
  }
  resize(){this.width=innerWidth;this.height=innerHeight;const d=canvasPixelRatio(this.width,this.height,devicePixelRatio||1,this.quality);this.canvas.width=this.width*d;this.canvas.height=this.height*d;this.canvas.style.width=`${this.width}px`;this.canvas.style.height=`${this.height}px`;this.ctx.setTransform(d,0,0,d,0,0);this.map?.resize();}
  dispose(){this.loadGeneration=(this.loadGeneration||0)+1;this.cancelLoad?.();this.cancelLoad=null;clearTimeout(this.dataTimer);this.dataTimer=null;this.pendingRepository=null;this.ready=false;this.map?.remove();this.map=null;this.ctx.clearRect(0,0,this.width,this.height);}
  async load(manifest,base,run=null,{tileSource}={}){
    const generation=(this.loadGeneration||0)+1;this.loadGeneration=generation;this.cancelLoad?.();
    this.manifest=manifest;this.ready=false;clearTimeout(this.dataTimer);this.dataTimer=null;this.pendingFeatures=null;this.pendingRepository=null;this.lastRadius=null;this.map?.remove();this.map=null;
    if(manifest.mode==='tile-mask-v1'){
      this.type='canvas2d';
      this.map=new CanvasTileMap({container:'map',center:mapCoordinates(run?.position||[0,0],manifest),zoom:cameraMetrics(run?.radius||18,this.width,this.height,mapCoordinates(run?.position||[0,0],manifest)[1],manifest.projectionLatitude).zoom,source:tileSource,metadata:manifest.tileMetadata,onError:this.onError});
      await this.map.ready;if(generation!==this.loadGeneration)return;this.ready=true;this.map.setQuality(this.quality);this.resize();return;
    }
    this.type='webgl2';
    const style=manifest.mode==='tile-mask-v1'?streamMapStyle(manifest.tileMetadata,{manifest,buildings:false}):createMapStyle(manifest,base);
    this.map=new maplibregl.Map({container:'map',style,center:mapCoordinates(run?.position||manifest.spawn||[0,0],manifest),zoom:cameraMetrics(run?.radius||manifest.initialRadius||18,this.width,this.height,manifest.projectionLatitude===undefined?manifest.center[1]:mapCoordinates(run?.position||manifest.spawn||[0,0],manifest)[1],manifest.projectionLatitude).zoom,minZoom:0,maxZoom:19,pitch:0,bearing:0,interactive:false,maxTileCacheSize:64,attributionControl:{compact:true},canvasContextAttributes:{antialias:true},fadeDuration:0});
    const map=this.map;
    map.on('error',event=>{if(this.map===map)this.onError(event.error?.message||'Ошибка фоновой карты');});
    const strict=manifest.mode==='tile-mask-v1',waiting=waitForRenderer(map,{event:strict?'style.load':'load',strict});
    this.cancelLoad=waiting.cancel;await waiting.promise;
    if(generation!==this.loadGeneration)return;
    this.cancelLoad=null;this.ready=!!map.getSource('buildings');this.resize();
    if(this.pendingRepository)this.syncBuildings(this.pendingRepository);
  }
  syncBuildings(repository){
    if(!repository||repository.disposed)return;
    this.pendingRepository=repository;
    if(!this.ready||this.dataTimer)return;
    // Chunk arrivals and dozens of swallowed objects share one worker message.
    const apply=()=>{this.dataTimer=null;const repo=this.pendingRepository;this.pendingRepository=null;
      if(!this.ready||!repo||repo.disposed)return;
      const diff=repo.takeRenderChanges();
      if(diff){const update=this.map.getSource('buildings')?.updateData(diff);update?.catch?.(error=>this.onError(error.message||'Не удалось обновить здания'));this.lastData=performance.now();}
    };
    const delay=Math.max(0,100-(performance.now()-(this.lastData||0)));
    if(delay)this.dataTimer=setTimeout(apply,delay);else apply();
  }
  // For explicit diagnostics only. Gameplay uses incremental syncBuildings.
  setBuildings(features){if(this.ready){const update=this.map.getSource('buildings')?.setData(features);update?.catch?.(error=>this.onError(error.message||'Не удалось обновить здания'));}}
  setRadius(radius){if(!this.ready||radius===this.lastRadius)return;this.lastRadius=radius;if(this.manifest.mode==='tile-mask-v1')return;this.map.setPaintProperty('buildings','fill-color',['case',['<=',['get','radius'],radius*1.06],'#b7cf66','#82927f']);this.map.setPaintProperty('building-edge','line-color',['case',['<=',['get','radius'],radius*1.06],'#798c3d','#61715d']);}
  setQuality(quality){this.quality=quality;this.map?.setQuality?.(quality);this.resize();}
  camera(position,radius,dt=1/60,overview=false){
    if(!this.ready)return;
    const current=this.map.getCenter(),target=mapCoordinates(position,this.manifest,current.lng);
    const targetZoom=cameraMetrics(radius,this.width,this.height,this.manifest.projectionLatitude===undefined?this.manifest.center[1]:target[1],this.manifest.projectionLatitude).zoom;
    const factor=1-Math.exp(-dt*5);
    if(Math.abs(target[0]-current.lng)<1e-9&&Math.abs(target[1]-current.lat)<1e-9&&Math.abs(targetZoom-this.map.getZoom())<1e-5)return;
    this.map.jumpTo({center:[current.lng+(target[0]-current.lng)*factor,current.lat+(target[1]-current.lat)*factor],zoom:this.map.getZoom()+(targetZoom-this.map.getZoom())*factor});
  }
  project(position){const p=this.map.project(mapCoordinates(position,this.manifest,this.map.getCenter().lng));return [p.x,p.y];}
  render(run,animations,now,direction=[0,0]){
    const c=this.ctx,w=this.width,h=this.height;c.clearRect(0,0,w,h);if(!this.ready||!run)return;
    this.map.draw?.();
    this.maskDisplay?.draw(this);
    if(this.type==='canvas2d'){
      c.save();c.strokeStyle='#6b8050';c.lineWidth=2;c.setLineDash([10,8]);c.beginPath();
      for(const [i,point] of [[-5000,-5000],[5000,-5000],[5000,5000],[-5000,5000]].entries()){const p=this.project(point);i?c.lineTo(...p):c.moveTo(...p);}c.closePath();c.stroke();c.restore();
    }
    const p=this.project(run.position),edge=this.project([run.position[0]+run.radius,run.position[1]]),r=Math.max(5,edge[0]-p[0]);
    // Imported city sectors share x units; Mercator y scale still varies by row.
    const ry=this.manifest.projectionLatitude===undefined?r:Math.max(5,Math.max(Math.abs(this.project([run.position[0],run.position[1]+run.radius])[1]-p[1]),Math.abs(this.project([run.position[0],run.position[1]-run.radius])[1]-p[1])));
    // Original visual treatment; purely cosmetic hole rings, never synthetic map objects.
    c.save();c.translate(p[0],p[1]);c.scale(1,ry/r);
    const halo=c.createRadialGradient(0,0,r*.8,0,0,r*1.3);halo.addColorStop(0,'#a9d84c00');halo.addColorStop(.65,'#99bc4c33');halo.addColorStop(1,'#99bc4c00');
    c.fillStyle=halo;c.beginPath();c.arc(0,0,r*1.3,0,Math.PI*2);c.fill();c.restore();
    c.save();c.shadowBlur=this.quality==='low'?0:18;c.shadowColor='#1b261777';c.fillStyle='#10170f';c.beginPath();c.ellipse(p[0],p[1],r,ry,0,0,Math.PI*2);c.fill();c.restore();
    c.strokeStyle='#d8fa51';c.lineWidth=3;c.beginPath();c.ellipse(p[0],p[1],r+1,ry+1,0,0,Math.PI*2);c.stroke();
    c.strokeStyle='#516837';c.lineWidth=1;c.beginPath();c.ellipse(p[0],p[1],r*.83,ry*.83,0,now*.0003,now*.0003+4.5);c.stroke();
    c.strokeStyle='#293822';c.beginPath();c.ellipse(p[0],p[1],r*.61,ry*.61,0,-now*.0005,-now*.0005+3.5);c.stroke();
    if(Math.hypot(...direction)>.15){const a=Math.atan2(-direction[1],direction[0]);c.fillStyle='#d8fa51';c.beginPath();c.arc(p[0]+Math.cos(a)*(r+9),p[1]+Math.sin(a)*(ry+9),3,0,Math.PI*2);c.fill();}
    const worldSize=512*2**this.map.getZoom();
    for(const anim of animations){
      const t=Math.min(1,(now-anim.started)/anim.duration),scale=1-t*t,origin=this.project(anim.building.center),target=p;
      c.save();c.globalAlpha=1-t;c.fillStyle='#cbdf7c';c.strokeStyle='#5a7333';c.lineWidth=1;
      const tx=origin[0]+(target[0]-origin[0])*t,ty=origin[1]+(target[1]-origin[1])*t;
      anim.projectedRings??=prepareAnimationGeometry(anim.building,this.manifest.center,this.manifest.projectionLatitude);
      const pixelScale=worldSize*scale;
      for(const polygon of anim.projectedRings){c.beginPath();for(const ring of polygon){for(let i=0;i<ring.length;i+=2){const x=tx+ring[i]*pixelScale,y=ty+ring[i+1]*pixelScale;i?c.lineTo(x,y):c.moveTo(x,y);}c.closePath();}c.fill('evenodd');c.stroke();}c.restore();
    }
    c.save();c.fillStyle='#ebf6d6';c.textAlign='center';c.font=`600 ${Math.max(10,Math.min(15,r*.22))}px monospace`;c.fillText(`${Math.round(run.radius)} м`,p[0],p[1]+4);c.restore();
  }
}
