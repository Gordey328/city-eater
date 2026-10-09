/**
 * Geometry for City Eater, in local metres (x east, y north).
 *
 * Point: [x, y]. Polygon: [outerRing, ...holeRings]. MultiPolygon:
 * [polygon, ...]. Rings may be open or closed; winding is immaterial.
 * Bounds are {minX,minY,maxX,maxY}; APIs also accept [minX,minY,maxX,maxY].
 * Nothing in this module mutates its inputs or depends on the DOM.
 */
const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;
const EPS = 1e-8;
export const FIT_TOLERANCE = 1.06;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const length = (a) => Math.hypot(a[0], a[1]);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const validPoint = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const longitudeDelta = (value) => ((value + 180) % 360 + 360) % 360 - 180;

/** Project WGS84 [longitude, latitude] around a fixed city centre. */
export function lonLatToLocal([lng, lat], [centerLng, centerLat]) {
  const cosLat = Math.max(1e-8, Math.cos(centerLat * DEG));
  return [longitudeDelta(lng - centerLng) * DEG * EARTH_RADIUS * cosLat,
    (lat - centerLat) * DEG * EARTH_RADIUS];
}

/** Inverse of lonLatToLocal; longitude is normalized to [-180, 180). */
export function localToLonLat([x, y], [centerLng, centerLat]) {
  const cosLat = Math.max(1e-8, Math.cos(centerLat * DEG));
  return [longitudeDelta(centerLng + x / (EARTH_RADIUS * cosLat * DEG)),
    centerLat + y / (EARTH_RADIUS * DEG)];
}

/** All exterior vertices of a canonical MultiPolygon, including closing points. */
export function outerVertices(polygons = []) {
  return polygons.flatMap((polygon) => (polygon[0] || []).filter(validPoint));
}

/** Bounding box of a MultiPolygon (or a flat array of points). Empty => null. */
export function getBounds(input = []) {
  const points = validPoint(input[0]) ? input : outerVertices(input);
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    if (!validPoint(point)) continue;
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}
export const boundingBox = getBounds;

/** Signed square-metre area; translated coordinates avoid cancellation. */
export function ringArea(ring = []) {
  if (ring.length < 3) return 0;
  const origin = ring[0];
  let sum = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    sum += cross(sub(ring[i], origin), sub(ring[i + 1], origin));
  }
  return sum / 2;
}

/** Filled area of one Polygon. Interior holes are subtracted regardless of winding. */
export function polygonArea(polygon = []) {
  if (!polygon.length) return 0;
  return Math.max(0, Math.abs(ringArea(polygon[0])) -
    polygon.slice(1).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0));
}

/** Filled area of a MultiPolygon (OSM component interiors should not overlap). */
export function polygonsArea(polygons = []) {
  return polygons.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}
export const multiPolygonArea = polygonsArea;

/** Closest point on a segment, including degenerate zero-length segments. */
export function closestPointOnSegment(point, a, b) {
  const edge = sub(b, a);
  const size = dot(edge, edge);
  const t = size ? clamp(dot(sub(point, a), edge) / size, 0, 1) : 0;
  return [a[0] + t * edge[0], a[1] + t * edge[1]];
}

function pointOnRing(point, ring) {
  for (let i = 0; i < ring.length; i++) {
    if (distance(point, closestPointOnSegment(point, ring[i], ring[(i + 1) % ring.length])) <= EPS) return true;
  }
  return false;
}

/** Point in a ring, including its boundary unless includeBoundary is false. */
export function pointInRing(point, ring = [], includeBoundary = true) {
  if (ring.length < 3) return false;
  if (pointOnRing(point, ring)) return includeBoundary;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Solid membership in one Polygon. Hole interiors are empty; all edges are solid. */
export function pointInPolygon(point, polygon = []) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((ring) => pointInRing(point, ring, false));
}

/** Solid membership in any component of a MultiPolygon, respecting holes. */
export function pointInPolygons(point, polygons = []) {
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}
export const pointInMultiPolygon = pointInPolygons;

