# Bounded buildings-first loading

The playable square remains 10 × 10 km. Internal 1 km fragments are a rendering/cache detail, not smaller arenas.

## Current path

1. Check the exact sector ID and geometry-version-compatible IndexedDB cache. Old complete enriched records remain usable with no network request.
2. For an uncached chosen square, make one bounded buildings-only query to the existing selected Overpass endpoint. Do not request other squares on pan, zoom or hover. Do not split the square into many provider requests or rotate providers.
3. Receive at most 40 MiB of decoded response data with a 110-second client timeout. Preserve the 30-second client cooldown. Count decoded bytes honestly; HTTP compression makes them different from wire traffic. Cancel oversized response bodies.
4. Pass the bounded raw JSON string to the import worker, avoiding parsing and cloning a large OSM object on the UI thread. Reject malformed JSON, runtime-error remarks and incomplete building contours. Preserve full multipolygon members and courtyard holes.
5. Only after the complete response is normalized do the full eligible-building area and 80% goal become authoritative. Geometry and local chunks are persisted together; readiness is reported after save/readback. Unknown or failed data must never be shown as an empty square. Explicitly partial/unknown cache records are not compatible.
6. During play, the existing repository reads only nearby normalized fragments from local IndexedDB. A later visit reuses the stored square. Cancelling download/normalization does not start another request automatically.

The query was already using `out body geom`; recursive node removal is not a new optimization. This iteration saves bandwidth by omitting initial roads, water and landcover. Uncached low-data sectors must be labeled accordingly. Prepared maps and older enriched caches retain their background. No synthetic substitute background or buildings are generated.

## Status contract

The existing `load(campaign, sector, onStatus)` API is retained. The callback receives optional second-argument details:

- `phase`: cache, cooldown, request, download, downloaded, normalize, save, ready
- `bytes`: decoded response bytes during download; no estimated total is invented
- `preparationProgress`: worker preparation fraction, separate from gameplay progress
- `buildingIndexComplete`: false until ready; ready also carries `buildingCount`, `totalBuildingArea`, `fromCache` and `backgroundRequested`

New manifests record `dataCoverage.buildingIndex = 'complete'` and `dataCoverage.background = 'not-requested'`. Provenance records `queryScope = 'buildings-only'` and `backgroundRequested = false`. Completeness refers to the successful OSM query and accepted playable contours, not every real building on Earth.

## Measured offline sample

The saved Luga response, OSM timestamp 2026-10-09T12:44:35Z, was replayed with and without background selectors. No new provider request was made.

| Measure | Full sample | Buildings only |
| --- | ---: | ---: |
| Comparable compact JSON bytes | 6,224,839 | 3,285,291 |
| OSM elements | 9,395 | 6,533 |
| Playable buildings | 6,510 | 6,510 |
| Eligible footprint area, m² | 1,809,335.419 | 1,809,335.419 |

Comparable compact JSON decreased by **47.22%**. Every normalized building ID, footprint, courtyard, radius and area is identical. This is not a live network-speed, compressed-wire-byte or memory benchmark, and other locations will differ. The old raw response was 8,451,793 bytes including formatting.

Reproduce with an existing complete raw response and its sector descriptor:

```sh
node scripts/compare_sector_payload.mjs raw-overpass.json sector.json
```

## Why not geographic progressive HTTP loading yet?

Many little Overpass requests add scheduling overhead, duplicate edge geometry and a long cooldown chain. Playing before the full building index exists also requires explicit unknown-region masks, stable cross-chunk relation ownership and a provisional goal. The current smaller single request is simpler and preserves a trustworthy denominator.

Optional background enrichment is deliberately deferred. It needs an independent background cache/version and deduplication against the building database; the current dataset fingerprint includes background content, so a naïve reimport can invalidate saved progress. No hidden second request is made now.

If arbitrary-city use grows beyond a small prototype, use prebuilt spatial archives or a suitable owned/licensed data backend. Public Overpass is not an unlimited production tile service. Preserve a complete index for the selected square, then range-read nearby geometry; do not fetch the whole world on the client.

## References

- [Overpass output formats](https://dev.overpass-api.de/overpass-doc/en/targets/formats.html): full geometry versus center/bounds/metadata outputs.
- [Overpass public-resource guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html): bounded use, load shedding and why public instances are unsuitable as an unrestricted application backend. Its numeric quotas describe the documented instances, not a promise about the selected VK endpoint.
