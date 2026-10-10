# Sharp background rendering · v0.9.1

This scoped change affects roads, water, parks and other background geometry only.
The source provider, native z14 gameplay geometry, 2 m building mask, Parts/Whole
rules, 5 km arena, goals, saves and boundary overrun are unchanged.

## Why the previous close-up was soft

The previous renderer expanded each complete native tile's 512×512 image when
the camera zoom exceeded 14. At radius 20 m, latitude 60°, 390×844 CSS pixels,
the existing camera uses zoom 16.29: that image was enlarged about 4.89 times.
Canvas smoothing softened those already-rasterized pixels.

## Small display tiles, same source data

- `visibleVisualTiles` selects a virtual display zoom up to 19 based on camera
  scale and the actual capped canvas pixel ratio. A worst-alignment viewport
  bound keeps the level stable while panning across tile edges; at most 16
  display tiles are requested.
- `visualTileSource` maps every virtual child to its real source ancestor at
  z≤14. There are no new above-native provider URLs. Sibling display tiles reuse
  the bounded shared raw-source cache and one decoded-parent worker entry.
- The worker crops and draws the vector commands directly into a 512×512 tile.
  Roads keep the same world width, polygons keep holes, and clipping preserves
  native tile cores. New detail changes pixel sharpness, not source geometry.
- An unchanged display tile is rasterized once while resident. Frame drawing
  remains cached `drawImage`; idle frames do not reconstruct paths.

## Explicit component budgets

Each background layer retains at most 16 fixed-size images: 16 MiB nominal RGBA.
A resident slot is reserved before rasterizing a replacement. One active job may
use up to 2 MiB nominal scratch/output surfaces; its offscreen backing canvas is
released after transfer. These are application component budgets, not a claim
about browser-wide heap/GPU allocations. Overview and gameplay have separate
bounded lifetimes during their transition.

The worker's decoded-command LRU is capped at four source parents and 8 MiB of
conservatively accounted arrays/objects. It does not retain PBF copies. A single
oversized decoded source is processed without entering the LRU. Fallback command
copies never detach cached buffers. Existing source concurrency, byte limits,
priority and cancellation isolation remain in force.

## Validation

Project tests cover crop transforms through z19, matching adjacent edges,
courtyard fill, invalid inputs, bitmap sizing, cache/transfer isolation, explicit
cleanup, bounded decoded parents and images, shared native source requests,
viewport/LOD stability, and repeated/cancelled navigation. The full game suite
also checks the unchanged consumption and persistence rules.

Actual close-up before/after comparison and both-mode gameplay are required on
an isolated published candidate before release. Physical-phone performance must
not be inferred from desktop or fixture tests. Native source simplification and
the separate 2 m building raster remain visible limits.
