/** One documented vector source. No endpoint rotation, proxying or automatic
 * retry. Live reachability must be verified separately from fixture tests. */
export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet/latest';
export const NATIVE_ZOOM = 14;
export const TILE_SOURCE_LIMITS = Object.freeze({concurrency: 2, tileBytes: 4 * 1024 * 1024, metadataBytes: 256 * 1024,
  retainedTiles: 24, retainedBytes: 32 * 1024 * 1024, timeoutMs: 20000});
const cancelled = () => new DOMException('Загрузка отменена', 'AbortError');
export class TileSourceError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TileSourceError'; this.code = code; Object.assign(this, details); }
}
function checkSignal(signal) { if (signal?.aborted) throw cancelled(); }
function sourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TileSourceError('INVALID_METADATA', 'Источник вернул неверный адрес тайлов.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'tiles.openfreemap.org' || url.port || url.username || url.password ||
      !url.pathname.startsWith('/planet/') || url.hash) throw new TileSourceError('INVALID_METADATA', 'Адрес тайлов не принадлежит выбранному источнику.');
  return url;
}
export function validateTileMetadata(data) {
  if (!data || !Array.isArray(data.tiles) || data.tiles.length < 1 || data.tiles.length > 4 ||
      !Number.isInteger(data.maxzoom) || data.maxzoom !== NATIVE_ZOOM ||
      (data.minzoom !== undefined && (!Number.isInteger(data.minzoom) || data.minzoom < 0 || data.minzoom > NATIVE_ZOOM))) {
    throw new TileSourceError('INVALID_METADATA', 'Нужны подтверждённые исходные тайлы уровня 14. Источник пока не готов.');
  }
  const tiles = data.tiles.map(value => {
    if (typeof value !== 'string' || !['{z}', '{x}', '{y}'].every(part => value.includes(part))) throw new TileSourceError('INVALID_METADATA', 'Источник не указал шаблон исходных тайлов.');
    sourceUrl(value.replace('{z}', '14').replace('{x}', '0').replace('{y}', '0'));
    return value;
  });
  if (data.vector_layers !== undefined && (!Array.isArray(data.vector_layers) || !data.vector_layers.some(layer => layer?.id === 'building'))) {
    throw new TileSourceError('INVALID_METADATA', 'Источник не подтвердил слой зданий.');
  }
  // A URL signature is advisory, NOT a guarantee of an immutable OSM snapshot.
  // Consumed cells remain anchored in the arena even if source versions change.
  return {tiles, minzoom: data.minzoom ?? 0, maxzoom: data.maxzoom, nativeZoom: NATIVE_ZOOM,
    vectorLayers: Array.isArray(data.vector_layers) ? data.vector_layers.map(layer => layer.id).filter(id => typeof id === 'string') : null,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> · <a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a>', sourceKey: `openfreemap-z14:${tiles.join('|')}`,
    sourceRevisionImmutable: false};
}
function canonicalTile(z, x, y, native = true) {
  const n = 2 ** z;
  if (!Number.isInteger(z) || z < 0 || z > NATIVE_ZOOM || (native && z !== NATIVE_ZOOM) || !Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= n) {
    throw new TileSourceError('INVALID_TILE', 'Некорректный исходный тайл.');
  }
  return {z, x: ((x % n) + n) % n, y};
}