function convexHull(points) {
  const sorted = points.filter(validPoint).map((p) => [...p]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((p, i, all) => !i || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (sorted.length <= 2) return sorted;
  const lower = [], upper = [];
  const add = (stack, p) => {
    while (stack.length >= 2 && cross(sub(stack.at(-1), stack.at(-2)), sub(p, stack.at(-1))) <= 0) stack.pop();
    stack.push(p);
  };
  for (const p of sorted) add(lower, p);
  for (let i = sorted.length - 1; i >= 0; i--) add(upper, sorted[i]);
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const circleContains = (circle, point) => circle && distance(circle.center, point) <= circle.radius + EPS * Math.max(1, circle.radius);
function diameterCircle(a, b) {
  const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { center, radius: Math.max(distance(center, a), distance(center, b)) };
}
function circumcircle(a, b, c) {
  const origin = [(Math.min(a[0], b[0], c[0]) + Math.max(a[0], b[0], c[0])) / 2,
    (Math.min(a[1], b[1], c[1]) + Math.max(a[1], b[1], c[1])) / 2];
  const p = sub(a, origin), q = sub(b, origin), r = sub(c, origin);
  const det = 2 * (p[0] * (q[1] - r[1]) + q[0] * (r[1] - p[1]) + r[0] * (p[1] - q[1]));
  if (Math.abs(det) < Number.EPSILON) return null;
  const pp = dot(p, p), qq = dot(q, q), rr = dot(r, r);
  const center = [origin[0] + (pp * (q[1] - r[1]) + qq * (r[1] - p[1]) + rr * (p[1] - q[1])) / det,
    origin[1] + (pp * (r[0] - q[0]) + qq * (p[0] - r[0]) + rr * (q[0] - p[0])) / det];
  return { center, radius: Math.max(distance(center, a), distance(center, b), distance(center, c)) };
}
function circleWithTwoBoundary(points, p, q) {
  const diameter = diameterCircle(p, q);
  if (points.every((point) => circleContains(diameter, point))) return diameter;
  let left = null, right = null;
  const pq = sub(q, p);
  for (const r of points) {
    const side = cross(pq, sub(r, p));
    const circle = circumcircle(p, q, r);
    if (!circle) continue;
    const offset = cross(pq, sub(circle.center, p));
    if (side > 0 && (!left || offset > cross(pq, sub(left.center, p)))) left = circle;
    else if (side < 0 && (!right || offset < cross(pq, sub(right.center, p)))) right = circle;
  }
  if (!left && !right) return diameter;
  if (!left) return right;
  if (!right) return left;
  return left.radius <= right.radius ? left : right;
}
function circleWithOneBoundary(points, p) {
  let circle = { center: [...p], radius: 0 };
  for (let i = 0; i < points.length; i++) {
    const q = points[i];
    if (!circleContains(circle, q)) circle = circle.radius === 0 ? diameterCircle(p, q)
      : circleWithTwoBoundary(points.slice(0, i + 1), p, q);
  }
  return circle;
}

/**
 * Exact smallest enclosing circle of points or all MultiPolygon outer vertices.
 * Uses a deterministic hull/shuffle plus boundary circles; does not confuse area
 * with required opening diameter. Empty input => {center:[0,0],radius:0}.
 */
export function minimalEnclosingCircle(input = []) {
  const points = convexHull(validPoint(input[0]) ? input : outerVertices(input));
  // Fixed-seed shuffle makes order-independent results and good expected runtime.
  let seed = 0x6d2b79f5;
  for (let i = points.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [points[i], points[j]] = [points[j], points[i]];
  }
  let circle = null;
  for (let i = 0; i < points.length; i++) {
    if (!circleContains(circle, points[i])) circle = circleWithOneBoundary(points.slice(0, i + 1), points[i]);
  }
  if (!circle) return { center: [0, 0], radius: 0 };
  // Preserve enclosure despite floating-point roundoff at the support points.
  for (const point of points) circle.radius = Math.max(circle.radius, distance(circle.center, point));
  return circle;
}
export const enclosingCircle = minimalEnclosingCircle;
export const minimumEnclosingCircle = minimalEnclosingCircle;
export const requiredCircle = minimalEnclosingCircle;

/** Every exterior vertex must fit; default tolerance gives a 6% gameplay margin. */
export function polygonFitsCircle(polygons, holeCenter, holeRadius, tolerance = FIT_TOLERANCE) {
  if (!(holeRadius >= 0) || !(tolerance > 0)) return false;
  const allowed = holeRadius * tolerance + EPS, allowedSquared = allowed * allowed;
  let hasPoint = false;
  for (const polygon of polygons || []) for (const point of polygon[0] || []) {
    if (!validPoint(point)) continue;
    hasPoint = true;
    const dx = point[0] - holeCenter[0], dy = point[1] - holeCenter[1];
    if (dx * dx + dy * dy > allowedSquared) return false;
  }
  return hasPoint;
}

function nearestPolygonBoundary(point, polygon) {
  let nearest = null;
  for (const ring of polygon) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const candidate = closestPointOnSegment(point, a, b);
      const d = distance(point, candidate);
      if (!nearest || d < nearest.distance) nearest = { point: candidate, distance: d, edge: sub(b, a) };
    }
  }
  return nearest;
}
function normalAtBoundary(point, edge, polygon) {
  const magnitude = length(edge);
  if (!magnitude) return [1, 0];
  const normal = [-edge[1] / magnitude, edge[0] / magnitude];
  const sample = [point[0] + normal[0] * 1e-4, point[1] + normal[1] * 1e-4];
  return pointInPolygon(sample, polygon) ? [-normal[0], -normal[1]] : normal;
}

/**
 * Circle vs filled MultiPolygon. Returns null at separation/tangency, otherwise
 * {normal:[x,y], penetration, point:[x,y]}; add normal * penetration to move out.
 * Courtyard holes are navigable. If the centre is inside solid, correction crosses
 * the nearest edge. For overlapping components, call again after each correction.
 */
export function circlePolygonCollision(center, radius, polygons) {
  if (!(radius >= 0)) return null;
  let strongest = null;
  for (const polygon of polygons || []) {
    if (!polygon[0]?.length) continue;
    const closest = nearestPolygonBoundary(center, polygon);
    if (!closest) continue;
    const inside = pointInPolygon(center, polygon);
    if (!inside && closest.distance >= radius - EPS) continue;
    const penetration = inside ? radius + closest.distance : radius - closest.distance;
    if (penetration <= EPS) continue;
    let normal;
    if (closest.distance > EPS) {
      const sign = inside ? -1 : 1;
      normal = [(center[0] - closest.point[0]) / closest.distance * sign,
        (center[1] - closest.point[1]) / closest.distance * sign];
    } else normal = normalAtBoundary(closest.point, closest.edge, polygon);
    const collision = { normal, penetration, point: closest.point };
    if (!strongest || penetration > strongest.penetration) strongest = collision;
  }
  return strongest;
}

function normalizeBounds(bbox) {
  if (Array.isArray(bbox)) return { minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3] };
  return bbox;
}
function validBounds(bbox) {
  return bbox && [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].every(Number.isFinite) &&
    bbox.minX <= bbox.maxX && bbox.minY <= bbox.maxY;
}
export function boundsIntersect(a, b) {
  a = normalizeBounds(a); b = normalizeBounds(b);
  return !!a && !!b && a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Uniform-grid broad phase. insert(item, item.bbox) replaces the same item.id;
 * remove(itemOrId), query(bbox) => unique items, clear(), values(), get(id), size.
 * Boundary touching counts as intersection. Query order is deterministic.
 */
export class SpatialIndex {
  constructor(cellSize = 100) {
    if (!(Number.isFinite(cellSize) && cellSize > 0)) throw new RangeError('cellSize must be positive');
    this.cellSize = cellSize;
    this.cells = new Map();
    this.items = new Map();
    this.queryVersion = 0;
  }
  get size() { return this.items.size; }
  *keysFor(bbox) {
    for (let x = Math.floor(bbox.minX / this.cellSize); x <= Math.floor(bbox.maxX / this.cellSize); x++) {
      for (let y = Math.floor(bbox.minY / this.cellSize); y <= Math.floor(bbox.maxY / this.cellSize); y++) yield `${x},${y}`;
    }
  }
  insert(item, bbox = item.bbox) {
    bbox = normalizeBounds(bbox);
    if (!validBounds(bbox)) throw new TypeError('A finite, ordered bounding box is required');
    const key = item.id ?? item;
    this.remove(key);
    const cellKeys = [...this.keysFor(bbox)];
    this.items.set(key, { item, bbox: { ...bbox }, cellKeys });
    for (const cellKey of cellKeys) {
      if (!this.cells.has(cellKey)) this.cells.set(cellKey, new Set());
      this.cells.get(cellKey).add(key);
    }
    return item;
  }
  remove(itemOrId) {
    const key = typeof itemOrId === 'object' && itemOrId !== null ? (itemOrId.id ?? itemOrId) : itemOrId;
    const entry = this.items.get(key);
    if (!entry) return false;
    for (const cellKey of entry.cellKeys) {
      const cell = this.cells.get(cellKey);
      cell.delete(key);
      if (!cell.size) this.cells.delete(cellKey);
    }
    this.items.delete(key);
    return true;
  }
  query(bbox, result = []) {
    result.length = 0;
    bbox = normalizeBounds(bbox);
    if (!validBounds(bbox)) return result;
    const version = ++this.queryVersion;
    for (const cellKey of this.keysFor(bbox)) {
      const cell = this.cells.get(cellKey);
      if (!cell) continue;
      for (const key of cell) {
        const entry = this.items.get(key);
        if (entry.queryVersion === version) continue;
        entry.queryVersion = version;
        const box = entry.bbox;
        if (box.minX <= bbox.maxX && box.maxX >= bbox.minX && box.minY <= bbox.maxY && box.maxY >= bbox.minY) result.push(entry.item);
      }
    }
    return result;
  }
  get(id) { return this.items.get(id)?.item; }
  values() { return [...this.items.values()].map((entry) => entry.item); }
  clear() { this.cells.clear(); this.items.clear(); }
}

/** Earliest circle cast against a segment capsule, including rounded vertices. */
function sweepSegment(position, displacement, radius, a, b) {
  const edge = sub(b, a), edgeLength = length(edge);
  const candidates = [];
  if (edgeLength > EPS) {
    const tangent = [edge[0] / edgeLength, edge[1] / edgeLength];
    const perpendicular = [-tangent[1], tangent[0]];
    const signedDistance = dot(sub(position, a), perpendicular);
    const approach = dot(displacement, perpendicular);
    if (Math.abs(approach) > EPS) {
      for (const sign of [-1, 1]) {
        const normal = [perpendicular[0] * sign, perpendicular[1] * sign];
        if (dot(displacement, normal) >= -EPS) continue;
        const time = (sign * radius - signedDistance) / approach;
        if (time < -EPS || time > 1 + EPS) continue;
        const center = [position[0] + time * displacement[0], position[1] + time * displacement[1]];
        const projection = dot(sub(center, a), tangent);
        if (projection >= -EPS && projection <= edgeLength + EPS) candidates.push({ time: clamp(time, 0, 1), normal });
      }
    }
  }
  const speedSquared = dot(displacement, displacement);
  if (speedSquared > EPS * EPS) {
    for (const point of [a, b]) {
      const relative = sub(position, point);
      const coefficient = dot(relative, displacement);
      const constant = dot(relative, relative) - radius * radius;
      const discriminant = coefficient * coefficient - speedSquared * constant;
      if (discriminant < 0) continue;
      const time = (-coefficient - Math.sqrt(Math.max(0, discriminant))) / speedSquared;
      if (time < -EPS || time > 1 + EPS) continue;
      const difference = [relative[0] + time * displacement[0], relative[1] + time * displacement[1]];
      const magnitude = length(difference);
      if (magnitude <= EPS) continue;
      const normal = [difference[0] / magnitude, difference[1] / magnitude];
      if (dot(displacement, normal) < -EPS) candidates.push({ time: clamp(time, 0, 1), normal });
    }
  }
  return candidates.sort((first, second) => first.time - second.time)[0] || null;
}

function movementBounds(position, displacement, radius) {
  return { minX: Math.min(position[0], position[0] + displacement[0]) - radius,
    minY: Math.min(position[1], position[1] + displacement[1]) - radius,
    maxX: Math.max(position[0], position[0] + displacement[0]) + radius,
    maxY: Math.max(position[1], position[1] + displacement[1]) + radius };
}

/**
 * Resolve one frame's displacement, with continuous collision detection and sliding.
 * Buildings too large for this hole are solid; edible ones can be approached.
 * buildings can be an array or a SpatialIndex. Arena is [-arenaHalf,+arenaHalf].
 * Returns {position,displacement,collisions,blocked}; collision records include id,
 * normal, and (for overlap recovery) penetration. Inputs are never changed.
 */
export function resolveMotion(position, displacement, holeRadius, buildings = [], arenaHalf = 5000) {
  if (!(holeRadius >= 0) || !(arenaHalf > 0)) throw new RangeError('Invalid hole radius or arena');
  const limit = Math.max(0, arenaHalf - holeRadius);
  let current = [clamp(position[0], -limit, limit), clamp(position[1], -limit, limit)];
  let remaining = [...displacement];
  const collisions = [];
  const skin = 1e-5;
  const candidates = (bbox) => (typeof buildings.query === 'function' ? buildings.query(bbox) : buildings)
    .filter((building) => !building.eaten && !building.removed &&
      (building.radius ?? minimalEnclosingCircle(building.polygons).radius) > holeRadius * FIT_TOLERANCE + EPS &&
      (!building.bbox || boundsIntersect(building.bbox, bbox)));
  if (limit === 0) return { position: [0, 0], displacement: [-position[0], -position[1]], collisions: [], blocked: length(displacement) > EPS };

  // Recover safely from spawn overlap or newly enlarged circles before casting.
  for (let iteration = 0; iteration < 12; iteration++) {
    let corrected = false;
    for (const building of candidates(movementBounds(current, [0, 0], holeRadius))) {
      const hit = circlePolygonCollision(current, holeRadius, building.polygons);
      if (!hit) continue;
      current = [clamp(current[0] + hit.normal[0] * (hit.penetration + skin), -limit, limit),
        clamp(current[1] + hit.normal[1] * (hit.penetration + skin), -limit, limit)];
      collisions.push({ id: building.id, ...hit });
      corrected = true;
    }
    if (!corrected) break;
  }

  for (let iteration = 0; iteration < 8 && length(remaining) > EPS; iteration++) {
    let first = null;
    const consider = (hit) => { if (hit && (!first || hit.time < first.time - EPS)) first = hit; };
    for (let axis = 0; axis < 2; axis++) {
      if (Math.abs(remaining[axis]) <= EPS) continue;
      const sign = Math.sign(remaining[axis]);
      const time = (sign * limit - current[axis]) / remaining[axis];
      if (time >= -EPS && time <= 1 + EPS) {
        const normal = [0, 0]; normal[axis] = -sign;
        consider({ time: clamp(time, 0, 1), normal, id: 'arena' });
      }
    }
    for (const building of candidates(movementBounds(current, remaining, holeRadius))) {
      for (const polygon of building.polygons) for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          const hit = sweepSegment(current, remaining, holeRadius, ring[i], ring[(i + 1) % ring.length]);
          if (hit) consider({ ...hit, id: building.id });
        }
      }
    }
    if (!first) {
      current = [current[0] + remaining[0], current[1] + remaining[1]];
      remaining = [0, 0]; break;
    }
    current = [current[0] + remaining[0] * first.time + first.normal[0] * skin,
      current[1] + remaining[1] * first.time + first.normal[1] * skin];
    collisions.push({ id: first.id, normal: first.normal, time: first.time });
    remaining = [remaining[0] * (1 - first.time), remaining[1] * (1 - first.time)];
    const inward = dot(remaining, first.normal);
    if (inward < 0) remaining = [remaining[0] - inward * first.normal[0], remaining[1] - inward * first.normal[1]];
  }
  current = [clamp(current[0], -limit, limit), clamp(current[1], -limit, limit)];
  const actual = sub(current, position);
  return { position: current, displacement: actual, collisions,
    blocked: distance(actual, displacement) > 1e-4 };
}
