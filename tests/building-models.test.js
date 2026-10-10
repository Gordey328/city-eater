import test from 'node:test';
import assert from 'node:assert/strict';
import {localToLonLat} from '../src/geometry.js';
import {mercatorProject} from '../src/mercator-view.js';
import {prepareBuildingModel, releaseBuildingModel, planBuildingModels, drawBuildingModels, buildingModelScreenBounds} from '../src/building-models.js';

const manifest = {center: [30.1075, 59.5633], projectionLatitude: 59.5633};
const rectangle = (left, bottom, right, top) => [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]];
const polygons = [[rectangle(-10, -10, 10, 10)]];
const makeBuilding = (overrides = {}) => ({id: 'building-1', complete: true, polygons, center: [0, 0],
  modelParts: [{polygons, heightMeters: 12, minHeightMeters: 0, heightProvenance: 'source-approximation'}], ...overrides});

class TestPath {
  constructor() { this.commands = []; }
  moveTo(x, y) { this.commands.push(['moveTo', x, y]); }
  lineTo(x, y) { this.commands.push(['lineTo', x, y]); }
  closePath() { this.commands.push(['closePath']); }
  get vertices() { return this.commands.filter(command => command[0] !== 'closePath').length; }
}
const pathFactory = () => new TestPath();
const prepare = (building = makeBuilding(), m = manifest) => prepareBuildingModel(building, m, {pathFactory});
function frame(m = manifest, extra = {}) {
  const center = mercatorProject(m.center), worldSize = 2 ** 25;
  return {worldSize, offsetX: 400 - center[0] * worldSize, offsetY: 300 - center[1] * worldSize * .9,
    groundScaleY: .9, roofLiftFactor: .44, pixelRatio: 1, viewportWidth: 800, viewportHeight: 600, ...extra};
}
function context() {
  const ctx = {calls: [], transforms: [], submittedVertices: 0, saved: 0,
    save() { this.saved++; }, restore() { this.saved--; }, setLineDash() {},
    setTransform(...matrix) { this.matrix = matrix; this.transforms.push(matrix); },
    fill(path, rule) { this.calls.push({method: 'fill', path, rule, matrix: [...this.matrix], alpha: this.globalAlpha, colour: this.fillStyle}); this.submittedVertices += path.vertices; },
    stroke(path) { this.calls.push({method: 'stroke', path, matrix: [...this.matrix]}); this.submittedVertices += path.vertices; },
  };
  return ctx;
}
const approx = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const apply = (matrix, point) => [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];

test('exact original contour, courtyard and all parts are prepared once without viewport data', () => {
  const courtyard = [[rectangle(-30, -30, 30, 30), rectangle(-10, -10, 10, 10)]];
  const building = makeBuilding({polygons: courtyard, modelParts: [{polygons: courtyard, heightMeters: 10}]});
  const before = JSON.stringify(building); let created = 0;
  const factory = () => { created++; return new TestPath(); };
  const model = prepareBuildingModel(building, manifest, {pathFactory: factory});
  assert.equal(model.originalPolygons, courtyard);
  assert.equal(model.worldPolygons[0].length, 2);
  assert.equal(model.ground.vertexCount, 8);
  assert.equal(model.sourceVertices, 20, 'footprint and every source part count, including source closing vertices');
  assert.equal(created, 2, 'shared footprint path and unit quad are prepared once');
  assert.equal(prepareBuildingModel(building, {...manifest}, {pathFactory: factory}), model);
  drawBuildingModels(context(), [model], frame(), {extrusion: .2});
  drawBuildingModels(context(), [model], frame(manifest, {worldSize: 2 ** 26, offsetX: 200}), {extrusion: .8});
  assert.equal(created, 2, 'zoom/pan/LOD does not build any paths');
  assert.equal(JSON.stringify(building), before, 'source gameplay contour is never mutated');
});

test('paths preserve all real contour vertices instead of convexifying or raster-snapping', () => {
  const ring = [[-20, -20], [20, -20], [20, 0], [2, 0], [2, 20], [-20, 20], [-20, -20]];
  const original = [[ring]], model = prepare(makeBuilding({polygons: original, modelParts: []}));
  assert.equal(model.ground.vertexCount, 6);
  for (let i = 0; i < ring.length - 1; i++) {
    const expected = mercatorProject(localToLonLat(ring[i], manifest.center, manifest.projectionLatitude));
    approx(model.worldPolygons[0][0][i][0], expected[0]);
    approx(model.worldPolygons[0][0][i][1], expected[1]);
  }
});

