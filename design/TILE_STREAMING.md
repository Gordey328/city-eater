# Native-tile coverage prototype

Status: implemented and fixture-tested for the optional partial-building preview. The live OpenFreeMap endpoint has **not** been verified in the current execution environment: access was blocked. Do not treat the local tests as proof of live source availability, payload contents, network latency or mobile rendering performance. No alternate endpoints or access workarounds were used.

## Public API

`TileSource` in `src/tile-source.js`:

- `getMetadata({signal} = {})` returns validated `tiles`, `minzoom`, `maxzoom`, `nativeZoom`, attribution and advisory `sourceKey`.
- `loadNativeTile(z, x, y, signal)` returns one native PBF `ArrayBuffer`, canonical coordinates, key, source key and byte count. Every caller receives its own transferable buffer copy; the raw LRU remains intact.
- `retryFailures({clearCache = false} = {})` permits an explicit retry. Errors otherwise remain latched.
- `dispose()` aborts this session's requests and clears its raw LRU.

Use one source instance per stream session. Concurrent requests for the same native tile are deduplicated. The source is not a general independently-cancellable multi-subscriber service: the initiating request's signal owns its fetch; session cancellation must call `dispose()`.

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
