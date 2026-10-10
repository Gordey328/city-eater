import polygonClipping from 'polygon-clipping';
import {SpatialIndex, closestPointOnSegment, getBounds, polygonsArea} from './geometry.js';
import {ARENA_HALF_METRES, RADIUS_CAP_METRES, boundaryOverrun} from './game-config.js';
import {rasterizeCoverageChunk} from './consumption-mask.js';

/** Local-metre, polygon-based movement and score limits for one selected land
 * component. These rules constrain the hole CENTER, never its circular rim.
 * Water geometry must be complete throughout the explicit known domain.
 * Missing geometry is not a declaration of land.
 */
const EPS = 1e-9;
const MAX_SLIDES = 6;
export const LAND_REGION_LIMITS = Object.freeze({vertices:300000,polygons:2048});
const square = Object.freeze({minX:-ARENA_HALF_METRES,minY:-ARENA_HALF_METRES,
  maxX:ARENA_HALF_METRES,maxY:ARENA_HALF_METRES});
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const dot = (a,b) => a[0]*b[0]+a[1]*b[1];
const cross = (a,b) => a[0]*b[1]-a[1]*b[0];
const subtract = (a,b) => [a[0]-b[0],a[1]-b[1]];
const at = (a,d,t) => [a[0]+d[0]*t,a[1]+d[1]*t];
const length = v => Math.hypot(v[0],v[1]);
const inBounds = (p,b) => p[0]>=b.minX-EPS && p[0]<=b.maxX+EPS && p[1]>=b.minY-EPS && p[1]<=b.maxY+EPS;
function point(p) {
  if (!Array.isArray(p) || p.length!==2 || !p.every(Number.isFinite)) throw new TypeError('Expected a finite local-metre point');
  return p;
}
function bounds(input) {
  if (Array.isArray(input) && input.length!==4) throw new TypeError('Expected exactly four known-domain bounds');
  const b=Array.isArray(input)?{minX:input[0],minY:input[1],maxX:input[2],maxY:input[3]}:input;
  if (!b || ![b.minX,b.minY,b.maxX,b.maxY].every(Number.isFinite) || b.minX>=b.maxX || b.minY>=b.maxY)
    throw new TypeError('Expected explicit finite, nonempty known-domain bounds');
  return {minX:b.minX,minY:b.minY,maxX:b.maxX,maxY:b.maxY};
}
function rectangle(b) {
  return [[[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY],[b.minX,b.minY]]]];
}
function validatePolygons(polygons,name,{budget={vertices:0},within=null,closed=false}={}) {
  if (!Array.isArray(polygons)) throw new TypeError(`Expected explicit ${name} MultiPolygon`);
  if (polygons.length>LAND_REGION_LIMITS.polygons) throw new RangeError('Land geometry polygon limit exceeded');
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) throw new TypeError(`Invalid ${name} polygon`);
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length<(closed?4:3)) throw new TypeError(`Invalid ${name} ring`);
      budget.vertices+=ring.length;
      if (budget.vertices>LAND_REGION_LIMITS.vertices) throw new RangeError('Land geometry vertex limit exceeded');
      for (const p of ring) {
        point(p);
        if (within && !inBounds(p,within)) throw new RangeError(`${name} geometry exceeds its known bounds`);
      }
      if (closed && !samePoint(ring[0],ring.at(-1))) throw new TypeError(`Expected closed ${name} ring`);
    }
  }
}
function freezeGeometry(polygons) {
  return Object.freeze(polygons.map(polygon=>Object.freeze(polygon.map(ring=>Object.freeze(ring.map(p=>Object.freeze([...p])))))));
}
function edgesOf(polygons) {
  const edges=[];
  for (const polygon of polygons) for (const ring of polygon) for (let i=0;i<ring.length;i++) {
    const a=ring[i],b=ring[(i+1)%ring.length],delta=subtract(b,a),size=length(delta);
    if (!size) continue;
    edges.push({id:edges.length,a,b,delta,tangent:delta.map(v=>v/size),
      bbox:{minX:Math.min(a[0],b[0]),minY:Math.min(a[1],b[1]),maxX:Math.max(a[0],b[0]),maxY:Math.max(a[1],b[1])}});
  }
  return edges;
}
function pointOnEdge(p,edge) {
  if (!inBounds(p,edge.bbox)) return false;
  // A physical-distance tolerance, independent of long edges or frame length.
  return Math.abs(cross(subtract(p,edge.a),edge.tangent))<=EPS;
}
function indexGeometry(polygons) {
  const edges=edgesOf(polygons),index=new SpatialIndex(128),bbox=getBounds(polygons);
  for (const edge of edges) index.insert(edge);
  return {edges,index,bbox};
}
/** Even/odd classification of a normalized disjoint MultiPolygon. The indexed
 * horizontal ray avoids scanning every coastline vertex for each movement test.
 */
