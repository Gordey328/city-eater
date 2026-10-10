import {VectorTile, classifyRings} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import polygonClipping from 'polygon-clipping';
import {lonLatToLocal, getBounds, minimalEnclosingCircle, polygonsArea} from './geometry.js';
import {maskChunksForBounds, rasterizeCoverageChunk, countMaskBits} from './consumption-mask.js';

export const WHOLE_LIMITS = Object.freeze({tiles: 64, bytes: 32 * 1024 * 1024, vertices: 300000,
  fragments: 30000, comparisons: 250000, gridReferences: 500000, buildings: 12000, rasterBuildings: 256, rasterChunks: 36, separateBuildings: 16, separateBytes: 1024 * 1024, modelParts: 64, modelVertices: 300000});
const N = 16384, EPS = 1e-10, AREA_EPS = 1e-14, CELL = 1 / 32;
const fail = message => { throw new Error(`Целые здания: ${message}`); };
const boxOf = polygons => {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const polygon of polygons)for(const ring of polygon)for(const [x,y] of ring){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  return [minX,minY,maxX,maxY];
};
const boxesOverlap = (a,b) => a[0]<b[2]-EPS&&a[2]>b[0]+EPS&&a[1]<b[3]-EPS&&a[3]>b[1]+EPS;
const area = polygons => polygons.reduce((sum,polygon)=>sum+polygon.reduce((value,ring,index)=>{
  const p=ring[0];let signed=0;for(let i=1;i<ring.length-1;i++)signed+=(ring[i][0]-p[0])*(ring[i+1][1]-p[1])-(ring[i+1][0]-p[0])*(ring[i][1]-p[1]);
  return value+(index?-1:1)*Math.abs(signed)/2;
},0),0);
const signature = properties => JSON.stringify(['render_height','render_min_height','colour','hide_3d'].map(key=>properties?.[key]??null));
// OpenMapTiles emits derived rendering values, without retaining whether they
// came from a height tag, levels, or the upstream 5 m default. Never label these
// values as measured. Unsupported/missing attributes do not invent a new height.
const NAMED_COLOURS=new Set('black silver gray grey white maroon red purple fuchsia green lime olive yellow navy blue teal aqua orange brown beige tan gold pink violet indigo cyan magenta darkred darkgreen darkblue darkgray darkgrey lightgray lightgrey lightblue lightgreen ivory coral salmon khaki turquoise transparent'.split(' '));
export function buildingRenderAttributes(properties={}){
  const raw=properties.render_height,min=properties.render_min_height;
  const missing=raw===undefined||raw===null;
  const validHeight=typeof raw==='number'&&Number.isFinite(raw)&&raw>0&&raw<=3660;
  const validMin=min===undefined||min===null||(typeof min==='number'&&Number.isFinite(min)&&min>=0&&min<raw);
  const valid=validHeight&&validMin;
  const colourValue=typeof properties.colour==='string'&&properties.colour.length<=32?properties.colour.toLowerCase().trim():'';
  const colour=/^#[0-9a-f]{6}$/.test(colourValue)?colourValue:/^#[0-9a-f]{3}$/.test(colourValue)?'#'+[...colourValue.slice(1)].map(c=>c+c).join(''):NAMED_COLOURS.has(colourValue)?colourValue:null;
  const hide=properties.hide_3d;
  const hide3d=![undefined,null,false,0,'false','0',''].includes(hide);
  return{heightMeters:valid?raw:null,minHeightMeters:valid?(min??0):null,colour,hide3d,
    heightProvenance:valid?'source-approximation':missing?'missing':'invalid',
    minHeightProvenance:min===undefined||min===null?'ground-fallback':validMin&&validHeight?'source-approximation':'invalid'};
}
const tileIdentity = tile => `${tile.x}/${tile.y}`;
const opposite = {left:'right',right:'left',top:'bottom',bottom:'top'};
function seamIntervals(polygons,x,y){
  const result={left:[],right:[],top:[],bottom:[]};
  const specs=[['left',0,x,1],['right',0,x+1,1],['top',1,y,0],['bottom',1,y+1,0]];
  for(const polygon of polygons)for(const ring of polygon)for(const [side,axis,edge,along] of specs){
    for(let i=0;i<ring.length-1;i++){
      const a=ring[i],b=ring[i+1],aOn=Math.abs(a[axis]-edge)<=EPS,bOn=Math.abs(b[axis]-edge)<=EPS;
      if(aOn&&bOn)result[side].push([Math.min(a[along],b[along]),Math.max(a[along],b[along])]);
      else if(aOn)result[side].push([a[along],a[along]]);
    }
  }
  return result;
}
function covered(interval,matches){
  let cursor=interval[0];
  for(const [start,end] of [...matches].sort((a,b)=>a[0]-b[0])){
    if(end<cursor-EPS)continue;if(start>cursor+EPS)return false;cursor=Math.max(cursor,end);
    if(cursor>=interval[1]-EPS)return true;
  }
  return false;
}
function overlapIntervals(a,b){const result=[];for(const x of a)for(const y of b){const left=Math.max(x[0],y[0]),right=Math.min(x[1],y[1]);if(right-left>EPS)result.push([left,right]);}return result;}

