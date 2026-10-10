import {decodeVisualTile, drawVisualTile, normalizeVisualView, VISUAL_TILE_SIZE} from './visual-tile-drawing.js';

export const VISUAL_DECODED_CACHE_LIMIT = 4;
export const VISUAL_DECODED_CACHE_BYTES = 8 * 1024 * 1024;
const defaultCanvas = typeof OffscreenCanvas === 'function' ? () => new OffscreenCanvas(VISUAL_TILE_SIZE, VISUAL_TILE_SIZE) : null;

/** Conservative retained-byte accounting: floats plus generous allowances for
 * commands, path arrays, typed-array/buffer wrappers, the key and Map entry.
 * Source PBF bytes and transient output copies are never retained by this LRU.
 */
export function decodedVisualTileBytes(decoded, sourceKey = '') {
  let bytes = 1024 + sourceKey.length * 2 + decoded.commands.length * 256;
  for (const command of decoded.commands) for (const points of command.paths) bytes += 256 + points.byteLength;
  return bytes;
}
function copyCommands(commands) {
  return commands.map(command => ({...command, paths: command.paths.map(points => points.slice())}));
}
function rasterize(decoded, createCanvas, view, start) {
  if (createCanvas) {
    let canvas;
    try {
      canvas = createCanvas();
      // A custom canvas factory cannot accidentally enlarge the texture budget.
      if (canvas) canvas.width = canvas.height = VISUAL_TILE_SIZE;
      const context = canvas?.getContext('2d');
      if (context && typeof canvas.transferToImageBitmap === 'function') {
        drawVisualTile(context, decoded.commands, VISUAL_TILE_SIZE, view);
        return {bitmap: canvas.transferToImageBitmap(), view, stats: {vertices: decoded.vertices, features: decoded.features, rasterMs: performance.now() - start, offscreen: true}};
      }
    } catch { /* Fall back if this browser cannot rasterize offscreen. */ }
    finally {
      // transferToImageBitmap installs another backing store. Do not retain it
      // beside the returned bitmap, including on a failed transfer/raster.
      if (canvas) { try { canvas.width = canvas.height = 0; } catch {} }
    }
  }
  // postMessage transfers only these copies. Cached parent paths must stay live
  // for the next crop even when OffscreenCanvas is unavailable or throws.
  return {commands: copyCommands(decoded.commands), view, stats: {vertices: decoded.vertices, features: decoded.features, rasterMs: performance.now() - start, offscreen: false}};
}

/** Backward-compatible stateless entry point, also used by fixture workers. */
export function prepareVisualTile(buffer, createCanvas = defaultCanvas, view) {
  const start = performance.now(), crop = normalizeVisualView(view);
  return rasterize(decodeVisualTile(buffer), createCanvas, crop, start);
}

/** One worker owns this bounded LRU. sourceKey includes the provider signature
 * and actual source z/x/y, never the virtual display tile coordinates.
 */
export function createVisualTileProcessor({createCanvas = defaultCanvas, decode = decodeVisualTile} = {}) {
  const cache = new Map();
  let decodedBytes = 0, decodeCalls = 0, cacheHits = 0;
  return {
    prepare({buffer, sourceKey, view} = {}) {
      const start = performance.now(), crop = normalizeVisualView(view);
      if (sourceKey !== undefined && typeof sourceKey !== 'string') throw new TypeError('Некорректный ключ визуального тайла.');
      let entry = sourceKey ? cache.get(sourceKey) : null;
      const cacheHit = Boolean(entry);
      if (entry) {
        cache.delete(sourceKey); cache.set(sourceKey, entry); cacheHits++;
      } else {
        decodeCalls++;
        const decoded = decode(buffer), bytes = decodedVisualTileBytes(decoded, sourceKey);
        entry = {decoded, bytes};
        if (sourceKey && bytes <= VISUAL_DECODED_CACHE_BYTES) {
          while (cache.size >= VISUAL_DECODED_CACHE_LIMIT || decodedBytes + bytes > VISUAL_DECODED_CACHE_BYTES) {
            const oldest = cache.keys().next().value;
            decodedBytes -= cache.get(oldest).bytes; cache.delete(oldest);
          }
          cache.set(sourceKey, entry); decodedBytes += bytes;
        }
      }
      const result = rasterize(entry.decoded, createCanvas, crop, start);
      Object.assign(result.stats, {decodedCacheHit: cacheHit, decodedParents: cache.size, decodedBytes});
      return result;
    },
    clear() { cache.clear(); decodedBytes = 0; },
    get stats() { return {decodedParents: cache.size, decodedBytes, decodeCalls, cacheHits}; },
  };
}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const processor = createVisualTileProcessor();
  self.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'visual') return;
    let result;
    try {
      result = processor.prepare(message);
      const transfer = result.bitmap ? [result.bitmap] : result.commands.flatMap(command => command.paths.map(points => points.buffer));
      self.postMessage({type: 'visual', requestId: message.requestId, key: message.key, ...result}, transfer);
    } catch (error) {
      // A failed postMessage leaves the bitmap owned by this worker. Successful
      // transfers return above without closing the main thread's new drawable.
      try { result?.bitmap?.close(); } catch {}
      self.postMessage({type: 'error', requestId: message.requestId, message: error.message || 'Не удалось подготовить фон карты.'});
    }
  });
}
