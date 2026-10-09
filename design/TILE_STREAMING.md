# Native-tile coverage prototype

Status: native streaming and Canvas2D background support are implemented. Initial cloud source probes were blocked; subsequent permitted app navigation loaded real native tiles and produced coverage. The b567714c candidate subsequently passed actual desktop Canvas2D entry, movement/absorption, save/reload and cancellation; see [runtime validation](CANVAS_RUNTIME_VALIDATION.md). Local fixture tests do not establish live network latency or mobile rendering performance. No alternate endpoints or access workarounds are used.

## Public API

`TileSource` in `src/tile-source.js`:

- `getMetadata({signal} = {})` returns validated `tiles`, `minzoom`, `maxzoom`, `nativeZoom`, attribution and advisory `sourceKey`.
- `loadNativeTile(z, x, y, signal)` accepts only native z14 and returns one native PBF `ArrayBuffer`, canonical coordinates, key, source key and byte count. Every caller receives its own transferable buffer copy; the raw LRU remains intact.
- `loadVisualTile(z, x, y, signal)` accepts visual zooms 0–14 within metadata limits, uses the same cache/endpoint, and queues behind native gameplay.
- `retryFailures({clearCache = false} = {})` permits an explicit retry. Errors otherwise remain latched.
- `dispose()` aborts this session's requests and clears its raw LRU.

Use one source instance per stream session and share it with its visual background. Concurrent requests for the same tile are deduplicated. Subscribers cancel independently: cancelling visual work cannot abort a native subscriber; the underlying request aborts only when all subscribers have cancelled. Session cancellation calls `dispose()`.

`TileStream` in `src/tile-stream.js`:

- Constructor: `{manifest, mask, onChange, onStatus, source?, workerFactory?}`.
- `prepare(position, radius)` confirms the hole plus 100 m and returns metadata.
- `update(position, radius, direction = [0, 0])` follows the hole plus 150 m and at most 100 m directional lookahead. It does not follow camera zoom.
- `covers(position, radius)` checks only authoritative arena-intersecting mask chunks. Radius is bounded to 500 m; callers must clamp any extra movement guard accordingly.
- `retry(position, radius)` explicitly clears failed/corrupt cached source responses and restarts worker decoding.
- `dispose()` aborts, terminates the worker, evicts coverage and prevents late attachment.
- `onChange(key, bits)` announces a known coverage chunk; `onChange(key, null)` tells the renderer to clear an evicted chunk.
- `source`, `metadata` and `stats` are available for diagnostics.

The mask contract is `ingestCoverage(key, Uint8Array)`, `getCoverageChunk(key)` and `evictCoverage(key)`. Consumed bits are independent and survive coverage eviction.

## Correctness boundary

The playable arena remains exactly 10 × 10 km in its existing local projection. Reward identity is a fixed world-space 2 m cell, not a tile feature ID or a clipped building fragment. Native tile feature IDs may be reused or absent; grouped MultiPolygons are allowed.

For each 512 m coverage chunk:

1. Enumerate every native source tile intersecting the chunk, respecting the arena projection and antimeridian.
2. Fetch all contributors successfully before publishing any known coverage for that chunk. HTTP failures, timeouts, malformed PBF, geometry limits and missing contributors stay unknown. They never imply empty space.
3. Decode only the building layer, using its actual extent. Preserve polygon grouping and courtyard rings. Reject invalid geometry rather than fabricate it.
4. Clip tile buffers to each tile's canonical interior, transform to arena-local metres, and union-rasterize occupied cell centres. Overlap, duplicates and tile seams therefore do not multiply occupied area.
5. Ingest the complete 8192-byte coverage bitmask. Only the consumption engine awards new occupied cells; courtyard/background cells remain zero.

A valid successful PBF with no building layer is known empty building coverage. It is distinct from an HTTP error or malformed response. A single coverage chunk becomes known independently of the rest of the arena. No full-area denominator or whole-arena completion is inferred.

The stream uses one pump reading the latest desired set. Frequent updates cannot repeatedly invalidate a useful in-flight chunk. A result for a no-longer-desired region is not attached. The next job always comes from the current hole-local neighborhood.

## Fixed budgets

