import {VectorTile, classifyRings} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import polygonClipping from 'polygon-clipping';
import {lonLatToLocal} from './geometry.js';
import {rasterizeCoverageChunk} from './consumption-mask.js';

export const TILE_GEOMETRY_LIMITS = Object.freeze({features: 30000, vertices: 300000,
  extent: 65536, retainedTiles: 24, retainedBytes: 32 * 1024 * 1024, batchBytes: 32 * 1024 * 1024});
const error = message => new Error(`Неполная геометрия тайла: ${message}`);

/** Decode only genuine native building polygons. Feature IDs/properties never
 * identify reward objects. Clipping buffers to each canonical tile interior and
 * OR-rasterizing world cells makes duplicates and seam fragments harmless.
 */
export function decodeBuildingTile(tile, manifest) {
  if (!tile || tile.z !== 14 || !Number.isInteger(tile.x) || tile.x < 0 || tile.x >= 16384 ||
      !Number.isInteger(tile.y) || tile.y < 0 || tile.y >= 16384 || !(tile.buffer instanceof ArrayBuffer)) throw error('неверные координаты или данные');
  if (tile.buffer.byteLength > 4 * 1024 * 1024) throw error('превышен размер');
  if (!Array.isArray(manifest?.center) || !manifest.center.every(Number.isFinite) ||
      !Number.isFinite(manifest.projectionLatitude ?? manifest.center[1])) throw error('неверная проекция');
  let vector;
  try { vector = new VectorTile(new PbfReader(tile.buffer)); } catch { throw error('не удалось разобрать PBF'); }
  const layer = vector.layers.building;
  if (!layer) return {polygons: [], vertices: 0, features: 0, bytes: 0};
  if (!Number.isInteger(layer.extent) || layer.extent <= 0 || layer.extent > TILE_GEOMETRY_LIMITS.extent || layer.length > TILE_GEOMETRY_LIMITS.features) throw error('превышен предел слоя');
  const extent = layer.extent, size = extent * 2 ** tile.z;
  const tileBox = [[[[0, 0], [extent, 0], [extent, extent], [0, extent], [0, 0]]]];
  const polygons = []; let vertices = 0, outputVertices = 0;
  const project = ([x, y]) => {
    const longitude = (tile.x * extent + x) / size * 360 - 180;
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y * extent + y) / size))) * 180 / Math.PI;
    return lonLatToLocal([longitude, latitude], manifest.center, manifest.projectionLatitude);
  };
  try {
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type !== 3) throw error('в слое зданий есть неполигональный объект');
      const rings = feature.loadGeometry();
      for (const ring of rings) {
        vertices += ring.length;
        if (vertices > TILE_GEOMETRY_LIMITS.vertices) throw error('слишком много вершин');
        if (ring.length < 4 || ring.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > extent * 16 || Math.abs(p.y) > extent * 16) ||
            ring[0].x !== ring.at(-1).x || ring[0].y !== ring.at(-1).y) throw error('незамкнутый контур');
      }
      const grouped = classifyRings(rings).map(polygon => polygon.map(ring => ring.map(p => [p.x, p.y])));
      if (!grouped.length) continue;
      const clipped = polygonClipping.intersection(grouped, tileBox);
      for (const polygon of clipped) {
        const converted = polygon.map(ring => { outputVertices += ring.length; return ring.map(project); });
        if (outputVertices > TILE_GEOMETRY_LIMITS.vertices) throw error('слишком много вершин после отсечения');
        polygons.push(converted);
      }
    }
  } catch (cause) { if (cause.message?.startsWith('Неполная геометрия')) throw cause; throw error('повреждённый контур или PBF'); }
  // Conservative retained-memory accounting for JS coordinate arrays.
  return {polygons, vertices: outputVertices, features: layer.length, bytes: outputVertices * 64 + polygons.length * 64};
}

export class TileCoverageProcessor {
  constructor() { this.cache = new Map(); this.bytes = 0; this.projectionKey = null; }
  process({key, tiles, manifest}) {
    if (!Array.isArray(tiles) || tiles.length > 64 || !tiles.length) throw error('нет подтверждённых исходных тайлов');
    const projectionKey = JSON.stringify([manifest?.id, manifest?.center, manifest?.projectionLatitude]);
    if (projectionKey !== this.projectionKey) { this.cache.clear(); this.bytes = 0; this.projectionKey = projectionKey; }
    const start = performance.now(), polygons = [];
    let inputBytes = 0, decoded = 0, vertices = 0;
    for (const tile of tiles) {
      inputBytes += tile.buffer?.byteLength || 0;
      if (inputBytes > TILE_GEOMETRY_LIMITS.batchBytes) throw error('слишком большой пакет');
      const cacheKey = `${tile.sourceKey}/${tile.z}/${tile.x}/${tile.y}`;
      let value = this.cache.get(cacheKey);
      if (value) { this.cache.delete(cacheKey); this.cache.set(cacheKey, value); }
      else {
        value = decodeBuildingTile(tile, manifest); decoded++;
        if (value.bytes > TILE_GEOMETRY_LIMITS.retainedBytes) throw error('слишком сложный тайл');
        this.cache.set(cacheKey, value); this.bytes += value.bytes;
        while (this.cache.size > TILE_GEOMETRY_LIMITS.retainedTiles || this.bytes > TILE_GEOMETRY_LIMITS.retainedBytes) {
          const first = this.cache.keys().next().value; this.bytes -= this.cache.get(first).bytes; this.cache.delete(first);
        }
      }
      vertices += value.vertices;
      if (vertices > TILE_GEOMETRY_LIMITS.vertices) throw error('слишком сложный участок');
      polygons.push(...value.polygons);
    }
    const bits = rasterizeCoverageChunk(key, polygons);
    return {key, bits, stats: {decodedTiles: decoded, decodeMs: performance.now() - start,
      retainedTiles: this.cache.size, retainedBytes: this.bytes, vertices}};
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const processor = new TileCoverageProcessor();
  self.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'rasterize') return;
    try {
      const result = processor.process(message);
      self.postMessage({type: 'coverage', requestId: message.requestId, ...result}, [result.bits.buffer]);
    } catch (cause) {
      self.postMessage({type: 'error', requestId: message.requestId, message: cause.message || 'Не удалось проверить геометрию тайлов.'});
    }
  });
}
