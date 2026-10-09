import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOSMSector, OSM_IMPORT_LIMITS, OSMImportError} from '../src/osm-import.js';
import {localToLonLat, polygonsArea, minimalEnclosingCircle} from '../src/geometry.js';

// Tiny artificial OSM records are test fixtures only. Runtime never invents
// replacement footprints, roads, trees or other rewards.
const sector = {id: 'fixture-sector', title: 'OSM test fixture', center: [30, 60], arenaSize: 10000};
const rectangle = (left, bottom, right, top) => [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]];
const geometry = (points) => points.map((point) => {
  const [lon, lat] = localToLonLat(point, sector.center);
  return {lon, lat};
});
const way = (id, points, tags = {building: 'yes'}) => ({type: 'way', id, tags, geometry: geometry(points)});
const member = (ref, points, role = 'outer') => ({type: 'way', ref, role, geometry: geometry(points)});
const relation = (id, members, tags = {type: 'multipolygon', building: 'yes'}) => ({type: 'relation', id, tags, members});
const payload = (elements) => ({version: 0.6, generator: 'Fixture Overpass JSON', osm3s: {timestamp_osm_base: '2026-10-09T11:00:00Z'}, elements});
const buildingsOf = (result) => Object.values(result.chunks).flatMap((chunk) => chunk.buildings);
const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const errorCode = (code) => (error) => error instanceof OSMImportError && error.code === code;

test('way footprints keep OSM IDs, exact metre area, north-up projection and conservative MEC', () => {
  const result = normalizeOSMSector(payload([way(123, rectangle(-10, -5, 10, 5))]), sector);
  const [building] = buildingsOf(result);
  assert.equal(building.id, 'w123');
  assert.equal(building.geometry.type, 'MultiPolygon');
  assert.equal(building.polygons.length, 1);
  assert.equal(building.polygons[0].length, 1);
  near(building.area, 200);
  near(polygonsArea(building.polygons), 200);
  near(building.center[0], 0);
  near(building.center[1], 0);
  near(building.radius, Math.hypot(10, 5) + 0.005);
  near(building.radius - minimalEnclosingCircle(building.polygons).radius, 0.005, 1e-12);
  assert.equal(result.manifest.projection.radius, 6378137);
  assert.equal(result.manifest.projection.y, 'north');
  assert.equal(result.manifest.initialRadius, 18);
  assert.equal(result.manifest.totalBuildingArea, 200);
  assert.equal(result.manifest.pmtiles, undefined);
});

test('multipolygon relations retain every component and courtyard and suppress member ways', () => {
  const outer = rectangle(-30, -30, 30, 30), inner = rectangle(-10, -10, 10, 10), second = rectangle(100, 100, 110, 110);
  const source = payload([
    way(1, outer), way(2, inner), way(3, second),
    relation(99, [member(1, outer), member(2, inner, 'inner'), member(3, second)]),
  ]);
  const result = normalizeOSMSector(source, sector);
  const [building] = buildingsOf(result);
  assert.equal(result.manifest.buildingCount, 1);
  assert.equal(building.id, 'r99');
  assert.equal(building.polygons.length, 2);
  assert.equal(building.polygons.reduce((count, p) => count + p.length - 1, 0), 1);
  near(building.area, 3300);
  near(result.manifest.totalBuildingArea, 3300);
  assert.deepEqual(source.elements[3].members.map((m) => m.ref), [1, 2, 3], 'input members must not be mutated');
});

test('relations stitch split and reversed outer and inner ways', () => {
  const outer = rectangle(0, 0, 40, 40), inner = rectangle(10, 10, 30, 30);
  const result = normalizeOSMSector(payload([relation(20, [
    member(1, outer.slice(0, 3)), member(2, outer.slice(2).reverse()),
    member(3, inner.slice(0, 3), 'inner'), member(4, inner.slice(2).reverse(), 'inner'),
  ])]), sector);
  const [building] = buildingsOf(result);
  assert.equal(building.id, 'r20');
  assert.equal(building.polygons[0].length, 2);
  near(building.area, 1200);
});

test('overlapping multipolygon outers are unioned before calculating reward area', () => {
  const result = normalizeOSMSector(payload([relation(1, [
    member(2, rectangle(0, 0, 10, 10)), member(3, rectangle(5, 0, 15, 10)),
  ])]), sector);
  assert.equal(result.manifest.buildingCount, 1);
  const [building] = buildingsOf(result);
  near(building.area, 150);
  near(polygonsArea(building.polygons), 150);
  assert.equal(building.polygons.length, 1);
  assert.equal(result.manifest.totalBuildingArea, 150);
});

