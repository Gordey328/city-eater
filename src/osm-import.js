/**
 * Pure, bounded Overpass JSON → playable OSM sector conversion.
 * No fetching, random geometry, wall-clock timestamps, DOM or persistent state.
 * The caller should run this in osm-import.worker.js for large responses.
 */
import osmtogeojson from 'osmtogeojson';
import polygonClipping from 'polygon-clipping';
import {
  lonLatToLocal, localToLonLat, polygonsArea, minimalEnclosingCircle, getBounds,
  ringArea, pointInRing,
} from './geometry.js';

export const OSM_IMPORT_LIMITS = Object.freeze({
  maxResponseBytes: 40 * 1024 * 1024,
  maxElements: 100000,
  maxBuildings: 30000,
  maxVertices: 1000000,
});
const CHUNK_SIZE = 1000;
const ARENA_SIZE = 10000;
const ROUNDING_MARGIN = 0.005;
const BOUNDARY_EPSILON = 0.000001;
import {OSM_IMPORT_PIPELINE as PIPELINE_VERSION} from './import-contract.js';
const COPYRIGHT = '© OpenStreetMap contributors';
const COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const LICENSE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const encoder = new TextEncoder();
const positiveTag = (value) => typeof value === 'string' && value !== '' && value !== 'no';
const isBuilding = (tags = {}) => positiveTag(tags.building);
const isPart = (tags = {}) => positiveTag(tags['building:part']);
const roundArea = (value) => Math.round(value * 1000) / 1000;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pointEqual = (a, b) => a[0] === b[0] && a[1] === b[1];
const finiteCoordinate = (p) => Array.isArray(p) && p.length >= 2 &&
  Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const toBBox = (bounds) => [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
const geometryKey = (geometry) => JSON.stringify(geometry.coordinates);
const toLocalPolygons = (coordinates, center) => coordinates.map((polygon) => polygon.map((ring) => ring.map((point) => lonLatToLocal(point, center))));

export class OSMImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OSMImportError';
    this.code = code;
  }
}

function fail(code, message) { throw new OSMImportError(code, message); }

function validateSector(sector) {
  if (!sector || typeof sector.id !== 'string' || !sector.id.trim() ||
      typeof sector.title !== 'string' || !sector.title.trim() ||
      !finiteCoordinate(sector.center) || Math.abs(sector.center[1]) > 85 ||
      (sector.arenaSize !== undefined && sector.arenaSize !== ARENA_SIZE)) {
    fail('INVALID_SECTOR', 'Некорректный сектор: нужны id, название, центр [долгота, широта] и размер 10 000 м. Широта должна быть от −85° до 85°.');
  }
  return {id: sector.id, title: sector.title, center: [...sector.center], arenaSize: ARENA_SIZE};
}

function parsePayload(payload) {
  if (payload && typeof payload === 'object' && Array.isArray(payload.elements) &&
      payload.elements.length > OSM_IMPORT_LIMITS.maxElements) {
    fail('TOO_MANY_ELEMENTS', 'Ответ OSM содержит больше 100 000 элементов. Выбери менее плотный сектор.');
  }
  let serialized;
  try { serialized = typeof payload === 'string' ? payload : JSON.stringify(payload); }
  catch { fail('INVALID_OSM', 'Ответ OSM не является корректным JSON.'); }
  if (typeof serialized !== 'string') fail('INVALID_OSM', 'Пустой ответ OSM.');
  if (serialized.length > OSM_IMPORT_LIMITS.maxResponseBytes ||
      encoder.encode(serialized).byteLength > OSM_IMPORT_LIMITS.maxResponseBytes) {
    fail('RESPONSE_TOO_LARGE', 'Ответ OSM превышает 40 МиБ. Выбери менее плотный сектор.');
  }
  let source;
  try { source = JSON.parse(serialized); }
  catch { fail('INVALID_OSM', 'Не удалось прочитать JSON от OSM.'); }
  if (!source || !Array.isArray(source.elements)) fail('INVALID_OSM', 'В ответе OSM отсутствует список elements.');
  if (source.elements.length > OSM_IMPORT_LIMITS.maxElements) {
    fail('TOO_MANY_ELEMENTS', 'Ответ OSM содержит больше 100 000 элементов. Выбери менее плотный сектор.');
  }
  // Overpass can return valid JSON plus a runtime-error remark and partial data.
  if (typeof source.remark === 'string' && source.remark.trim()) {
    fail('INCOMPLETE_RESPONSE', `OSM вернул неполный ответ: ${source.remark.slice(0, 300)}`);
  }
  return {source, responseBytes: encoder.encode(serialized).byteLength};
}

