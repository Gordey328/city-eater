# Streamed-mode Canvas renderer

## Scope

The opt-in `?stream=1` mode uses production Canvas2D for both its map overview and gameplay. Existing prepared maps and old whole-building saves keep the existing MapLibre renderer. The candidate was staged independently and passed genuine desktop browser gameplay before promotion.

## Rendering and source ownership

- Real OpenFreeMap/OpenMapTiles vector tiles provide roads, water, parks and land cover. No generated scenery or synthetic building positions are used.
- A worker decodes and rasterizes each background tile once to a 512 × 512 bitmap. OffscreenCanvas is used when available; otherwise the worker returns bounded drawing commands, rasterized once into a cached main-thread canvas.
- Buildings are excluded from background tiles. The remaining-building occupancy mask is rendered above them, so consumed areas cannot reappear in the background.
- The gameplay source is shared by native building coverage and background reads. Native requests have higher priority. Cancellation is subscriber-specific, and one visual layer cannot dispose another consumer's source.
- The overview has a separate source lifetime. Diagnostics report its traffic separately rather than silently excluding it from startup costs.
- Controlled attribution links identify OpenStreetMap, OpenMapTiles and OpenFreeMap.

## Budgets

- At most two concurrent requests per source instance; one visual fetch/raster job at a time. The overview and entering game have separate lifetimes and can briefly overlap.
- At most 16 cached visual bitmaps (16 MiB uncompressed pixel storage). Visible background zoom is reduced if necessary to keep the requested set within this budget.
- Existing 24-tile / 32 MiB native byte/decoded limits and 36 resident gameplay-mask regions remain in force.
- Canvas device-pixel ratio is capped at 2, or 1 for low quality. Each backing store is additionally capped at 4,194,304 pixels. Projection remains in CSS pixels.
- Camera changes redraw cached images independently of tile membership. Idle background frames do not repeat rasterization.
- Gameplay detail remains fixed at native z14 and the 2 m mask. Camera zoom does not expand the physics working set.

## Honest coverage

Unknown gameplay chunks have a translucent amber tint. They are never rewarded or treated as verified empty. The hole waits at an unknown frontier until authoritative native coverage is ready. The 10 × 10 km arena outline, area milestones, persistent once-only mask and explicit 500 m growth cap remain unchanged.

## Verification

The frozen initial Canvas candidate `b567714c` passed 261 project tests and production bundling, including both worker entries. Independent tests verify cached-camera redraw, real-Mercator high-latitude rows, dateline viewport coverage, shared cancellation and bitmap lifetime. These are component checks, not proof of live gameplay or physical-phone frame rate.

The earlier actual cloud-browser app route successfully downloaded real native coverage and reached renderer initialization, where its WebGL2 capability failed. The Canvas candidate subsequently passed actual entry, normal movement and absorption, pause, save, reload and re-entry. See [runtime validation](CANVAS_RUNTIME_VALIDATION.md) for the measured scope and limits. No endpoint proxy, security setting or browser flag was changed.
