import {normalizeOSMSector} from './osm-import.js';

// The parent owns fetching, cancellation (worker.terminate), caching and retries.
// Importing the module in tests is safe; it has no main-thread side effects.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  self.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type !== 'normalize') return;
    const envelope = message.requestId === undefined ? {} : {requestId: message.requestId};
    try {
      const result = normalizeOSMSector(message.payload, message.sector, {
        source: message.source,
        onProgress: (progress) => self.postMessage({type: 'progress', ...envelope, ...progress}),
      });
      self.postMessage({type: 'result', ...envelope, result});
    } catch (error) {
      self.postMessage({type: 'error', ...envelope, error: {
        name: error?.name || 'Error', code: error?.code || 'IMPORT_FAILED',
        message: error?.message || 'Не удалось подготовить сектор OSM.',
      }});
    }
  });
}
