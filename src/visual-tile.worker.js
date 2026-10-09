import {decodeVisualTile, drawVisualTile, VISUAL_TILE_SIZE} from './visual-tile-drawing.js';

export function prepareVisualTile(buffer, createCanvas = typeof OffscreenCanvas === 'function' ? () => new OffscreenCanvas(VISUAL_TILE_SIZE, VISUAL_TILE_SIZE) : null) {
  const start = performance.now(), decoded = decodeVisualTile(buffer);
  if (createCanvas) {
    try {
    const canvas = createCanvas(), context = canvas?.getContext('2d');
    if (context && typeof canvas.transferToImageBitmap === 'function') {
      drawVisualTile(context, decoded.commands);
      return {bitmap: canvas.transferToImageBitmap(), stats: {vertices: decoded.vertices, features: decoded.features, rasterMs: performance.now() - start, offscreen: true}};
    }
    } catch { /* Fall back if this browser cannot rasterize offscreen. */ }
  }
  return {commands: decoded.commands, stats: {vertices: decoded.vertices, features: decoded.features, rasterMs: performance.now() - start, offscreen: false}};
}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  self.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'visual') return;
    try {
      const result = prepareVisualTile(message.buffer);
      const transfer = result.bitmap ? [result.bitmap] : result.commands.flatMap(command => command.paths.map(points => points.buffer));
      self.postMessage({type: 'visual', requestId: message.requestId, key: message.key, ...result}, transfer);
    } catch (error) { self.postMessage({type: 'error', requestId: message.requestId, message: error.message || 'Не удалось подготовить фон карты.'}); }
  });
}
