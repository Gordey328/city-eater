# Source-height projection · candidate v0.11.1

## Composition and release gate

This candidate consists of the frozen water-arena candidate `cbf62ed3` plus the
explicitly requested removal of the building-height display limit. The original
water source archive remains unchanged. This is not a release of the water
candidate or permission to retry its cancelled publication action.

The height change affects only `building-models.js`, `whole-visual-layer.js` and
the renderer's model options. No footprint, source fetch, saved mask, shoreline,
mode, score or growth rule changes. Tests and version/build metadata accompany
those source changes.

## Projection and visibility

- The former 96 CSS px roof-lift compression is removed. Every valid model part
  uses its source height and minimum height in the same local Mercator scale.
- Existing near/far interpolation still flattens the models at distance. The
  map-derived height is approximate, and roofs remain footprint extrusions,
  not reconstructed architectural roof or spire models.
- Missing, non-finite, non-positive, greater-than-3660 m, invalid minimum-height,
  and `hide_3d` values retain the existing flat fallback. The 3660 m check is a
  malformed-data safeguard, not a normal screen-height cap.
- A visual-only spatial index includes the maximum projected northward extent
  of each already resident certified model. This prevents a tall wall or roof
  being lost solely because its ground footprint is below the viewport. It
  does not request a larger tile region or certify unknown building geometry.
- Exact per-frame culling uses full projected roof/wall bounds. Shadows remain
  bounded decorative offsets. Diagnostic `maxRoofLiftPixels` now reports the
  largest selected actual lift; `heightScale` is `source-metres`.
- Shadows are painted first, followed by each complete building in southward
  ground-depth order. A foreground flat building can cover a rear wall. This
  is the existing fixed orthographic painter model, not a depth-buffer renderer.

## Budgets and tests

All existing model count, emitted vertex, prepared path, classification-mask,
source tile, bitmap and backing-store budgets remain unchanged. Tall walls
use the same cached unit quad, rather than adding faces or allocating a large
height-dependent bitmap. Finite-arithmetic checks reject projection overflow
before submitting Canvas matrices. Canvas clips output to the existing viewport.

Automated tests cover heights through 3660 m, latitude/zoom/DPR combinations,
mixed parts and minimum heights, roof-only and wall-only visibility, ground
ordering, flat endpoints, source bounds immutability, partial-mask fallback,
finite matrices, dense idle settling and unchanged draw budgets. Actual staged
near/far tall-building appearance and both-mode play are still required before
promotion. No phone-performance claim is made.
