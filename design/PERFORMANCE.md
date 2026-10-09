# Absorption performance update

## Cause and fixes

The late-game cost was not a linear search through the complete eaten-ID history. IDs already used a Set. Growth widened the viewport and increased resident geometry, then each absorption start/completion rebuilt the whole resident FeatureCollection and sent it to MapLibre. Completions also serialized the complete increasing consumed-ID Set to IndexedDB. Every animated polygon vertex was reprojected through MapLibre every frame.

- MapLibre now receives coalesced stable-ID `updateData` additions/removals, at most once per 100 ms. Geometry is created only on chunk arrival. Unchanged frames send nothing. This uses the installed MapLibre 6.13.0 unique-ID differential source API; its worker updates the index incrementally and restricts tile invalidation to affected geometry.
- Absorbing objects reserve their IDs and immediately leave the active index/render set. Rewards still arrive after 420 ms and only once. The pending queue is bounded at 128; visual effects are independently bounded to 16 objects / 1,400 vertices, or 6 / 400 in low quality. Omitting a cosmetic effect never omits a reward.
- Animation Mercator offsets are cached once. North-up, zero-pitch frames use exact cached offsets and a scale instead of calling MapLibre projection for every vertex. Polygon interiors remain holes.
- Spatial queries reuse their output array and use per-entry visitation stamps. Containment checks loop exterior vertices directly and compare squared distances, keeping the original six-percent tolerance. Moving frames retain their containment checks; stationary unchanged frames need none.
- Consumed geometry is no longer retained in chunk arrays. Chunk residency retains IDs; detailed objects survive only while active or in the short pending animation queue. A stale in-flight chunk cannot repopulate a newer viewport.
- Checkpoints coalesce reward requests for two seconds, then use idle time when supported. Only then is the consumed Set serialized. Explicit pause, exit, level switch and completion flush immediately. Writes are sequential and snapshot positions are copied.
- Camera calls stop once the requested center/zoom settles. The nearest-target HUD now queries a local spatial neighborhood every 650 ms instead of scanning every resident object every 120 ms. It does not scan eaten history.

## Reproduce

Run `npm test`, `npm run build`, and `npm run bench:absorption`.
For a saved report: `node scripts/benchmark_absorption.mjs design/absorption-benchmark.json`.
The installed MapLibre worker index can be measured separately with `node scripts/benchmark_source_updates.mjs design/source-update-benchmark.json`.
Optional V8 CPU profile: `node --cpu-prof --cpu-prof-dir=/tmp scripts/benchmark_absorption.mjs /tmp/absorption-benchmark.json`.

The benchmark contains 48 combinations: real packaged Pushkin and Gatchina plus a 20,000-building synthetic stress dataset; radii 18 / 100 / 250 / 500 m; consumed histories 0 / 1,000 / 6,000 / 12,000 IDs. Radius and consumed history are deliberately varied independently to isolate their costs. Viewport: 390 × 844 CSS pixels. Legacy kernels reproduce the pre-update a6cd03e8 implementation. Five warmups precede each measured series. Raw medians, p95 and byte counts are in `absorption-benchmark.json`.

Representative measured CPU medians on this cloud Node runtime:

| Workload | Before | After |
|---|---:|---:|
| Pushkin, radius 500 m, 6,000 consumed, 5,033 resident objects: source payload construction + structured clone | 31.41 ms | 0.0031 ms |
| Same update payload size, 28 removed IDs | 1,721,266 bytes | 361 bytes |
| Gatchina, radius 500 m, 6,000 consumed, 5,378 resident objects: source construction + clone | 27.56 ms | 0.0032 ms |
| Same update payload size, 28 removed IDs | 1,554,203 bytes | 362 bytes |
| Pushkin radius 500 m, no consumed history: spatial query + exact fit checks | 0.355 ms | 0.072 ms |
| 120 save requests with 12,000 consumed IDs: cumulative serialization + clone | 220.85 ms / 120 writes | 0.68 ms / 1 write |
| Projection arithmetic for the same 3,853 real Pushkin animation vertices | 0.705 ms | 0.034 ms |

After the security-motivated upgrade to MapLibre 6.13.0, its installed @maplibre/geojson-vt 6.1.2 worker tile index was measured again, with identical geometry, 20 batches of 28 removals and 3×3 tile reads at the radius-derived zoom. At radius 500 m / 6,000 consumed IDs, cumulative worker-index CPU changed from 493.59 to 263.39 ms in Pushkin and 406.98 to 219.42 ms in Gatchina. This smaller improvement matters: source-payload speedups are not equivalent to end-to-end rendering speedups. Full results and methodology are in `source-update-benchmark.json`.

Allocation evidence: the old source path allocated one Feature and properties object per resident unabsorbed building, plus full collection arrays and cloned coordinates on each update. The new removal path allocates only the changed-ID list, with zero Feature/property/coordinate objects for removals. No full-scene snapshot is taken by the gameplay loop. The V8 profile confirms significant clone/garbage-collection work in the legacy stress workload.

These timings are component CPU/structured-clone microbenchmarks, not whole-frame performance, IndexedDB disk latency, worker tiling time or mobile FPS. They must not be presented as a claimed frame-rate multiplier. Real iPhone/Safari and Android/Chrome tests remain necessary. The available cloud browser has WebGL disabled, and an attempted separate test-browser launch was blocked by the environment, so GPU/gameplay frame-rate validation was not performed here.

## Correctness checks

Automated tests cover complete contour fit and holes, no building collision blocking, radius-driven zoom, one-time rewards in batches above the visual/pending caps, streamed reserve/consume persistence, stable render deltas, stationary scan suppression, stale-load cancellation, sequential/coalesced saves, copied save positions, and exact Mercator animation offsets including the date line. Independent QA also tested real-data reward integrity and consumed-history-independent simulation cost.

## MapLibre 6 compatibility verification

The renderer now uses named namespace imports because MapLibre 6 no longer exposes a default ESM export. Source updates return Promises and are handled without blocking the animation loop. Style construction is a pure module validated against the installed style specification for both prepared PMTiles and imported GeoJSON backgrounds, including water-line filters and OSM attribution.

`tests/renderer-compatibility.test.js` also instantiates the actual installed `GeoJSONSource` and worker tile-index implementation without WebGL: initial load, queued additions/removals, unknown-ID removal, stable IDs and Promise completion all pass. The upgraded aggregate suite passed 88 tests and the production bundle built successfully. This adds source/API compatibility evidence; it still does not constitute GPU or mobile FPS validation.
