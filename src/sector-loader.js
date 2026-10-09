import {compatibleSectorCache} from './import-contract.js';
import {OSM_ENDPOINT} from './overpass-client.js';
import {makeBuildingSectorQuery} from './sector-query.js';
const abortError = () => new DOMException('Загрузка отменена', 'AbortError');

/** Download one authoritative sector index, then stream only nearby normalized
 * chunks from IndexedDB in BuildingRepository. Unknown source regions are never
 * represented as empty and no gameplay denominator is exposed before validation.
 */
export class SectorLoader {
  constructor(cache, client) {
    this.cache = cache;
    this.client = client;
    this.active = null;
    this.stats = {cacheHits: 0, imports: 0};
  }
  cancel() { this.active?.abort(); }

  async load(campaign, sector, onStatus = () => {}) {
    if (this.active) throw new Error('Сначала заверши текущую загрузку.');
    const controller = new AbortController();
    this.active = controller;
    const check = () => { if (controller.signal.aborted) throw abortError(); };
    const status = (message, detail = {}) => onStatus(message, {buildingIndexComplete: false, ...detail});
    const ready = (record, fromCache) => status(fromCache ? 'Сектор готов из локального кэша.' : 'Здания сектора готовы.', {
      phase: 'ready', buildingIndexComplete: true, fromCache,
      buildingCount: record.manifest.buildingCount, totalBuildingArea: record.manifest.totalBuildingArea,
      backgroundRequested: record.provenance?.backgroundRequested !== false,
    });
    try {
      status('Проверяем сохранённый сектор…', {phase: 'cache'});
      const cached = await this.cache.getSector(sector.id);
      check();
      if (cached && compatibleSectorCache(cached, sector)) {
        this.stats.cacheHits++;
        ready(cached, true);
        return cached;
      }
      if (cached) status('Формат сохранённой карты обновился. Подготовим участок заново; совместимость прохождения проверим перед запуском.', {phase: 'cache'});
      const payload = await this.client.request(makeBuildingSectorQuery(sector), {
        signal: controller.signal, onStatus: status, format: 'text',
      });
      check();
      status('Проверяем полный набор зданий 10 × 10 км…', {phase: 'normalize'});
      const result = await new Promise((resolve, reject) => {
        check();
        const worker = new Worker(new URL('./osm-import.worker.js', import.meta.url), {type: 'module'});
        let workerTimer, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(workerTimer);
          worker.terminate();
          controller.signal.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(value);
        };
        const cancel = () => finish(abortError());
        controller.signal.addEventListener('abort', cancel, {once: true});
        worker.onmessage = event => {
          if (settled) return;
          const message = event.data;
          if (message?.type === 'progress') {
            // These fractions describe worker preparation, never swallowed area.
            const text = message.stage === 'background' ? 'Группируем здания по локальным фрагментам…' : message.message || 'Подготавливаем здания…';
            status(text, {phase: 'normalize', stage: message.stage, preparationProgress: message.progress});
          } else if (message?.type === 'result') finish(null, message.result);
          else if (message?.type === 'error') finish(new Error(message.error?.message || message.message || 'Ошибка подготовки карты.'));
        };
        worker.onerror = event => finish(new Error(event.message || 'Не удалось подготовить карту.'));
        workerTimer = setTimeout(() => finish(new Error('Подготовка участка заняла слишком много времени. Выбери менее плотный сектор.')), 45000);
        try {
          worker.postMessage({type: 'normalize', payload, sector, source: {
            endpoint: OSM_ENDPOINT, downloadedAt: new Date().toISOString(), backgroundRequested: false,
          }});
        } catch (error) { finish(error); }
      });
      check();
      if (!Number.isFinite(result?.manifest?.totalBuildingArea) || result.manifest.totalBuildingArea < 0 ||
          !Number.isSafeInteger(result.manifest.buildingCount) || result.manifest.buildingCount < 0 ||
          !compatibleSectorCache({id: sector.id, ...result, manifest: {...result.manifest, background: result.background}}, sector)) {
        throw new Error('Не удалось проверить полный набор зданий. Данные не сохранены.');
      }
      // Completeness describes this successful OSM query and validated playable
      // contours, not a claim that every real-world building exists in OSM.
      result.manifest.dataCoverage = {buildingIndex: 'complete', background: 'not-requested'};
      result.provenance = {...result.provenance, queryScope: 'buildings-only', backgroundRequested: false};
      // Geometry and chunk records commit together. A quota failure must never
      // advertise the sector or its denominator as ready.
      status('Сохраняем здания на этом устройстве…', {phase: 'save'});
      await this.cache.putSector(campaign.id, result);
      check();
      await this.cache.updateProgress(campaign.id, sector.id, {
        prepared: true, totalBuildingArea: result.manifest.totalBuildingArea, version: result.manifest.version,
      });
      check();
      const stored = await this.cache.getSector(sector.id);
      check();
      if (!stored || !compatibleSectorCache(stored, sector)) throw new Error('Не удалось проверить сохранённый сектор. Попробуй ещё раз.');
      this.stats.imports++;
      ready(stored, false);
      return stored;
    } catch (error) {
      if (error.name === 'QuotaExceededError') throw new Error('В браузере не хватает места для этого города. Готовые карты по-прежнему доступны.');
      throw error;
    } finally {
      if (this.active === controller) this.active = null;
    }
  }
}