- Native source zoom: exactly 14, checked against TileJSON before activation
- Concurrent network requests: 2
- One tile: at most 4 MiB decoded bytes
- TileJSON: at most 256 KiB
- Per-request timeout: 20 seconds, with no automatic retry
- Raw native LRU: at most 24 tiles / 32 MiB
- Decoded geometry LRU: at most 24 tiles / 32 MiB conservative coordinate accounting
- Worker job: one coverage chunk; at most 32 MiB input and 300,000 vertices
- Coverage residency: at most 36 chunks, 8192 bytes each
- Radius: at most 500 m; area and score can continue beyond radius saturation

These are component budgets, not a claim that total browser RAM is capped at 32 MiB. In-flight buffers, MapLibre, rendering textures and persistent consumed bits use additional memory. Raw native tiles are not persisted in a custom disk cache in this iteration. Browser HTTP caching may help, but is not guaranteed.

## Source configuration and limits

The documented TileJSON URL is `https://tiles.openfreemap.org/planet/latest`. Tile templates are read from a successful response, validated to stay on the official `tiles.openfreemap.org` host, and never guessed or rotated. The native layer is `building`. A source advertising an unexpected native zoom fails closed.

A URL signature is not an immutable dataset revision: dated OpenFreeMap URLs can fall back to newer content. Consumed world cells therefore remain consumed through source changes; no reward history is keyed to source feature IDs. Any live payload/schema compatibility still requires a permitted real-source validation pass.

Official documentation:

- [OpenFreeMap tile versions](https://github.com/hyperknot/openfreemap#tile-versions)
- [OpenMapTiles building schema](https://openmaptiles.org/docs/schema/#building)

## Verified locally

`tests/tile-stream.test.js` covers:

- Strict source metadata, native zoom, endpoint validation and canonical wrapping
- Pending-request deduplication, two-request concurrency, transferable-copy isolation and bounded LRUs
- HTTP/byte-limit/malformed-PBF errors, explicit retry and valid-empty distinction
- Dynamic vector extent, duplicate features, buffer clipping, seam-spanning courtyard union
- Unknown frontier, arena edges, radius cap, cancellation and stale-result exclusion
- Continuous update calls without in-flight starvation
- Existing real Gatchina relation `r1659230`, with two courtyards, locally encoded as native-zoom PBF and decoded back into masks. The test requires retained courtyard holes and less than 2% changed occupied cells from vector-tile quantization compared with the original footprint.

The real-geometry replay uses the repository's existing OSM geometry. It is not an OpenFreeMap response or a live service benchmark.

## Canvas2D background tiles

`VisualTileLayer` in `src/visual-tile-source.js` accepts `{source, onChange, onError}` and provides `ensure([{z,x,y}])`, `get(z,x,y)`, explicit `retry()`, `dispose()` and `stats`. The shared source remains owned by the whole game, not the visual layer. Pan changes the desired set and discards obsolete output; it does not abort shared tile downloads.

The layer runs at most one visual fetch and one visual worker job at a time. Native gameplay takes queue priority; the shared source still permits at most two total network requests. It retains at most sixteen 512×512 tile images (16 MiB nominal RGBA pixels), plus transient rasterization data. Existing raw-source/geometry budgets are unchanged.

The worker decodes real landcover, selected green landuse, park, water, waterway and transportation geometry. It clips drawing to the canonical tile core and preserves polygon holes. Buildings are never painted into background tiles, so consumed building cells cannot reappear beneath the gameplay mask. Labels are omitted in this first Canvas2D style.

Where worker OffscreenCanvas is supported, each tile is rasterized off the UI thread and returned as an ImageBitmap. Otherwise bounded geometry commands return to the main thread, rasterize once into a cached Canvas2D tile, and are discarded. Frame rendering uses cached image draws rather than replaying polygons. Bitmap resources are closed on eviction/disposal; fallback canvases are released.

`tests/visual-tiles.test.js` verifies visual/native zoom separation, native queue priority, shared-subscriber cancellation, raster clipping/holes, omission of buildings, offscreen and fallback paths, cache residency, stale visual results, and shared-source lifecycle. These tests are source-independent; actual visible rendering/input must also pass through the delivered Canvas2D path.
