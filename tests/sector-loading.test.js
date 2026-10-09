import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBuildingSectorQuery} from '../src/sector-query.js';
import {makeSectorQuery} from '../src/city-campaign.js';
import {OverpassClient, OSM_ENDPOINT, MAX_RESPONSE_BYTES} from '../src/overpass-client.js';
import {SectorLoader} from '../src/sector-loader.js';
import {normalizeOSMSector} from '../src/osm-import.js';
import {localToLonLat, lonLatToLocal} from '../src/geometry.js';

const sector = {id: 'lean-test/s0-0', title: 'Fixture', center: [30, 60], arenaSize: 10000};
const way = {type: 'way', id: 12, tags: {building: 'yes'}, geometry: [[0, 0], [12, 0], [12, 12], [0, 12], [0, 0]].map(p => {
  const [lon, lat] = localToLonLat(p, sector.center);
  return {lon, lat};
})};
const source = {version: 0.6, elements: [way]};
const raw = JSON.stringify(source);
const response = text => new Response(text, {headers: {'Content-Type': 'application/json'}});
function installWorker(t, WorkerClass) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {configurable: true, writable: true, value: WorkerClass});
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker; });
}
function recordFor(result) {
  return {id: result.manifest.id, manifest: {...result.manifest, background: result.background}, provenance: result.provenance};
}
function memoryCache(initial) {
  let record = initial;
  return {
    writes: 0, progressWrites: 0,
    async getSector() { return record; },
    async putSector(campaignId, result) { this.writes++; record = recordFor(result); },
    async updateProgress() { this.progressWrites++; },
  };
}
class ImportWorker {
  static calls = [];
  constructor() { this.terminated = false; }
  terminate() { this.terminated = true; }
  postMessage(message) {
    ImportWorker.calls.push(message);
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        const result = normalizeOSMSector(message.payload, message.sector, {
          source: message.source, onProgress: p => this.onmessage({data: {type: 'progress', ...p}}),
        });
        this.onmessage({data: {type: 'result', result}});
      } catch (error) { this.onmessage({data: {type: 'error', error: {message: error.message}}}); }
    });
  }
}

test('lean query selects full building geometries only, with unchanged 10km metric basis and date-line handling', () => {
  for (const s of [sector, {...sector, center: [30, 63], projectionLatitude: 60}, {...sector, center: [179.99, 60]}]) {
    const q = makeBuildingSectorQuery(s), full = makeSectorQuery(s);
    assert.match(q, /out body geom;/);
    assert.match(q, /timeout:60/);
    assert.match(q, /maxsize:134217728/);
    assert.doesNotMatch(q, /highway|waterway|natural|landuse|leisure|out center|out bb|out meta|\(\.\_;/);
    assert.deepEqual(q.match(/wr\["building"\][^\n]+/g), full.match(/wr\["building"\][^\n]+/g));
    assert.equal((q.match(/wr\["building"\]/g) || []).length, s.center[0] > 179 ? 2 : 1);
    if (s.center[0] < 179) {
      const bbox = q.match(/\]\(([^)]+)\)/)[1].split(',').map(Number);
      const local = lonLatToLocal([bbox[1], bbox[0]], s.center, s.projectionLatitude);
      assert.ok(Math.abs(local[0] + 5100) < 1e-6 && Math.abs(local[1] + 5100) < 1e-6);
    }
  }
  assert.throws(() => makeBuildingSectorQuery({...sector, arenaSize: 1000}));
  assert.throws(() => makeBuildingSectorQuery({...sector, projectionLatitude: 90}));
});

test('client text mode streams bounded UTF-8 without main-thread JSON parsing or extra requests', async t => {
  const body = '{"elements":[],"generator":"Луга"}', bytes = new TextEncoder().encode(body), statuses = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, OSM_ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('data'), 'only-this-query');
    return new Response(new ReadableStream({start(controller) {
      // Deliberately split a Cyrillic UTF-8 codepoint across chunks.
      const split = bytes.findIndex(b => b >= 0xc0) + 1;
      controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close();
    }}));
  });
  const client = new OverpassClient(); client.last = 0;
  assert.equal(await client.request('only-this-query', {format: 'text', onStatus: (text, detail) => statuses.push(detail)}), body);
  assert.equal(calls, 1);
  assert.equal(client.requestCount, 1);
  assert.equal(client.lastResponse.bytes, bytes.length);
  assert.equal(client.busy, false);
  assert.ok(statuses.some(s => s.phase === 'download' && s.bytes === bytes.length));
  assert.ok(statuses.every(s => s.buildingIndexComplete === false));
});

test('client default JSON mode rejects malformed, partial and invalid responses, but accepts truly empty elements', async t => {
  for (const body of ['{', '{"remark":"runtime error: timeout","elements":[]}', 'null', '{}']) {
    t.mock.method(globalThis, 'fetch', async () => response(body));
    const client = new OverpassClient(); client.last = 0;
    await assert.rejects(client.request('q'));
    assert.equal(client.busy, false);
    assert.equal(client.requestCount, 1);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => response('{"elements":[]}'));
  assert.deepEqual(await new OverpassClient().request('q'), {elements: []});
});