test('nearest-world projection stays continuous across the antimeridian', () => {
  for (const longitude of [179.99999, -179.99999]) {
    const m = {center: [longitude, 35], projectionLatitude: 35}, model = prepare(makeBuilding(), m);
    const centerX = (longitude + 180) / 360;
    assert.ok(model.bounds[2] - model.bounds[0] < .00001);
    assert.ok(Math.abs(model.origin[0] - centerX) < .00001);
    const f = frame(m), bounds = buildingModelScreenBounds(model, f);
    assert.ok(bounds[0] < 400 && bounds[2] > 400);
    assert.equal(drawBuildingModels(null, [model], f, {extrusion: 1}).drawnBuildings, 1);
  }
});

test('default top-down factors and extrusion zero produce an exact flat path', () => {
  const model = prepare(), f = frame(), ctx = context();
  delete f.groundScaleY; delete f.roofLiftFactor;
  const stats = drawBuildingModels(ctx, [model], f, {extrusion: 1});
  // Recenter without a tilt for this flat-frame fixture.
  assert.equal(stats.extrudedBuildings, 0);
  const centered = frame(manifest, {roofLiftFactor: 0});
  const flat = drawBuildingModels(context(), [model], centered, {extrusion: 1});
  assert.equal(flat.flatBuildings, 1); assert.equal(flat.drawnVertices, 8);
  const zero = drawBuildingModels(context(), [model], frame(), {extrusion: 0});
  assert.equal(zero.flatBuildings, 1); assert.equal(zero.extrudedBuildings, 0);
});

test('ground and roof use identical affine world matrices and CSS-to-device scale', () => {
  const model = prepare(), f = frame(manifest, {pixelRatio: 2}), ctx = context();
  drawBuildingModels(ctx, [model], f, {extrusion: .75});
  const ground = ctx.calls.find(call => call.method === 'fill' && call.path === model.ground.path && call.alpha === 1);
  const roof = ctx.calls.find(call => call.method === 'fill' && call.path === model.parts[0].path && call.alpha === .75);
  const point = model.ground.path.commands[0].slice(1), world = model.worldPolygons[0][0][0];
  const screen = apply(ground.matrix, point);
  approx(screen[0], (world[0] * f.worldSize + f.offsetX) * 2);
  approx(screen[1], (world[1] * f.worldSize * f.groundScaleY + f.offsetY) * 2);
  const roofPoint = apply(roof.matrix, point);
  approx(screen[0], roofPoint[0]);
  approx(screen[1] - roofPoint[1], 12 * model.metersToWorld * f.worldSize * f.roofLiftFactor * .75 * 2);
  assert.equal(ctx.saved, 0);
});

test('courtyard-facing walls are visible regardless of source ring winding and holes use evenodd', () => {
  for (const reverseOuter of [false, true]) for (const reverseHole of [false, true]) {
    const outer = rectangle(-30, -30, 30, 30), hole = rectangle(-10, -10, 10, 10);
    if (reverseOuter) outer.reverse(); if (reverseHole) hole.reverse();
    const shape = [[outer, hole]], model = prepare(makeBuilding({polygons: shape, modelParts: [{polygons: shape, heightMeters: 10}]}));
    assert.equal(model.parts[0].walls.length, 2);
    assert.equal(model.parts[0].walls.filter(wall => wall.hole).length, 1);
    const ctx = context(); drawBuildingModels(ctx, [model], frame(), {extrusion: 1});
    assert.ok(ctx.calls.filter(call => call.method === 'fill' && call.path !== model.wallPath).every(call => call.rule === 'evenodd'));
    assert.equal(ctx.calls.filter(call => call.method === 'fill' && call.path === model.wallPath).length, 2);
  }
});