test('collinear outline vertices do not create duplicate buildings', () => {
  const result = normalizeOSMSector(payload([
    way(1, rectangle(0, 0, 10, 10)),
    way(2, [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [0, 10], [0, 0]]),
  ]), sector);
  assert.equal(result.manifest.buildingCount, 1);
  assert.equal(result.manifest.totalBuildingArea, 100);
});

test('traditional node-reference responses and legacy multipolygon tags work', () => {
  const outer = rectangle(0, 0, 40, 40), inner = rectangle(10, 10, 30, 30);
  const nodes = [...geometry(outer.slice(0, 4)), ...geometry(inner.slice(0, 4))].map((p, i) => ({type: 'node', id: i + 1, ...p}));
  const result = normalizeOSMSector(payload([...nodes,
    {type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: {building: 'yes'}},
    {type: 'way', id: 11, nodes: [5, 6, 7, 8, 5]},
    relation(50, [{type: 'way', ref: 10, role: 'outer'}, {type: 'way', ref: 11, role: 'inner'}], {type: 'multipolygon'}),
  ]), sector);
  assert.deepEqual(buildingsOf(result).map((b) => b.id), ['r50']);
  near(buildingsOf(result)[0].area, 1200);
});

test('full-geometry member ways without top-level records use relation IDs', () => {
  const result = normalizeOSMSector(payload([relation(900, [member(901, rectangle(0, 0, 10, 20))])]), sector);
  assert.deepEqual(buildingsOf(result).map((b) => b.id), ['r900']);
  assert.equal(result.manifest.totalBuildingArea, 200);
});

test('whole footprints crossing any arena edge are excluded, not clipped', () => {
  const result = normalizeOSMSector(payload([
    way(1, rectangle(4990, 0, 5010, 10)), way(2, rectangle(-5010, 0, -4990, 10)),
    way(3, rectangle(0, 4990, 10, 5010)), way(4, rectangle(0, -5010, 10, -4990)),
    way(5, rectangle(4990, 4990, 5000, 5000)),
  ]), sector);
  assert.deepEqual(buildingsOf(result).map((b) => b.id), ['w5']);
  assert.equal(result.provenance.metrics.excluded.boundaryExcluded, 4);
  assert.deepEqual(result.manifest.chunks.map((c) => [c.x, c.y]), [[9, 9]]);
});

test('an outside component excludes the entire multipolygon and every member', () => {
  const inside = rectangle(0, 0, 10, 10), outside = rectangle(4995, 0, 5015, 10);
  const result = normalizeOSMSector(payload([way(1, inside), way(2, outside), relation(9, [member(1, inside), member(2, outside)])]), sector);
  assert.equal(result.manifest.buildingCount, 0);
  assert.equal(result.provenance.metrics.excluded.boundaryExcluded, 1);
});

test('deduplication ignores ring start and winding while preferring relation outlines', () => {
  const ring = rectangle(0, 0, 20, 20), shifted = [...ring.slice(2, -1), ...ring.slice(0, 3)];
  const result = normalizeOSMSector(payload([
    way(40, ring), way(30, [...ring].reverse()), way(20, shifted), relation(10, [member(41, ring)]),
  ]), sector);
  assert.deepEqual(buildingsOf(result).map((b) => b.id), ['r10']);
  assert.equal(result.provenance.metrics.excluded.duplicateExcluded, 3);
});

test('building parts covered by their parent do not receive a second area reward', () => {
  const result = normalizeOSMSector(payload([
    way(1, rectangle(0, 0, 40, 40)),
    way(2, rectangle(10, 10, 20, 20), {building: 'yes', 'building:part': 'yes'}),
    way(3, rectangle(100, 0, 110, 10), {building: 'yes', 'building:part': 'yes'}),
    way(4, rectangle(200, 0, 210, 10), {'building:part': 'yes'}),
  ]), sector);
  assert.deepEqual(buildingsOf(result).map((b) => b.id), ['w1', 'w3']);
  assert.equal(result.manifest.totalBuildingArea, 1700);
  assert.equal(result.provenance.metrics.excluded.buildingPartExcluded, 1);
});