/** A deterministic, streaming 128-bit content fingerprint (not a security hash). */
function contentHash(values) {
  let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
  for (const value of values) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (let i = 0; i <= text.length; i++) {
      const code = i === text.length ? 0 : text.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193);
      b = Math.imul(b ^ code, 0x85ebca6b);
      c = Math.imul(c ^ code, 0xc2b2ae35);
      d = Math.imul(d ^ code, 0x27d4eb2f);
    }
  }
  return [a, b, c, d].map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

function backgroundKind(tags = {}) {
  if (isBuilding(tags) || isPart(tags)) return null;
  if (positiveTag(tags.highway)) return {kindGroup: 'roads', kind: tags.highway};
  if (positiveTag(tags.waterway)) return {kindGroup: 'water', kind: tags.waterway};
  if (tags.natural === 'water') return {kindGroup: 'water', kind: tags.water || tags.natural};
  if (['reservoir', 'basin'].includes(tags.landuse)) return {kindGroup: 'water', kind: tags.landuse};
  if (['wood', 'wetland', 'scrub', 'grassland', 'heath'].includes(tags.natural)) {
    return {kindGroup: 'parks', kind: tags.natural};
  }
  if (['forest', 'grass', 'meadow', 'recreation_ground', 'village_green', 'allotments', 'orchard', 'farmland'].includes(tags.landuse)) {
    return {kindGroup: 'parks', kind: tags.landuse};
  }
  if (['park', 'garden', 'golf_course', 'nature_reserve', 'recreation_ground'].includes(tags.leisure)) {
    return {kindGroup: 'parks', kind: tags.leisure};
  }
  return null;
}

function sanitizeTags(tags) {
  const safe = {};
  for (const [key, value] of Object.entries(tags || {})) {
    if (!['__proto__', 'constructor', 'prototype'].includes(key) && typeof value === 'string') safe[key] = value;
  }
  return safe;
}

function coordinatesOfWay(way, nodeMap) {
  if (Array.isArray(way?.geometry)) {
    const coordinates = way.geometry.map((p) => p && [p.lon, p.lat]);
    return coordinates.every(finiteCoordinate) ? coordinates : null;
  }
  if (!Array.isArray(way?.nodes)) return null;
  const coordinates = way.nodes.map((id) => {
    const node = nodeMap.get(String(id));
    return node && [node.lon, node.lat];
  });
  return coordinates.every(finiteCoordinate) ? coordinates : null;
}

/** Reject open/missing relation members, including holes a converter may drop. */
function completeMultipolygon(relation, wayMap, nodeMap) {
  const endpoints = {outer: new Map(), inner: new Map()};
  let outers = 0;
  for (const member of relation.members || []) {
    const role = member.role || 'outer';
    if (!['outer', 'inner'].includes(role)) continue;
    if (member.type !== 'way') return false;
    const line = coordinatesOfWay(wayMap.get(String(member.ref)), nodeMap);
    if (!line || line.length < 2) return false;
    if (role === 'outer') outers++;
    if (pointEqual(line[0], line.at(-1))) {
      if (line.length < 4) return false;
    } else {
      for (const p of [line[0], line.at(-1)]) {
        const key = JSON.stringify(p);
        endpoints[role].set(key, (endpoints[role].get(key) || 0) + 1);
      }
    }
  }
  return outers > 0 && Object.values(endpoints).every((group) => [...group.values()].every((count) => count % 2 === 0));
}

