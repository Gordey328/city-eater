import {VectorTile,classifyRings} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import polygonClipping from 'polygon-clipping';
import {lonLatToLocal,getBounds,polygonsArea,ringArea} from './geometry.js';
import {ARENA_HALF_METRES,RADIUS_CAP_METRES} from './game-config.js';
import {maskChunksForBounds,rasterizeCoverageChunk,countMaskBits} from './consumption-mask.js';

export const WATER_BOUNDARY_LIMITS=Object.freeze({tiles:64,bytes:32*1024*1024,tileBytes:4*1024*1024,vertices:300000,features:30000,regions:2048,workerTimeoutMs:30000});
export const WATER_BOUNDARY_POLICY=freezeWaterBoundary({id:'mapped-surface-water-v1',includedClasses:['ocean','lake','river','pond'],excludedClasses:['swimming_pool','dock'],excludedCrossings:['bridge','tunnel','aqueduct'],fountainAmbiguity:true});
const N=16384,METRES_PER_DEGREE=6378137*Math.PI/180,PRECISION=1e6;
const round=value=>Math.round(value*PRECISION)/PRECISION;
const rectangle=([l,b,r,t])=>[[[[l,b],[r,b],[r,t],[l,t],[l,b]]]];
const pointCompare=(a,b)=>a[0]-b[0]||a[1]-b[1];
const stringCompare=(a,b)=>a<b?-1:a>b?1:0;
const key=tile=>`${tile.x}/${tile.y}`;
export class WaterBoundaryError extends Error{
  constructor(code,message,details={}){super(message);this.name='WaterBoundaryError';this.code=code;Object.assign(this,details);}
}
const fail=(code,message,details)=>{throw new WaterBoundaryError(code,message,details);};
function frame(manifest){
  const center=manifest?.center,basis=manifest?.projectionLatitude??center?.[1];
  if(!Array.isArray(center)||center.length!==2||!center.every(Number.isFinite)||Math.abs(center[0])>180||Math.abs(center[1])>84.9||!Number.isFinite(basis)||Math.abs(basis)>84.9)fail('WATER_FRAME','Некорректная область береговой линии.');
  return{center:[...center],projectionLatitude:basis};
}
export function waterBoundaryPlan(manifest){
  const f=frame(manifest),half=ARENA_HALF_METRES+RADIUS_CAP_METRES,domainBounds=[-half,-half,half,half];
  const scale=METRES_PER_DEGREE*Math.cos(f.projectionLatitude*Math.PI/180),west=f.center[0]-half/scale,east=f.center[0]+half/scale;
  const south=f.center[1]-half/METRES_PER_DEGREE,north=f.center[1]+half/METRES_PER_DEGREE;
  const tileY=lat=>(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*N;
  const x0=Math.floor((west+180)/360*N),x1=Math.ceil((east+180)/360*N)-1,y0=Math.floor(tileY(north)),y1=Math.ceil(tileY(south))-1;
  if(y0<0||y1>=N)fail('WATER_FRAME','Область выходит за пределы исходной карты.');
  const tileCount=(x1-x0+1)*(y1-y0+1),tiles=[];
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)tiles.push({z:14,x:((x%N)+N)%N,y});
  return{...f,domainBounds,arenaBounds:[-ARENA_HALF_METRES,-ARENA_HALF_METRES,ARENA_HALF_METRES,ARENA_HALF_METRES],tiles,tileCount,supported:tileCount<=WATER_BOUNDARY_LIMITS.tiles};
}
export function waterBoundaryTiles(manifest){
  const plan=waterBoundaryPlan(manifest);
  if(!plan.supported)fail('WATER_TILE_LIMIT',`Для береговой линии нужно ${plan.tileCount} тайлов; безопасный предел — ${WATER_BOUNDARY_LIMITS.tiles}. Этот район пока не поддерживается.`,{requiredTiles:plan.tileCount});
  return plan.tiles;
}
function vertexCount(polygons){return polygons.reduce((sum,polygon)=>sum+polygon.reduce((n,ring)=>n+ring.length,0),0);}
function canonicalRing(input,outer){
  const ring=[];
  for(const p of input){
    if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite))fail('WATER_GEOMETRY','Некорректная береговая линия.');
    const point=p.map(round);if(!ring.length||pointCompare(point,ring.at(-1)))ring.push(point);
  }
  if(ring.length&&pointCompare(ring[0],ring.at(-1))===0)ring.pop();
  if(ring.length<3)fail('WATER_GEOMETRY','Вырожденная береговая линия.');
  const signed=ringArea([...ring,ring[0]]);if(Math.abs(signed)<1e-10)fail('WATER_GEOMETRY','Нулевая площадь контура воды.');
  if((signed>0)!==outer)ring.reverse();
  let start=0;for(let i=1;i<ring.length;i++)if(pointCompare(ring[i],ring[start])<0)start=i;
  const result=[...ring.slice(start),...ring.slice(0,start)];result.push([...result[0]]);return result;
}
function canonicalPolygons(polygons){
  return polygons.map(polygon=>{
    if(!Array.isArray(polygon)||!polygon.length)fail('WATER_GEOMETRY','Пустой контур воды.');
    const outer=canonicalRing(polygon[0],true),holes=polygon.slice(1).map(ring=>canonicalRing(ring,false));
    holes.sort((a,b)=>stringCompare(JSON.stringify(a),JSON.stringify(b)));return[outer,...holes];
  }).sort((a,b)=>stringCompare(JSON.stringify(a),JSON.stringify(b)));
}
function checkPolygons(polygons,bounds){
  if(!Array.isArray(polygons)||polygons.length>WATER_BOUNDARY_LIMITS.features)fail('WATER_GEOMETRY','Слишком много водных контуров.');
  let count=0;
  for(const polygon of polygons){
    if(!Array.isArray(polygon)||!polygon.length)fail('WATER_GEOMETRY','Некорректный водный полигон.');
    for(const ring of polygon){
      if(!Array.isArray(ring)||ring.length<4)fail('WATER_GEOMETRY','Незамкнутый водный контур.');
      count+=ring.length;if(count>WATER_BOUNDARY_LIMITS.vertices)fail('WATER_GEOMETRY_LIMIT','Слишком подробная береговая линия.');
      for(const p of ring)if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<bounds[0]-1e-6||p[1]<bounds[1]-1e-6||p[0]>bounds[2]+1e-6||p[1]>bounds[3]+1e-6)fail('WATER_GEOMETRY','Водный контур выходит за известную область.');
      if(pointCompare(ring[0],ring.at(-1)))fail('WATER_GEOMETRY','Незамкнутый водный контур.');
    }
  }
  return count;
}
/** A deterministic, strictly interior point; never a centroid that can fall in
 * a lake or outside a concave island. Each scanline avoids vertex ordinates. */
