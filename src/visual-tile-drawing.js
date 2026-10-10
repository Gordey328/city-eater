/** Real OpenMapTiles background styling. Buildings are deliberately absent:
 * gameplay draws remaining occupancy separately, so eaten cells cannot reappear.
 */
import {VectorTile, classifyRings} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
export const VISUAL_TILE_SIZE = 512;
export const VISUAL_MAX_DETAIL_SCALE = 32; // Native z14 geometry, display through z19.
export const VISUAL_TILE_LIMITS = Object.freeze({features: 30000, vertices: 300000, commands: 40000});
export const VISUAL_GROUND = '#e7e9d9';
const layerOrder = ['landcover', 'landuse', 'park', 'water', 'waterway', 'transportation'];
const paintFor = (layer, properties) => {
  if (layer === 'landcover') return properties.class === 'ice' ? 'ice' : properties.class === 'sand' ? 'sand' : 'green';
  if (layer === 'landuse') return ['forest', 'grass', 'cemetery', 'recreation_ground', 'park', 'village_green'].includes(properties.class) ? 'green' : null;
  if (layer === 'park') return 'park';
  if (layer === 'water' || layer === 'waterway') return 'water';
  return properties.class === 'rail' ? 'rail' : 'road';
};
export function decodeVisualTile(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > 4 * 1024 * 1024) throw new Error('Неверный размер визуального тайла.');
  let tile;
  try { tile = new VectorTile(new PbfReader(buffer)); } catch { throw new Error('Не удалось прочитать визуальный PBF.'); }
  const commands = []; let vertices = 0, features = 0;
  for (const layerName of layerOrder) {
    const layer = tile.layers[layerName]; if (!layer) continue;
    if (!Number.isInteger(layer.extent) || layer.extent <= 0 || layer.extent > 65536) throw new Error('Неверный масштаб визуального тайла.');
    const scale = VISUAL_TILE_SIZE / layer.extent;
    for (let i = 0; i < layer.length; i++) {
      if (++features > VISUAL_TILE_LIMITS.features) throw new Error('Слишком много объектов в визуальном тайле.');
      const feature = layer.feature(i), paint = paintFor(layerName, feature.properties);
      if (!paint || ![2, 3].includes(feature.type)) continue;
      let lines;
      try { lines = feature.loadGeometry(); } catch { throw new Error('Неполная геометрия визуального тайла.'); }
      for (const line of lines) {
        vertices += line.length;
        if (vertices > VISUAL_TILE_LIMITS.vertices) throw new Error('Слишком много точек в визуальном тайле.');
        if (line.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > layer.extent * 16 || Math.abs(p.y) > layer.extent * 16)) throw new Error('Некорректные координаты визуального тайла.');
      }
      const packed = path => { const points = new Float32Array(path.length * 2); for (let j = 0; j < path.length; j++) { points[j * 2] = path[j].x * scale; points[j * 2 + 1] = path[j].y * scale; } return points; };
      if (feature.type === 3) {
        for (const polygon of classifyRings(lines)) commands.push({type: 'polygon', paint, paths: polygon.map(packed)});
      } else for (const line of lines) if (line.length >= 2) commands.push({type: 'line', paint, paths: [packed(line)]});
      if (commands.length > VISUAL_TILE_LIMITS.commands) throw new Error('Слишком сложный визуальный тайл.');
    }
  }
  return {commands, vertices, features};
}
function path(context, points, close) {
  if (points.length < 2) return;
  context.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) context.lineTo(points[i], points[i + 1]);
  if (close) context.closePath();
}
/** A virtual tile is one exact, power-of-two crop of the source tile core. */
export function normalizeVisualView(view = {scale: 1, x: 0, y: 0}) {
  if (!view || !Number.isInteger(view.scale) || view.scale < 1 || view.scale > VISUAL_MAX_DETAIL_SCALE ||
      (view.scale & (view.scale - 1)) !== 0 || !Number.isInteger(view.x) || !Number.isInteger(view.y) ||
      view.x < 0 || view.y < 0 || view.x >= view.scale || view.y >= view.scale) {
    throw new RangeError('Некорректная область визуального тайла.');
  }
  return {scale: view.scale, x: view.x, y: view.y};
}
export function drawVisualTile(context, commands, size = VISUAL_TILE_SIZE, view) {
  const crop = normalizeVisualView(view);
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('Некорректный размер визуального тайла.');
  context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, size, size);
  context.fillStyle = VISUAL_GROUND; context.fillRect(0, 0, size, size);
  // Clip before transforming, so buffered source geometry cannot escape this
  // virtual tile. Rasterize the vectors directly rather than enlarging pixels.
  context.beginPath(); context.rect(0, 0, size, size); context.clip();
  const scale = size / VISUAL_TILE_SIZE * crop.scale;
  context.setTransform(scale, 0, 0, scale, -crop.x * size, -crop.y * size);
  // Retain the canonical source core, including at outer world/tile borders.
  context.beginPath(); context.rect(0, 0, VISUAL_TILE_SIZE, VISUAL_TILE_SIZE); context.clip();
  context.lineJoin = 'round'; context.lineCap = 'round';
  const fills = {green: '#cfdbbb', park: '#c4d3b3', water: '#a9cad0', ice: '#f7f8f2', sand: '#e8dec2', road: '#fffdef', rail: '#aeb1a2'};
  for (const command of commands) {
    context.beginPath();
    for (const points of command.paths) path(context, points, command.type === 'polygon');
    context.fillStyle = fills[command.paint] || VISUAL_GROUND;
    if (command.type === 'polygon') context.fill('evenodd');
    else if (command.paint === 'road') {
      context.setLineDash([]); context.lineWidth = 2.8; context.strokeStyle = '#c8cbb9'; context.stroke();
      context.lineWidth = 1.7; context.strokeStyle = '#fffdef'; context.stroke();
    } else {
      context.setLineDash(command.paint === 'rail' ? [3, 2] : []);
      context.lineWidth = command.paint === 'rail' ? 1 : 1.4;
      context.strokeStyle = fills[command.paint]; context.stroke();
    }
  }
  context.restore();
}
