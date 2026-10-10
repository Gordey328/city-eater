# Whole-building mode

Whole mode uses complete connected footprint components from the native building
layer. It shares the same persistent, 2 m world-area consumption mask as Parts.
Switching modes, rebuilding a catalog, revisiting a tile, or changing source IDs
cannot reward an already-consumed cell again.

## What constitutes a complete component

`whole-building.js` decodes each native z14 Polygon component separately, including
its courtyard rings. It ignores feature IDs: one source feature may pack several
unrelated buildings into a MultiPolygon. Layer extents are decoded dynamically.

Reconstruction happens in unwrapped native-tile coordinates before projection to
local metres. Each fragment retains two geometries:

- The original buffered source polygon, used as seam evidence.
- Its intersection with the canonical tile interior, used for the final union.

Fragments across adjacent tile interiors join only when they have overlapping,
positive-length seam intervals, compatible rendering properties, and a
positive-area intersection of their original buffered polygons. Every interval
on every touched native edge must have matching continuation evidence. A missing
tile, a valid-empty neighbor, a mismatching continuation, or an unresolved edge
leaves the entire component ineligible. A successful download alone does not
certify an edge fragment as a house. The union preserves holes and removes
canonical-tile/buffer duplicates.

Within one tile, positive-area overlap joins duplicate outlines and overlapping
building parts into one conservative complex. Mere shared edges or point contact
do not join separate Polygon components, so adjacent terraced houses remain
separate when the source supplies them separately. Reused IDs do not join them.
An exact natural edge on a native seam can be conservatively withheld when there
is no reliable continuation evidence; reconstruction never guesses a completion.

This is a geometric completeness check for the supplied native source, not a
cadastral or semantic house-identity guarantee. A connected outline already
merged upstream cannot be reliably separated into its original houses. The
native source is also quantized; the test does not recover survey precision.

## Fit, border access, and rewards

The active arena is 3,000 × 3,000 m. The hole center may move beyond an arena edge
by its current radius, capped at 500 m. Native catalog queries cover the entire
hole circle's bounding box plus 150 m, including the region outside the arena.
The catalog never clips a building to the active arena for eligibility.

Whole mode requires every exterior vertex of the original certified footprint
to fit inside the current circle, with no fit enlargement. Previously eaten
Parts do not reduce that requirement. Oversized buildings remain passable.
Rasterization then clips rewards to the active arena's mask. Outside geometry
is used only to test the complete contour; it never modifies neighboring saves.
Adjacent districts own disjoint half-open geographic interiors.

The regression fixture includes a 900 m wide footprint with only 50 m inside the
square. It fits at a center 400 m outside; the full roughly 72,000 m² footprint
is retained, while only its roughly 4,000 m² in-square strip is rewardable.

Raster work is asynchronous. Before a result is committed, `StreamingGame`
rechecks active mode, current catalog membership, consumption generation, and
current original-footprint fit. Pause, mode changes, disposal, and stale catalogs
invalidate pending results. `consumeBuildingChunks` validates every required
coverage chunk before any mutation; unknown coverage makes the whole operation
incomplete. Commit and reward run together without an intervening await.

## Render heights and smooth footprint models