/** Preserve each source Polygon component before canonical clipping. The raw
 * buffered copy is evidence for matching a cut across a native seam. Mere
 * boundary contact, reused IDs and feature packing do not identify a house.
 */
export function decodeWholeFragments(tile,manifest){
  if(tile?.z!==14||!Number.isInteger(tile.x)||tile.x<0||tile.x>=N||!Number.isInteger(tile.y)||tile.y<0||tile.y>=N||!(tile.buffer instanceof ArrayBuffer)||tile.buffer.byteLength>4*1024*1024)fail('неверный исходный тайл');
  const centerX=(manifest.center[0]+180)/360*N;
  let x=tile.x;while(x+.5-centerX>N/2)x-=N;while(x+.5-centerX<-N/2)x+=N;
  const y=tile.y,box=[[[[x,y],[x+1,y],[x+1,y+1],[x,y+1],[x,y]]]];
  let vector;try{vector=new VectorTile(new PbfReader(tile.buffer));}catch{fail('повреждённый PBF');}
  const layer=vector.layers.building,fragments=[];let vertices=0;
  if(!layer)return{fragments,vertices};
  if(!Number.isInteger(layer.extent)||layer.extent<=0||layer.extent>65536||layer.length>WHOLE_LIMITS.fragments)fail('слишком сложный слой');
  for(let i=0;i<layer.length;i++){
    const feature=layer.feature(i);if(feature.type!==3)fail('неполигональное здание');
    let rings;try{rings=feature.loadGeometry();}catch{fail('некорректный контур');}
    for(const ring of rings){
      vertices+=ring.length;if(vertices>WHOLE_LIMITS.vertices)fail('слишком много вершин');
      if(ring.length<4||ring[0].x!==ring.at(-1).x||ring[0].y!==ring.at(-1).y||ring.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>16*layer.extent||Math.abs(p.y)>16*layer.extent))fail('неполный контур');
    }
    for(const polygon of classifyRings(rings)){
      const raw=[polygon.map(ring=>ring.map(p=>[x+p.x/layer.extent,y+p.y/layer.extent]))];
      let core;try{core=polygonClipping.intersection(raw,box);}catch{fail('не удалось отсечь контур');}
      if(!core.length||area(core)<=AREA_EPS)continue;
      fragments.push({tile:tileIdentity(tile),x,y,raw,core,rawBounds:boxOf(raw),bounds:boxOf(core),properties:signature(feature.properties),render:buildingRenderAttributes(feature.properties),seams:seamIntervals(core,x,y),matched:{left:[],right:[],top:[],bottom:[]}});
    }
  }
  return{fragments,vertices};
}

/** Certify only joined complete components. Positive-area overlaps merge parts
 * and duplicate outlines. Across native seams matching additionally requires
 * compatible attributes and overlap of original buffered geometry. Adjacent
 * terraced polygons that merely touch remain separate. Unmatched seam intervals
 * make the entire connected component ineligible, never a smaller edible house.
 */
