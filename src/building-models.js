import {localToLonLat,lonLatToLocal} from './geometry.js';
import {mercatorProject,mercatorUnproject} from './mercator-view.js';
import {MAX_BUILDING_TILT} from './building-lod.js';

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const MAX_SOURCE_VERTICES = 300000;
const MAX_MODEL_PARTS = 64;
const cache = new WeakMap();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const DEFAULT_FILL = '#90a966';
const DEFAULT_ROOF = '#b2bea0';
const DEFAULT_EDGE = '#62744e';

// Allows preparation and deterministic tests without Canvas or a DOM. In a
// browser every path below is a native Path2D, constructed only at preparation.
class RecordedPath {
  constructor() { this.commands = []; }
  moveTo(x, y) { this.commands.push(['moveTo', x, y]); }
  lineTo(x, y) { this.commands.push(['lineTo', x, y]); }
  closePath() { this.commands.push(['closePath']); }
}
const defaultPathFactory = () => typeof globalThis.Path2D === 'function' ? new globalThis.Path2D() : new RecordedPath();

function sourceVertexCount(polygons) {
  if (!Array.isArray(polygons) || !polygons.length) return Infinity;
  let count = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length) return Infinity;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 3) return Infinity;
      count += ring.length;
      if (count > MAX_SOURCE_VERTICES) return count;
      for (const point of ring) if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) return Infinity;
    }
  }
  return count;
}

function signedArea(ring) {
  const origin = ring[0]; let area = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    area += (ring[i][0] - origin[0]) * (ring[i + 1][1] - origin[1]) -
      (ring[i + 1][0] - origin[0]) * (ring[i][1] - origin[1]);
  }
  return area / 2;
}

// Count retained path points, world points and visible edge endpoints before
// allocating any Path2D. Latitude projection reverses winding, but preserves x.
function geometryMetrics(polygons) {
  let vertices = 0, walls = 0;
  for (const polygon of polygons) for (let hole = 0; hole < polygon.length; hole++) {
    const ring = polygon[hole], closed = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
    const count = ring.length - (closed ? 1 : 0), winding = Math.sign(signedArea(ring));
    if (count < 3 || !winding) return null;
    vertices += count;
    for (let i = 0; i < count; i++) {
      if ((ring[(i + 1) % count][0] - ring[i][0]) * winding * (hole ? -1 : 1) > 0) walls++;
    }
  }
  return {vertices, walls, retained: vertices * 2 + walls * 2};
}

function prepareGeometry(polygons, manifest, origin, pathFactory) {
  const centerX = (manifest.center[0] + 180) / 360;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const path = pathFactory(), worldPolygons = [], walls = [];
  let vertexCount = 0;
  for (const polygon of polygons) {
    const projectedPolygon = [];
    for (let holeIndex = 0; holeIndex < polygon.length; holeIndex++) {
      const sourceRing = polygon[holeIndex];
      const closed = sourceRing.length > 1 && sourceRing[0][0] === sourceRing.at(-1)[0] && sourceRing[0][1] === sourceRing.at(-1)[1];
      const end = sourceRing.length - (closed ? 1 : 0), ring = [];
      if (end < 3) return null;
      for (let i = 0; i < end; i++) {
        const world = mercatorProject(localToLonLat(sourceRing[i], manifest.center, manifest.projectionLatitude));
        world[0] += Math.round(centerX - world[0]);
        bounds[0] = Math.min(bounds[0], world[0]); bounds[1] = Math.min(bounds[1], world[1]);
        bounds[2] = Math.max(bounds[2], world[0]); bounds[3] = Math.max(bounds[3], world[1]);
        ring.push(world);
        const point = [world[0] - origin[0], world[1] - origin[1]];
        if (i === 0) path.moveTo(...point); else path.lineTo(...point);
      }
      path.closePath(); vertexCount += end;
      const winding = Math.sign(signedArea(ring));
      if (!winding) return null;
      // The view is north-up and looks from the south. Hole-facing normals are
      // reversed independently of source winding; courtyards are never filled.
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const normalY = -dx * winding * (holeIndex ? -1 : 1);
        if (normalY > 1e-16) walls.push({
          x: a[0] - origin[0], y: a[1] - origin[1], dx, dy,
          depth: (a[1] + b[1]) / 2, hole: holeIndex > 0,
          colour: dy >= 0 ? '#819170' : '#718463',
        });
      }
      projectedPolygon.push(ring);
    }
    worldPolygons.push(projectedPolygon);
  }
  walls.sort((a, b) => a.depth - b.depth);
  return {path, worldPolygons, bounds, vertexCount, walls};
}