export function waterRegionRepresentativePoint(polygon){
  const ys=[...new Set(polygon[0].slice(0,-1).map(p=>p[1]))].sort((a,b)=>a-b);
  if(ys.length<2)fail('WATER_GEOMETRY','Участок суши не имеет площади.');
  const mid=(ys[0]+ys.at(-1))/2,candidates=[(ys[0]+ys[1])/2];
  if(!ys.includes(mid))candidates.unshift(mid);
  for(const y of candidates){
    const crossings=[];
    for(const ring of polygon)for(let i=0;i<ring.length-1;i++){
      const a=ring[i],b=ring[i+1];if((a[1]>y)!==(b[1]>y))crossings.push(a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]));
    }
    crossings.sort((a,b)=>a-b);let best=null;
    for(let i=0;i+1<crossings.length;i+=2)if(crossings[i+1]-crossings[i]>1e-9&&(!best||crossings[i+1]-crossings[i]>best[1]-best[0]))best=[crossings[i],crossings[i+1]];
    if(best)return[(best[0]+best[1])/2,y];
  }
  fail('WATER_GEOMETRY','Не удалось найти внутреннюю точку суши.');
}
/** Decode only water geometry. Building/road layers in the same full MVT are
 * never normalized or awaited. Empty water in a successful supported tile is dry. */