function prepareElements(source, stats) {
  const map = new Map();
  let vertices = 0;
  for (const element of source.elements) {
    if (!element || !['node', 'way', 'relation'].includes(element.type) ||
        !Number.isSafeInteger(Number(element.id)) || Number(element.id) <= 0) continue;
    element.id = Number(element.id);
    element.tags = sanitizeTags(element.tags);
    // out center / out bb are not real footprints; never let the converter
    // manufacture a rectangular building or a centre-point substitute.
    delete element.bounds;
    delete element.center;
    vertices += Array.isArray(element.geometry) ? element.geometry.length : 0;
    if (element.members !== undefined && !Array.isArray(element.members)) element.members = [];
    for (const member of element.members || []) vertices += Array.isArray(member?.geometry) ? member.geometry.length : 0;
    if (vertices > OSM_IMPORT_LIMITS.maxVertices) {
      fail('TOO_MANY_VERTICES', 'Геометрия OSM содержит больше 1 000 000 точек. Выбери менее плотный сектор.');
    }
    const key = `${element.type}/${element.id}`;
    const previous = map.get(key);
    if (!previous || (element.version || 0) > (previous.version || 0) ||
        ((element.version || 0) === (previous.version || 0) && JSON.stringify(element) < JSON.stringify(previous))) map.set(key, element);
  }
  const orderedElements = [...map.values()].sort((a, b) => compare(`${a.type}/${a.id}`, `${b.type}/${b.id}`));
  const wayMap = new Map(), nodeMap = new Map();
  for (const element of orderedElements) {
    if (element.type === 'way') wayMap.set(String(element.id), element);
    if (element.type === 'node') nodeMap.set(String(element.id), element);
  }
  // Materialize actual OSM member ways from out geom once, avoiding the
  // converter's quadratic full-geometry relation lookup. These are source
  // contours, not generated game objects.
  for (const relation of orderedElements) {
    if (relation.type !== 'relation') continue;
    relation.members = (relation.members || []).filter((member) => member &&
      ['node', 'way', 'relation'].includes(member.type) && Number.isSafeInteger(Number(member.ref)) && Number(member.ref) > 0);
    for (const member of relation.members) {
      member.ref = Number(member.ref);
      if (member.type === 'way' && Array.isArray(member.geometry)) {
        const previous = wayMap.get(String(member.ref));
        if (!previous || !coordinatesOfWay(previous, nodeMap)) {
          const way = {type: 'way', id: member.ref, ...(previous || {}), geometry: member.geometry};
          // A geometry-only member has no matching source node IDs.
          if (!previous?.geometry) delete way.nodes;
          wayMap.set(String(member.ref), way);
        }
        delete member.geometry;
      }
      if (member.type === 'way' && !member.role) member.role = 'outer';
    }
  }
  const buildingMembers = new Set(), backgroundMembers = new Set(), explicitParts = new Set(), rejectedRelations = new Set();
  for (const relation of orderedElements) {
    if (relation.type !== 'relation') continue;
    const tags = relation.tags;
    if (tags.type === 'building') {
      for (const member of relation.members) if (member.role === 'part') explicitParts.add(`${member.type}/${member.ref}`);
      // type=building is an outline/parts grouping, not itself a multipolygon.
      continue;
    }
    if (!['multipolygon', 'boundary'].includes(tags.type)) continue;
    const outerWays = relation.members.filter((m) => m.type === 'way' && m.role === 'outer')
      .map((m) => wayMap.get(String(m.ref))).filter(Boolean);
    // Old-style multipolygons store building/landcover tags on outer ways.
    if (!isBuilding(tags) && !backgroundKind(tags) && tags.building !== 'no') {
      const inherited = outerWays.find((way) => isBuilding(way.tags) || backgroundKind(way.tags));
      if (inherited) relation.tags = {...inherited.tags, ...tags};
    }
    if (isBuilding(relation.tags)) {
      for (const member of relation.members) if (member.type === 'way' && ['outer', 'inner'].includes(member.role)) buildingMembers.add(String(member.ref));
    }
    if (backgroundKind(relation.tags)) {
      for (const member of relation.members) if (member.type === 'way' && ['outer', 'inner'].includes(member.role)) backgroundMembers.add(String(member.ref));
    }
    if (!completeMultipolygon(relation, wayMap, nodeMap)) {
      rejectedRelations.add(`relation/${relation.id}`);
      if (isBuilding(relation.tags)) stats.invalidOrIncompleteBuilding++;
    }
    // Keep relation IDs even for a single-outer, old-style multipolygon.
    relation.tags = {...relation.tags, '__city_eater_relation': 'yes'};
  }
  const elements = [...nodeMap.values(), ...wayMap.values()];
  for (const element of orderedElements) if (element.type === 'relation' && !rejectedRelations.has(`relation/${element.id}`)) elements.push(element);
  const candidateCount = [...wayMap.values()].filter((way) => isBuilding(way.tags) && !buildingMembers.has(String(way.id))).length +
    elements.filter((element) => element.type === 'relation' && isBuilding(element.tags) && element.tags.type !== 'building').length;
  if (candidateCount > OSM_IMPORT_LIMITS.maxBuildings) {
    fail('TOO_MANY_BUILDINGS', 'В секторе больше 30 000 контуров зданий. Выбери менее плотный сектор.');
  }
  elements.sort((a, b) => compare(`${a.type}/${a.id}`, `${b.type}/${b.id}`));
  return {elements, buildingMembers, backgroundMembers, explicitParts, wayMap, nodeMap, elementMap: map};
}

