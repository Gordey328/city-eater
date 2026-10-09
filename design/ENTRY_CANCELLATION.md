# Entry cancellation regression matrix

Run `npm run test:entry` for the focused entry/loader/gesture matrix, or `npm test` for all checks.

The application keeps its existing generation-token structure. The regression harness reads and executes the actual `selectLevel` and empty-sector result functions from `src/main.js` with deferred dependencies, rather than testing a separate model. At every asynchronous boundary, it replaces the active selection before resolving the old operation, then verifies the old result cannot overwrite the new run, manifest, campaign, state or start gameplay.

Covered entry boundaries:

- Previous-run save
- Prepared-map metadata
- Custom-sector loading
- Campaign readback
- Saved run and incompatible-run deletion
- Renderer initialization
- Nearby geometry chunks
- Last-selected-level save
- Explicit restart checkpoint
- View transition
- Verified-empty progress write
- Error progress write

The production SectorLoader/OverpassClient tests additionally exercise the inner network, raw worker normalization, cancellation, quota and IndexedDB write/readback boundaries. Successful loading becomes ready only after the full building index is validated and persisted. Cancelled or partial input never supplies a gameplay denominator.

MapExplorer tests cover cancelled cache reads followed by a new selection, closing the map while metadata is pending, BODY-focus Escape, queued tap cancellation and the delayed map fade. The fade captures selection ownership and rechecks it after its timer, so an obsolete transition cannot hide a replacement map. Gesture tests cover pan/pinch, pointer cancellation, lost capture, window blur and hidden visibility.

No production network request is needed for this matrix. It does not claim WebGL rendering or real-phone FPS validation.