test('multipart roofs retain own source heights and elevated walls start at minimum height', () => {
  const low = [[rectangle(-10, -10, 0, 10)]], high = [[rectangle(0, -10, 10, 10)]];
  const model = prepare(makeBuilding({modelParts: [
    {polygons: high, heightMeters: 30, minHeightMeters: 10, colour: '#ff0000'},
    {polygons: low, heightMeters: 6, minHeightMeters: 0},
  ]}));
  const ctx = context(), f = frame(); drawBuildingModels(ctx, [model], f, {extrusion: 1});
  const multiplier = model.metersToWorld * f.worldSize * f.roofLiftFactor;
  for (const part of model.parts) {
    const roof = ctx.calls.find(call => call.method === 'fill' && call.path === part.path);
    approx(roof.matrix[5], model.origin[1] * f.worldSize * f.groundScaleY + f.offsetY - part.heightMeters * multiplier);
  }
  const highPart = model.parts[0], wall = highPart.walls[0];
  const wallCall = ctx.calls.find(call => call.method === 'fill' && call.path === model.wallPath && Math.abs(call.matrix[3] + 20 * multiplier) < 1e-6);
  assert.ok(wallCall);
  approx(wallCall.matrix[5], (model.origin[1] + wall.y) * f.worldSize * f.groundScaleY + f.offsetY - 10 * multiplier);
  assert.equal(ctx.calls.find(call => call.method === 'fill' && call.path === highPart.path).colour, '#ff0000');
});

test('missing, invalid and hidden heights stay flat and never invent an extrusion', () => {
  const invalids = [{heightMeters: null}, {heightMeters: -2}, {heightMeters: Infinity}, {heightMeters: 6, minHeightMeters: 7},
    {heightMeters: 6, hide3d: true}, {heightMeters: 6, heightProvenance: 'invalid'}, {heightMeters: 6, heightProvenance: 'missing'}];
  for (const attributes of invalids) {
    const model = prepare(makeBuilding({modelParts: [{polygons, ...attributes}]}));
    const stats = drawBuildingModels(context(), [model], frame(), {extrusion: 1});
    assert.equal(stats.flatBuildings, 1); assert.equal(stats.extrudedBuildings, 0); assert.equal(stats.drawnVertices, 8);
  }
});

test('actual submitted vertices include every ground/shadow/roof fill, stroke and wall quad', () => {
  const shape = [[rectangle(-30, -30, 30, 30), rectangle(-10, -10, 10, 10)]];
  const model = prepare(makeBuilding({polygons: shape, modelParts: [{polygons: shape, heightMeters: 10}]}));
  const ctx = context(), stats = drawBuildingModels(ctx, [model], frame(), {extrusion: 1});
  assert.equal(stats.drawnVertices, 40); // 8 ground + 8 shadow + 8 roof + 8 outline + 2*4 walls
  assert.equal(stats.drawnVertices, ctx.submittedVertices);
  assert.equal(model.emittedVertexCost, stats.drawnVertices);
  const flatCtx = context(), flat = drawBuildingModels(flatCtx, [model], frame(), {extrusion: 1, maxVertices: 16});
  assert.equal(flat.flatFallbacks, 1); assert.equal(flat.drawnVertices, 16); assert.equal(flat.drawnVertices, flatCtx.submittedVertices);
  const absent = drawBuildingModels(context(), [model], frame(), {extrusion: 1, maxVertices: 15});
  assert.deepEqual(absent.selectedIds, []); assert.equal(absent.drawnVertices, 0);
});

test('dry plan excludes only actually selected IDs and can be replayed exactly under hard caps', () => {
  const entries = ['a', 'b', 'c'].map(id => prepare(makeBuilding({id}))), f = frame();
  const preview = drawBuildingModels(null, entries, f, {extrusion: 1, maxBuildings: 2, maxVertices: 28});
  assert.deepEqual(preview.selectedIds, ['a', 'b']);
  assert.equal(preview.drawnVertices, 28); assert.equal(preview.flatFallbacks, 1);
  const ctx = context(), replay = drawBuildingModels(ctx, entries, f, {plan: preview.plan});
  assert.equal(replay.plan, preview.plan); assert.deepEqual(replay.selectedIds, preview.selectedIds);
  assert.equal(ctx.submittedVertices, 28);
  assert.equal(drawBuildingModels(null, entries, f, {maxBuildings: 0}).drawnBuildings, 0);
  assert.equal(drawBuildingModels(null, entries, f, {maxVertices: 0}).drawnVertices, 0);
});

