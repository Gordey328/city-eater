import {localToLonLat} from './geometry.js';
import {mercatorProject} from './mercator-view.js';
/** Frozen coast and score outline, cached once in world coordinates. Camera
 * updates alter an affine matrix only; provider/zoom never changes this path. */
export class RegionDisplay {
 constructor(manifest,pathFactory=()=>new Path2D()){
  this.origin=mercatorProject(manifest.center);this.paths={};
  for(const [name,polygons] of [['land',manifest.region?.polygons||[]],['water',manifest.boundary?.waterPolygons||[]]]){
   const path=pathFactory();let vertices=0;for(const polygon of polygons)for(const ring of polygon){for(let i=0;i<ring.length;i++){const p=mercatorProject(localToLonLat(ring[i],manifest.center,manifest.projectionLatitude));p[0]+=Math.round(this.origin[0]-p[0]);i?path.lineTo(p[0]-this.origin[0],p[1]-this.origin[1]):path.moveTo(p[0]-this.origin[0],p[1]-this.origin[1]);vertices++;}path.closePath();}this.paths[name]=path;this.vertices=(this.vertices||0)+vertices;
  }
 }
 transform(context,frame){const {worldSize:s,groundScaleY:y=1,offsetX,offsetY}=frame;context.translate(this.origin[0]*s+offsetX,this.origin[1]*s*y+offsetY);context.scale(s,s*y);}
 drawWater(context,frame){context.save();this.transform(context,frame);context.fillStyle='#b8d8dd';context.fill(this.paths.water,'evenodd');context.restore();}
 clipLand(context,frame){context.save();this.transform(context,frame);context.clip(this.paths.land,'evenodd');const {worldSize:s,groundScaleY:y=1,offsetX,offsetY}=frame;context.scale(1/s,1/(s*y));context.translate(-(this.origin[0]*s+offsetX),-(this.origin[1]*s*y+offsetY));}
 drawBoundary(context,frame){context.save();this.transform(context,frame);context.strokeStyle='#357778';context.lineWidth=2/frame.worldSize;context.setLineDash([]);context.stroke(this.paths.land);context.restore();}
}