function allRelationRingsPreserved(feature, prepared) {
  if (feature.properties.type !== 'relation' || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) return true;
  const relation = prepared.elementMap.get(`relation/${feature.properties.id}`);
  if (!relation || !['multipolygon', 'boundary'].includes(relation.tags.type)) return true;
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const vertices = {outer: new Set(), inner: new Set()};
  for (const polygon of polygons) for (let i = 0; i < polygon.length; i++) {
    for (const point of polygon[i]) vertices[i === 0 ? 'outer' : 'inner'].add(JSON.stringify(point));
  }
  for (const member of relation.members) {
    if (member.type !== 'way' || !['outer', 'inner'].includes(member.role)) continue;
    const line = coordinatesOfWay(prepared.wayMap.get(String(member.ref)), prepared.nodeMap);
    if (!line || line.some((point) => !vertices[member.role].has(JSON.stringify(point)))) return false;
  }
  return true;
}

function canonicalRing(rawRing, center, outer) {
  if (!Array.isArray(rawRing) || rawRing.length < 4 || !rawRing.every(finiteCoordinate) ||
      !pointEqual(rawRing[0], rawRing.at(-1))) return null;
  let coordinates = rawRing.slice(0, -1).filter((p, i, all) => !i || !pointEqual(p, all[i - 1])).map((p) => [p[0], p[1]]);
  if (coordinates.length < 3) return null;
  const area = ringArea(coordinates.map((p) => lonLatToLocal(p, center)));
  if (Math.abs(area) < 1e-8) return null;
  if ((area > 0) !== outer) coordinates.reverse();
  let start = 0;
  for (let i = 1; i < coordinates.length; i++) {
    if (coordinates[i][0] < coordinates[start][0] ||
        (coordinates[i][0] === coordinates[start][0] && coordinates[i][1] < coordinates[start][1])) start = i;
  }
  coordinates = [...coordinates.slice(start), ...coordinates.slice(0, start)];
  coordinates.push([...coordinates[0]]);
  return coordinates;
}

function canonicalPolygons(geometry, center) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
  const input = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(input) || !input.length) return null;
  const polygons = [];
  for (const polygon of input) {
    if (!Array.isArray(polygon) || !polygon.length) return null;
    const rings = polygon.map((ring, i) => canonicalRing(ring, center, i === 0));
    if (rings.some((ring) => !ring)) return null;
    rings.splice(1, rings.length - 1, ...rings.slice(1).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))));
    polygons.push(rings);
  }
  return polygons.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
}