export function decodeWaterBoundaryTile(tile,manifest){
  const started=performance.now();
  if(tile?.z!==14||!Number.isInteger(tile.x)||tile.x<0||tile.x>=N||!Number.isInteger(tile.y)||tile.y<0||tile.y>=N||!(tile.buffer instanceof ArrayBuffer)||tile.buffer.byteLength>WATER_BOUNDARY_LIMITS.tileBytes)fail('WATER_TILE','Некорректный тайл береговой линии.');
  const f=frame(manifest),centerX=(f.center[0]+180)/360*N;let x=tile.x;
  while(x+.5-centerX>N/2)x-=N;while(x+.5-centerX<-N/2)x+=N;
  const y=tile.y,tileBox=rectangle([x,y,x+1,y+1]);let vector;
  try{vector=new VectorTile(new PbfReader(tile.buffer));}catch{fail('WATER_PBF','Повреждённый тайл береговой линии.');}
  const layer=vector.layers.water,polygons=[];let vertices=0,includedFeatures=0,excludedFeatures=0;
  if(!layer)return{polygons,vertices,includedFeatures,excludedFeatures,decodeMs:performance.now()-started};
  if(!Number.isInteger(layer.extent)||layer.extent<=0||layer.extent>65536||layer.length>WATER_BOUNDARY_LIMITS.features)fail('WATER_GEOMETRY_LIMIT','Слишком сложный слой воды.');
  for(let i=0;i<layer.length;i++){
    const feature=layer.feature(i),properties=feature.properties,clazz=properties.class,crossing=properties.brunnel;
    if(!WATER_BOUNDARY_POLICY.includedClasses.includes(clazz)&&!WATER_BOUNDARY_POLICY.excludedClasses.includes(clazz))fail('WATER_CLASS',`Неизвестный тип водного объекта: ${String(clazz).slice(0,40)}.`);
    if(crossing!==undefined&&crossing!==null&&crossing!==''&&!WATER_BOUNDARY_POLICY.excludedCrossings.includes(crossing))fail('WATER_CLASS','Неизвестный уровень водного объекта.');
    if(WATER_BOUNDARY_POLICY.excludedClasses.includes(clazz)||WATER_BOUNDARY_POLICY.excludedCrossings.includes(crossing)){excludedFeatures++;continue;}
    if(feature.type!==3)fail('WATER_GEOMETRY','Водный объект не является полигоном.');
    const rings=feature.loadGeometry();
    for(const ring of rings){vertices+=ring.length;if(vertices>WATER_BOUNDARY_LIMITS.vertices)fail('WATER_GEOMETRY_LIMIT','Слишком подробный водный тайл.');
      if(ring.length<4||ring[0].x!==ring.at(-1).x||ring[0].y!==ring.at(-1).y||ring.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>16*layer.extent||Math.abs(p.y)>16*layer.extent))fail('WATER_GEOMETRY','Неполный водный контур.');}
    for(const polygon of classifyRings(rings)){
      const raw=[polygon.map(ring=>ring.map(p=>[x+p.x/layer.extent,y+p.y/layer.extent]))];
      try{polygons.push(...polygonClipping.intersection(raw,tileBox));}catch{fail('WATER_GEOMETRY','Не удалось отсечь водный тайл.');}
    }
    includedFeatures++;
  }
  return{polygons,vertices,includedFeatures,excludedFeatures,decodeMs:performance.now()-started};
}
async function digest(value){
  const bytes=new TextEncoder().encode(JSON.stringify(value)),hash=await crypto.subtle.digest('SHA-256',bytes);
  return[...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
export function freezeWaterBoundary(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freezeWaterBoundary(item);Object.freeze(value);}return value;
}
async function assemble(waterPolygons,manifest,sourceKey,stats){
  const envelopeId=manifest.envelopeId||manifest.id;
  if(typeof envelopeId!=='string'||!envelopeId||envelopeId.length>512)fail('WATER_FRAME','Неизвестный идентификатор района.');
  const plan=waterBoundaryPlan(manifest);checkPolygons(waterPolygons,plan.domainBounds);
  let water,land;
  try{water=canonicalPolygons(waterPolygons.length?polygonClipping.union(...waterPolygons):[]);land=canonicalPolygons(polygonClipping.difference(rectangle(plan.arenaBounds),water));}
  catch(error){if(error instanceof WaterBoundaryError)throw error;fail('WATER_GEOMETRY','Не удалось восстановить береговую линию.');}
  const waterVertices=checkPolygons(water,plan.domainBounds),landVertices=checkPolygons(land,plan.arenaBounds);
  if(waterVertices+landVertices>WATER_BOUNDARY_LIMITS.vertices||land.length>WATER_BOUNDARY_LIMITS.regions)fail('WATER_GEOMETRY_LIMIT','Слишком сложная береговая линия района.');
  const hash=await digest({schemaVersion:1,envelopeId,policy:WATER_BOUNDARY_POLICY.id,detailZoom:14,center:plan.center,projectionLatitude:plan.projectionLatitude,domainBounds:plan.domainBounds,sourceKey,waterPolygons:water});
  const regions=land.map((polygon,index)=>{const b=getBounds([polygon]);return{id:`${hash}:r${index}`,polygons:[polygon],areaM2:round(polygonsArea([polygon])),bounds:[b.minX,b.minY,b.maxX,b.maxY],representativePoint:waterRegionRepresentativePoint(polygon)};});
  return freezeWaterBoundary({schemaVersion:1,envelopeId,id:hash,hash,complete:true,policy:structuredClone(WATER_BOUNDARY_POLICY),sourceKey,detailZoom:14,center:plan.center,projectionLatitude:plan.projectionLatitude,arenaBounds:plan.arenaBounds,domainBounds:plan.domainBounds,knownTileCount:plan.tileCount,waterPolygons:water,regions,stats:{...stats,waterVertices,landVertices,regions:regions.length}});
}
export async function reconstructWaterBoundary(tiles,manifest){
  const started=performance.now(),expected=waterBoundaryTiles(manifest),expectedKeys=new Set(expected.map(key));
  if(!Array.isArray(tiles)||tiles.length!==expected.length)fail('WATER_INCOMPLETE','Не все тайлы береговой линии получены.');
  const seen=new Set(),sourceKeys=new Set(),polygons=[];let fullMvtBytes=0,vertices=0,includedFeatures=0,excludedFeatures=0,decodeMs=0,minTileBytes=Infinity,maxTileBytes=0;
  for(const tile of [...tiles].sort((a,b)=>a.y-b.y||a.x-b.x)){
    if(!expectedKeys.has(key(tile))||seen.has(key(tile)))fail('WATER_INCOMPLETE','Набор тайлов береговой линии неполный.');seen.add(key(tile));
    if(typeof tile.sourceKey!=='string'||!tile.sourceKey||tile.sourceKey.length>2048)fail('WATER_SOURCE','Неизвестная версия источника воды.');sourceKeys.add(tile.sourceKey);
    if(sourceKeys.size>1)fail('WATER_SOURCE','Смешаны версии источника воды.');
    fullMvtBytes+=tile.buffer?.byteLength||0;minTileBytes=Math.min(minTileBytes,tile.buffer?.byteLength||0);maxTileBytes=Math.max(maxTileBytes,tile.buffer?.byteLength||0);
    if(fullMvtBytes>WATER_BOUNDARY_LIMITS.bytes)fail('WATER_BYTE_LIMIT','Тайлы береговой линии превышают безопасный предел.');
    const decoded=decodeWaterBoundaryTile(tile,manifest);vertices+=decoded.vertices;includedFeatures+=decoded.includedFeatures;excludedFeatures+=decoded.excludedFeatures;decodeMs+=decoded.decodeMs;
    if(vertices>WATER_BOUNDARY_LIMITS.vertices||includedFeatures+excludedFeatures>WATER_BOUNDARY_LIMITS.features)fail('WATER_GEOMETRY_LIMIT','Слишком подробная береговая линия района.');
    polygons.push(...decoded.polygons);
  }
  const f=frame(manifest),plan=waterBoundaryPlan(manifest),project=([x,y])=>lonLatToLocal([x/N*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/N)))*180/Math.PI],f.center,f.projectionLatitude);
  let water;
  try{const world=polygons.length?polygonClipping.union(...polygons):[];water=polygonClipping.intersection(world.map(polygon=>polygon.map(ring=>ring.map(project))),rectangle(plan.domainBounds));}
  catch{fail('WATER_GEOMETRY','Не удалось объединить береговую линию.');}
  const boundary=await assemble(water,manifest,tiles[0].sourceKey,{sourceTiles:tiles.length,fullMvtBytes,minTileBytes,maxTileBytes,vertices,includedFeatures,excludedFeatures,decodeMs});
  return freezeWaterBoundary({...boundary,stats:{...boundary.stats,reconstructMs:performance.now()-started}});
}
/** Saved snapshots are geometry/frame checked without any provider request.
 * Re-derive land and SHA-256 so partial or inconsistent records never become dry. */
