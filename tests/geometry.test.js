import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lonLatToLocal, localToLonLat, getBounds, ringArea, polygonArea, polygonsArea,
  minimalEnclosingCircle, polygonFitsCircle, pointInRing, pointInPolygon,
  pointInPolygons, circlePolygonCollision, closestPointOnSegment,
  boundsIntersect, SpatialIndex, resolveMotion,
} from '../src/geometry.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} within ${tolerance} of ${expected}`);
const nearPoint = (actual, expected, tolerance = 1e-6) => actual.forEach((value, i) => near(value, expected[i], tolerance));
const ring = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
const box = (x1, y1, x2, y2) => [[ring(x1, y1, x2, y2)]];
const building = (id, polygons) => ({ id, polygons, ...minimalEnclosingCircle(polygons),
  area: polygonsArea(polygons), bbox: getBounds(polygons) });

test('local metres projection round trips and handles the date line', () => {
  const origin = [30.3351, 59.9343];
  const point = [30.381, 59.911];
  nearPoint(localToLonLat(lonLatToLocal(point, origin), origin), point, 1e-10);
  nearPoint(lonLatToLocal(origin, origin), [0, 0]);
  const across = lonLatToLocal([-179.99, 0.01], [179.99, 0]);
  assert.ok(across[0] > 2200 && across[0] < 2300);
  nearPoint(localToLonLat(across, [179.99, 0]), [-179.99, 0.01], 1e-10);
});

test('bounds and robust area support open, closed, reversed rings and holes', () => {
  const outer = ring(0, 0, 10, 10), hole = ring(2, 2, 8, 8);
  assert.equal(ringArea(outer), 100);
  assert.equal(ringArea([...outer].reverse()), -100);
  assert.equal(ringArea(outer.slice(0, -1)), 100);
  assert.equal(polygonArea([outer, hole]), 64);
  assert.equal(polygonArea([[...outer].reverse(), hole]), 64);
  assert.equal(polygonsArea([[outer, hole], [ring(20, 20, 22, 23)]]), 70);
  const translated = ring(1e9, 1e9, 1e9 + 10, 1e9 + 10);
  assert.equal(polygonArea([translated]), 100);
  assert.deepEqual(getBounds([[outer, hole], [ring(20, 20, 22, 23)]]), { minX: 0, minY: 0, maxX: 22, maxY: 23 });
  assert.equal(getBounds([]), null);
  assert.equal(polygonsArea([]), 0);
});

test('point containment treats courtyard interiors as empty and edges as solid', () => {
  const polygon = [ring(-10, -10, 10, 10), ring(-5, -5, 5, 5)];
  assert.equal(pointInRing([0, 0], polygon[0]), true);
  assert.equal(pointInPolygon([8, 0], polygon), true);
  assert.equal(pointInPolygon([0, 0], polygon), false);
  assert.equal(pointInPolygon([5, 0], polygon), true);
  assert.equal(pointInPolygon([10, 0], polygon), true);
  assert.equal(pointInPolygon([10.1, 0], polygon), false);
  assert.equal(pointInPolygons([22, 22], [polygon, [ring(20, 20, 25, 25)]]), true);
  assert.equal(pointInPolygons([15, 15], [polygon, [ring(20, 20, 25, 25)]]), false);
  assert.equal(pointInRing([0, 0], []), false);
});

test('minimum enclosing circles handle empty, singleton, duplicate and collinear points', () => {
  assert.deepEqual(minimalEnclosingCircle([]), { center: [0, 0], radius: 0 });
  assert.deepEqual(minimalEnclosingCircle([[4, 8], [4, 8]]), { center: [4, 8], radius: 0 });
  const circle = minimalEnclosingCircle([[0, 0], [2, 0], [-4, 0], [1, 0], [-4, 0]]);
  nearPoint(circle.center, [-1, 0]); near(circle.radius, 3);
});

test('minimum enclosing circle is exact for right, acute and obtuse triangles', () => {
  let circle = minimalEnclosingCircle([[0, 0], [4, 0], [0, 3]]);
  nearPoint(circle.center, [2, 1.5]); near(circle.radius, 2.5);
  circle = minimalEnclosingCircle([[0, 0], [2, 0], [1, Math.sqrt(3)]]);
  nearPoint(circle.center, [1, Math.sqrt(3) / 3]); near(circle.radius, 2 / Math.sqrt(3));
  circle = minimalEnclosingCircle([[-5, 0], [5, 0], [0, 1]]);
  nearPoint(circle.center, [0, 0]); near(circle.radius, 5);
});

test('same area does not mean same opening: narrow footprint requires larger hole', () => {
  const narrow = box(-50, -0.5, 50, 0.5), square = box(-5, -5, 5, 5);
  assert.equal(polygonsArea(narrow), polygonsArea(square));
  const longCircle = minimalEnclosingCircle(narrow), squareCircle = minimalEnclosingCircle(square);
  near(longCircle.radius, Math.hypot(50, 0.5));
  near(squareCircle.radius, Math.sqrt(50));
  assert.equal(polygonFitsCircle(square, [0, 0], 8), true);
  assert.equal(polygonFitsCircle(narrow, [0, 0], 8), false);
  assert.equal(polygonFitsCircle(narrow, [0, 0], 51, 1), true);
});

