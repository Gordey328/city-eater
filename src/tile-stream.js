import {TileSource, NATIVE_ZOOM} from './tile-source.js';
import {maskChunkBounds, maskChunksForBounds} from './consumption-mask.js';

export const TILE_STREAM_LIMITS = Object.freeze({coverageChunks: 36, radius: 500, initialMargin: 100,
  margin: 150, directionLead: 100, tilesPerChunk: 64, workerTimeoutMs: 20000});
const abortError = () => new DOMException('Загрузка отменена', 'AbortError');
const metersPerDegree = 6378137 * Math.PI / 180;
const xy = p => Array.isArray(p) ? p : [p?.x, p?.y];
function arenaPosition(position, radius) {
  const p = xy(position);
  if (!p.every(Number.isFinite) || p.some(v => Math.abs(v) > 5000) || !Number.isFinite(radius) || radius < 0 || radius > TILE_STREAM_LIMITS.radius) throw new RangeError('Некорректная позиция или радиус потоковой карты.');
  return p;
}
function boxFor(position, radius, margin, direction = [0, 0]) {
  const p = arenaPosition(position, radius), d = xy(direction);
  const length = Math.hypot(...d), lead = length > 0 && Number.isFinite(length) ? d.map(v => v / length * TILE_STREAM_LIMITS.directionLead) : [0, 0];
  return [Math.max(-5000, p[0] - radius - margin + Math.min(0, lead[0])), Math.max(-5000, p[1] - radius - margin + Math.min(0, lead[1])),
    Math.min(5000, p[0] + radius + margin + Math.max(0, lead[0])), Math.min(5000, p[1] + radius + margin + Math.max(0, lead[1]))];
}
export function nativeTilesForBounds(manifest, bounds) {
  const b = Array.isArray(bounds) ? bounds : [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
  const center = manifest?.center, basis = manifest?.projectionLatitude ?? center?.[1];
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite) || Math.abs(center[1]) > 84.9 ||
      !Number.isFinite(basis) || Math.abs(basis) > 84.9 || !b.every(Number.isFinite) || b[0] >= b[2] || b[1] >= b[3] || b[2] - b[0] > 512.000001 || b[3] - b[1] > 512.000001) throw new RangeError('Некорректная область исходных тайлов.');
  const n = 2 ** NATIVE_ZOOM, longitudeScale = metersPerDegree * Math.cos(basis * Math.PI / 180);
  const west = center[0] + b[0] / longitudeScale, east = center[0] + b[2] / longitudeScale;
  const south = center[1] + b[1] / metersPerDegree, north = center[1] + b[3] / metersPerDegree;
  const tileY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  const x0 = Math.floor((west + 180) / 360 * n), x1 = Math.ceil((east + 180) / 360 * n) - 1;
  const y0 = Math.floor(tileY(north)), y1 = Math.ceil(tileY(south)) - 1;
  if (y0 < 0 || y1 >= n || (x1 - x0 + 1) * (y1 - y0 + 1) > TILE_STREAM_LIMITS.tilesPerChunk) throw new RangeError('Слишком много исходных тайлов для одного фрагмента.');
  const result = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) result.push({z: NATIVE_ZOOM, x: ((x % n) + n) % n, y});
  return result;
}

/** Authoritative coverage follows the hole, never the zoomed-out camera. Only
 * complete native-tile sets may publish a known mask chunk; failures stay unknown.
 * Repeated update calls do not retry a failed region. retry() is user initiated.
 */
