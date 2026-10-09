export const MAX_CANVAS_PIXELS=4194304;
export function canvasPixelRatio(width,height,deviceRatio=1,quality='high'){
  return Math.min(quality==='low'?1:2,Math.max(.1,Number(deviceRatio)||1),Math.sqrt(MAX_CANVAS_PIXELS/(Math.max(1,width)*Math.max(1,height))));
}