/** Union real components, avoiding duplicate area in overlapping OSM outers. */
function normalizeFootprint(coordinates, center) {
  const local = toLocalPolygons(coordinates, center);
  // Do not turn an invalid, partly external courtyard into a filled footprint.
  if (local.some((polygon) => polygon.slice(1).some((ring) => ring.some((point) => !pointInRing(point, polygon[0]))))) return null;
  let union;
  try { union = polygonClipping.union(local); }
  catch { return null; }
  if (!union.length) return null;
  const lonLat = union.map((polygon) => polygon.map((ring) => ring.map((point) => localToLonLat(point, center))));
  const canonical = canonicalPolygons({type: 'MultiPolygon', coordinates: lonLat}, center);
  if (!canonical) return null;
  return {geometry: {type: 'MultiPolygon', coordinates: canonical}, polygons: toLocalPolygons(canonical, center)};
}

function canonicalLine(line) {
  if (!Array.isArray(line) || line.length < 2 || !line.every(finiteCoordinate)) return null;
  const points = line.map((p) => [p[0], p[1]]);
  const reverse = [...points].reverse();
  return JSON.stringify(points) < JSON.stringify(reverse) ? points : reverse;
}

function canonicalBackgroundGeometry(geometry, center) {
  if (['Polygon', 'MultiPolygon'].includes(geometry?.type)) {
    const coordinates = canonicalPolygons(geometry, center);
    return coordinates && {type: 'MultiPolygon', coordinates};
  }
  if (geometry?.type === 'LineString') {
    const coordinates = canonicalLine(geometry.coordinates);
    return coordinates && {type: 'LineString', coordinates};
  }
  if (geometry?.type === 'MultiLineString') {
    const coordinates = geometry.coordinates.map(canonicalLine);
    return coordinates.every(Boolean) && {type: 'MultiLineString', coordinates: coordinates.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))};
  }
  return null;
}