export class TileSource {
  constructor({fetchImpl = globalThis.fetch.bind(globalThis)} = {}) {
    this.fetchImpl = fetchImpl;
    this.controller = new AbortController();
    this.cache = new Map(); this.cacheBytes = 0; this.pending = new Map(); this.errors = new Map();
    this.queue = []; this.running = 0; this.metadata = null; this.metadataPromise = null; this.metadataTask = null;
    this.stats = {requests: 0, metadataRequests: 0, tileRequests: 0, bytes: 0, cacheHits: 0, maxConcurrent: 0, retainedTiles: 0, retainedBytes: 0, nativeRequests: 0, visualRequests: 0};
  }
  async getMetadata({signal} = {}) {
    checkSignal(signal); checkSignal(this.controller.signal);
    if (this.metadata) return this.metadata;
    if (this.errors.has('metadata')) throw this.errors.get('metadata');
    if (!this.metadataTask || this.metadataTask.controller.signal.aborted) {
      const record = this.sharedTask('metadata', async sharedSignal => {
        this.stats.metadataRequests++;
        const bytes = await this.fetchBytes(TILEJSON_URL, TILE_SOURCE_LIMITS.metadataBytes, sharedSignal);
        let parsed;
        try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new TileSourceError('INVALID_METADATA', 'Источник вернул неполные сведения о карте.'); }
        this.metadata = validateTileMetadata(parsed); return this.metadata;
      }, -1, () => { if (this.metadataTask === record) { this.metadataTask = null; this.metadataPromise = null; } });
      this.metadataTask = record; this.metadataPromise = record.promise;
    }
    return this.subscribe(this.metadataTask, signal);
  }
  loadNativeTile(z, x, y, signal) { return this.loadTile(z, x, y, signal, true); }
  loadVisualTile(z, x, y, signal) { return this.loadTile(z, x, y, signal, false); }
  async loadTile(z, x, y, signal, native) {
    checkSignal(signal); checkSignal(this.controller.signal);
    const tile = canonicalTile(z, x, y, native), metadata = await this.getMetadata({signal});
    if (tile.z < metadata.minzoom) throw new TileSourceError('INVALID_TILE', 'Источник не поддерживает этот масштаб.');
    const key = `${metadata.sourceKey}/${tile.z}/${tile.x}/${tile.y}`;
    if (this.errors.has(key)) throw this.errors.get(key);
    if (this.cache.has(key)) {
      const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value); this.stats.cacheHits++;
      return {...value, buffer: value.buffer.slice(0)};
    }
    if (!this.pending.has(key) || this.pending.get(key).controller.signal.aborted) {
      const record = this.sharedTask(key, async sharedSignal => {
        const url = metadata.tiles[0].replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
        sourceUrl(url); this.stats.tileRequests++; this.stats[native ? 'nativeRequests' : 'visualRequests']++;
        const bytes = await this.fetchBytes(url, TILE_SOURCE_LIMITS.tileBytes, sharedSignal);
        const value = {...tile, key, sourceKey: metadata.sourceKey, buffer: bytes.buffer, bytes: bytes.byteLength};
        this.cache.set(key, value); this.cacheBytes += value.bytes; this.trimCache(); return value;
      }, native ? 0 : 1, () => { if (this.pending.get(key) === record) this.pending.delete(key); });
      this.pending.set(key, record);
    }
    const record = this.pending.get(key);
    if (native) record.priority = Math.min(record.priority, 0);
    const value = await this.subscribe(record, signal);
    return {...value, buffer: value.buffer.slice(0)};
  }
  sharedTask(key, task, priority, cleanup) {
    const record = {controller: new AbortController(), subscribers: new Set(), settled: false, priority, promise: null};
    record.promise = this.schedule(() => task(record.controller.signal), record.controller.signal, () => record.priority)
      .catch(error => { if (error.name !== 'AbortError') this.errors.set(key, error); throw error; })
      .finally(() => { record.settled = true; cleanup(); });
    return record;
  }
  subscribe(record, signal) {
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      const subscriber = {}; let done = false; record.subscribers.add(subscriber);
      const finish = (error, value) => {
        if (done) return; done = true; signal?.removeEventListener('abort', abort); record.subscribers.delete(subscriber);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        finish(cancelled());
        // Visual navigation cannot cancel a native gameplay subscriber sharing
        // the same z14 download. Abort only after the last subscriber leaves.
        if (!record.settled && !record.subscribers.size) record.controller.abort();
      };
      signal?.addEventListener('abort', abort, {once: true});
      record.promise.then(value => finish(null, value), error => finish(error));
      if (signal?.aborted) abort();
    });
  }
  schedule(task, signal, priority = () => 0) {
    checkSignal(signal); checkSignal(this.controller.signal);
    return new Promise((resolve, reject) => {
      const item = {task, signal, resolve, reject, priority, started: false, cleanup: null};
      const abort = () => {
        if (item.started) return;
        const index = this.queue.indexOf(item); if (index >= 0) this.queue.splice(index, 1);
        item.cleanup(); reject(cancelled());
      };
      item.cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, {once: true});
      this.queue.push(item); this.pump();
    });
  }
  pump() {
    this.queue.sort((a, b) => a.priority() - b.priority());
    while (this.running < TILE_SOURCE_LIMITS.concurrency && this.queue.length) {
      const item = this.queue.shift(); item.started = true; item.cleanup();
      if (this.controller.signal.aborted || item.signal?.aborted) { item.reject(cancelled()); continue; }
      this.running++; this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.running);
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { this.running--; this.pump(); });
    }
  }
  async fetchBytes(url, limit, signal) {
    const controller = new AbortController(), abort = () => controller.abort();
    const sourceSignal = this.controller.signal;
    sourceSignal.addEventListener('abort', abort, {once: true}); signal?.addEventListener('abort', abort, {once: true});
    if (sourceSignal.aborted || signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort('timeout'), TILE_SOURCE_LIMITS.timeoutMs);
    try {
      checkSignal(controller.signal); this.stats.requests++;
      const response = await this.fetchImpl(url, {signal: controller.signal, credentials: 'omit'});
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new TileSourceError('HTTP_ERROR', `Тайлы карты недоступны (HTTP ${response.status}). Неизвестная область не считается пустой.`, {status: response.status});
      }
      if (Number(response.headers.get('content-length') || 0) > limit) {
        await response.body?.cancel().catch(() => {});
        throw new TileSourceError('BYTE_LIMIT', 'Тайл превышает безопасный размер. Область ещё не загружена.');
      }
      const chunks = []; let size = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            checkSignal(controller.signal);
            const {done, value} = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); throw new TileSourceError('BYTE_LIMIT', 'Превышен предел размера тайла.'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      } else {
        const value = new Uint8Array(await response.arrayBuffer()); size = value.byteLength;
        if (size > limit) throw new TileSourceError('BYTE_LIMIT', 'Превышен предел размера тайла.');
        chunks.push(value);
      }
      checkSignal(controller.signal);
      const result = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      this.stats.bytes += size; return result;
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted || sourceSignal.aborted) throw cancelled();
        throw new TileSourceError('TIMEOUT', 'Источник тайлов не ответил вовремя. Повтори загрузку явно.');
      }
      if (error instanceof TileSourceError) throw error;
      throw new TileSourceError('NETWORK_ERROR', 'Не удалось получить реальные тайлы. Проверь доступ к источнику и повтори загрузку.', {cause: error});
    } finally { clearTimeout(timer); sourceSignal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); }
  }
  trimCache() {
    while (this.cache.size > TILE_SOURCE_LIMITS.retainedTiles || this.cacheBytes > TILE_SOURCE_LIMITS.retainedBytes) {
      const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key);
    }
    this.stats.retainedTiles = this.cache.size; this.stats.retainedBytes = this.cacheBytes;
  }
  retryFailures({clearCache = false} = {}) {
    this.errors.clear();
    if (clearCache) { this.cache.clear(); this.cacheBytes = 0; this.trimCache(); }
  }
  dispose() {
    this.controller.abort(); for (const item of this.queue.splice(0)) { item.cleanup(); item.reject(cancelled()); }
    this.cache.clear(); this.cacheBytes = 0; this.trimCache(); this.errors.clear();
  }
}