test('oversized announced response is cancelled before reading', async t => {
  let cancelled = false, read = false;
  const body = new ReadableStream({cancel() { cancelled = true; }});
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, headers: new Headers({'content-length': String(MAX_RESPONSE_BYTES + 1)}), body, text() { read = true; }}));
  const client = new OverpassClient();
  await assert.rejects(client.request('q'), /Данных слишком много/);
  assert.equal(cancelled, true);
  assert.equal(read, false);
  assert.equal(client.busy, false);
});

test('actual streamed bytes are capped even without Content-Length and response is cancelled', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { cancelled = true; },
  })));
  const client = new OverpassClient();
  await assert.rejects(client.request('q', {limit: 10, format: 'text'}), /лимит/);
  assert.equal(cancelled, true);
  assert.equal(client.lastResponse, null);
  assert.equal(client.busy, false);
});

test('provider errors cancel the body and never trigger retries or endpoint rotation', async t => {
  for (const code of [429, 502, 503, 504, 403]) {
    let calls = 0, cancelled = false;
    t.mock.method(globalThis, 'fetch', async url => { calls++; assert.equal(url, OSM_ENDPOINT); return new Response(new ReadableStream({cancel() { cancelled = true; }}), {status: code}); });
    const client = new OverpassClient();
    await assert.rejects(client.request('q'));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(client.busy, false);
    t.mock.restoreAll();
  }
});

test('cancelled cooldown never contacts provider and rejects simultaneous calls', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(raw); });
  const client = new OverpassClient(), controller = new AbortController(), statuses = [];
  client.last = Date.now();
  const pending = client.request('q', {signal: controller.signal, onStatus: (text, detail) => statuses.push(detail)});
  await assert.rejects(client.request('another'), /Предыдущая загрузка/);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(calls, 0);
  assert.equal(client.busy, false);
  assert.equal(statuses[0].phase, 'cooldown');
});

test('loader hands raw response to worker, caches once, and exposes denominator only after readback', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(raw));
  installWorker(t, ImportWorker);
  ImportWorker.calls = [];
  const cache = memoryCache(), client = new OverpassClient(), loader = new SectorLoader(cache, client), statuses = [];
  const result = await loader.load({id: 'lean-test'}, sector, (text, detail) => statuses.push(detail));
  assert.equal(ImportWorker.calls.length, 1);
  assert.equal(typeof ImportWorker.calls[0].payload, 'string');
  assert.equal(client.requestCount, 1);
  assert.equal(cache.writes, 1);
  assert.equal(cache.progressWrites, 1);
  assert.equal(result.manifest.buildingCount, 1);
  assert.deepEqual(result.manifest.dataCoverage, {buildingIndex: 'complete', background: 'not-requested'});
  assert.equal(result.provenance.backgroundRequested, false);
  assert.equal(result.provenance.queryScope, 'buildings-only');
  assert.equal(result.manifest.background.data.features.length, 0);
  assert.ok(statuses.slice(0, -1).every(s => s.buildingIndexComplete === false && s.totalBuildingArea === undefined));
  assert.equal(statuses.at(-1).phase, 'ready');
  assert.equal(statuses.at(-1).buildingIndexComplete, true);
  assert.equal(statuses.at(-1).totalBuildingArea, result.manifest.totalBuildingArea);
  assert.equal(loader.active, null);
});

test('complete legacy enriched cache is reused without requests, reimport or version churn', async () => {
  const normalized = normalizeOSMSector(raw, sector), cached = recordFor(normalized);
  cached.manifest.background.data.features.push({type: 'Feature', geometry: {type: 'LineString', coordinates: [[30, 60], [30.01, 60]]}, properties: {kindGroup: 'roads'}});
  const cache = memoryCache(cached), loader = new SectorLoader(cache, {request() { throw new Error('Unexpected request'); }}), statuses = [];
  assert.equal(await loader.load({id: 'lean-test'}, sector, (text, detail) => statuses.push(detail)), cached);
  assert.equal(cache.writes, 0);
  assert.equal(loader.stats.cacheHits, 1);
  assert.equal(statuses.at(-1).backgroundRequested, true);
  assert.equal(statuses.at(-1).fromCache, true);
});

test('malformed and partial raw worker responses never become empty or enter cache/progress', async t => {
  installWorker(t, ImportWorker);
  for (const payload of ['{', '{"elements":[],"remark":"runtime error: timeout"}', '{}']) {
    const cache = memoryCache(), statuses = [], loader = new SectorLoader(cache, {async request() { return payload; }});
    await assert.rejects(loader.load({id: 'lean-test'}, sector, (text, detail) => statuses.push(detail)));
    assert.equal(cache.writes, 0);
    assert.equal(cache.progressWrites, 0);
    assert.ok(statuses.every(s => s.buildingIndexComplete === false));
    assert.equal(loader.active, null);
  }
});

