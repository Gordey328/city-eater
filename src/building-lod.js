export const MAX_BUILDING_TILT=Math.PI/7; // mild, fixed orthographic tilt (~26°)
export function buildingAppearance(metersPerPixel,mode='whole'){
  if(mode!=='whole')return{lod:0,angle:0,groundScaleY:1,roofLiftFactor:0};
  const t=Math.max(0,Math.min(1,(1.1-Math.max(.001,metersPerPixel))/(1.1-.65))),lod=t*t*(3-2*t),angle=MAX_BUILDING_TILT*lod;
  return{lod,angle,groundScaleY:Math.cos(angle),roofLiftFactor:Math.sin(angle)};
}
/** Only camera appearance eases; eligibility, masks and rewards never use it. */
export function easeBuildingAppearance(previous,target,dt){
  const fraction=1-Math.exp(-Math.max(0,Math.min(.1,dt))*8),angle=Math.abs(previous-target.angle)<1e-4?target.angle:previous+(target.angle-previous)*fraction;
  return{lod:angle/MAX_BUILDING_TILT,angle,groundScaleY:Math.cos(angle),roofLiftFactor:Math.sin(angle)};
}