function containsGeometry(p,geometry) {
  if (!geometry.bbox || !inBounds(p,geometry.bbox)) return false;
  let inside=false;
  const candidates=geometry.index.query({minX:p[0]-EPS,minY:p[1]-EPS,maxX:geometry.bbox.maxX+EPS,maxY:p[1]+EPS});
  for (const edge of candidates) {
    if (pointOnEdge(p,edge)) return true;
    const [a,b]=[edge.a,edge.b];
    if ((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
function movementBounds(p,d) {
  const q=at(p,d,1);
  return {minX:Math.min(p[0],q[0])-EPS,minY:Math.min(p[1],q[1])-EPS,
    maxX:Math.max(p[0],q[0])+EPS,maxY:Math.max(p[1],q[1])+EPS};
}
/** Exact boundary event parameters, including collinear edges. No fixed-step
 * movement samples: even water narrower than a mask cell creates two events.
 */
function intersections(p,d,edge) {
  const relative=subtract(edge.a,p),denominator=cross(d,edge.delta);
  if (denominator!==0) {
    const t=cross(relative,edge.delta)/denominator,u=cross(relative,d)/denominator;
    if (t>=-Number.EPSILON*8 && t<=1+Number.EPSILON*8 && u>=-Number.EPSILON*8 && u<=1+Number.EPSILON*8)
      return [clamp(t,0,1)];
    return [];
  }
  if (Math.abs(cross(relative,d))>EPS*length(d)) return [];
  const magnitude=dot(d,d);
  if (!magnitude) return [];
  const a=dot(relative,d)/magnitude,b=dot(subtract(edge.b,p),d)/magnitude;
  if (Math.max(a,b)<0 || Math.min(a,b)>1) return [];
  return [clamp(a,0,1),clamp(b,0,1)];
}
function radiusBounds(radius) {
  const overrun=boundaryOverrun(radius);
  return {minX:square.minX-overrun,minY:square.minY-overrun,maxX:square.maxX+overrun,maxY:square.maxY+overrun};
}
function samePoint(a,b) { return a[0]===b[0] && a[1]===b[1]; }

function knownDomain({polygons,waterPolygons,domainBounds}) {
  const budget={vertices:0};
  validatePolygons(polygons,'active land',{budget});validatePolygons(waterPolygons,'water',{budget});
  const domain=bounds(domainBounds);
  if (domain.minX>square.minX || domain.minY>square.minY || domain.maxX<square.maxX || domain.maxY<square.maxY)
    throw new RangeError('Known domain must cover the complete active square');
  if (!polygons.length) throw new RangeError('The active land region is empty');
  const maxBounds=radiusBounds(RADIUS_CAP_METRES);
  return {minX:Math.max(domain.minX,maxBounds.minX),minY:Math.max(domain.minY,maxBounds.minY),
    maxX:Math.min(domain.maxX,maxBounds.maxX),maxY:Math.min(domain.maxY,maxBounds.maxY)};
}
function validatePrepared(prepared,known) {
  if (!prepared || typeof prepared!=='object') throw new TypeError('Expected worker-prepared land geometry');
  const preparedBounds=bounds(prepared.domainBounds);
  for (const key of ['minX','minY','maxX','maxY']) if (preparedBounds[key]!==known[key])
    throw new RangeError('Prepared land domain does not match the certified known domain');
  const budget={vertices:0};
  validatePolygons(prepared.polygons,'prepared active land',{budget,within:square,closed:true});
  validatePolygons(prepared.allowedPolygons,'prepared allowed land',{budget,within:known,closed:true});
  if (prepared.polygons.length!==1 || !(polygonsArea(prepared.polygons)>0))
    throw new RangeError('Select exactly one nonempty connected land component');
  if (!prepared.allowedPolygons.length || prepared.allowedPolygons.some(polygon=>!(polygonsArea([polygon])>0)))
    throw new RangeError('Active land has no certified movement domain');
}

/** Heavy static preparation for a worker. The detached, structured-clone-safe
 * result is {polygons,allowedPolygons,domainBounds}; it carries no indexes or
 * closures. Source completeness and selected-region identity must already be
 * certified by the caller. Input and result each have a 300k-vertex budget.
 */
export function prepareLandGeometry(input={}) {
  const known=knownDomain(input),{polygons,waterPolygons}=input;
  const squarePolygon=rectangle(square),active=polygonClipping.difference(polygonClipping.intersection(polygons,squarePolygon),waterPolygons);
  validatePolygons(active,'active land');
  if (active.length!==1 || !(polygonsArea(active)>0)) throw new RangeError('Select exactly one nonempty connected land component');
  // Other in-square components stay forbidden even when a route around a river
  // is possible outside the artificial square. Outside land must actually be
  // attached to the selected component inside the fully known maximum halo.
  const otherSquare=polygonClipping.difference(squarePolygon,active);
  validatePolygons(otherSquare,'other square');
  const possible=polygonClipping.difference(rectangle(known),waterPolygons,otherSquare);
  validatePolygons(possible,'possible land');
  const allowed=possible.filter(polygon=>polygonsArea(polygonClipping.intersection([polygon],active))>0);
  const prepared={polygons:active,allowedPolygons:allowed,domainBounds:known};
  validatePrepared(prepared,known);
  const copy=polygons=>polygons.map(polygon=>polygon.map(ring=>ring.map(p=>[...p])));
  return {polygons:copy(active),allowedPolygons:copy(allowed),domainBounds:{...known}};
}

/**
 * Create immutable rules for ONE connected in-square land region.
 *
 * polygons and waterPolygons use [polygon[ring[[x,y],...]],...] in local metres;
 * domainBounds is mandatory, e.g. [-2000,-2000,2000,2000]. A smaller known halo
 * remains a hard boundary; a larger one cannot extend movement beyond 500 m.
 * Pass preparedGeometry from prepareLandGeometry in our own worker to avoid
 * static Boolean clipping on the UI thread. Its geometry must belong to these
 * same certified inputs; this is not a persisted/untrusted geometry loader.
 * Without it, preparation runs synchronously as a test/fallback convenience.
 * Static Boolean clipping never runs on a movement/growth tick.
 *
 * contains(p,r): point membership, including water/land boundary and permitted
 *   artificial-edge overrun. Reachability comes from resolveMotion's continuous
 *   path, not from testing only an arbitrary target's membership.
 * isReachable(p,r): cold-restore validation that preserves a valid saved halo
 *   position exactly. Clips the static domain to this radius and verifies its
 *   connection to active land. Never call this Boolean operation per frame.
 * nearestPoint(p): spawn/restore recovery onto ACTIVE IN-SQUARE land. This must
 *   not be used to snap each movement target; that would teleport across water.
 * resolveMotion(p,d,r): exact clipped/sliding path; radius affects square
 *   overrun only. Returned path excludes a discontinuous invalid-start recovery.
 * scoreChunk(key): independent copy of a cached active-region 2 m bitmask,
 *   compatible with ConsumptionMask's 256×256 low-bit-first chunks.
 */
export function createLandRegion({polygons,waterPolygons,domainBounds,preparedGeometry}={}) {
  const input={polygons,waterPolygons,domainBounds},known=knownDomain(input);
  const prepared=preparedGeometry??prepareLandGeometry(input);
  validatePrepared(prepared,known);
  // Detach before indexing: later mutations of a received worker message cannot
  // change index coordinates or the region's cached score geometry.
  const active=freezeGeometry(prepared.polygons),allowed=freezeGeometry(prepared.allowedPolygons);
  const activeGeometry=indexGeometry(active),movementGeometry=indexGeometry(allowed),scoreCache=new Map();
  // A single cold-restore cache, bounded independently of the number of growth
  // radii seen during play. Ordinary motion never reads or updates this cache.
  let reachableRadius=null,reachableGeometry=null;
  const contains=(p,radius=0)=>{
    point(p);return inBounds(p,radiusBounds(radius)) && containsGeometry(p,movementGeometry);
  };
  const isReachable=(p,radius=0)=>{
    if (!contains(p,radius)) return false;
    if (containsGeometry(p,activeGeometry)) return true;
    const overrun=boundaryOverrun(radius);
    // The maximum domain was already certified as linked to active land above.
    if (overrun===RADIUS_CAP_METRES) return true;
    if (reachableRadius!==overrun) {
      const clipped=polygonClipping.intersection(allowed,rectangle(radiusBounds(overrun)));
      const connected=clipped.filter(polygon=>polygonsArea(polygonClipping.intersection([polygon],active))>0);
      reachableGeometry=indexGeometry(connected);reachableRadius=overrun;
    }
    return containsGeometry(p,reachableGeometry);
  };
  const nearestPoint=p=>{
    point(p);
    if (containsGeometry(p,activeGeometry)) return [...p];
    let best=null,bestDistance=Infinity;
    for (const edge of activeGeometry.edges) {
      const candidate=closestPointOnSegment(p,edge.a,edge.b),distance=length(subtract(candidate,p));
      if (distance<bestDistance) { best=candidate;bestDistance=distance; }
    }
    return best;
  };
  const resolveMotion=(position,displacement,radius=0)=>{
    point(position);point(displacement);
    const limit=radiusBounds(radius),rectangleEdges=edgesOf(rectangle(limit));
    const valid=p=>inBounds(p,limit) && containsGeometry(p,movementGeometry);
    const recovered=!valid(position);
    let current=recovered?nearestPoint(position):[...position],remaining=[...displacement];
    const path=[[...current]],collisions=[];
    // Partition the requested segment at ALL indexed boundary intersections.
    // A midpoint classifies an exact open interval, not a sampled frame step.
    const cast=(p,d)=>{
      const swept=movementBounds(p,d),extent=movementGeometry.bbox;
      // Even an enormous finite input step must query only the known domain,
      // rather than iterating empty spatial-index cells out to its endpoint.
      const query={minX:Math.max(swept.minX,extent.minX-EPS),minY:Math.max(swept.minY,extent.minY-EPS),
        maxX:Math.min(swept.maxX,extent.maxX+EPS),maxY:Math.min(swept.maxY,extent.maxY+EPS)};
      const candidates=[...movementGeometry.index.query(query),...rectangleEdges];
      const events=[{time:0},{time:1}];
      for (const edge of candidates) for (const time of intersections(p,d,edge)) events.push({time,edge});
      events.sort((a,b)=>a.time-b.time);
      let previous=0;
      for (const event of events) {
        if (event.time>previous && !valid(at(p,d,previous+(event.time-previous)/2))) {
          const hit=at(p,d,previous);
          // Do not merge nearby event times: a very thin water polygon is real.
          const edges=candidates.filter(edge=>pointOnEdge(hit,edge));
          return {position:hit,time:previous,edges};
        }
        previous=event.time;
      }
      const target=at(p,d,1);
      return valid(target)?{position:target,time:1,edges:[]}:{position:[...p],time:0,edges:[]};
    };
    for (let iteration=0;iteration<MAX_SLIDES && length(remaining)>EPS;iteration++) {
      const hit=cast(current,remaining);
      if (!samePoint(hit.position,current)) path.push([...hit.position]);
      current=hit.position;
      if (hit.time===1) { remaining=[0,0];break; }
      const unspent=remaining.map(v=>v*(1-hit.time));
      collisions.push({position:[...current],time:hit.time});
      let best=null,bestProgress=0;
      for (const edge of hit.edges) {
        const along=dot(unspent,edge.tangent),slide=edge.tangent.map(v=>v*along);
        if (length(slide)<=EPS) continue;
        const next=cast(current,slide),progress=dot(subtract(next.position,current),unspent);
        if (progress>bestProgress+EPS*EPS) { best=slide;bestProgress=progress; }
      }
      if (!best) break;
      remaining=best;
    }
    return {position:[...current],displacement:subtract(current,position),path,
      collisions,blocked:recovered || collisions.length>0,recovered};
  };
  const scoreChunk=key=>{
    if (!scoreCache.has(key)) scoreCache.set(key,rasterizeCoverageChunk(key,active));
    return new Uint8Array(scoreCache.get(key));
  };
  return Object.freeze({polygons:active,domainBounds:Object.freeze({...known}),
    areaM2:polygonsArea(active),contains,isReachable,nearestPoint,resolveMotion,scoreChunk});
}