test('type=building part memberships suppress duplicates explicitly', () => {
  const result = normalizeOSMSector(payload([
    way(1, rectangle(0, 0, 40, 40)), way(2, rectangle(10, 10, 20, 20)),
    relation(10, [{type: 'way', ref: 1, role: 'outline'}, {type: 'way', ref: 2, role: 'part'}], {type: 'building'}),
  ]), sector);
  assert.deepEqual(buildingsOf(result).map((b) => b.id), ['w1']);
});

test('chunk assignment uses centres while metadata bounds cover the entire geometry', () => {
  const result = normalizeOSMSector(payload([
    way(1, rectangle(900, 20, 1300, 50)), way(2, rectangle(-4990, -4980, -4970, -4960)),
  ]), sector);
  const northeast = result.manifest.chunks.find((c) => c.id === '6-5');
  assert.ok(northeast);
  near(northeast.bbox[0], 900);
  near(northeast.bbox[2], 1300);
  assert.equal(northeast.area, 12000);
  assert.ok(northeast.bytes > 0);
  assert.ok(result.chunks['0-0']);
  for (const chunk of Object.values(result.chunks)) assert.equal(chunk.version, result.manifest.version);
});

test('dataset versions are deterministic for element order and winding, and change with geometry or sector', () => {
  const a = way(1, rectangle(0, 0, 10, 10)), b = way(2, rectangle(100, 100, 110, 110));
  const first = normalizeOSMSector(payload([a, b]), sector);
  const reordered = normalizeOSMSector(payload([{...b, geometry: [...b.geometry].reverse()}, a]), sector);
  assert.equal(first.manifest.version, reordered.manifest.version);
  assert.equal(first.manifest.version, normalizeOSMSector(JSON.stringify(payload([a, b])), sector).manifest.version);
  assert.notEqual(first.manifest.version, normalizeOSMSector(payload([a, way(2, rectangle(100, 100, 111, 110))]), sector).manifest.version);
  assert.notEqual(first.manifest.version, normalizeOSMSector(payload([a, b]), {...sector, id: 'other'}).manifest.version);
  assert.notEqual(first.manifest.version, normalizeOSMSector(payload([a, b]), {...sector, center: [30.0001, 60]}).manifest.version);
  assert.equal(first.manifest.version, first.provenance.datasetVersion);
  assert.equal(first.manifest.version, normalizeOSMSector(payload([a, b]), {...sector, title: 'A display-only rename'}).manifest.version);
});

test('background is real roads/water/parks with actual tag kinds, never building footprints', () => {
  const building = rectangle(0, 0, 20, 20);
  const result = normalizeOSMSector(payload([
    way(1, building, {building: 'yes', leisure: 'park'}),
    way(2, rectangle(10, 10, 15, 15), {'building:part': 'yes', leisure: 'garden'}),
    way(3, [[0, 100], [100, 100]], {highway: 'residential'}),
    way(4, rectangle(200, 200, 300, 300), {natural: 'water', water: 'pond'}),
    way(5, rectangle(400, 400, 500, 500), {leisure: 'park'}),
    way(6, [[0, 700], [700, 800]], {waterway: 'stream'}),
    way(7, building, {leisure: 'park'}),
  ]), sector);
  assert.equal(result.background.type, 'geojson');
  assert.equal(result.background.data.type, 'FeatureCollection');
  const features = result.background.data.features;
  assert.deepEqual(features.map((f) => [f.id, f.properties.kindGroup, f.properties.kind]), [
    ['w3', 'roads', 'residential'], ['w4', 'water', 'pond'], ['w5', 'parks', 'park'], ['w6', 'water', 'stream'],
  ]);
  assert.equal(features.find((f) => f.id === 'w6').geometry.type, 'LineString');
  assert.ok(features.every((f) => !('building' in f.properties) && !('building:part' in f.properties)));
});

test('background multipolygon water relations retain islands and do not duplicate member outlines', () => {
  const outer = rectangle(0, 0, 100, 100), inner = rectangle(20, 20, 30, 30);
  const result = normalizeOSMSector(payload([
    way(1, outer, {natural: 'water'}),
    relation(2, [member(1, outer), member(3, inner, 'inner')], {type: 'multipolygon', natural: 'water'}),
  ]), sector);
  assert.equal(result.background.data.features.length, 1);
  assert.equal(result.background.data.features[0].geometry.coordinates[0].length, 2);
});

