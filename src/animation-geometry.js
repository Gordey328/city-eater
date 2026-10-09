import {localToLonLat} from './geometry.js';
const DEG=Math.PI/180;
export function mercatorPoint([lng,lat]){
  const sine=Math.sin(Math.max(-85.051129,Math.min(85.051129,lat))*DEG);
  return [(lng+180)/360,.5-Math.log((1+sine)/(1-sine))/(4*Math.PI)];
}
/** Cache exact Mercator offsets once, then use only arithmetic while animating.
 * The game camera is north-up with pitch 0, so the transform is a uniform scale.
 */
export function prepareAnimationGeometry(building,center,projectionLatitude=center[1]){
  const origin=mercatorPoint(localToLonLat(building.center,center,projectionLatitude));
  return building.polygons.map(polygon=>polygon.map(ring=>{
    const offsets=new Float64Array(ring.length*2);
    for(let i=0;i<ring.length;i++){
      const point=mercatorPoint(localToLonLat(ring[i],center,projectionLatitude));
      // Keep dateline-crossing cities continuous around the building origin.
      let dx=point[0]-origin[0];if(dx>.5)dx--;if(dx<-.5)dx++;
      offsets[i*2]=dx;offsets[i*2+1]=point[1]-origin[1];
    }
    return offsets;
  }));
}
