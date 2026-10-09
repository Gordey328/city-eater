import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCampaign, deriveManualBounds, makeSectorQuery, coverageDimensions } from '../src/city-campaign.js';
import {
  MAP_GRID_VERSION, MAP_MAX_LATITUDE, MAX_VISIBLE_MAP_CELLS,
  getMapCellAt, getVisibleMapCells, nearestMapCell, cellContainsCoordinate,
  makeMapCellCampaign, mapCellBounds, mapCellFeature,
} from '../src/map-cells.js';

const R = 6378137, DEG = Math.PI / 180;
const step = 5000 / (R * DEG);
const wrapped = longitude => ((longitude + 180) % 360 + 360) % 360 - 180;
const metricPoint = (point, cell) => [
  wrapped(point[0] - cell.center[0]) * R * DEG * Math.cos(cell.projectionLatitude * DEG),
  (point[1] - cell.center[1]) * R * DEG,
];

test('global cell identities and geometry do not depend on pan, zoom, title, or longitude world copy', () => {
  const point = [30.4158, 59.7229], cell = getMapCellAt(point);
  for (const delta of [-720, -360, 0, 360, 720]) assert.deepEqual(getMapCellAt([point[0] + delta, point[1]]), cell);
  const a = getVisibleMapCells([30.3, 59.6, 30.6, 59.9]);
  const b = getVisibleMapCells([30.4, 59.7, 30.5, 59.8]);
  assert.deepEqual(a.cells.find(item => item.id === cell.id), cell);
  assert.deepEqual(b.cells.find(item => item.id === cell.id), cell);
  const one = makeMapCellCampaign(cell, { title: 'Пушкин' });
  const two = makeMapCellCampaign(cell, { title: 'Другое название' });
  assert.equal(one.id, two.id);
  assert.equal(one.sectors[0].id, two.sectors[0].id);
  assert.deepEqual(one.bounds, two.bounds);
  assert.equal(one.projectionLatitude, two.projectionLatitude);
});

test('every latitude row has exact 5000-metre arena bounds and a finite local basis', () => {
  for (let latitude = -MAP_MAX_LATITUDE + step / 2; latitude < MAP_MAX_LATITUDE; latitude += step) {
    const cell = getMapCellAt([73.12456, latitude]);
    assert.ok(cell);
    assert.ok(Number.isFinite(cell.projectionLatitude));
    const sw = metricPoint(cell.bounds.slice(0, 2), cell), ne = metricPoint(cell.bounds.slice(2), cell);
    for (const [actual, expected] of [[sw[0], -2500], [sw[1], -2500], [ne[0], 2500], [ne[1], 2500]]) assert.ok(Math.abs(actual - expected) < 1e-6, `${latitude}: ${actual}`);
    const actualLocalWidth = (cell.bounds[2] - cell.bounds[0]) * R * DEG * Math.cos(cell.center[1] * DEG);
    assert.ok(Math.abs(actualLocalWidth / 5000 - 1) < 0.0015, `${latitude}: local distortion too high`);
  }
  assert.notEqual(getMapCellAt([0, 0]).projectionLatitude, getMapCellAt([0, 59]).projectionLatitude);
});

test('equatorial integer column basis never feeds acos a value above one', () => {
  for (const latitude of [-step / 2, -1e-9, 0, 1e-9, step / 2]) {
    const cell = getMapCellAt([0, latitude]);
    assert.ok(Number.isFinite(cell.projectionLatitude));
    assert.ok(Math.abs(cell.projectionLatitude) < 2);
    assert.equal(cell.arenaSize,5000);
  }
});

test('longitude rows close at the date line with no partial or overlapping cells', () => {
  for (const latitude of [-84.8, -78, -35, 0, 59, 78, 84.8]) {
    const first = getMapCellAt([-180, latitude]);
    const last = getMapCellAt([180 - 1e-7, latitude]);
    assert.equal(first.bounds[0], -180);
    assert.equal(last.bounds[2], 180);
    assert.deepEqual(getMapCellAt([180, latitude]), first);
    assert.deepEqual(getMapCellAt([-540, latitude]), first);
    assert.equal(cellContainsCoordinate(last, [-180, latitude]), false);
    assert.equal(cellContainsCoordinate(first, [180, latitude]), true);
    const width = first.bounds[2] - first.bounds[0];
    assert.ok(Math.abs(width * (last.gridColumn + 1) - 360) < 1e-9);
  }
});

test('exact shared edges belong to one cell and selection agrees with containment', () => {
  for (const point of [[0, 0], [30, 59], [160, -35], [-179.9, 84.8], [-149.4571343814892, -32.743592106156555]]) {
    const cell = getMapCellAt(point), [w, s, e, n] = cell.bounds;
    assert.equal(cellContainsCoordinate(cell, [w, s]), true);
    assert.equal(getMapCellAt([w, s]).id, cell.id);
    assert.equal(cellContainsCoordinate(cell, [e, cell.center[1]]), false);
    assert.notEqual(getMapCellAt([e, cell.center[1]]).id, cell.id);
    assert.equal(cellContainsCoordinate(cell, [cell.center[0], n]), false);
    if (n < MAP_MAX_LATITUDE) assert.notEqual(getMapCellAt([cell.center[0], n]).id, cell.id);
    assert.ok(cellContainsCoordinate(cell, cell.center));
  }
});