test('background outline aliases cannot rebake buildings or parts via extra collinear vertices', () => {
  const result = normalizeOSMSector(payload([
    way(1, rectangle(0, 0, 10, 10)),
    way(2, [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [0, 0]], {leisure: 'park'}),
    way(3, rectangle(100, 100, 110, 110), {'building:part': 'yes'}),
    way(4, [[100, 100], [105, 100], [110, 100], [110, 110], [100, 110], [100, 100]], {leisure: 'garden'}),
  ]), sector);
  assert.deepEqual(result.background.data.features, []);
  assert.equal(result.manifest.buildingCount, 1);
});

test('empty and sparse sectors have honest suitability warnings without invented additions', () => {
  const empty = normalizeOSMSector(payload([]), sector);
  assert.equal(empty.manifest.buildingCount, 0);
  assert.equal(empty.manifest.totalBuildingArea, 0);
  assert.deepEqual(empty.manifest.chunks, []);
  assert.deepEqual(empty.chunks, {});
  assert.deepEqual(empty.background.data.features, []);
  assert.equal(empty.manifest.suitability.status, 'empty');
  assert.equal(empty.manifest.suitability.minRadius, null);
  assert.equal(empty.manifest.suitability.initialEdibleBuildingCount, 0);
  assert.equal(empty.manifest.suitability.suggestedInitialRadius, null);
  assert.ok(empty.manifest.warnings.length);
  const sparse = normalizeOSMSector(payload([way(1, rectangle(0, 0, 5, 5))]), sector);
  assert.equal(sparse.manifest.suitability.status, 'sparse');
  assert.equal(sparse.manifest.buildingCount, 1);
});

test('unsuitable starting geometry is diagnosed without silently changing the 18m default', () => {
  const result = normalizeOSMSector(payload([way(1, rectangle(-50, -50, 50, 50))]), sector);
  const metrics = result.manifest.suitability;
  near(metrics.minRadius, Math.hypot(50, 50) + 0.005);
  assert.equal(metrics.initialEdibleBuildingCount, 0);
  assert.equal(metrics.suggestedInitialRadius, Math.ceil(metrics.minRadius / 1.06 + 1));
  assert.equal(result.manifest.initialRadius, 18);
  assert.equal(result.provenance.metrics.initialEdibleBuildingCount, 0);
  assert.ok(result.manifest.warnings.some((warning) => warning.includes('18 м')));
  const mixed = normalizeOSMSector(payload([
    way(1, rectangle(-50, -50, 50, 50)), way(2, rectangle(100, 100, 105, 105)),
  ]), sector);
  assert.equal(mixed.manifest.suitability.initialEdibleBuildingCount, 1);
});

test('metadata identifies real OSM source without fabricating fetch dates or versions', () => {
  const result = normalizeOSMSector(payload([way(1, rectangle(0, 0, 5, 5), {building: 'house', 'building:levels': '3'})]), sector,
    {source: {endpoint: 'https://example.test/overpass', downloadedAt: '2026-10-09T12:00:00Z'}});
  assert.equal(result.manifest.sourceTimestamp, '2026-10-09T11:00:00Z');
  assert.equal(result.manifest.sourceUrl, 'https://example.test/overpass');
  assert.equal(result.provenance.generator, 'Fixture Overpass JSON');
  assert.equal(result.provenance.downloadedAt, '2026-10-09T12:00:00Z');
  assert.equal(result.provenance.license, 'ODbL-1.0');
  assert.equal(buildingsOf(result)[0].height, 9);
  assert.equal(buildingsOf(result)[0].osmVersion, undefined);
  const missing = normalizeOSMSector({elements: []}, sector);
  assert.equal(missing.manifest.sourceTimestamp, null);
  assert.equal(missing.provenance.downloadedAt, undefined);
});

