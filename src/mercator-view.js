/** Web Mercator coordinates for source tiles. Gameplay may extend beyond a city's
 * allowed 84.9° center, so this uses the actual Mercator limit, not picker bounds. */
export const MERCATOR_LATITUDE_LIMIT=85.0511287798066;
export function mercatorProject([lon,lat]){const p=Math.max(-MERCATOR_LATITUDE_LIMIT,Math.min(MERCATOR_LATITUDE_LIMIT,lat))*Math.PI/180;return[(lon+180)/360,(1-Math.log(Math.tan(p)+1/Math.cos(p))/Math.PI)/2];}
export function mercatorUnproject([x,y]){return[((x*360)%360+360)%360-180,Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI];}