function renderHeight(part) {
  const height = part.heightMeters, minimum = part.minHeightMeters ?? 0;
  return part.hide3d !== true && finite(height) && height > 0 && height <= 3660 &&
    finite(minimum) && minimum >= 0 && minimum < height &&
    !['missing', 'invalid'].includes(part.heightProvenance) ? {height, minimum} : null;
}

/** Visual-only broad phase, computed once for each resident catalog object.
 * A roof can enter the screen while its ground lies far south of the viewport.
 * Index that full possible projection at the maximum supported tilt, rather
 * than fetching more geometry or changing the authoritative ground footprint. */
export function buildingVisualQueryBounds(building, manifest) {
  const bounds = [...building.bounds];
  const inputs = Array.isArray(building.modelParts) ? building.modelParts : [building];
  const height = inputs.reduce((maximum, part) => Math.max(maximum, renderHeight(part)?.height || 0), 0);
  if (!height) return bounds;
  const center = Array.isArray(building.center) ? building.center : [bounds[0], bounds[1]];
  const latitude = localToLonLat(center, manifest.center, manifest.projectionLatitude)[1];
  const metersToWorld = 1 / (EARTH_CIRCUMFERENCE * Math.cos(clamp(latitude, -85.0511287798066, 85.0511287798066) * Math.PI / 180));
  const north = mercatorProject(localToLonLat([bounds[0], bounds[3]], manifest.center, manifest.projectionLatitude));
  north[1] -= height * metersToWorld * Math.tan(MAX_BUILDING_TILT);
  bounds[3] = Math.max(bounds[3], lonLatToLocal(mercatorUnproject(north), manifest.center, manifest.projectionLatitude)[1]);
  return bounds;
}

/** Prepare once per immutable catalog building. All input coordinates are local
 * metres. The authoritative original footprint is retained, without simplifying,
 * joining houses, or changing fit/reward geometry. Path coordinates are world
 * distances relative to a fixed origin, avoiding float precision loss at z19.
 * pathFactory is optional and exists for pure tests / non-DOM Canvas adapters.
 */