test('missing nodes, unclosed ways, incomplete relation holes and bounds-only geometry are never invented', () => {
  const outer = rectangle(0, 0, 40, 40), inner = rectangle(10, 10, 20, 20);
  const result = normalizeOSMSector(payload([
    way(1, outer.slice(0, -1)),
    {type: 'way', id: 2, tags: {building: 'yes'}, nodes: [1, 2, 3, 1]},
    {type: 'way', id: 3, tags: {building: 'yes'}, bounds: {minlon: 30, minlat: 60, maxlon: 30.001, maxlat: 60.001}},
    relation(4, [member(5, outer), member(6, inner.slice(0, 3), 'inner')]),
    way(7, [[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]),
  ]), sector);
  assert.equal(result.manifest.buildingCount, 0);
  assert.deepEqual(result.background.data.features, []);
  assert.ok(result.provenance.metrics.excluded.invalidOrIncompleteBuilding > 0);
});

test('orphan inner rings are rejected rather than silently filling the courtyard', () => {
  const result = normalizeOSMSector(payload([
    relation(1, [member(2, rectangle(0, 0, 20, 20)), member(3, rectangle(100, 100, 110, 110), 'inner')]),
  ]), sector);
  assert.equal(result.manifest.buildingCount, 0);
  assert.equal(result.provenance.metrics.excluded.invalidOrIncompleteBuilding, 1);
  assert.ok(result.manifest.warnings.some((warning) => warning.includes('некорректных')));
});

test('partly exterior courtyards are rejected rather than clipped into a different outline', () => {
  const result = normalizeOSMSector(payload([
    relation(1, [member(2, rectangle(0, 0, 20, 20)), member(3, rectangle(10, 10, 30, 30), 'inner')]),
  ]), sector);
  assert.equal(result.manifest.buildingCount, 0);
  assert.equal(result.provenance.metrics.excluded.invalidOrIncompleteBuilding, 1);
});

test('JSON-only validation, Overpass partial failure and hard size guards produce clear codes', () => {
  assert.throws(() => normalizeOSMSector('<osm></osm>', sector), errorCode('INVALID_OSM'));
  assert.throws(() => normalizeOSMSector({}, sector), errorCode('INVALID_OSM'));
  assert.throws(() => normalizeOSMSector({elements: [], remark: 'runtime error: Query timed out'}, sector), errorCode('INCOMPLETE_RESPONSE'));
  assert.throws(() => normalizeOSMSector({elements: new Array(OSM_IMPORT_LIMITS.maxElements + 1)}, sector), errorCode('TOO_MANY_ELEMENTS'));
  assert.throws(() => normalizeOSMSector(' '.repeat(OSM_IMPORT_LIMITS.maxResponseBytes + 1), sector), errorCode('RESPONSE_TOO_LARGE'));
  const excessive = Array.from({length: OSM_IMPORT_LIMITS.maxBuildings + 1}, (_, i) => ({type: 'way', id: i + 1, tags: {building: 'yes'}}));
  assert.throws(() => normalizeOSMSector(payload(excessive), sector), errorCode('TOO_MANY_BUILDINGS'));
  assert.throws(() => normalizeOSMSector(payload([]), {...sector, arenaSize: 5000}), errorCode('INVALID_SECTOR'));
  assert.throws(() => normalizeOSMSector(payload([]), {...sector, center: [0, 90]}), errorCode('INVALID_SECTOR'));
});

test('progress is monotonic and the converter never mutates its input', () => {
  const source = payload([relation(1, [member(2, rectangle(0, 0, 20, 20))])]);
  const before = JSON.stringify(source), progress = [];
  normalizeOSMSector(source, sector, {onProgress: (p) => progress.push(p)});
  assert.equal(JSON.stringify(source), before);
  assert.equal(progress[0].progress, 0);
  assert.equal(progress.at(-1).progress, 1);
  assert.ok(progress.every((p, i) => !i || p.progress >= progress[i - 1].progress));
});

test('worker protocol reports progress, results, errors and echoes request IDs', async () => {
  let listener;
  const sent = [];
  const previous = globalThis.self;
  globalThis.self = {addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; }, postMessage(message) { sent.push(message); }};
  try {
    await import(`../src/osm-import.worker.js?fixture=${Date.now()}`);
    listener({data: {type: 'normalize', requestId: 'fixture', payload: payload([]), sector}});
    assert.ok(sent.some((message) => message.type === 'progress'));
    const result = sent.find((message) => message.type === 'result');
    assert.equal(result.requestId, 'fixture');
    assert.equal(result.result.manifest.suitability.status, 'empty');
    sent.length = 0;
    listener({data: {type: 'normalize', requestId: 'bad', payload: {}, sector}});
    assert.equal(sent.at(-1).type, 'error');
    assert.equal(sent.at(-1).requestId, 'bad');
    assert.equal(sent.at(-1).error.code, 'INVALID_OSM');
    assert.equal(typeof sent.at(-1).error.message, 'string');
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});
