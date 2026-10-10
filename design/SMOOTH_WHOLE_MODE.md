# Smooth Whole models and 3 km districts · v0.10

## Scope

Districts are 3000×3000 local metres. The new v3 namespace starts fresh while
leaving older databases untouched. The 100,000 m² labelled goal, 500 m growth
cap, radius-sized center overrun and active-district-only reward remain.
There is no water-clipped-field implementation in this release.

Parts keeps its existing 2 m grid consumption and flat appearance. Whole uses
original certified polygons for fit, independent of all graphics, roofs and
heights. The same persistent mask prevents repeated rewards across both modes.

## Appearance

The near view uses a fixed mild orthographic tilt, at most π/7 (~26°). Ground
roads, building masks, original footprints and the hole ellipse share the exact
same axis-aligned Mercator vertical compression. This is not perspective or a
freely rotating camera. Heights lift roofs above that ground plane. Canvas2D
remains the primary runtime, without a WebGL requirement.

Whole detail is full at ≤0.65 m/CSS px and flat at ≥1.1 m/CSS px, with a smooth
transition between. Appearance eases over time, including the short return to
flat Parts mode. Original smooth footprints remain flat at distance wherever
certified geometry, known coverage and the drawing budget permit. No paths or
classification masks are rebuilt merely because the tilt/zoom factor changes.

Heights in OpenMapTiles are approximate map-rendering values. They may originate
from supplied height, storeys or an upstream default, and their provenance is
not retained by the tile schema. Mixed-height parts preserve their individual
shapes and levels. Missing/invalid heights or hide_3d outlines remain flat.
Excessively tall near roofs are visually capped at 96 CSS pixels; this has no
impact on containment, growth or score. Courtyard rings remain holes, with
appropriate courtyard-facing walls.

## Truthful mask replacement

For each candidate's original in-district footprint bits F and saved consumed
bits E, the visual classifier requires all F chunks to be known and covered.
Nonempty F with no eaten cells is untouched; no remaining cells is exhausted;
otherwise it is partial. Zero-cell and uncertain footprints are not assumed
eaten. Only selected untouched models replace their exact fallback cells.
Their original vector polygons are then drawn, removing the staircase fringe
without clearing unrelated neighbors or bounding-box interiors.

Partially bitten buildings retain their saved grid cut-outs, including after
switching modes or reloading. Uncertified seams, oversized/complex contours,
unloaded geometry and objects excluded by the drawing budget retain the honest
2D mask fallback. They do not vanish or become easier to eat. Whole buildings
still disappear atomically according to the existing reward mask. A complete
border footprint may extend outside the square; only active-square cells pay.

## Bounded work and ownership

- At most 128 nearby candidate models and 2 MiB of retained footprint bits.
- At most 8 objects per classification request; source API limit16 objects and
  1 MiB returned chunk bytes, with catalog generation checks.
- At most four preparation attempts and 6000 unique source vertices per frame,
  plus a 2 ms soft preparation deadline. Too-complex objects keep the fallback.
- Cached projected geometry is capped at 96,000 retained vertices; cache eviction
  and mode/catalog resets explicitly release Path2D cache ownership.
- At most 24,000 submitted drawing vertices per frame, counting fills, outline
  strokes, roof paths and wall quads, rather than only original source points.
- Rendering uses cached paths relative to immutable local origins. View changes
  alter affine matrices only; antimeridian entry uses the district's world copy.
- Late classifications are rejected after mode/catalog changes, disposal or a
  newer visible selection. Temporary budget exclusions recover after space frees.

These limits bound application components, not total browser/GPU memory. Existing
background tile image, worker, source byte and concurrency budgets remain.

## Verification gate

Automated checks cover exact 3 km cells/mask padding, fresh save namespaces,
source heights/parts, courtyard roofs/walls, original ground fit, partial masks,
mode switches, lifetime cache release, dense-view preparation bounds, dateline
entries, shared tilted projection, expanded viewport coverage and exact flat
endpoints. Actual staged near/far appearance, both-mode play, saves and boundary
behavior must pass before promotion. Desktop evidence is not a physical-phone
FPS claim.
