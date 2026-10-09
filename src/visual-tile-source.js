import {drawVisualTile, VISUAL_TILE_SIZE} from './visual-tile-drawing.js';
export const VISUAL_CACHE_LIMIT = 16;
const cancelled = () => new DOMException('Загрузка отменена', 'AbortError');
const tileKey = (z, x, y) => `${z}/${x}/${y}`;
function canonical(tile) {
  if (!tile || !Number.isInteger(tile.z) || tile.z < 0 || tile.z > 14 || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.y < 0 || tile.y >= 2 ** tile.z) throw new RangeError('Некорректный визуальный тайл.');
  const x = ((tile.x % 2 ** tile.z) + 2 ** tile.z) % 2 ** tile.z;
  return {z: tile.z, x, y: tile.y, key: tileKey(tile.z, x, tile.y)};
}
function defaultCanvas() {
  if (typeof document === 'undefined') throw new Error('Canvas2D недоступен.');
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = VISUAL_TILE_SIZE; return canvas;
}
function release(drawable) { if (typeof drawable?.close === 'function') drawable.close(); else if (drawable) { drawable.width = 0; drawable.height = 0; } }

/** One low-priority visual request at a time. It shares source bytes with native
 * physics but never disposes the shared source or aborts its tile downloads.
 * Every retained tile is rasterized once; frame drawing is drawImage only.
 */
export class VisualTileLayer {
  constructor({source, onChange = () => {}, onError = () => {}, workerFactory = () => new Worker(new URL('./visual-tile.worker.js', import.meta.url), {type: 'module'}), canvasFactory = defaultCanvas}) {
    if (!source?.loadVisualTile) throw new TypeError('Нужен источник визуальных тайлов.');
    this.source = source; this.onChange = onChange; this.onError = onError; this.workerFactory = workerFactory; this.canvasFactory = canvasFactory;
    this.cache = new Map(); this.desired = new Map(); this.errors = new Map(); this.pending = null; this.disposed = false;
    this.worker = null; this.workerJob = null; this.requestId = 0;
    this.stats = {loads: 0, cacheHits: 0, rasterMs: 0, offscreenTiles: 0, fallbackTiles: 0, retainedTiles: 0, retainedPixelBytes: 0, maxConcurrent: 0, discarded: 0};
  }
  get(z, x, y) {
    const tile = canonical({z, x, y}), drawable = this.cache.get(tile.key);
    if (!drawable) return null;
    this.cache.delete(tile.key); this.cache.set(tile.key, drawable); return drawable;
  }
  async ensure(coords) {
    if (this.disposed) throw cancelled();
    if (!Array.isArray(coords) || coords.length > VISUAL_CACHE_LIMIT) throw new RangeError('На экране допускается не больше 16 визуальных тайлов.');
    const tiles = coords.map(canonical); this.desired = new Map(tiles.map(tile => [tile.key, tile]));
    if (this.pending) return this.pending;
    const pending = this.fill(); this.pending = pending;
    try { await pending; } finally { if (this.pending === pending) this.pending = null; }
  }
  async fill() {
    for (;;) {
      if (this.disposed) throw cancelled();
      const tile = [...this.desired.values()].find(value => !this.cache.has(value.key));
      if (!tile) return;
      if (this.errors.has(tile.key)) throw this.errors.get(tile.key);
      try {
        this.stats.maxConcurrent = 1;
        const source = await this.source.loadVisualTile(tile.z, tile.x, tile.y);
        if (this.disposed) throw cancelled();
        if (!this.desired.has(tile.key)) { this.stats.discarded++; continue; }
        const result = await this.rasterize(tile.key, source.buffer);
        if (this.disposed || !this.desired.has(tile.key)) { release(result.bitmap); this.stats.discarded++; if (this.disposed) throw cancelled(); continue; }
        let drawable = result.bitmap;
        if (!drawable) {
          drawable = this.canvasFactory(); const context = drawable.getContext('2d');
          if (!context) throw new Error('Не удалось открыть Canvas2D для карты.');
          drawable.width = drawable.height = VISUAL_TILE_SIZE; drawVisualTile(context, result.commands); this.stats.fallbackTiles++;
        } else this.stats.offscreenTiles++;
        while (this.cache.size >= VISUAL_CACHE_LIMIT) {
          const key = [...this.cache.keys()].find(value => !this.desired.has(value));
          if (key === undefined) { release(drawable); throw new Error('Превышен предел визуального кэша.'); }
          release(this.cache.get(key)); this.cache.delete(key);
        }
        this.cache.set(tile.key, drawable); this.stats.loads++; this.stats.rasterMs += result.stats?.rasterMs || 0;
        this.stats.retainedTiles = this.cache.size; this.stats.retainedPixelBytes = this.cache.size * VISUAL_TILE_SIZE * VISUAL_TILE_SIZE * 4;
        this.onChange(tile.key);
      } catch (error) {
        if (error.name !== 'AbortError') this.errors.set(tile.key, error);
        if (!this.disposed && !this.desired.has(tile.key)) continue;
        if (error.name !== 'AbortError') this.onError(error, tile);
        throw error;
      }
    }
  }
  rasterize(key, buffer) {
    if (this.disposed) return Promise.reject(cancelled());
    if (!this.worker) this.worker = this.workerFactory();
    const worker = this.worker, requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (this.workerJob?.requestId !== requestId) return;
        clearTimeout(this.workerJob.timer); this.workerJob = null; if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => { worker.terminate(); if (this.worker === worker) this.worker = null; finish(new Error('Фон карты готовился слишком долго.')); }, 20000);
      this.workerJob = {requestId, timer, finish};
      worker.onmessage = event => {
        const message = event.data;
        if (this.disposed || this.workerJob?.requestId !== requestId || message?.requestId !== requestId) { release(message?.bitmap); return; }
        if (message.type === 'error') finish(new Error(message.message));
        else if (message.type === 'visual' && message.key === key && (message.bitmap || Array.isArray(message.commands))) finish(null, message);
        else { release(message?.bitmap); finish(new Error('Некорректный фон карты.')); }
      };
      worker.onerror = event => { worker.terminate(); if (this.worker === worker) this.worker = null; finish(new Error(event.message || 'Ошибка подготовки фона.')); };
      try { worker.postMessage({type: 'visual', requestId, key, buffer}, [buffer]); } catch (error) { finish(error); }
    });
  }
  async retry() {
    if (this.pending) { try { await this.pending; } catch {} }
    if (this.disposed) throw cancelled();
    this.errors.clear(); this.source.retryFailures({clearCache: true}); this.worker?.terminate(); this.worker = null;
    return this.ensure([...this.desired.values()]);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.workerJob?.finish(cancelled()); this.worker?.terminate(); this.worker = null;
    for (const drawable of this.cache.values()) release(drawable);
    this.cache.clear(); this.desired.clear(); this.errors.clear(); this.stats.retainedTiles = 0; this.stats.retainedPixelBytes = 0;
  }
}