test('enclosing circle is deterministic across input order and includes all components', () => {
  const points = [[3, 1], [-4, 8], [2, -2], [0, 0], [6, 6], [-2, -3]];
  assert.deepEqual(minimalEnclosingCircle(points), minimalEnclosingCircle([...points].reverse()));
  const multi = [...box(-11, -1, -9, 1), ...box(9, -1, 11, 1)];
  const circle = minimalEnclosingCircle(multi);
  nearPoint(circle.center, [0, 0]); near(circle.radius, Math.hypot(11, 1));
  assert.equal(polygonFitsCircle(multi, [0, 0], 10, 1), false);
  assert.equal(polygonFitsCircle(multi, [0, 0], 12, 1), true);
  assert.equal(polygonFitsCircle(multi, [-10, 0], 12, 1), false);
});

test('all outer vertices must fit; default tolerance is exactly a 6% margin', () => {
  const footprint = box(-1, -1, 1, 1);
  const required = Math.sqrt(2);
  assert.equal(polygonFitsCircle(footprint, [0, 0], required / 1.06), true);
  assert.equal(polygonFitsCircle(footprint, [0, 0], required / 1.07), false);
  assert.equal(polygonFitsCircle(footprint, [0.5, 0], required, 1), false);
  assert.equal(polygonFitsCircle([], [0, 0], 100), false);
  assert.equal(polygonFitsCircle(footprint, [0, 0], -1), false);
});

test('circle contact returns a separation normal and penetration outside and inside', () => {
  const polygon = box(0, 0, 10, 10);
  assert.equal(circlePolygonCollision([-2, 5], 2, polygon), null);
  let hit = circlePolygonCollision([-1, 5], 2, polygon);
  nearPoint(hit.normal, [-1, 0]); near(hit.penetration, 1);
  nearPoint(hit.point, [0, 5]);
  hit = circlePolygonCollision([1, 5], 2, polygon);
  nearPoint(hit.normal, [-1, 0]); near(hit.penetration, 3);
  hit = circlePolygonCollision([0, 5], 2, polygon);
  nearPoint(hit.normal, [-1, 0]); near(hit.penetration, 2);
  hit = circlePolygonCollision([-1, -1], 2, polygon);
  nearPoint(hit.normal, [-Math.SQRT1_2, -Math.SQRT1_2]); near(hit.penetration, 2 - Math.SQRT2);
  assert.equal(circlePolygonCollision([-20, -20], 2, polygon), null);
  nearPoint(closestPointOnSegment([4, 3], [1, 1], [1, 1]), [1, 1]);
});

test('courtyard holes are navigable and their walls push back into the hole', () => {
  const courtyard = [[ring(-20, -20, 20, 20), ring(-10, -10, 10, 10)]];
  assert.equal(circlePolygonCollision([0, 0], 5, courtyard), null);
  const hit = circlePolygonCollision([9, 0], 2, courtyard);
  nearPoint(hit.normal, [-1, 0]); near(hit.penetration, 1);
  const reversed = courtyard.map((polygon) => polygon.map((points) => [...points].reverse()));
  const other = circlePolygonCollision([9, 0], 2, reversed);
  nearPoint(other.normal, hit.normal); near(other.penetration, hit.penetration);
});

test('SpatialIndex deduplicates cells, filters bounds, replaces and removes items', () => {
  const index = new SpatialIndex(10);
  const a = { id: 'a', bbox: [-15, -15, 15, 15] }, b = { id: 'b', bbox: [30, 30, 40, 40] };
  index.insert(a); index.insert(b);
  assert.equal(index.size, 2);
  assert.deepEqual(index.query([-10, -10, 10, 10]), [a]);
  assert.deepEqual(index.query([15, 15, 30, 30]).map((item) => item.id).sort(), ['a', 'b']);
  assert.deepEqual(index.query([16, 16, 20, 20]), []);
  const replacement = { id: 'a', bbox: [100, 100, 101, 101] };
  index.insert(replacement);
  assert.equal(index.size, 2); assert.equal(index.get('a'), replacement);
  assert.deepEqual(index.query([-10, -10, 10, 10]), []);
  assert.equal(index.remove(replacement), true); assert.equal(index.remove('a'), false);
  assert.equal(index.remove('b'), true); assert.equal(index.size, 0); assert.equal(index.cells.size, 0);
  index.insert(a); index.clear(); assert.deepEqual(index.values(), []);
  assert.throws(() => new SpatialIndex(0), RangeError);
  assert.throws(() => index.insert({ id: 'bad', bbox: [1, 1, 0, 0] }), TypeError);
  assert.equal(boundsIntersect([0, 0, 1, 1], [1, 1, 2, 2]), true);
});