The game receives rendering heights, not height provenance or survey data. The
[OpenMapTiles schema](https://openmaptiles.org/docs/schema/#building) calls these
values approximate. The current [Planetiler implementation](https://github.com/openmaptiles/planetiler-openmaptiles/blob/main/src/main/java/org/openmaptiles/layers/Building.java)
uses explicit height when available, otherwise levels times 3.66, otherwise a
5 m default, then rounds upward. Minimum height similarly uses a tag, minimum
levels, or zero and rounds downward. The resulting tile does not say which path
was used. A supplied value of 5 m is therefore not proof of a measured height.
Colour can also be material-derived. `hide_3d` marks outlines to keep flat.

`building.modelParts` preserves attribute-specific polygons, including courtyard
holes, with `heightMeters`, `minHeightMeters`, sanitized `colour`, `hide3d`,
`heightProvenance`, and `minHeightProvenance`. Every valid supplied height is
`source-approximation`. Missing/invalid heights become null and stay flat;
missing minimum height uses zero with `ground-fallback` provenance. A negative,
non-numeric, non-finite, or inverted minimum height invalidates extrusion rather
than inventing a clamp. Heights above the defensive 3,660 m bound also stay flat.
The renderer must honor `hide3d` even when a height value is present.

Uniform attributes reuse the exact authoritative polygons reference. Mixed
complexes retain separate attribute-group unions; a tall inner part does not
raise the whole footprint to that height. Top-level height fields are null with
`mixed` provenance for such complexes. None of these model attributes changes
seam signatures, ground fit, complete-footprint certification, or reward geometry.
A model complexity fallback empties `modelParts` and records `modelFallback`;
the original certified gameplay footprint remains available for flat drawing.

`rasterizeSeparately(currentCatalogObjects)` returns individual `{id,chunks}`
footprint masks for classification against the persistent consumed mask. It
accepts at most 16 current objects and preflights at most 1 MiB of combined mask
output before any raster work. The worker and stream check generations; stale
results reject as AbortError. The existing union-raster consumption API is
unchanged. Visible renderer/cache limits are additional to these worker limits.

## Bounded loading and memory

`WholeBuildingStream` borrows the existing `TileSource`. It does not dispose the
shared source and does not recursively fetch neighbors to chase an open complex.
Catalogs rebuild only when the required native-tile set or source-key changes.
An unchanged set preserves the catalog array and ephemeral IDs. A new set clears
readiness; obsolete catalog and raster results cannot attach. Failed regions
require explicit retry rather than an animation-loop retry storm.

Limits in the implementation:

- At most 64 native tiles and 32 MiB per catalog input batch.
- Two native fetch subscribers at a time, using the source's shared two-request
  network limit, cache, deduplication, and native-over-visual priority.
- At most 300,000 decoded/output vertices and 30,000 input fragments.
- At most 500,000 spatial-grid references and 250,000 pair comparisons.
- At most 12,000 certified output components.
- At most 64 render attribute groups per component and 300,000 additional model
  vertices per catalog; excess rendering complexity falls back flat.
- Components wider or taller than the 1,000 m maximum hole diameter are omitted
  from the consumable catalog; the regular map/coverage still contains them.
- Raster batches accept at most 256 components and 36 mask chunks. The current
  game integration requests at most four nearby components per job.
- Worker timeout: 30 seconds; error latch retention: 16 failed catalog windows.

Exceeding a limit fails closed. It does not produce a smaller certified fragment.
The native source retains its own bounded 24-tile/32 MiB raw cache. Catalog input
buffers transfer to the worker; reconstructed catalog geometry is bounded by the
vertex/output limits. There is no additional raw-tile disk cache or area-wide
prefetch.

The source URL signature is advisory, not an immutable OSM snapshot identifier.
Mixed explicit source keys are rejected, and a changed key rebuilds the catalog.
Unannounced upstream revisions under the same URL cannot be identified with
certainty. Persistent consumed cells remain source-independent either way.

## Validation and evidence boundaries

`tests/whole-building.test.js` covers touching versus overlapping components,
reused IDs, buffered seams and courtyards, missing contributors, the outside
900 m border case, stale worker results, cancellation, update starvation, and
same-window reuse. Height tests cover approximate/default uncertainty, hidden
outlines, mixed-height wings, separate-raster caps, and render-only complexity
fallbacks without changed gameplay. A genuine saved Gatchina OSM relation (`r1659230`) is locally
encoded into native PBF tiles and reconstructed with both courtyards intact and
less than 0.5% area difference. This is a real-geometry adapter fixture, not a
claim that it is a captured live OpenFreeMap payload.

Independent QA also exercises four-way seams including the date line, source
revision rejection, atomic mask commits, mode switches, and actual game-runtime
races. Browser/native-provider success and performance must be recorded separately
from fixture results, through the normal application path.
