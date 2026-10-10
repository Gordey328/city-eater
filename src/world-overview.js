import {canvasPixelRatio} from './canvas-budget.js';
/** Honest 2D fallback for the city-selection overview, using the same Natural Earth data.
 * Canvas tile imagery can be injected without changing selection gestures. */
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function overviewProject([lon,lat]){const p=clamp(lat,-84.9,84.9)*Math.PI/180;return[(lon+180)/360,(1-Math.log(Math.tan(p)+1/Math.cos(p))/Math.PI)/2];}
export function overviewUnproject([x,y]){return[((x*360)%360+360)%360-180,Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI];}
const polygonCache=new WeakMap();
export function overviewPolygon(polygon){let cached=polygonCache.get(polygon);if(cached)return cached;const origin=overviewProject(polygon[0][0]),path=typeof Path2D==='function'?new Path2D():null,bounds=[Infinity,Infinity,-Infinity,-Infinity],points=polygon.map(ring=>ring.map((point,i)=>{const p=overviewProject(point);p[0]+=Math.round(origin[0]-p[0]);bounds[0]=Math.min(bounds[0],p[0]);bounds[1]=Math.min(bounds[1],p[1]);bounds[2]=Math.max(bounds[2],p[0]);bounds[3]=Math.max(bounds[3],p[1]);if(path){i?path.lineTo(p[0]-origin[0],p[1]-origin[1]):path.moveTo(p[0]-origin[0],p[1]-origin[1]);if(i===ring.length-1)path.closePath();}return p;}));cached={origin,path,bounds,points};polygonCache.set(polygon,cached);return cached;}
export class WorldOverview {
  constructor(container,land,center,onSelect){
    this.container=container;this.center=overviewProject(center||[30,35]);this.zoom=2;this.features=[];this.handlers=new Map();this.onSelect=onSelect;this.events=new AbortController();this.points=new Map();this.dragged=false;
    this.land=(land.features||[]).flatMap(f=>f.geometry?.type==='Polygon'?[f.geometry.coordinates]:f.geometry?.type==='MultiPolygon'?f.geometry.coordinates:[]).map(polygon=>polygon.map(ring=>{let prev;return ring.map(p=>{const q=overviewProject(p);if(prev!==undefined){while(q[0]-prev>.5)q[0]--;while(q[0]-prev<-.5)q[0]++;}prev=q[0];return q;});}));
    container.replaceChildren();this.canvas=document.createElement('canvas');this.canvas.className='world-overview-canvas';this.canvas.setAttribute('aria-label','Обзорная карта мира: перетаскивай, меняй масштаб, нажми для выбора города');this.canvas.tabIndex=0;container.append(this.canvas);this.ctx=this.canvas.getContext('2d');
    const controls=document.createElement('div');controls.className='world-overview-controls';for(const [label,delta] of [['+',1],['−',-1]]){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-label',delta>0?'Приблизить карту':'Отдалить карту');b.onclick=()=>{this.zoom=clamp(this.zoom+delta,1,16);this.viewChanged();};controls.append(b);}container.append(controls);
    const attribution=document.createElement('span');this.attribution=attribution;attribution.className='world-overview-attribution';attribution.textContent='Natural Earth · обзорная карта 2D';container.append(attribution);
    const opt={signal:this.events.signal};this.canvas.addEventListener('pointerdown',e=>{this.canvas.setPointerCapture(e.pointerId);this.points.set(e.pointerId,[e.clientX,e.clientY]);if(this.points.size===1){this.origin=[e.clientX,e.clientY];this.startCenter=[...this.center];this.dragged=false;}else{this.pinchDistance=this.distance();this.pinchZoom=this.zoom;this.dragged=true;}e.preventDefault();},opt);
    this.canvas.addEventListener('pointermove',e=>{if(!this.points.has(e.pointerId))return;this.points.set(e.pointerId,[e.clientX,e.clientY]);if(this.points.size>=2){this.zoom=clamp(this.pinchZoom+Math.log2(this.distance()/(this.pinchDistance||1)),1,16);this.viewChanged();return;}const dx=e.clientX-this.origin[0],dy=e.clientY-this.origin[1];if(Math.hypot(dx,dy)>5)this.dragged=true;const scale=512*2**this.zoom;this.center=[this.startCenter[0]-dx/scale,clamp(this.startCenter[1]-dy/scale,.01,.99)];this.viewChanged();},opt);
    const release=e=>{const selected=!this.dragged&&this.points.size===1&&this.points.has(e.pointerId);this.points.delete(e.pointerId);if(selected&&e.type==='pointerup'){const rect=this.canvas.getBoundingClientRect(),scale=512*2**this.zoom;this.onSelect(overviewUnproject([this.center[0]+(e.clientX-rect.left-this.width/2)/scale,this.center[1]+(e.clientY-rect.top-this.height/2)/scale]));}if(this.points.size===1){this.origin=[...this.points.values()][0];this.startCenter=[...this.center];this.dragged=true;}};
    this.canvas.addEventListener('pointerup',release,opt);this.canvas.addEventListener('pointercancel',release,opt);const reset=()=>{this.points.clear();this.dragged=true;this.pinchDistance=0;};this.canvas.addEventListener('lostpointercapture',reset,opt);window.addEventListener('blur',reset,opt);document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();},opt);this.canvas.addEventListener('wheel',e=>{e.preventDefault();this.zoom=clamp(this.zoom-e.deltaY*.002,1,16);this.viewChanged();},{...opt,passive:false});
    this.canvas.addEventListener('keydown',e=>{const d=.12/2**(this.zoom-2);if(e.key==='ArrowLeft')this.center[0]-=d;else if(e.key==='ArrowRight')this.center[0]+=d;else if(e.key==='ArrowUp')this.center[1]-=d;else if(e.key==='ArrowDown')this.center[1]+=d;else if(e.key==='Enter'){this.onSelect(overviewUnproject(this.center));return;}else return;e.preventDefault();this.center[1]=clamp(this.center[1],.01,.99);this.viewChanged();},opt);
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(container);this.resize();
  }
  setBackground(drawer,attribution){this.backgroundDrawer=drawer;if(attribution)this.attribution.innerHTML=attribution;this.draw();}
  distance(){const p=[...this.points.values()];return p.length>=2?Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]):1;}
  resize(){this.width=this.container.clientWidth;this.height=this.container.clientHeight;const d=canvasPixelRatio(this.width,this.height,devicePixelRatio||1);this.canvas.width=Math.max(1,this.width*d);this.canvas.height=Math.max(1,this.height*d);this.canvas.style.width=`${this.width}px`;this.canvas.style.height=`${this.height}px`;this.ctx.setTransform(d,0,0,d,0,0);this.viewChanged();}
  getZoom(){return this.zoom;}
  getCenter(){const [lng,lat]=overviewUnproject(this.center);return{lng,lat};}
  getBounds(){const scale=512*2**this.zoom,west=(this.center[0]-this.width/2/scale)*360-180,east=(this.center[0]+this.width/2/scale)*360-180,north=overviewUnproject([0,this.center[1]-this.height/2/scale])[1],south=overviewUnproject([0,this.center[1]+this.height/2/scale])[1];return{getWest:()=>west,getEast:()=>east,getSouth:()=>south,getNorth:()=>north};}
  project(point){const p=overviewProject(point),scale=512*2**this.zoom,shift=Math.round(this.center[0]-p[0]);return{x:(p[0]+shift-this.center[0])*scale+this.width/2,y:(p[1]-this.center[1])*scale+this.height/2};}
  on(event,callback){if(!this.handlers.has(event))this.handlers.set(event,new Set());this.handlers.get(event).add(callback);return this;}
  viewChanged(){for(const callback of this.handlers.get('movestart')||[])callback();this.draw();for(const callback of this.handlers.get('moveend')||[])callback();}
  getSource(name){return name==='selection'?{setData:data=>{this.features=data.features||[];this.draw();}}:null;}
  easeTo({center,zoom}){if(center)this.center=overviewProject(center);if(Number.isFinite(zoom))this.zoom=clamp(zoom,1,16);this.viewChanged();}
  path(polygon,shift=0){const c=this.ctx,scale=512*2**this.zoom;c.beginPath();for(const ring of polygon){ring.forEach((p,i)=>{const x=(p[0]+shift-this.center[0])*scale+this.width/2,y=(p[1]-this.center[1])*scale+this.height/2;i?c.lineTo(x,y):c.moveTo(x,y);});c.closePath();}}
  draw(){if(!this.ctx||!this.width)return;const c=this.ctx,scale=512*2**this.zoom;c.clearRect(0,0,this.width,this.height);c.fillStyle='#c5dce1';c.fillRect(0,0,this.width,this.height);c.fillStyle='#e3e8d4';c.strokeStyle='#9fae8e';c.lineWidth=.75;
    for(const p of this.land){const base=Math.round(this.center[0]-(p[0]?.[0]?.[0]||0));for(const shift of [base-1,base,base+1]){this.path(p,shift);c.fill('evenodd');c.stroke();}}
    this.backgroundDrawer?.(c,{center:[this.getCenter().lng,this.getCenter().lat],zoom:this.zoom,width:this.width,height:this.height});
    for(const f of this.features){
      if(f.geometry.type==='Polygon'||f.geometry.type==='MultiPolygon'){
        const polygons=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;
        for(const polygon of polygons){
          const cached=overviewPolygon(polygon),p=cached.points,shift=Math.round(this.center[0]-p[0][0][0]),box=cached.bounds;
          const left=(box[0]+shift-this.center[0])*scale+this.width/2,right=(box[2]+shift-this.center[0])*scale+this.width/2,top=(box[1]-this.center[1])*scale+this.height/2,bottom=(box[3]-this.center[1])*scale+this.height/2;
          if(right<0||left>this.width||bottom<0||top>this.height)continue;
          const status=f.properties?.status,progress=clamp(Number(f.properties?.goalProgress)||0,0,100),tx=(cached.origin[0]+shift-this.center[0])*scale+this.width/2,ty=(cached.origin[1]-this.center[1])*scale+this.height/2;
          c.save();c.fillStyle=status==='done'?'#678c3755':status==='cached'||status==='ready'?'#b7da6655':'#dce5bc33';c.strokeStyle=status==='done'?'#4e722e':'#6e8553';c.lineWidth=f.properties?.selected?2.5:1.25;
          if(cached.path){c.translate(tx,ty);c.scale(scale,scale);c.lineWidth/=scale;c.fill(cached.path,'evenodd');c.stroke(cached.path);}else{this.path(p,shift);c.fill('evenodd');c.stroke();}
          if(progress>0){cached.path?c.clip(cached.path,'evenodd'):c.clip('evenodd');c.fillStyle=progress>=100?'#739d45aa':'#a5ce62aa';if(cached.path)c.fillRect((left-tx)/scale,(bottom-(bottom-top)*progress/100-ty)/scale,(right-left)/scale,(bottom-top)*progress/100/scale);else c.fillRect(left,bottom-(bottom-top)*progress/100,right-left,(bottom-top)*progress/100);}
          c.restore();
          if(right-left>64&&bottom-top>45){const anchor=f.properties?.labelCoordinate?this.project(f.properties.labelCoordinate):{x:(left+right)/2,y:(top+bottom)/2};if(anchor.x<0||anchor.x>this.width||anchor.y<0||anchor.y>this.height)continue;const label=progress>=100?'✓ Цель':`${Math.floor(progress)}% цели`;c.save();c.font='600 11px monospace';c.textAlign='center';c.lineWidth=4;c.strokeStyle='#f7fbe9';c.strokeText(label,anchor.x,anchor.y);c.fillStyle='#304c20';c.fillText(label,anchor.x,anchor.y);c.restore();}
        }
      }else if(f.geometry.type==='Point'){const p=this.project(f.geometry.coordinates);c.beginPath();c.arc(p.x,p.y,9,0,Math.PI*2);c.fillStyle='#192c15';c.fill();c.strokeStyle='#d8fa51';c.lineWidth=3;c.stroke();}
    }

  }
  remove(){this.events.abort();this.observer.disconnect();this.container.replaceChildren();}
}