function heightFromTags(tags) {
  const height = /^\s*(\d+(?:[.,]\d+)?)\s*(m|metres|meters|ft|feet|')?\s*$/i.exec(tags.height || '');
  if (height) {
    const value = Number(height[1].replace(',', '.')) * (/^(ft|feet|')$/i.test(height[2] || '') ? 0.3048 : 1);
    if (value > 0 && value < 2000) return value;
  }
  const levels = Number(tags['building:levels']);
  return Number.isFinite(levels) && levels > 0 && levels < 500 ? levels * 3 : undefined;
}

function containedPart(part, parent) {
  if (part.bbox.some((v, i) => i < 2 ? v < parent.bbox[i] - BOUNDARY_EPSILON : v > parent.bbox[i] + BOUNDARY_EPSILON)) return false;
  try { return polygonsArea(polygonClipping.difference(part.polygons, parent.polygons)) < 0.000001; }
  catch { return false; }
}

function buildChunks(buildings, version) {
  const chunks = {};
  for (const building of buildings) {
    const x = Math.min(9, Math.max(0, Math.floor((building.center[0] + ARENA_SIZE / 2 + BOUNDARY_EPSILON) / CHUNK_SIZE)));
    const y = Math.min(9, Math.max(0, Math.floor((building.center[1] + ARENA_SIZE / 2 + BOUNDARY_EPSILON) / CHUNK_SIZE)));
    const id = `${x}-${y}`;
    (chunks[id] ||= {version, buildings: []}).buildings.push(building);
  }
  const index = Object.keys(chunks).sort().map((id) => {
    const chunk = chunks[id], [x, y] = id.split('-').map(Number);
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const building of chunk.buildings) {
      for (let i = 0; i < 4; i++) bbox[i] = i < 2 ? Math.min(bbox[i], building.bbox[i]) : Math.max(bbox[i], building.bbox[i]);
    }
    return {id, x, y, url: `chunks/${id}.json`, buildingCount: chunk.buildings.length,
      area: roundArea(chunk.buildings.reduce((sum, b) => sum + b.area, 0)), bbox,
      bytes: encoder.encode(JSON.stringify(chunk)).byteLength};
  });
  return {chunks, index};
}

/**
 * @param {object|string} payload One bounded Overpass JSON response.
 * @param {{id:string,title:string,center:number[],arenaSize?:number}} sector
 * @param {{onProgress?:(progress:object)=>void, source?:object}} options
 */
export function normalizeOSMSector(payload, sector, {onProgress = () => {}, source: sourceInfo = {}} = {}) {
  const level = validateSector(sector);
  onProgress({stage: 'validate', progress: 0, message: 'Проверяем ответ OSM'});
  const {source, responseBytes} = parsePayload(payload);
  const stats = {invalidOrIncompleteBuilding: 0, boundaryExcluded: 0, subSquareMeterExcluded: 0,
    duplicateExcluded: 0, relationMemberExcluded: 0, buildingPartExcluded: 0};
  const prepared = prepareElements(source, stats);
  onProgress({stage: 'convert', progress: 0.15, message: 'Собираем контуры и внутренние дворы'});
  let converted;
  try { converted = osmtogeojson({elements: prepared.elements}, {flatProperties: false}); }
  catch { fail('GEOMETRY_CONVERSION_FAILED', 'Не удалось собрать геометрию OSM. Попробуй загрузить сектор заново.'); }
  const features = converted.features.filter((f) => ['way', 'relation'].includes(f.properties?.type))
    .sort((a, b) => Number(isPart(a.properties.tags)) - Number(isPart(b.properties.tags)) ||
      (a.properties.type === 'relation' ? 0 : 1) - (b.properties.type === 'relation' ? 0 : 1) || compare(a.id, b.id));
  const buildingGeometryKeys = new Set(), seen = new Set(), candidates = [];
  for (let i = 0; i < features.length; i++) {
    if (i % 250 === 0) onProgress({stage: 'buildings', progress: 0.25 + 0.45 * i / Math.max(1, features.length), message: 'Измеряем здания'});
    const feature = features[i], properties = feature.properties, tags = properties.tags || {};
    if (!isBuilding(tags) && !isPart(tags)) continue;
    const coordinates = canonicalPolygons(feature.geometry, level.center);
    if (properties.tainted || !coordinates || !allRelationRingsPreserved(feature, prepared)) { stats.invalidOrIncompleteBuilding++; continue; }
    buildingGeometryKeys.add(geometryKey({coordinates}));
    const normalized = normalizeFootprint(coordinates, level.center);
    if (normalized) buildingGeometryKeys.add(geometryKey(normalized.geometry));
    if (!isBuilding(tags)) continue;
    if (properties.type === 'way' && prepared.buildingMembers.has(String(properties.id))) { stats.relationMemberExcluded++; continue; }
    if (prepared.explicitParts.has(feature.id)) { stats.buildingPartExcluded++; continue; }
    const originalPolygons = toLocalPolygons(coordinates, level.center);
    // Holes are checked too, so malformed OSM cannot sneak outside via an inner ring.
    if (originalPolygons.some((polygon) => polygon.some((ring) => ring.some((p) => Math.abs(p[0]) > 5000 + BOUNDARY_EPSILON || Math.abs(p[1]) > 5000 + BOUNDARY_EPSILON)))) {
      stats.boundaryExcluded++; continue;
    }
    if (!normalized) { stats.invalidOrIncompleteBuilding++; continue; }
    const {geometry, polygons} = normalized;
    const key = geometryKey(geometry);
    buildingGeometryKeys.add(key);
    const bounds = getBounds(polygons), bbox = toBBox(bounds);
    const area = polygonsArea(polygons);
    if (area < 1) { stats.subSquareMeterExcluded++; continue; }
    if (seen.has(key)) { stats.duplicateExcluded++; continue; }
    seen.add(key);
    const circle = minimalEnclosingCircle(polygons);
    const building = {id: `${properties.type === 'relation' ? 'r' : 'w'}${properties.id}`, geometry, polygons,
      area: roundArea(area), center: circle.center, radius: circle.radius + ROUNDING_MARGIN, bbox,
      kind: tags.building};
    if (properties.meta?.version !== undefined) building.osmVersion = properties.meta.version;
    if (tags.name) building.name = tags.name;
    const height = heightFromTags(tags);
    if (height !== undefined) building.height = height;
    candidates.push({building, part: isPart(tags)});
  }
  // Building-part contours do not add a second reward over their parent.
  const parents = candidates.filter((c) => !c.part).map((c) => c.building);
  const parentCells = new Map();
  for (const parent of parents) {
    const minX = Math.floor((parent.bbox[0] + 5000) / CHUNK_SIZE), maxX = Math.floor((parent.bbox[2] + 5000) / CHUNK_SIZE);
    const minY = Math.floor((parent.bbox[1] + 5000) / CHUNK_SIZE), maxY = Math.floor((parent.bbox[3] + 5000) / CHUNK_SIZE);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = `${x}-${y}`;
      if (!parentCells.has(key)) parentCells.set(key, []);
      parentCells.get(key).push(parent);
    }
  }
  const buildings = candidates.filter(({building, part}) => {
    if (!part) return true;
    const key = `${Math.floor((building.center[0] + 5000) / CHUNK_SIZE)}-${Math.floor((building.center[1] + 5000) / CHUNK_SIZE)}`;
    if ((parentCells.get(key) || []).some((parent) => containedPart(building, parent))) { stats.buildingPartExcluded++; return false; }
    return true;
  }).map((candidate) => candidate.building).sort((a, b) => compare(a.id, b.id));
  if (buildings.length > OSM_IMPORT_LIMITS.maxBuildings) fail('TOO_MANY_BUILDINGS', 'В секторе больше 30 000 зданий. Выбери менее плотный сектор.');
  onProgress({stage: 'background', progress: 0.75, message: 'Готовим дороги, воду и парки'});
  const backgroundSeen = new Set(), backgroundFeatures = [];
  for (const feature of features) {
    const properties = feature.properties, tags = properties.tags || {};
    if (isBuilding(tags) || isPart(tags) || properties.tainted || !allRelationRingsPreserved(feature, prepared) || prepared.explicitParts.has(feature.id) ||
        (properties.type === 'way' && (prepared.buildingMembers.has(String(properties.id)) || prepared.backgroundMembers.has(String(properties.id))))) continue;
    const kind = backgroundKind(tags);
    if (!kind) continue;
    let geometry = canonicalBackgroundGeometry(feature.geometry, level.center);
    if (!geometry) continue;
    if (geometry.type === 'MultiPolygon' && buildingGeometryKeys.has(geometryKey(geometry))) continue;
    if (geometry.type === 'MultiPolygon') {
      const normalized = normalizeFootprint(geometry.coordinates, level.center);
      if (!normalized) continue;
      geometry = normalized.geometry;
      if (buildingGeometryKeys.has(geometryKey(geometry))) continue;
    }
    // A closed highway loop is still a road centreline, unless explicitly an area.
    if (kind.kindGroup === 'roads' && geometry.type === 'MultiPolygon' && tags.area !== 'yes') {
      geometry = {type: 'MultiLineString', coordinates: geometry.coordinates.map((polygon) => polygon[0])};
    }
    const rawKey = geometryKey(geometry), key = `${kind.kindGroup}:${geometry.type}:${rawKey}`;
    if ((geometry.type === 'MultiPolygon' && buildingGeometryKeys.has(rawKey)) || backgroundSeen.has(key)) continue;
    backgroundSeen.add(key);
    backgroundFeatures.push({type: 'Feature', id: `${properties.type === 'relation' ? 'r' : 'w'}${properties.id}`,
      properties: {...kind, ...(tags.name ? {name: tags.name} : {})}, geometry});
  }
  backgroundFeatures.sort((a, b) => compare(a.id, b.id) || compare(a.properties.kindGroup, b.properties.kindGroup));
  const background = {type: 'geojson', data: {type: 'FeatureCollection', features: backgroundFeatures}};
  const fingerprint = contentHash([PIPELINE_VERSION, {id: level.id, center: level.center, arenaSize: level.arenaSize},
    ...buildings.map((b) => [b.id, b.geometry, b.height ?? null]), ...backgroundFeatures]);
  const version = `osm-${PIPELINE_VERSION}-${fingerprint}`;
  const {chunks, index} = buildChunks(buildings, version);
  const southwest = localToLonLat([-5000, -5000], level.center), northeast = localToLonLat([5000, 5000], level.center);
  const bounds = [...southwest, ...northeast];
  const warnings = [];
  const minRadius = buildings.length ? buildings.reduce((minimum, building) => Math.min(minimum, building.radius), Infinity) : null;
  const initialEdibleBuildingCount = buildings.filter((building) => building.radius <= 18 * 1.06).length;
  const suggestedInitialRadius = minRadius === null ? null : Math.ceil(minRadius / 1.06 + 1);
  const suitability = buildings.length === 0
    ? {status: 'empty', message: 'В этом секторе нет полных пригодных контуров зданий OSM. Выбери соседний сектор.'}
    : buildings.length < 100
      ? {status: 'sparse', message: `Мало зданий OSM: ${buildings.length}. Карта может быть слишком пустой для игры.`}
      : {status: 'ready', message: null};
  Object.assign(suitability, {minRadius, initialEdibleBuildingCount, suggestedInitialRadius});
  if (suitability.message) warnings.push(suitability.message);
  if (buildings.length && initialEdibleBuildingCount === 0) {
    warnings.push(`Для начального радиуса 18 м нет подходящих зданий. Для этого сектора можно выбрать начальный радиус ${suggestedInitialRadius} м.`);
  }
  if (stats.invalidOrIncompleteBuilding) warnings.push(`Пропущено неполных или некорректных контуров зданий: ${stats.invalidOrIncompleteBuilding}.`);
  const sourceTimestamp = typeof source.osm3s?.timestamp_osm_base === 'string' ? source.osm3s.timestamp_osm_base : null;
  const manifest = {...level, version, chunkSize: CHUNK_SIZE,
    totalBuildingArea: roundArea(buildings.reduce((sum, b) => sum + b.area, 0)), buildingCount: buildings.length,
    spawn: [0, 0], initialRadius: 18, targetPercent: 80, chunks: index, bounds,
    projection: {type: 'local-equirectangular', radius: 6378137, origin: [...level.center], units: 'meters', x: 'east', y: 'north'},
    attribution: COPYRIGHT, license: 'ODbL-1.0', licenseUrl: LICENSE_URL, sourceTimestamp,
    sourceUrl: typeof sourceInfo.endpoint === 'string' ? sourceInfo.endpoint : 'https://www.openstreetmap.org/',
    warnings, suitability};
  const provenance = {source: 'OpenStreetMap', sourceFormat: 'Overpass JSON',
    ...(typeof sourceInfo.endpoint === 'string' ? {endpoint: sourceInfo.endpoint} : {}),
    ...(typeof sourceInfo.downloadedAt === 'string' ? {downloadedAt: sourceInfo.downloadedAt} : {}),
    generator: typeof source.generator === 'string' ? source.generator : null,
    osmTimestamp: sourceTimestamp, datasetVersion: version, geometryHash: fingerprint,
    hashAlgorithm: 'deterministic-128-bit-content-fingerprint', responseBytes, sourceElements: source.elements.length,
    license: 'ODbL-1.0', copyright: COPYRIGHT, copyrightUrl: COPYRIGHT_URL, licenseUrl: LICENSE_URL,
    pipeline: PIPELINE_VERSION, arenaBounds: bounds,
    metrics: {buildingCount: buildings.length, totalArea: manifest.totalBuildingArea, chunks: index.length,
      minRadius, initialEdibleBuildingCount, suggestedInitialRadius,
      backgroundLayers: {roads: 0, water: 0, parks: 0}, excluded: stats},
    normalization: [
      'Only complete real OSM building contours inside the 10 km metric arena are eligible; no synthetic objects are added.',
      'Multipolygon relations retain courtyard holes and supersede member ways; identical outlines and contained building parts are excluded.',
      'Overlapping real components are unioned before area calculation; invalid or missing courtyard rings are rejected.',
      'Polygon coordinates use R=6378137 local equirectangular metres, x east and y north; areas subtract holes.',
      'Every footprint uses its minimum enclosing circle with an additional 5 mm conservative radius margin.',
      'Background contains only real OSM roads, water and green spaces; building footprints are never baked into it.',
      'OSM building:levels, when used, estimates height at 3 metres per level.',
    ], warnings: [...warnings]};
  for (const feature of backgroundFeatures) provenance.metrics.backgroundLayers[feature.properties.kindGroup]++;
  onProgress({stage: 'complete', progress: 1, message: 'Сектор готов', buildingCount: buildings.length});
  return {manifest, chunks, background, provenance};
}

export default normalizeOSMSector;