export async function validateWaterBoundary(boundary,manifest){
  const plan=waterBoundaryPlan(manifest);waterBoundaryTiles(manifest);
  if(!boundary||boundary.envelopeId!==(manifest.envelopeId||manifest.id)||boundary.schemaVersion!==1||boundary.complete!==true||boundary.detailZoom!==14||JSON.stringify(boundary.policy)!==JSON.stringify(WATER_BOUNDARY_POLICY)||JSON.stringify(boundary.center)!==JSON.stringify(plan.center)||boundary.projectionLatitude!==plan.projectionLatitude||JSON.stringify(boundary.arenaBounds)!==JSON.stringify(plan.arenaBounds)||JSON.stringify(boundary.domainBounds)!==JSON.stringify(plan.domainBounds)||boundary.knownTileCount!==plan.tileCount||typeof boundary.sourceKey!=='string'||!boundary.sourceKey||boundary.sourceKey.length>2048)fail('WATER_SAVED_INVALID','Сохранённая береговая линия несовместима с районом.');
  let savedVertices=checkPolygons(boundary.waterPolygons,plan.domainBounds);
  if(!Array.isArray(boundary.regions)||boundary.regions.length>WATER_BOUNDARY_LIMITS.regions)fail('WATER_SAVED_INVALID','Неполная сохранённая суша.');
  for(const region of boundary.regions){savedVertices+=checkPolygons(region.polygons,plan.arenaBounds);if(savedVertices>WATER_BOUNDARY_LIMITS.vertices)fail('WATER_GEOMETRY_LIMIT','Сохранённая береговая линия превышает предел геометрии.');}
  const stats={};
  for(const name of ['sourceTiles','fullMvtBytes','minTileBytes','maxTileBytes','vertices','includedFeatures','excludedFeatures','decodeMs','reconstructMs','requiredTiles','loadedTiles','sharedSourceBytesDelta','startupMs']){const value=boundary.stats?.[name];if(Number.isFinite(value)&&value>=0&&value<1e12)stats[name]=value;}
  const restored=await assemble(boundary.waterPolygons,manifest,boundary.sourceKey,stats);
  if(boundary.hash!==restored.hash||boundary.id!==restored.id||JSON.stringify(boundary.waterPolygons)!==JSON.stringify(restored.waterPolygons)||JSON.stringify(boundary.regions)!==JSON.stringify(restored.regions))fail('WATER_SAVED_INVALID','Сохранённая береговая линия повреждена.');
  return restored;
}

export async function rasterizeWaterRegion(boundary,regionId,manifest){
  const validated=await validateWaterBoundary(boundary,manifest),region=validated.regions.find(region=>region.id===regionId);
  if(!region)fail('WATER_REGION','Выбранный участок суши не найден.');
  const keys=maskChunksForBounds(region.bounds);if(keys.length>36)fail('WATER_GEOMETRY_LIMIT','Слишком большая маска суши.');
  let scoreAreaM2=0;const chunks=keys.map(key=>{const bits=rasterizeCoverageChunk(key,region.polygons);scoreAreaM2+=countMaskBits(bits)*4;return[key,bits];});
  return{chunks,scoreAreaM2};
}