test('successful full empty query is explicitly complete and empty only after validation', async t => {
  installWorker(t, ImportWorker);
  const cache = memoryCache(), loader = new SectorLoader(cache, {async request() { return '{"elements":[]}'; }});
  const record = await loader.load({id: 'lean-test'}, sector);
  assert.equal(record.manifest.buildingCount, 0);
  assert.equal(record.manifest.totalBuildingArea, 0);
  assert.equal(record.manifest.suitability.status, 'empty');
  assert.equal(record.manifest.dataCoverage.buildingIndex, 'complete');
});

test('cancellation during download cannot start worker, cache partial data or mark progress', async () => {
  let resolveRequest;
  const cache = memoryCache(), loader = new SectorLoader(cache, {request() { return new Promise(resolve => { resolveRequest = resolve; }); }});
  const pending = loader.load({id: 'lean-test'}, sector);
  await new Promise(resolve => setImmediate(resolve));
  loader.cancel();
  resolveRequest(raw);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(cache.writes, 0);
  assert.equal(cache.progressWrites, 0);
  assert.equal(loader.active, null);
});

test('worker cancellation terminates work and stale results cannot mutate cache', async t => {
  let worker;
  class HangingWorker {
    constructor() { worker = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  installWorker(t, HangingWorker);
  const cache = memoryCache(), loader = new SectorLoader(cache, {async request() { return raw; }});
  const pending = loader.load({id: 'lean-test'}, sector);
  await new Promise(resolve => setImmediate(resolve));
  loader.cancel();
  worker.onmessage({data: {type: 'result', result: normalizeOSMSector(raw, sector)}});
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(worker.terminated, true);
  assert.equal(cache.writes, 0);
  assert.equal(loader.active, null);
});

test('cache quota failure does not announce readiness or write campaign progress', async t => {
  installWorker(t, ImportWorker);
  const cache = memoryCache();
  cache.putSector = async () => { throw new DOMException('Quota', 'QuotaExceededError'); };
  const statuses = [], loader = new SectorLoader(cache, {async request() { return raw; }});
  await assert.rejects(loader.load({id: 'lean-test'}, sector, (text, detail) => statuses.push(detail)), /не хватает места/);
  assert.equal(cache.progressWrites, 0);
  assert.ok(statuses.every(s => s.buildingIndexComplete === false));
  assert.equal(loader.active, null);
});

test('explicitly incomplete cache is never reused as a full building denominator', async t => {
  installWorker(t, ImportWorker);
  for (const state of ['partial', 'unknown']) {
    const cached = recordFor(normalizeOSMSector(raw, sector));
    cached.manifest.dataCoverage = {buildingIndex: state};
    const cache = memoryCache(cached), statuses = [];
    let requests = 0;
    const loader = new SectorLoader(cache, {async request() { requests++; return raw; }});
    const result = await loader.load({id: 'lean-test'}, sector, (text, detail) => statuses.push(detail));
    assert.equal(requests, 1);
    assert.equal(loader.stats.cacheHits, 0);
    assert.equal(result.manifest.dataCoverage.buildingIndex, 'complete');
    assert.ok(statuses.slice(0, -1).every(s => s.buildingIndexComplete === false));
  }
});

test('worker transport failure terminates worker and does not leave loader locked', async t => {
  let worker;
  class BrokenWorker {
    constructor() { worker = this; }
    terminate() { this.terminated = true; }
    postMessage() { throw new DOMException('Clone failed', 'DataCloneError'); }
  }
  installWorker(t, BrokenWorker);
  const cache = memoryCache(), loader = new SectorLoader(cache, {async request() { return raw; }});
  await assert.rejects(loader.load({id: 'lean-test'}, sector), error => error.name === 'DataCloneError');
  assert.equal(worker.terminated, true);
  assert.equal(loader.active, null);
  assert.equal(cache.writes, 0);
});

test('cancel after a complete cache commit cannot announce readiness or start another request', async t => {
  installWorker(t, ImportWorker);
  let release;
  const cache = memoryCache();
  const putSector = cache.putSector;
  cache.putSector = async (...args) => { await putSector.apply(cache, args); await new Promise(resolve => { release = resolve; }); };
  const statuses = [], loader = new SectorLoader(cache, {async request() { return raw; }});
  const pending = loader.load({id: 'lean-test'}, sector, (text, detail) => statuses.push(detail));
  await new Promise(resolve => setImmediate(resolve));
  loader.cancel(); release();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(cache.progressWrites, 0);
  assert.ok(statuses.every(s => s.buildingIndexComplete === false));
  // A complete committed record is useful on retry; it is not a partial cache.
  assert.equal((await cache.getSector()).manifest.dataCoverage.buildingIndex, 'complete');
  assert.equal(loader.active, null);
});
