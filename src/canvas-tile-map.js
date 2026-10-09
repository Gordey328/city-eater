import {canvasPixelRatio} from './canvas-budget.js';
import {mercatorProject as overviewProject,mercatorUnproject as overviewUnproject} from './mercator-view.js';
import {TileSource} from './tile-source.js';
import {VisualTileLayer} from './visual-tile-source.js';

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function visibleVisualTiles(center,zoom,width,height,maxTiles=16){
  const p=overviewProject(center),world=512*2**zoom;
  let z=clamp(Math.floor(zoom),0,14),result;
  for(;;){
    const n=2**z,x0=Math.floor((p[0]-width/2/world)*n),x1=Math.floor((p[0]+width/2/world)*n),y0=Math.max(0,Math.floor((p[1]-height/2/world)*n)),y1=Math.min(n-1,Math.floor((p[1]+height/2/world)*n));
    result=[];const seen=new Set();
    for(let y=y0;y<=y1;y++)for(let wx=x0;wx<=x1;wx++){
      const x=((wx%n)+n)%n,key=`${z}/${x}/${y}`;
      // Canonical URLs are deduplicated; nearest world copy is used for drawing.
      if(!seen.has(key)){seen.add(key);result.push({z,x,y});}
    }
    if(result.length<=maxTiles||z===0)break;z--;
  }
  return result.sort((a,b)=>{const n=2**a.z,d=t=>{const x=(t.x+.5)/n,wrapped=x+Math.round(p[0]-x);return (wrapped-p[0])**2+((t.y+.5)/n-p[1])**2;};return d(a)-d(b);});
}
export function drawVisualTiles(context,layer,tiles,{center,zoom,width,height}){
  const p=overviewProject(center),world=512*2**zoom;let missing=0,drawn=0;
  context.save();context.imageSmoothingEnabled=true;
  for(const tile of tiles){const image=layer.get(tile.z,tile.x,tile.y),n=2**tile.z,size=world/n,base=tile.x/n,copy=Math.round(p[0]-(base+.5/n));
    if(!image){missing++;continue;}
    for(const shift of [copy-1,copy,copy+1]){const x=(base+shift-p[0])*world+width/2,y=(tile.y/n-p[1])*world+height/2;if(x+size<0||x>width||y+size<0||y>height)continue;context.drawImage(image,x,y,size+.5,size+.5);drawn++;}
  }
  context.restore();return {missing,drawn};
}

/** Genuine north-up tiled map for the raster-mask game; requires only Canvas2D. */
export class CanvasTileMap {
  constructor({container,center,zoom,source=null,metadata,onError=()=>{},onStatus=()=>{},layerFactory=options=>new VisualTileLayer(options)}){
    this.container=typeof container==='string'?document.getElementById(container):container;this.center=[...center];this.zoom=zoom;this.onError=onError;this.onStatus=onStatus;this.ownsSource=!source;this.source=source||new TileSource();this.metadata=metadata;this.removed=false;this.revision=0;this.drawnRevision=-1;this.requested='';this.tiles=[];this.quality='high';this.stats={renderer:'canvas2d',frames:0,drawnTiles:0,missingTiles:0};
    this.container.replaceChildren();this.canvas=document.createElement('canvas');this.canvas.className='canvas-tile-map';this.canvas.setAttribute('aria-label','Карта OpenStreetMap, Canvas 2D');this.container.append(this.canvas);this.ctx=this.canvas.getContext('2d');if(!this.ctx)throw new Error('Canvas 2D недоступен в этом браузере.');
    this.attribution=document.createElement('div');this.attribution.className='canvas-map-attribution';this.attribution.innerHTML=metadata.attribution;this.container.append(this.attribution);
    this.layer=layerFactory({source:this.source,onChange:()=>{if(!this.removed){this.revision++;this.draw();}},onError:error=>{if(!this.removed)this.onError(error.message||String(error));}});
    this.resize();this.started=true;this.ready=this.ensure(true);
  }
  getCenter(){return{lng:this.center[0],lat:this.center[1]};}
  getZoom(){return this.zoom;}
  project(point){const p=overviewProject(point),center=overviewProject(this.center),world=512*2**this.zoom;return{x:(p[0]+Math.round(center[0]-p[0])-center[0])*world+this.width/2,y:(p[1]-center[1])*world+this.height/2};}
  getBounds(){const center=overviewProject(this.center),world=512*2**this.zoom;return{getWest:()=>((center[0]-this.width/2/world)*360-180),getEast:()=>((center[0]+this.width/2/world)*360-180),getSouth:()=>overviewUnproject([0,center[1]+this.height/2/world])[1],getNorth:()=>overviewUnproject([0,center[1]-this.height/2/world])[1]};}
  jumpTo({center,zoom}){if(center)this.center=[...center];if(Number.isFinite(zoom))this.zoom=clamp(zoom,0,19);this.revision++;this.ensure().catch(()=>{});this.draw();}
  resize(){const width=this.container.clientWidth||innerWidth,height=this.container.clientHeight||innerHeight,d=canvasPixelRatio(width,height,devicePixelRatio||1,this.quality);this.width=width;this.height=height;this.canvas.width=Math.max(1,width*d);this.canvas.height=Math.max(1,height*d);this.canvas.style.width=`${width}px`;this.canvas.style.height=`${height}px`;this.ctx.setTransform(d,0,0,d,0,0);this.revision++;this.draw();if(this.started)this.ensure().catch(()=>{});}
  setQuality(quality){this.quality=quality;this.resize();}
  async ensure(force=false){
    if(this.removed)return;const tiles=visibleVisualTiles(this.center,this.zoom,this.width,this.height),signature=tiles.map(t=>`${t.z}/${t.x}/${t.y}`).sort().join('|');this.tiles=tiles;
    if(!force&&signature===this.requested)return;this.requested=signature;
    try{await this.layer.ensure(tiles);if(!this.removed){this.revision++;this.draw();}}
    catch(error){if(!this.removed)this.onError(error.message||String(error));throw error;}
  }
  draw(){if(this.removed||!this.ctx||!this.layer||this.drawnRevision===this.revision)return;this.drawnRevision=this.revision;const c=this.ctx;c.clearRect(0,0,this.width,this.height);c.fillStyle='#e7e9d9';c.fillRect(0,0,this.width,this.height);const detail=drawVisualTiles(c,this.layer,this.tiles,{center:this.center,zoom:this.zoom,width:this.width,height:this.height});this.stats.frames++;this.stats.drawnTiles=detail.drawn;this.stats.missingTiles=detail.missing;this.stats.visual=this.layer.stats;}
  remove(){if(this.removed)return;this.removed=true;this.layer.dispose();if(this.ownsSource)this.source.dispose();this.container.replaceChildren();}
}