test('canonical owner contains the selected point even at equivalent wrapped shared edges', () => {
  const points = [[-149.4571343814892, -32.743592106156555]];
  for (let row = -940; row <= 940; row += 17) {
    const cell = getMapCellAt([row * 7.371, (row + 0.5) * step]);
    points.push([cell.bounds[0], cell.bounds[1]], [cell.bounds[2], cell.center[1]]);
  }
  for (const [longitude, latitude] of points) for (const world of [-360, 0, 360]) {
    const point = [longitude + world, latitude], owner = getMapCellAt(point);
    assert.ok(owner && cellContainsCoordinate(owner, point), `${point}: canonical owner does not contain point`);
  }
});

test('viewport selection is finite and all-or-none, with no arbitrary coarse sample', () => {
  const world = getVisibleMapCells([-180, -90, 180, 90]);
  assert.equal(world.tooDense, true);
  assert.equal(world.cells.length, 0);
  assert.ok(world.totalCount > 1000000 && world.totalCount < 30000000);
  const city = getVisibleMapCells([30.1, 59.5, 30.9, 60]);
  assert.equal(city.tooDense, false);
  assert.equal(city.totalCount, city.cells.length);
  assert.ok(city.totalCount > 1 && city.totalCount <= MAX_VISIBLE_MAP_CELLS);
  assert.equal(new Set(city.cells.map(cell => cell.id)).size, city.cells.length);
  const limited = getVisibleMapCells([30.1, 59.5, 30.9, 60], { maxCells: 1 });
  assert.equal(limited.tooDense, true);
  assert.equal(limited.totalCount, city.totalCount);
  assert.deepEqual(limited.cells, []);
  for (const maxCells of [0, -1, 1.5, Infinity, 10001]) assert.throws(() => getVisibleMapCells([0, 0, 1, 1], { maxCells }));
});

test('wrapped, unwrapped, and repeated-world viewports return identical cells', () => {
  const canonical = getVisibleMapCells([179.8, -16.2, -179.8, -15.8]);
  assert.deepEqual(getVisibleMapCells([179.8, -16.2, 180.2, -15.8]), canonical);
  assert.deepEqual(getVisibleMapCells([-180.2, -16.2, -179.8, -15.8]), canonical);
  assert.deepEqual(getVisibleMapCells([539.8, -16.2, 540.2, -15.8]), canonical);
  assert.ok(canonical.cells.some(cell => cell.center[0] < 0));
  assert.ok(canonical.cells.some(cell => cell.center[0] > 0));
  assert.equal(new Set(canonical.cells.map(cell => cell.id)).size, canonical.cells.length);
  const world = getVisibleMapCells([-180, -1, 180, 1]);
  assert.deepEqual(getVisibleMapCells([-540, -1, 540, 1]), world);
});

test('a cell-sized viewport contains exactly that cell, not rows of floating-point slivers', () => {
  for (const point of [[30, 59], [-73.9, 40.7], [139.7, 35.7], [0, 0], [179.99, -16], [-179.99, 84.8]]) {
    const cell = getMapCellAt(point);
    const view = getVisibleMapCells(cell.bounds);
    assert.equal(view.totalCount, 1, JSON.stringify(cell.bounds));
    assert.equal(view.cells[0].id, cell.id);
  }
});

test('polar caps are explicitly unselectable, while nearest and viewport behavior remain bounded', () => {
  assert.ok(getMapCellAt([0, -MAP_MAX_LATITUDE]));
  assert.equal(getMapCellAt([0, MAP_MAX_LATITUDE]), null);
  for (const latitude of [-90, -84.9, 84.9, 90]) {
    assert.equal(getMapCellAt([0, latitude]), null);
    const nearest = nearestMapCell([0, latitude]);
    assert.ok(nearest);
    assert.equal(nearest.arenaSize,5000);
  }
  assert.deepEqual(getVisibleMapCells([-10, 85, 10, 90]), { cells: [], tooDense: false, totalCount: 0 });
});

test('invalid points and viewports fail fast without coercion or unbounded loops', () => {
  for (const point of [null, [0], [0, 0, 0], ['0', 0], [NaN, 0], [0, Infinity], [0, 90.1]]) {
    assert.throws(() => getMapCellAt(point));
    assert.throws(() => nearestMapCell(point));
  }
  for (const bounds of [null, [], [0, 0, 1], [0, 0, 1, NaN], [0, 1, 1, 0], [0, -91, 1, 0], [0, 0, 0, 1]]) assert.throws(() => getVisibleMapCells(bounds));
  assert.throws(() => getMapCellAt([0, 0], { campaign: {} }));
  assert.throws(() => getVisibleMapCells([0, 0, 1, 1], { campaign: { sectors: Array(10001) } }));
});

