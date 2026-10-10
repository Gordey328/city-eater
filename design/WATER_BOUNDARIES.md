# Frozen surface-water boundaries

A new district first prepares a fixed native-z14 water snapshot for the complete
3 × 3 km envelope plus a 500 m halo on every side. Its known domain is therefore
4 × 4 km in the district's local planar projection. Gameplay and selecting a
land component wait for every contributing tile. No missing tile, failed body,
unknown water class, or unconfirmed source capability is interpreted as dry land.

## Source semantics and limits

The existing OpenFreeMap TileSource and its shared cache/two-request scheduler
are reused. TileJSON must explicitly list the `water` layer. Within a successful
MVT, an absent water layer is valid dry coverage. Only water geometry is decoded;
building geometry and the complete district's building index are not prepared.
The transport still downloads the full MVT, including its other layers.

Included surface classes are ocean, lake, river and pond. Explicit swimming_pool
and dock classes are excluded: the latter combines wet and dry docks. Water
marked bridge, tunnel or aqueduct is also excluded as grade-separated. Unknown
classes/crossings reject preparation. Intermittent mapped surface water remains
water; the source does not describe its current wet/dry state. No size cutoff or
invented coastline is used. Waterway centerlines without mapped water polygons
do not supply an authoritative surface width; no fabricated river-width buffer
is added around them.

The [OpenMapTiles water schema](https://github.com/openmaptiles/openmaptiles/blob/master/layers/water/water.yaml)
distinguishes pools and describes these classes. Its
[source mapping](https://github.com/openmaptiles/openmaptiles/blob/master/layers/water/mapping.yaml)
does not select ordinary amenity=fountain alone. However, a fountain also tagged
natural=water may arrive as generic lake: the tile does not retain a fountain
marker, so that ambiguous case cannot be excluded reliably. The snapshot policy
records this limitation. The
[Planetiler source](https://github.com/openmaptiles/planetiler-openmaptiles/blob/main/src/main/java/org/openmaptiles/layers/Water.java)
uses OSM-derived coastline water polygons for high-detail oceans.

Preflight rejects more than 64 native tiles before any metadata/tile request.
There is no lower-detail fallback. Full input PBFs are capped at 32 MiB per
boundary and 4 MiB per tile, with at most two concurrent source subscribers.
Geometry is capped at 300,000 vertices, 30,000 source features and 2,048 land
components. Worker operations time out after 30 seconds. Exceeding a limit leaves
the district unavailable rather than producing a partial land definition.

A sample offline plan at longitude 30 requires 6 tiles at latitude 0, 9 at 30/45,
16 at 60, 36 at 70, 56 at 75, 110 at 80 and 361 at 84.9 degrees. Counts vary with
tile alignment and projection basis. The last two examples are unsupported by
the fixed cap.

## Geometry and persistence contract

`WaterBoundaryLoader({manifest,source,onStatus})` provides:

- `prepare()` → complete, deeply frozen boundary snapshot
- `rasterizeRegion(boundary,regionId)` → `{chunks,scoreAreaM2,preparedGeometry}` for one selection
- `validate(boundary)` → worker-side strict cached validation, without source requests
- `retry()` → explicit retry of a failed preparation
- `dispose()` → cancels this loader, without disposing the shared source

Canonical tile interiors remove buffered overlaps before water polygons are
united. Islands/courtyard-like holes remain holes in water. The in-square land
is the exact polygon difference between the envelope and that water union.
Each connected polygon becomes one independently selectable region, including
its internal lake holes. Its representative point is chosen on an interior
scanline; a naive centroid could lie in water or outside a concave island.

The snapshot contains schemaVersion, envelopeId, id/hash, sourceKey, detailZoom,
complete, policy, center, projectionLatitude, arenaBounds, domainBounds,
knownTileCount, waterPolygons, regions and diagnostics. Each region has id,
polygons, areaM2, bounds and representativePoint. Canonical local coordinates
are rounded to one micrometre, far below native tile quantization, with fixed
ring winding/start and component ordering. A SHA-256 hash binds the envelope,
frame, source signature, detail, policy and canonical water geometry.

`validateWaterBoundary(boundary,manifest)` is the pure asynchronous validator
and makes no network request. Browser store reads/writes use the `water-validate`
worker operation (or loader `validate`) so Boolean reconstruction stays off the
UI thread; pure direct execution is retained for Node tests. It checks the complete frame, limits and canonical hash, re-derives all
land components and rejects altered/partial/inconsistent records. It returns a
detached frozen snapshot. Saved boundaries remain fixed on restore rather than
silently following an updated provider coastline. The source URL signature is
not itself a guarantee that all provider content is permanently immutable.

Selected-region rasterization runs in the worker, not for every component in
advance. At most 36 × 8,192 mask bytes are returned. The worker also prepares
the selected component’s static allowed-halo geometry, so the main thread only
indexes it and does not repeat polygon Boolean work. Loader validation requires
the exact complete bbox chunk set, unique keys, zero arena-edge padding, and a
popcount matching the returned area before installing any masks. `scoreAreaM2` is the exact count of
included 2 m cell centers times 4; it can differ slightly from geometric area.
Water, neighboring components and the exterior halo do not own scoring cells.
Movement uses the true polygon boundary separately from this scoring grid.

## Evidence and diagnostics

`fullMvtBytes` records all source PBF body bytes used, including cached tiles.
`sharedSourceBytesDelta` records the shared source counter change during entry,
which can include other consumers. Fetch body counts are decoded payload bytes,
not a measurement of HTTP compression or wire traffic. Water-only decode time,
reconstruction time, tile count and whole preparation time are also recorded.

Existing browser evidence before this feature measured 157,444 body bytes for
two native MVTs and 379,137 for seven native MVTs. A 16-tile extrapolation is about
0.87–1.26 MB; it is not a measurement of the new complete water window. Actual
entry cost must be captured through the staged application's normal path.

Fixtures cover dry land, oceans, river splits, islands, pools/docks/crossings,
missing/malformed tiles, explicit water capability, high-latitude preflight,
source revision mismatch, stable hashes, tampered saves, cancellation and the
date line. A saved real OSM Silver Lake outline (way/62808325, Gatchina) is
locally encoded into native PBF tiles; reconstructed water area differs by less
than 0.5%. This is an adapter fixture, not a captured live-provider payload.