export function prepareBuildingModel(building, manifest, {pathFactory = defaultPathFactory, maxVertices = 24000} = {}) {
  if (!building || typeof building !== 'object' || building.complete !== true) return null;
  if (!Array.isArray(manifest?.center) || manifest.center.length !== 2 || !manifest.center.every(finite) ||
      !finite(manifest.projectionLatitude ?? manifest.center[1])) throw new TypeError('Invalid building model projection.');
  const projectionKey = `${manifest.center[0]},${manifest.center[1]},${manifest.projectionLatitude ?? manifest.center[1]}`;
  const preparationBudget = budget(maxVertices, 24000);
  const previous = cache.get(building);
  if (previous?.projectionKey === projectionKey && previous.pathFactory === pathFactory) return previous.model.preparedVertexCost <= preparationBudget ? previous.model : null;
  const footprintSourceVertices = sourceVertexCount(building.polygons);
  const inputs = Array.isArray(building.modelParts) ? building.modelParts : [building];
  let sourceVertices = footprintSourceVertices;
  for (const part of inputs) sourceVertices += sourceVertexCount(part?.polygons);
  if (sourceVertices > MAX_SOURCE_VERTICES || inputs.length > MAX_MODEL_PARTS) return null;
  let preparedVertexCost = 4, pathVertices = 4;
  for (const polygons of new Set([building.polygons, ...inputs.map(part => part.polygons)])) {
    const metrics = geometryMetrics(polygons);
    if (!metrics) return null;
    preparedVertexCost += metrics.retained; pathVertices += metrics.vertices;
    if (preparedVertexCost > preparationBudget) return null;
  }
  const origin = mercatorProject(localToLonLat(building.polygons[0][0][0], manifest.center, manifest.projectionLatitude));
  origin[0] += Math.round((manifest.center[0] + 180) / 360 - origin[0]);
  const geometries = new Map();
  const geometryFor = polygons => {
    if (!geometries.has(polygons)) geometries.set(polygons, prepareGeometry(polygons, manifest, origin, pathFactory));
    return geometries.get(polygons);
  };
  const ground = geometryFor(building.polygons);
  if (!ground) return null;
  const center = Array.isArray(building.center) && building.center.every(finite) ? building.center : building.polygons[0][0][0];
  const latitude = localToLonLat(center, manifest.center, manifest.projectionLatitude)[1];
  const metersToWorld = 1 / (EARTH_CIRCUMFERENCE * Math.max(1e-8, Math.cos(clamp(latitude, -85.0511287798066, 85.0511287798066) * Math.PI / 180)));
  const parts = [];
  for (const input of inputs) {
    const geometry = geometryFor(input.polygons);
    if (!geometry) return null;
    const heights = renderHeight(input);
    parts.push({...geometry, heightMeters: heights?.height ?? null, minHeightMeters: heights?.minimum ?? null,
      heightProvenance: input.heightProvenance ?? (heights ? 'source-approximation' : 'missing'),
      colour: typeof input.colour === 'string' && input.colour.length <= 32 && input.colour !== 'transparent' ? input.colour : DEFAULT_ROOF,
      hide3d: input.hide3d === true});
  }
  // One reusable unit wall quad; every edge uses an affine matrix. Neither
  // extrusion interpolation nor pan/zoom constructs or mutates any paths.
  const wallPath = pathFactory();
  wallPath.moveTo(0, 0); wallPath.lineTo(1, 0); wallPath.lineTo(1, 1); wallPath.lineTo(0, 1); wallPath.closePath();
  const renderable = parts.filter(part => part.heightMeters !== null).sort((a, b) => a.heightMeters - b.heightMeters || a.bounds[3] - b.bounds[3]);
  const bounds = [...ground.bounds];
  for (const part of parts) {
    bounds[0] = Math.min(bounds[0], part.bounds[0]); bounds[1] = Math.min(bounds[1], part.bounds[1]);
    bounds[2] = Math.max(bounds[2], part.bounds[2]); bounds[3] = Math.max(bounds[3], part.bounds[3]);
  }
  const flatVertexCost = ground.vertexCount * 2; // fill + outline
  const extrudedVertexCost = ground.vertexCount * 2 + renderable.reduce((n, part) => n + part.vertexCount * 2 + part.walls.length * 4, 0); // ground + shadow + roofs/outlines + wall quads
  const model = {id: building.id, building, originalPolygons: building.polygons, origin, metersToWorld,
    ground, parts, renderParts: renderable, bounds, worldPolygons: ground.worldPolygons, wallPath,
    sourceVertices, footprintSourceVertices, preparedVertexCost, pathVertices, flatVertexCost,
    emittedVertexCost: renderable.length ? extrudedVertexCost : flatVertexCost,
    maxHeightMeters: renderable.reduce((height, part) => Math.max(height, part.heightMeters), 0)};
  cache.set(building, {projectionKey, pathFactory, model});
  return model;
}

/** The catalog may retain its source buildings after a visual cache eviction.
 * Explicit release ensures their prepared paths do not survive that eviction. */
export function releaseBuildingModel(building) { return cache.delete(building); }