test('culling includes a roof that enters the viewport and skips truly offscreen buildings', () => {
  const model = prepare(makeBuilding({modelParts: [{polygons, heightMeters: 100}]})), f = frame();
  const groundBounds = buildingModelScreenBounds(model, f);
  const roofOnlyFrame = {...f, offsetY: f.offsetY + 620 - groundBounds[1]};
  const roofOnly = drawBuildingModels(null, [model], roofOnlyFrame, {extrusion: 1});
  assert.equal(roofOnly.drawnBuildings, 1);
  assert.equal(drawBuildingModels(null, [model], roofOnlyFrame, {extrusion: 0}).culledBuildings, 1);
  assert.deepEqual(drawBuildingModels(null, [model], {...f, offsetX: f.offsetX + 10000}, {extrusion: 1}).selectedIds, []);
  assert.deepEqual(drawBuildingModels(null, [model], roofOnlyFrame, {extrusion: 1, maxVertices: 8}).selectedIds, [], 'flat fallback outside viewport is not excluded from the mask');
});

test('visual height cap is reported without changing source heights, min heights or footprint', () => {
  const building = makeBuilding({modelParts: [{polygons, heightMeters: 900, minHeightMeters: 100}]}), model = prepare(building);
  const stats = drawBuildingModels(null, [model], frame(), {extrusion: 1, maxRoofLiftPixels: 40});
  assert.equal(stats.visuallyCappedBuildings, 1); assert.equal(stats.plan.selections[0].lift, 40);
  assert.equal(model.parts[0].heightMeters, 900); assert.equal(model.parts[0].minHeightMeters, 100);
  assert.equal(building.modelParts[0].heightMeters, 900);
});

test('preparation accounts for all model parts before geometry work and rejects unsafe inputs', () => {
  const ring = Array.from({length: 5000}, (_, i) => [Math.cos(i / 5000 * Math.PI * 2), Math.sin(i / 5000 * Math.PI * 2)]);
  const shape = [[ring]], large = makeBuilding({modelParts: Array.from({length: 61}, () => ({polygons: shape, heightMeters: 5}))});
  let calls = 0;
  assert.equal(prepareBuildingModel(large, manifest, {pathFactory: () => { calls++; return new TestPath(); }}), null);
  assert.equal(calls, 0, 'preflight occurs before preparing oversized geometry');
  assert.equal(prepare(makeBuilding({complete: false})), null);
  assert.equal(prepare(makeBuilding({polygons: [[[[NaN, 0], [1, 0], [1, 1]]]]})), null);
  assert.throws(() => planBuildingModels([], {worldSize: 0, offsetX: 0, offsetY: 0}));
  assert.throws(() => planBuildingModels([], {...frame(), groundScaleY: -1}));
});

test('default preparation is DOM-free and can be used for dry planning in Node', () => {
  const model = prepareBuildingModel(makeBuilding(), manifest);
  assert.ok(model); assert.equal(drawBuildingModels(null, [model], frame(), {extrusion: 1}).drawnBuildings, 1);
});

test('retained geometry preflight runs before Path2D allocation and respects tighter reuse budgets', () => {
  const building = makeBuilding(); let created = 0;
  const factory = () => { created++; return new TestPath(); };
  // Four world vertices, four path vertices, two wall endpoint vertices, plus
  // the reusable four-point wall path. The shared ground/part path counts once.
  assert.equal(prepareBuildingModel(building, manifest, {pathFactory: factory, maxVertices: 13}), null);
  assert.equal(created, 0);
  const model = prepareBuildingModel(building, manifest, {pathFactory: factory, maxVertices: 14});
  assert.equal(model.preparedVertexCost, 14); assert.equal(model.pathVertices, 8);
  assert.equal(prepareBuildingModel(building, manifest, {pathFactory: factory, maxVertices: 13}), null);
  assert.equal(created, 2);
});

test('explicit release drops retained paths even while the original catalog building stays alive', () => {
  const building = makeBuilding(), first = prepare(building);
  assert.equal(releaseBuildingModel(building), true);
  assert.equal(releaseBuildingModel(building), false);
  assert.notEqual(prepare(building), first);
});
