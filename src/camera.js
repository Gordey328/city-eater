/** MapLibre uses a 512-pixel world at zoom 0, unlike 256px raster tile formulas. */
export const MERCATOR_METERS_PER_PIXEL_Z0 = 40075016.68557849 / 512;
export const HOLE_SCREEN_DIAMETER = 0.21;
const DEG=Math.PI/180, METERS_PER_DEGREE=6378137*DEG;
const mercatorY=latitude=>.5-Math.log(Math.tan(Math.PI/4+latitude*DEG/2))/(2*Math.PI);
const latitudeAtY=y=>Math.atan(Math.sinh(Math.PI*(1-2*y)))/DEG;
/** x units may use the common city latitude; local north/south metres do not. */
export function cameraMetrics(radius,width,height,latitude=60,projectionLatitude=latitude) {
  const shortSide=Math.max(1,Math.min(width,height));
  const targetMetersPerPixel=Math.max(0.01,radius)/(shortSide*HOLE_SCREEN_DIAMETER/2);
  const scale=MERCATOR_METERS_PER_PIXEL_Z0*Math.cos(projectionLatitude*DEG);
  let targetZoom=Math.log2(scale/targetMetersPerPixel);
  if(projectionLatitude!==latitude){
    const centerY=mercatorY(latitude),deltaLatitude=radius/METERS_PER_DEGREE;
    const northRadius=Math.abs(mercatorY(latitude+deltaLatitude)-centerY);
    const southRadius=Math.abs(mercatorY(latitude-deltaLatitude)-centerY);
    const longestWorldRadius=Math.max(radius/(scale*512),northRadius,southRadius);
    targetZoom=Math.log2((shortSide*HOLE_SCREEN_DIAMETER/2)/(512*longestWorldRadius));
  }
  const zoom=Math.max(0,Math.min(19,targetZoom));
  const metersPerPixel=scale/2**zoom;
  const metersPerPixelY=MERCATOR_METERS_PER_PIXEL_Z0*Math.cos(latitude*DEG)/2**zoom;
  const y=mercatorY(latitude),halfWorldHeight=height/(2*512*2**zoom);
  // Inverse Mercator edges cover the full viewport even at high latitudes.
  const northExtent=(latitudeAtY(y-halfWorldHeight)-latitude)*METERS_PER_DEGREE;
  const southExtent=(latitude-latitudeAtY(y+halfWorldHeight))*METERS_PER_DEGREE;
  return {zoom,metersPerPixel,metersPerPixelY,radiusPixels:radius/metersPerPixel,halfWidth:width*metersPerPixel/2,halfHeight:Math.max(northExtent,southExtent),northExtent,southExtent};
}
export function streamingExtent(radius,width,height,latitude=60,projectionLatitude=latitude) {
  const camera=cameraMetrics(radius,width,height,latitude,projectionLatitude);
  return {x:Math.max(700,camera.halfWidth+250),y:Math.max(700,camera.halfHeight+250)};
}