function normalizeFrame(frame) {
  if (!finite(frame?.worldSize) || frame.worldSize <= 0 || !finite(frame.offsetX) || !finite(frame.offsetY)) throw new TypeError('Invalid building model frame.');
  const groundScaleY = frame.groundScaleY ?? 1, roofLiftFactor = frame.roofLiftFactor ?? 0, pixelRatio = frame.pixelRatio ?? 1;
  if (!finite(groundScaleY) || groundScaleY <= 0 || !finite(roofLiftFactor) || roofLiftFactor < 0 || !finite(pixelRatio) || pixelRatio <= 0) throw new TypeError('Invalid building model projection factors.');
  if (![frame.worldSize * pixelRatio, frame.worldSize * groundScaleY * pixelRatio,
    frame.offsetX * pixelRatio, frame.offsetY * pixelRatio].every(finite)) throw new RangeError('Building projection overflow.');
  return {...frame, groundScaleY, roofLiftFactor, pixelRatio,
    viewportWidth: finite(frame.viewportWidth ?? frame.width) ? Math.max(0, frame.viewportWidth ?? frame.width) : Infinity,
    viewportHeight: finite(frame.viewportHeight ?? frame.height) ? Math.max(0, frame.viewportHeight ?? frame.height) : Infinity};
}

const budget = (value, fallback) => value === undefined ? fallback : finite(value) ? Math.max(0, Math.floor(value)) : 0;

/** CSS-pixel screen bounds, including lifted roofs and the bounded shadow. */
export function buildingModelScreenBounds(model, frame, lift = 0, shadow = false) {
  const f = normalizeFrame(frame), b = model.bounds;
  return [b[0] * f.worldSize + f.offsetX,
    b[1] * f.worldSize * f.groundScaleY + f.offsetY - lift,
    b[2] * f.worldSize + f.offsetX + (shadow ? Math.min(18, lift * .22) : 0),
    b[3] * f.worldSize * f.groundScaleY + f.offsetY + (shadow ? Math.min(28, lift * .35) : 0)];
}

/** Plan before drawing the fallback mask. Its selectedIds are exactly the
 * footprints to exclude. Vertex budget counts every submitted fill/stroke path
 * and every wall quad, not merely unique source geometry. Budget fallback uses
 * the complete original footprint; no partially drawn buildings are selected.
 */
export function planBuildingModels(entries, frame, options = {}) {
  const f = normalizeFrame(frame), extrusion = finite(options.extrusion) ? clamp(options.extrusion, 0, 1) : 0;
  const maxBuildings = budget(options.maxBuildings, 128), maxVertices = budget(options.maxVertices, 24000);
  const selections = [], seen = new Set();
  const stats = {selectedIds: [], drawnBuildings: 0, drawnVertices: 0, sourceVertices: 0,
    extrudedBuildings: 0, flatBuildings: 0, flatFallbacks: 0,
    culledBuildings: 0, skippedBuildings: 0, maxRoofLiftPixels: 0, heightScale: 'source-metres', maxVertices, maxBuildings};
  for (const model of entries || []) {
    if (!model?.ground || seen.has(model.id)) continue;
    seen.add(model.id);
    const lift = model.maxHeightMeters * model.metersToWorld * f.worldSize * f.roofLiftFactor * extrusion;
    if (!finite(lift * f.pixelRatio)) throw new RangeError('Building height projection overflow.');
    let isExtruded = lift > 1e-6;
    let bounds = buildingModelScreenBounds(model, f, isExtruded ? lift : 0, isExtruded);
    if (!bounds.every(value => finite(value * f.pixelRatio))) throw new RangeError('Building screen bounds overflow.');
    if (bounds[2] < 0 || bounds[0] > f.viewportWidth || bounds[3] < 0 || bounds[1] > f.viewportHeight) { stats.culledBuildings++; continue; }
    if (selections.length >= maxBuildings) { stats.skippedBuildings++; continue; }
    let cost = isExtruded ? model.emittedVertexCost : model.flatVertexCost;
    const fellBack = isExtruded && stats.drawnVertices + cost > maxVertices;
    if (fellBack) { isExtruded = false; cost = model.flatVertexCost; bounds = buildingModelScreenBounds(model, f); }
    if (stats.drawnVertices + cost > maxVertices) { stats.skippedBuildings++; continue; }
    // A roof-only candidate may become offscreen when reduced to a flat path.
    if (!isExtruded && (bounds[2] < 0 || bounds[0] > f.viewportWidth || bounds[3] < 0 || bounds[1] > f.viewportHeight)) { stats.culledBuildings++; continue; }
    selections.push({model, isExtruded, lift: isExtruded ? lift : 0, extrusion, bounds, cost});
    stats.selectedIds.push(model.id); stats.drawnBuildings++; stats.drawnVertices += cost; stats.sourceVertices += model.sourceVertices;
    if (isExtruded) { stats.extrudedBuildings++; stats.maxRoofLiftPixels = Math.max(stats.maxRoofLiftPixels, lift); }
    else stats.flatBuildings++;
    if (fellBack) stats.flatFallbacks++;
  }
  // South-facing foreground buildings cover the buildings behind them.
  selections.sort((a, b) => a.model.bounds[3] - b.model.bounds[3]);
  return {frame: f, selections, stats};
}

