// One intentionally selected provider. Never rotate endpoints to evade a limit.
export const OSM_ENDPOINT = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
export const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
export const REQUEST_COOLDOWN_MS = 30000;
export const REQUEST_TIMEOUT_MS = 110000;
const abortError = () => new DOMException('Загрузка отменена', 'AbortError');

function waitForCooldown(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const id = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(id); signal.removeEventListener('abort', cancel); reject(abortError()); };
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
  });
}

export class OverpassClient {
  constructor() {
    this.requestCount = 0;
    this.busy = false;
    this.last = 0;
    this.lastResponse = null;
    try { this.last = Number(localStorage.getItem('city-eater-osm-last') || 0); } catch {}
    if (!Number.isFinite(this.last)) this.last = 0;
  }

  /** Text mode defers JSON validation to the import worker; never publish or cache
   * its result until that worker has rejected malformed/partial OSM responses.
   * Progress bytes describe the decoded response, not compressed wire traffic.
   */
  async request(query, {signal, onStatus = () => {}, limit = MAX_RESPONSE_BYTES, format = 'json'} = {}) {
    if (!['json', 'text'].includes(format)) throw new TypeError('Неизвестный формат ответа OSM.');
    if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_RESPONSE_BYTES) throw new RangeError('Некорректный предел ответа OSM.');
    if (this.busy) throw new Error('Предыдущая загрузка ещё идёт. Дождись её завершения или отмени.');
    this.busy = true;
    this.lastResponse = null;
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) controller.abort();
    let timer;
    const check = () => { if (controller.signal.aborted) throw abortError(); };
    const status = (text, detail) => onStatus(text, {buildingIndexComplete: false, ...detail});
    try {
      check();
      // Re-read the persisted timestamp so sequential requests from another tab
      // are not forgotten. This is a courtesy throttle, not a provider quota.
      try { this.last = Math.max(this.last, Number(localStorage.getItem('city-eater-osm-last') || 0) || 0); } catch {}
      const wait = Math.max(0, REQUEST_COOLDOWN_MS - (Date.now() - this.last));
      if (wait) {
        status(`Пауза между запросами: ${Math.ceil(wait / 1000)} с…`, {phase: 'cooldown', waitMs: wait});
        await waitForCooldown(wait, controller.signal);
      }
      check();
      this.last = Date.now();
      try { localStorage.setItem('city-eater-osm-last', String(this.last)); } catch {}
      timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
      status('Получаем реальные данные OpenStreetMap…', {phase: 'request', bytes: 0, maxBytes: limit});
      this.requestCount++;
      const response = await fetch(OSM_ENDPOINT, {
        method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
        body: new URLSearchParams({data: query}), signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) throw new Error('Источник временно ограничил запросы. Попробуй позже; готовые карты доступны сразу.');
        if ([502, 503, 504].includes(response.status)) throw new Error('Источник OSM перегружен. Попробуй позже; готовые карты доступны сразу.');
        throw new Error(`Источник OSM ответил ${response.status}. Попробуй позже.`);
      }
      const announced = Number(response.headers.get('content-length') || 0);
      if (announced > limit) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Данных слишком много для безопасной загрузки на телефоне. Выбери менее плотный участок.');
      }
      let text = '', bytes = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        try {
          for (;;) {
            check();
            const {done, value} = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) {
              await reader.cancel();
              throw new Error(`Превышен лимит ${(limit / 1048576).toFixed(0)} МБ для одного участка. Готовые карты доступны сразу.`);
            }
            text += decoder.decode(value, {stream: true});
            status(`Загружаем участок: ${(bytes / 1048576).toFixed(1)} МБ…`, {phase: 'download', bytes, maxBytes: limit});
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
      } else {
        text = await response.text();
        bytes = new TextEncoder().encode(text).byteLength;
        if (bytes > limit) throw new Error('Слишком большой ответ OSM.');
      }
      check();
      this.lastResponse = {bytes, elapsedMs: Date.now() - this.last, format};
      status('Ответ получен. Проверяем полноту данных…', {phase: 'downloaded', ...this.lastResponse});
      if (format === 'text') return text;
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Источник вернул неполный ответ. Данные не сохранены; попробуй позже.'); }
      if (data?.remark) throw new Error('Источник не успел завершить запрос. Частичные данные не используются. Попробуй позже.');
      if (!Array.isArray(data?.elements)) throw new Error('Некорректный ответ OSM.');
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw abortError();
        throw new Error('Источник не ответил за отведённое время. Попробуй позже.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.busy = false;
    }
  }
}
export function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
