/** MapLibre uses a 512-pixel world at zoom 0, unlike 256px raster tile formulas. */
export const MERCATOR_METERS_PER_PIXEL_Z0 = 40075016.68557849 / 512;
export const HOLE_SCREEN_DIAMETER = 0.21;
export function cameraMetrics(radius,width,height,latitude=60) {
  const shortSide=Math.max(1,Math.min(width,height));
  const targetMetersPerPixel=Math.max(0.01,radius)/(shortSide*HOLE_SCREEN_DIAMETER/2);
  const scale=MERCATOR_METERS_PER_PIXEL_Z0*Math.cos(latitude*Math.PI/180);
  const zoom=Math.max(10.5,Math.min(19,Math.log2(scale/targetMetersPerPixel)));
  const metersPerPixel=scale/2**zoom;
  return {zoom,metersPerPixel,radiusPixels:radius/metersPerPixel,halfWidth:width*metersPerPixel/2,halfHeight:height*metersPerPixel/2};
}
export function streamingExtent(radius,width,height,latitude=60) {
  const camera=cameraMetrics(radius,width,height,latitude);
  return {x:Math.max(700,camera.halfWidth+250),y:Math.max(700,camera.halfHeight+250)};
}