function usePath(context, path, method, rule) {
  if (path instanceof RecordedPath) {
    context.beginPath();
    for (const [name, ...args] of path.commands) context[name](...args);
    if (rule) context[method](rule); else context[method]();
  } else if (rule) context[method](path, rule);
  else context[method](path);
}

function pathTransform(context, model, frame, lift = 0, xShift = 0, yShift = 0) {
  const d = frame.pixelRatio, s = frame.worldSize;
  context.setTransform(s * d, 0, 0, s * frame.groundScaleY * d,
    (model.origin[0] * s + frame.offsetX + xShift) * d,
    (model.origin[1] * s * frame.groundScaleY + frame.offsetY - lift + yShift) * d);
}

/** Pure dry-run when context is null. Reuse the returned plan after drawing the
 * fallback mask: drawBuildingModels(ctx, entries, frame, {...opts, plan}). All
 * Frame positions and roof lifts are CSS pixels; pixelRatio is applied here.
 * The caller owns certification, consumed/partial filtering and mask exclusion.
 */
export function drawBuildingModels(context, entries, frame, options = {}) {
  const plan = options.plan || planBuildingModels(entries, frame, options);
  if (!context) return {...plan.stats, plan};
  const f = plan.frame;
  context.save();
  try {
    context.lineJoin = 'round'; context.lineCap = 'round';
    context.setLineDash?.([]);
    context.globalCompositeOperation = 'source-over';
    // Shadows are behind every building, including their courtyard holes.
    for (const item of plan.selections) if (item.isExtruded) {
      pathTransform(context, item.model, f, 0, Math.min(18, item.lift * .22), Math.min(28, item.lift * .35));
      context.globalAlpha = .11 * item.extrusion; context.fillStyle = '#263122';
      usePath(context, item.model.ground.path, 'fill', 'evenodd');
    }
    context.globalAlpha = 1;
    for (const item of plan.selections) {
      pathTransform(context, item.model, f);
      context.fillStyle = DEFAULT_FILL;
      usePath(context, item.model.ground.path, 'fill', 'evenodd');
      if (!item.isExtruded) {
        context.lineWidth = .65 / f.worldSize; context.strokeStyle = DEFAULT_EDGE;
        usePath(context, item.model.ground.path, 'stroke');
        continue;
      }
      const model = item.model, liftPerMeter = model.metersToWorld * f.worldSize * f.roofLiftFactor * item.extrusion;
      for (const part of model.renderParts) {
        const roofLift = part.heightMeters * liftPerMeter, baseLift = part.minHeightMeters * liftPerMeter;
        for (const wall of part.walls) {
          const d = f.pixelRatio, s = f.worldSize;
          context.setTransform(wall.dx * s * d, wall.dy * s * f.groundScaleY * d, 0, -(roofLift - baseLift) * d,
            ((model.origin[0] + wall.x) * s + f.offsetX) * d,
            ((model.origin[1] + wall.y) * s * f.groundScaleY + f.offsetY - baseLift) * d);
          context.fillStyle = wall.colour;
          usePath(context, model.wallPath, 'fill');
        }
        pathTransform(context, model, f, roofLift);
        context.globalAlpha = item.extrusion; context.fillStyle = part.colour;
        usePath(context, part.path, 'fill', 'evenodd');
        context.globalAlpha = 1;
        context.lineWidth = .65 / f.worldSize; context.strokeStyle = DEFAULT_EDGE;
        usePath(context, part.path, 'stroke');
      }
    }
  } finally { context.restore(); }
  return {...plan.stats, plan};
}