export function reconstructWholeBuildings(tiles,manifest,{generation=1}={}){
  if(!Array.isArray(tiles)||!tiles.length||tiles.length>WHOLE_LIMITS.tiles)fail('неверный набор тайлов');
  if(!Array.isArray(manifest?.center)||manifest.center.length!==2||!manifest.center.every(Number.isFinite)||!Number.isFinite(manifest.projectionLatitude??manifest.center[1]))fail('неверная проекция');
  const started=performance.now(),sourceKeys=new Set(tiles.map(tile=>tile.sourceKey));if(sourceKeys.size!==1)fail('смешаны версии источника');
  const seenTiles=new Set(),fragments=[];let bytes=0,vertices=0;
  for(const tile of tiles){
    if(seenTiles.has(tileIdentity(tile)))continue;seenTiles.add(tileIdentity(tile));bytes+=tile.buffer?.byteLength||0;if(bytes>WHOLE_LIMITS.bytes)fail('превышен предел пакета');
    const decoded=decodeWholeFragments(tile,manifest);vertices+=decoded.vertices;
    if(vertices>WHOLE_LIMITS.vertices)fail('слишком много геометрии');fragments.push(...decoded.fragments);
    if(fragments.length>WHOLE_LIMITS.fragments)fail('слишком много контуров');
  }
  const parents=fragments.map((_,i)=>i),find=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;},join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parents[b]=a;};
  const grid=new Map();let references=0,comparisons=0,joinedSeams=0,overlapJoins=0;
  for(let i=0;i<fragments.length;i++){
    const f=fragments[i],b=f.rawBounds,candidates=new Set();
    const minX=Math.floor(b[0]/CELL),maxX=Math.floor(b[2]/CELL),minY=Math.floor(b[1]/CELL),maxY=Math.floor(b[3]/CELL);
    references+=(maxX-minX+1)*(maxY-minY+1);if(references>WHOLE_LIMITS.gridReferences)fail('слишком большой комплекс');
    for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++)for(const j of grid.get(`${x},${y}`)||[])candidates.add(j);
    for(const j of candidates){
      const other=fragments[j];if(!boxesOverlap(f.rawBounds,other.rawBounds))continue;
      if(++comparisons>WHOLE_LIMITS.comparisons)fail('слишком сложное пересечение контуров');
      if(f.tile===other.tile){
        if(!boxesOverlap(f.bounds,other.bounds))continue;
        let overlap;try{overlap=polygonClipping.intersection(f.core,other.core);}catch{fail('не удалось проверить наложение');}
        if(area(overlap)>AREA_EPS){join(i,j);overlapJoins++;}
      }else{
        const dx=other.x-f.x,dy=other.y-f.y;
        if(Math.abs(dx)+Math.abs(dy)!==1||f.properties!==other.properties)continue;
        const side=dx===1?'right':dx===-1?'left':dy===1?'bottom':'top',back=opposite[side];
        const intervals=overlapIntervals(f.seams[side],other.seams[back]);if(!intervals.length)continue;
        let overlap;try{overlap=polygonClipping.intersection(f.raw,other.raw);}catch{fail('не удалось проверить шов');}
        if(area(overlap)<=AREA_EPS)continue;
        f.matched[side].push(...intervals);other.matched[back].push(...intervals);join(i,j);joinedSeams++;
      }
    }
    for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++){const key=`${x},${y}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(i);}
  }
  const groups=new Map();for(let i=0;i<fragments.length;i++){const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(fragments[i]);}
  const buildings=[];let incomplete=0,oversize=0,outputVertices=0,modelVertices=0,modelFallbacks=0;
  const project=([x,y])=>lonLatToLocal([x/N*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/N)))*180/Math.PI],manifest.center,manifest.projectionLatitude);
  for(const members of groups.values()){
    if(members.some(fragment=>Object.keys(fragment.seams).some(side=>fragment.seams[side].some(interval=>!covered(interval,fragment.matched[side]))))){incomplete++;continue;}
    let united;try{united=polygonClipping.union(...members.flatMap(fragment=>fragment.core));}catch{fail('не удалось восстановить цельный контур');}
    const polygons=united.map(polygon=>polygon.map(ring=>ring.map(project)));
    const b=getBounds(polygons);if(!b)continue;
    // Larger than any permitted hole: do not send an expensive impossible target.
    if(b.maxX-b.minX>1000||b.maxY-b.minY>1000){oversize++;continue;}
    outputVertices+=polygons.reduce((n,p)=>n+p.reduce((s,r)=>s+r.length,0),0);if(outputVertices>WHOLE_LIMITS.vertices)fail('превышен предел готовых контуров');
    const circle=minimalEnclosingCircle(polygons);
    // Keep rendering parts separate from the authoritative union used for fit
    // and reward. A tall overlapping part must not raise the entire complex.
    const renderGroups=new Map();for(const fragment of members){if(!renderGroups.has(fragment.properties))renderGroups.set(fragment.properties,[]);renderGroups.get(fragment.properties).push(fragment);}
    let modelParts=[],modelFallback=null,partVertices=0;
    if(renderGroups.size===1){modelParts=[{polygons,...members[0].render}];}
    else if(renderGroups.size<=WHOLE_LIMITS.modelParts){
      for(const fragments of renderGroups.values()){
        let partPolygons;
        try{partPolygons=polygonClipping.union(...fragments.flatMap(fragment=>fragment.core)).map(polygon=>polygon.map(ring=>ring.map(project)));}
        catch{modelFallback='geometry-limit';break;}
        const count=partPolygons.reduce((n,p)=>n+p.reduce((s,r)=>s+r.length,0),0);
        if(modelVertices+partVertices+count>WHOLE_LIMITS.modelVertices){modelFallback='vertex-limit';break;}
        partVertices+=count;modelParts.push({polygons:partPolygons,...fragments[0].render});
      }
    }else modelFallback='part-limit';
    if(modelFallback){modelParts=[];modelFallbacks++;}else modelVertices+=partVertices;
    const uniform=renderGroups.size===1?members[0].render:null;
    buildings.push({id:`whole-${generation}-${buildings.length}`,polygons,bounds:[b.minX,b.minY,b.maxX,b.maxY],center:circle.center,radius:circle.radius,area:polygonsArea(polygons),complete:true,
      modelParts,modelFallback,heightMeters:uniform?.heightMeters??null,minHeightMeters:uniform?.minHeightMeters??null,heightProvenance:uniform?.heightProvenance??'mixed'});
    if(buildings.length>WHOLE_LIMITS.buildings)fail('слишком много цельных контуров');
  }
  return{buildings,sourceKey:tiles[0].sourceKey,stats:{sourceTiles:seenTiles.size,fragments:fragments.length,vertices,comparisons,joinedSeams,overlapJoins,incomplete,oversize,modelVertices,modelFallbacks,buildings:buildings.length,reconstructMs:performance.now()-started}};
}

export function rasterizeWholeBuildings(buildings){
  if(!Array.isArray(buildings)||buildings.length>WHOLE_LIMITS.rasterBuildings)fail('слишком много домов за один шаг');
  const keys=new Set(),polygons=[];let vertices=0;
  for(const building of buildings){
    if(building?.complete!==true||!Array.isArray(building.polygons))fail('контур не подтверждён');
    for(const key of maskChunksForBounds(building.bounds))keys.add(key);
    polygons.push(...building.polygons);
    vertices+=building.polygons.reduce((n,p)=>n+p.reduce((s,r)=>s+r.length,0),0);
  }
  if(keys.size>WHOLE_LIMITS.rasterChunks||vertices>WHOLE_LIMITS.vertices)fail('слишком большой шаг поглощения');
  const chunks=[];for(const key of keys){const bits=rasterizeCoverageChunk(key,polygons);if(countMaskBits(bits))chunks.push([key,bits]);}
  return chunks;
}

/** Individual footprint masks for a small visible render batch. Preflight the
 * complete response before rasterizing so an oversized batch is all-or-nothing. */
export function rasterizeWholeBuildingsSeparately(buildings){
  if(!Array.isArray(buildings)||buildings.length>WHOLE_LIMITS.separateBuildings)fail('слишком много домов для раздельных масок');
  let bytes=0,vertices=0;const ids=new Set();
  for(const building of buildings){
    if(building?.complete!==true||!Array.isArray(building.polygons)||typeof building.id!=='string'||ids.has(building.id))fail('неверный набор отдельных домов');
    ids.add(building.id);bytes+=maskChunksForBounds(building.bounds).length*8192;
    vertices+=building.polygons.reduce((n,p)=>n+p.reduce((s,r)=>s+r.length,0),0);
    if(bytes>WHOLE_LIMITS.separateBytes||vertices>WHOLE_LIMITS.vertices)fail('раздельные маски превышают безопасный предел');
  }
  return buildings.map(building=>({id:building.id,chunks:rasterizeWholeBuildings([building])}));
}