test('motion slides along oversized building walls and does not mutate input', () => {
  const wall = building('wall', box(0, -100, 10, 100));
  const start = [-10, 0], movement = [20, 20];
  const result = resolveMotion(start, movement, 2, [wall]);
  near(result.position[0], -2, 1e-4); near(result.position[1], 20);
  assert.equal(result.blocked, true); assert.equal(result.collisions[0].id, 'wall');
  assert.equal(circlePolygonCollision(result.position, 2, wall.polygons), null);
  assert.deepEqual(start, [-10, 0]); assert.deepEqual(movement, [20, 20]);
});

test('continuous sweep prevents tunnelling through thin buildings at high speed', () => {
  const wall = building('wall', box(0, -100, 0.1, 100));
  const result = resolveMotion([-100, 0], [10000, 0], 2, [wall], 20000);
  near(result.position[0], -2, 1e-4); near(result.position[1], 0);
  assert.equal(result.blocked, true);
});

test('edible or removed buildings do not block movement', () => {
  const small = building('small', box(-1, -1, 1, 1));
  const result = resolveMotion([-10, 0], [20, 0], 2, [small]);
  nearPoint(result.position, [10, 0]); assert.equal(result.blocked, false);
  const large = { ...building('large', box(0, -100, 10, 100)), eaten: true };
  nearPoint(resolveMotion([-10, 0], [20, 0], 2, [large]).position, [10, 0]);
});

test('motion respects courtyard walls and can move away from touching walls', () => {
  const courtyard = building('courtyard', [[ring(-20, -20, 20, 20), ring(-10, -10, 10, 10)]]);
  const result = resolveMotion([0, 0], [30, 3], 1, [courtyard]);
  near(result.position[0], 9, 1e-4); near(result.position[1], 3);
  const wall = building('wall', box(0, -100, 10, 100));
  nearPoint(resolveMotion([-2, 0], [-5, 5], 2, [wall]).position, [-7, 5]);
});

test('motion recovers initial overlap and handles arena boundaries with sliding', () => {
  const wall = building('wall', box(0, -100, 10, 100));
  const recovered = resolveMotion([1, 0], [0, 0], 2, [wall]);
  near(recovered.position[0], -2, 1e-4);
  assert.equal(circlePolygonCollision(recovered.position, 2, wall.polygons), null);
  const boundary = resolveMotion([95, 0], [30, 20], 2, [], 100);
  nearPoint(boundary.position, [98, 20], 1e-4);
  assert.equal(boundary.collisions[0].id, 'arena');
  const corner = resolveMotion([95, 95], [30, 30], 2, [], 100);
  nearPoint(corner.position, [98, 98], 1e-4);
  nearPoint(resolveMotion([100, -100], [0, 0], 2, [], 100).position, [98, -98]);
  nearPoint(resolveMotion([0, 0], [20, 20], 200, [], 100).position, [0, 0]);
});

test('SpatialIndex and array movement queries produce identical collisions', () => {
  const walls = [building('a', box(0, -100, 10, 100)), building('b', box(-1000, -1000, -900, -900))];
  const index = new SpatialIndex(50); walls.forEach((wall) => index.insert(wall));
  nearPoint(resolveMotion([-10, 0], [20, 20], 2, index).position,
    resolveMotion([-10, 0], [20, 20], 2, walls).position);
});

test('MEC matches exhaustive support circles for seeded arbitrary point sets', () => {
  let seed = 1234;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 60; trial++) {
    const points = Array.from({ length: 7 }, () => [random() * 100 - 50, random() * 100 - 50]);
    const options = [];
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const [a, b] = [points[i], points[j]];
      const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      options.push({ center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) });
      for (let k = j + 1; k < points.length; k++) {
        const c = points[k];
        const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
        if (Math.abs(d) < 1e-10) continue;
        const aa = a[0] ** 2 + a[1] ** 2, bb = b[0] ** 2 + b[1] ** 2, cc = c[0] ** 2 + c[1] ** 2;
        const center = [(aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d,
          (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d];
        options.push({ center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) });
      }
    }
    const best = options.filter((circle) => points.every((point) => Math.hypot(point[0] - circle.center[0], point[1] - circle.center[1]) <= circle.radius + 1e-7))
      .sort((a, b) => a.radius - b.radius)[0];
    const actual = minimalEnclosingCircle(points);
    near(actual.radius, best.radius, 1e-7); nearPoint(actual.center, best.center, 1e-6);
  }
});

test('seeded sweeps stay outside a concave footprint, including reentrant corners', () => {
  const obstacle = building('concave', [[[[0, 0], [100, 0], [100, 20], [20, 20], [20, 100], [0, 100], [0, 0]]]]);
  let seed = 666;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let checked = 0;
  for (let i = 0; i < 500; i++) {
    const position = [random() * 200 - 50, random() * 200 - 50], radius = 1 + random() * 15;
    if (circlePolygonCollision(position, radius, obstacle.polygons)) continue;
    const displacement = [random() * 400 - 200, random() * 400 - 200];
    const result = resolveMotion(position, displacement, radius, [obstacle]);
    assert.equal(circlePolygonCollision(result.position, radius, obstacle.polygons), null,
      `Sweep ended in solid at ${result.position}`);
    checked++;
  }
  assert.ok(checked > 300);
});