export class TileStream {
  constructor({manifest, mask, onChange = () => {}, onStatus = () => {}, source = new TileSource(),
    workerFactory = () => new Worker(new URL('./tile-coverage.worker.js', import.meta.url), {type: 'module'})}) {
    this.manifest = manifest; this.mask = mask; this.onChange = onChange; this.onStatus = onStatus; this.source = source;
    this.workerFactory = workerFactory; this.worker = null; this.controller = new AbortController();
    this.metadata = null; this.desired = new Set(); this.coverage = new Map(); this.errors = new Map(); this.pending = null;
    this.generation = 0; this.requestId = 0; this.workerJob = null; this.disposed = false;
    this.stats = {requests: 0, bytes: 0, decodedTiles: 0, decodeMs: 0, startupMs: null, coverageChunks: 0, maxCoverageChunks: 0};
  }
  check() { if (this.disposed || this.controller.signal.aborted) throw abortError(); }
  syncStats() { Object.assign(this.stats, {requests: this.source.stats.requests, bytes: this.source.stats.bytes,
    nativeCacheHits: this.source.stats.cacheHits, retainedNativeTiles: this.source.stats.retainedTiles, retainedNativeBytes: this.source.stats.retainedBytes}); }
  async prepare(position, radius) {
    const start = performance.now();
    await this.loadRegion(position, radius, TILE_STREAM_LIMITS.initialMargin, [0, 0]);
    this.check(); if (!this.covers(position, radius)) throw new Error('Стартовая область ещё не подтверждена.');
    this.stats.startupMs = performance.now() - start;
    return this.metadata;
  }
  update(position, radius, direction = [0, 0]) { return this.loadRegion(position, radius, TILE_STREAM_LIMITS.margin, direction); }
  async loadRegion(position, radius, margin, direction) {
    this.check();
    const p = arenaPosition(position, radius), bounds = boxFor(p, radius, margin, direction);
    const keys = maskChunksForBounds(bounds).sort((a, b) => {
      const dist = key => { const v = maskChunkBounds(key); return ((v.minX + v.maxX) / 2 - p[0]) ** 2 + ((v.minY + v.maxY) / 2 - p[1]) ** 2; };
      return dist(a) - dist(b);
    });
    if (keys.length > TILE_STREAM_LIMITS.coverageChunks) throw new Error('Область загрузки превышает безопасный предел.');
    this.desired = new Set(keys);
    // One pump serves the newest desired region. Frequent animation-loop calls
    // must not invalidate a useful in-flight chunk and starve initial coverage.
    if (this.pending) return this.pending;
    const pending = this.fill(); this.pending = pending;
    try { await pending; } finally { if (this.pending === pending) this.pending = null; }
  }
  async fill() {
    this.onStatus('Загружаем ближайшие реальные тайлы…', {phase: 'tiles', known: this.coverage.size});
    this.metadata = await this.source.getMetadata({signal: this.controller.signal});
    for (;;) {
      this.check();
      const key = [...this.desired].find(value => !this.coverage.has(value));
      if (key === undefined) break;
      if (this.errors.has(key)) throw this.errors.get(key);
      try {
        const coords = nativeTilesForBounds(this.manifest, maskChunkBounds(key));
        const tiles = await this.loadContributingTiles(coords);
        this.check(); if (!this.desired.has(key)) continue;
        const result = await this.rasterize(key, tiles);
        this.check(); if (!this.desired.has(key)) continue;
        // Evict before ingest so resident coverage never transiently exceeds cap.
        this.evictForSlot();
        this.mask.ingestCoverage(key, result.bits); this.coverage.set(key, true);
        this.stats.decodedTiles += result.stats?.decodedTiles || 0; this.stats.decodeMs += result.stats?.decodeMs || 0;
        this.stats.retainedDecodedTiles = result.stats?.retainedTiles || 0; this.stats.retainedDecodedBytes = result.stats?.retainedBytes || 0;
        this.stats.coverageChunks = this.coverage.size; this.stats.maxCoverageChunks = Math.max(this.stats.maxCoverageChunks, this.coverage.size);
        this.onChange(key, this.mask.getCoverageChunk(key)); this.syncStats();
        this.onStatus('Ближайшая геометрия подтверждена.', {phase: 'coverage', key, known: this.coverage.size, ...this.stats});
      } catch (error) {
        if (error.name !== 'AbortError') this.errors.set(key, error);
        this.syncStats();
        if (!this.disposed && !this.desired.has(key)) continue;
        throw error;
      }
    }
    this.syncStats();
  }
  async loadContributingTiles(coords) {
    const tiles = new Array(coords.length); let next = 0, bytes = 0, failure = null;
    const load = async () => {
      while (!failure && next < coords.length) {
        const index = next++, tile = coords[index];
        try {
          this.check();
          const result = await this.source.loadNativeTile(tile.z, tile.x, tile.y, this.controller.signal);
          bytes += result.buffer.byteLength;
          if (bytes > 32 * 1024 * 1024) throw new Error('Пакет тайлов превышает безопасный предел.');
          tiles[index] = result;
        } catch (error) { failure ??= error; }
      }
    };
    await Promise.all([load(), load()]);
    if (failure) throw failure;
    return tiles;
  }
  evictForSlot() {
    while (this.coverage.size >= TILE_STREAM_LIMITS.coverageChunks) {
      const key = [...this.coverage.keys()].find(value => !this.desired.has(value));
      if (!key) throw new Error('Недостаточно места для подтверждённой области.');
      this.coverage.delete(key); this.mask.evictCoverage(key); this.onChange(key, null);
    }
  }
  rasterize(key, tiles) {
    this.check();
    if (!this.worker) this.worker = this.workerFactory();
    const worker = this.worker, requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (this.workerJob?.requestId !== requestId) return;
        clearTimeout(this.workerJob.timer); this.workerJob = null;
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        worker.terminate(); if (this.worker === worker) this.worker = null;
        finish(new Error('Подготовка геометрии заняла слишком много времени.'));
      }, TILE_STREAM_LIMITS.workerTimeoutMs);
      this.workerJob = {requestId, timer, finish};
      worker.onmessage = event => {
        const message = event.data;
        if (message?.requestId !== requestId) return;
        if (message.type === 'error') finish(new Error(message.message || 'Не удалось проверить тайл.'));
        else if (message.type === 'coverage' && message.key === key && message.bits instanceof Uint8Array && message.bits.byteLength === 8192) finish(null, message);
        else finish(new Error('Worker вернул неполное покрытие.'));
      };
      worker.onerror = event => { worker.terminate(); if (this.worker === worker) this.worker = null; finish(new Error(event.message || 'Ошибка обработки тайла.')); };
      try { worker.postMessage({type: 'rasterize', requestId, key, tiles, manifest: this.manifest}, tiles.map(tile => tile.buffer)); }
      catch (error) { finish(error); }
    });
  }
  covers(position, radius) {
    if (this.disposed) return false;
    const p = arenaPosition(position, radius);
    return maskChunksForBounds(boxFor(p, radius, 0)).every(key => this.coverage.has(key));
  }
  async retry(position, radius) {
    if (this.pending) { try { await this.pending; } catch {} }
    this.check(); this.errors.clear(); this.source.retryFailures({clearCache: true});
    // A syntactically successful download may have failed PBF validation. An
    // explicit retry must not keep replaying that cached response forever.
    this.worker?.terminate(); this.worker = null;
    return this.prepare(position, radius);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.controller.abort(); this.source.dispose();
    this.workerJob?.finish(abortError()); this.worker?.terminate(); this.worker = null;
    for (const key of this.coverage.keys()) { this.mask.evictCoverage(key); this.onChange(key, null); }
    this.coverage.clear(); this.desired.clear(); this.errors.clear(); this.stats.coverageChunks = 0;
  }
}
