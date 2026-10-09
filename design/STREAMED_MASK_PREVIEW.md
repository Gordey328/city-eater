# Streaming partial-building preview

This is an opt-in `?stream=1` preview. A normal URL retains the previous game. Existing whole-building saves remain in their original database and resume with their original rules, including the 80% goal. New preview runs are stored separately.

## Source verification gate

The adapter follows OpenFreeMap's documented native z14 OpenMapTiles layout. Initial direct source probes were unavailable, and the first actual app route later reached native coverage but failed WebGL initialization. These earlier limitations are historical, not the current Canvas result.

On 2026-10-09 at 18:13–18:24 UTC, the isolated Canvas candidate `b567714c` passed real remote tile delivery, worker decoding, rendered gameplay, normal movement/absorption, growth, save/reload/re-entry and cancellation. It uses no WebGL or source proxy. See [runtime validation](CANVAS_RUNTIME_VALIDATION.md). Physical-phone performance, controlled cold latency and live 500 m-radius gameplay remain unverified. Source failures still fail closed; fixture results are kept separate from the real-browser evidence.

- [OpenFreeMap integration](https://openfreemap.org/quick_start/)
- [Service terms](https://openfreemap.org/tos/)
- [Building tile generation](https://github.com/openmaptiles/planetiler-openmaptiles/blob/main/src/main/java/org/openmaptiles/layers/Building.java)
- [Tile version limitations](https://github.com/hyperknot/openfreemap#tile-versions)

There are no API keys, paid accounts, whole-city exports, background harvesting, endpoint rotation or Overpass fallbacks in this mode. Normal interactive basemap tiles and a small nearby native-detail working set are requested. Attribution remains visible.

## Gameplay changes

- The arena is still 10,000 × 10,000 local metric metres, with its saved projection basis and stable district ID.
- Buildings are consumed in portions. A fixed 2 m grid samples real footprint interiors, preserving courtyards and unioning overlaps. Each newly consumed cell rewards 4 m². This is an explicit game-resolution approximation, not a survey measurement.
- Saved consumption belongs to world-space cells, never unstable vector-feature IDs or geometry hashes. Reloaded tiles, feature regrouping and source revisions cannot reward the same cell again.
- The HUD shows eaten area and the next area milestone, never a percentage of an unknown district total. Reaching a milestone does not mean the district is fully cleared.
- Radius grows to an explicit 500 m prototype cap; area and score continue increasing. This bounds the detailed working set. There is no timer.
- Unknown regions block forward movement and show a loading notice. A failed tile is not an empty tile. Pause/resume offers an explicit retry after an error.

## True remote streaming

1. Fetch and validate the selected provider's TileJSON (native detail must be z14).
2. Request only the source tiles contributing to mask chunks near the chosen spawn, not the full 100 km² arena.
3. Decode PBF in a worker; preserve rings, clip buffered geometry to its canonical tile interior and union-rasterize footprints.
4. Mark a mask chunk known only after **every** contributing native tile succeeds. Only then can gameplay use it.
5. Prefetch toward movement. Repeated update calls continue useful in-flight jobs instead of starving them.
6. Draw the streets/water/parks using normal map LOD. Detailed building bitmaps follow the hole, independently of camera zoom. Eaten bits are subtracted only from changed resident bitmaps; no growing full-scene GeoJSON is rebuilt.

No complete-area denominator or all-arena cache commit gates entry. Storage commits the small run record and changed consumed chunks atomically. Native source data has bounded in-memory caching plus ordinary HTTP caching; this first preview does not promise offline source-tile reuse after page reload.

## Budgets

- Network concurrency: 2
- Native response: at most 4 MiB per tile; metadata at most 256 KiB
- Raw native cache: at most 24 tiles / 32 MiB
- Worker decoded cache: at most 24 tiles / 32 MiB estimated coordinate storage
- Confirmed coverage: at most 36 mask chunks, about 288 KiB of bit data
- Resident bitmap pixels: at most 9 MiB before browser canvas overhead
- Whole-arena eaten mask: at most 400 × 8,192 bytes, about 3.13 MiB including boundary padding
- Gameplay scan: at most 640 rows and a soft 3 ms slice per frame, resumed without duplicate rewards; stationary unchanged scenes skip scanning
- Canvas background: at most 16 cached 512 × 512 bitmaps (16 MiB pixels), rasterized once in a worker
- Canvas backing stores: DPR ≤2 and ≤4,194,304 pixels each

These are component budgets, not a measured total browser heap ceiling. Transfer buffers, temporary geometry operations, canvas/compositor storage and the browser add overhead. A source exceeding limits produces an explicit error, not fabricated or silently truncated geometry.

## Verification

Tests cover all 25 million valid mask cells, padding, circle/sweep oracles, chunk seams, overlapping footprints, two real OSM courtyards, date-line tiles, area quantization, unknown coverage, corrupted input, bounded requests/cache, cancellation, dirty bitmap work and atomic mask saves. A locally encoded PBF fixture uses an existing real Gatchina building; it is not represented as an OpenFreeMap live response.

`node scripts/benchmark_mask.mjs design/mask-benchmark.json` measures the actual bit-scanning and bitmap-update kernels at radii 18/100/500 m and 0/100/400 historical mask chunks. It does not measure network latency, graphics rendering or phone FPS. The earlier Luga full import's 26.8-second fetch is not comparable to fixture timings. The real Canvas run reports source bytes and entry timings separately. It is not a controlled cold comparison against that earlier Luga request.