test('saved campaigns keep IDs, sector references, order, geometry, progress and metre basis verbatim', () => {
  const campaign = makeCampaign({ title: 'Saved city', center: [30, 60], bounds: deriveManualBounds([30, 60], 20, 20) });
  campaign.progress = { [campaign.sectors[0].id]: { completed: true } };
  const original = structuredClone(campaign);
  const view = getVisibleMapCells([29, 59, 31, 61], { campaign });
  assert.equal(view.totalCount, 4);
  for (const sector of campaign.sectors) {
    assert.equal(getMapCellAt(sector.center, { campaign }), sector);
    assert.equal(view.cells.find(cell => cell.id === sector.id), sector);
    assert.equal(nearestMapCell(sector.center, { campaign }), sector);
  }
  assert.equal(getMapCellAt([0, 0], { campaign }), null);
  assert.ok(nearestMapCell([0, 0], { campaign }));
  assert.deepEqual(campaign, original);
});

test('centre-only legacy saved sectors remain readable and selectable without mutation', () => {
  const sector = { id: 'old/s0-0', center: [179.99, 60], arenaSize: 10000 };
  const campaign = { id: 'old', sectors: [sector] }, original = structuredClone(campaign);
  assert.equal(getMapCellAt([179.99, 60], { campaign }), sector);
  assert.equal(getMapCellAt([-179.99, 60], { campaign }), sector);
  assert.equal(getVisibleMapCells([179.8, 59.9, -179.8, 60.1], { campaign }).cells[0], sector);
  assert.equal(mapCellFeature(sector).geometry.type, 'MultiPolygon');
  assert.deepEqual(campaign, original);
});

test('empty campaign stays empty and nearest does not silently fall back to global cells', () => {
  const campaign = { sectors: [] };
  assert.equal(getMapCellAt([0, 0], { campaign }), null);
  assert.equal(nearestMapCell([0, 0], { campaign }), null);
  assert.deepEqual(getVisibleMapCells([-180, -90, 180, 90], { campaign }), { cells: [], tooDense: false, totalCount: 0 });
});

test('new map campaigns are complete single arenas with exact5km dimensions and new identities', () => {
  for (const point of [[0, 0], [30.4, 59.7], [179.999, 60], [-179.999, -16], [10, 84.8]]) {
    const cell = getMapCellAt(point), campaign = makeMapCellCampaign(cell, { title: '  Selected square  ' });
    assert.equal(campaign.id, cell.campaignId);
    assert.equal(campaign.gridVersion, MAP_GRID_VERSION);
    assert.equal(campaign.title, 'Selected square');
    assert.equal(campaign.sectorCount, 1);
    assert.equal(campaign.rows, 1);
    assert.equal(campaign.columns, 1);
    assert.equal(campaign.source, 'manual');
    assert.equal(campaign.extentLabel, 'Район, выбранный на карте');
    assert.equal(campaign.boundaryIsPolygon, false);
    const size = coverageDimensions(campaign.bounds, campaign.center, campaign.projectionLatitude);
    assert.ok(Math.abs(size.widthKm - 5) < 1e-8);
    assert.ok(Math.abs(size.heightKm - 5) < 1e-8);
    assert.equal(campaign.sectors[0].arenaSize,5000);
    assert.equal(getMapCellAt(cell.center, { campaign }).id, cell.id);
    assert.equal(mapCellFeature(cell).id, cell.id);
  }
  assert.throws(() => makeMapCellCampaign({ gridVersion: MAP_GRID_VERSION, gridRow: 999999, gridColumn: 0 }));
  assert.throws(() => makeMapCellCampaign({ gridVersion: 'legacy' }));
});

test('features use canonical IDs, permit display properties, and have closed finite rings', () => {
  const cell = getMapCellAt([179.999, 60]);
  const feature = mapCellFeature(cell, { completed: true });
  assert.equal(feature.id, cell.id);
  assert.equal(feature.properties.completed, true);
  assert.equal(feature.geometry.type, 'Polygon');
  const ring = feature.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(ring.every(point => point.every(Number.isFinite) && Math.abs(point[0]) <= 180));
  const legacy = { id: 'legacy', center: [179.99, 60] };
  for (const polygon of mapCellFeature(legacy).geometry.coordinates) for (const point of polygon[0]) assert.ok(Math.abs(point[0]) <= 180);
  assert.ok(mapCellBounds(legacy)[2] > 180);
});

test('nearest global cell is the nearest centre among an independently enumerated local viewport', () => {
  for (const point of [[30.42, 59.72], [0.03, -0.03], [-179.99, -16.2], [179.99, 80.1]]) {
    const nearest = nearestMapCell(point);
    const candidates = getVisibleMapCells([point[0] - 0.6, point[1] - 0.2, point[0] + 0.6, point[1] + 0.2]);
    const distance = cell => {
      const dLat = (point[1] - cell.center[1]) * DEG, dLon = wrapped(point[0] - cell.center[0]) * DEG;
      return Math.sin(dLat / 2) ** 2 + Math.cos(point[1] * DEG) * Math.cos(cell.center[1] * DEG) * Math.sin(dLon / 2) ** 2;
    };
    assert.equal(candidates.tooDense, false);
    const expected = [...candidates.cells].sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id))[0];
    assert.equal(nearest.id, expected.id);
  }
});
