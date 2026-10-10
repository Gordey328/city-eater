# Land-region gameplay · v0.11

The stable 3 km grid is now a selection envelope, not the score polygon. A tap
first loads or restores its immutable water snapshot; source preparation is
specified in WATER_BOUNDARIES.md. A water tap exposes selectable land outlines
and does not start building downloads. Each connected in-envelope land polygon
has a separately keyed run. Cancel remains available throughout preparation.

## Movement and ownership

The center stays on the active polygon or its permitted dry exterior halo.
Artificial square edges allow the current hole radius of overrun, up to 500 m.
Water does not get such an allowance. The rim can overhang water, but the center
cannot cross it. The known boundary domain covers the maximum 500 m halo before
entry, so growing later never invents dry coastline outside the original window.

A static indexed polygon domain subtracts both water and every other in-square
component. Thus even banks that reconnect outside the square cannot enter one
another's scoring areas. Continuous segment intersections and sliding prevent
fast input from tunneling thin water. Parts consumption follows each returned
slide segment, not a straight shortcut between its endpoints. Recovery of an
invalid start never awards a teleport sweep. Saved halo coordinates are checked
for reachability at the restored radius; valid coordinates remain exact.

Both modes share a fixed 2 m score mask intersected with the selected land.
Water, neighboring components and exterior halo bits are always excluded. Whole
fit still uses the complete original footprint, including water/edge portions;
only the active land intersection pays. Visual models likewise disappear based
on their in-region remaining bits. Frozen score clipping also validates consumed
bits during reload. No zero-cell region starts as an automatically completed run.

## Persistence and goals

The new database city-eater-land-3km-v4 leaves earlier databases untouched. Runs
bind envelope ID, immutable boundary ID, component ID, exact scoreable cell area,
frame and chosen goal. Boundary insertion is a read-and-write transaction: an
already saved coastline cannot be overwritten by a concurrent first-open result.
Restored geometry is validated and never refreshed from the network silently.

The default goal uses the largest of 100, 1000, 10000 or 100000 m² at most 5% of
scoreable land. Tiny areas use 100 m² or their smaller nonzero capacity. Players
can choose those simple goal options before a new run; changing the setting does
not alter an existing goal. This is a chosen building-area objective, not known
building stock or a land-cleared percentage. All map values explicitly say goal.
Continuing, returning to the map or selecting another island is never gated by
completion, including sparse areas where a chosen goal may be unattainable.

## Rendering and budgets

The active shoreline is drawn from cached immutable vector paths, including
interior water holes, on the same affine ground plane as roads and the hole.
Its exact source-detail boundary remains fixed as the camera zooms. Unknown
building-coverage tint is clipped to active land. The overview retains at most eight visible saved envelopes and 300,000 combined
water/land vertices, not every coastline ever visited. Saved-region lists use
lightweight run metadata. Saved-boundary topology validation is abortable and
worker-based in production. Map component geometry and projection paths are cached; idle frames do not reconstruct coast polygons.
Whole smooth/3D and Parts mask rendering retain their existing bounded budgets.

Tests cover coast, island, lake hole, river split, thin channels, exterior
reconnection traps, original Whole fit, scoring isolation, exact restored halo,
zero-cell rejection, transactional insertion and cancellation. Actual staged
source/startup and both-mode gameplay remain a release gate. Body bytes are not
compressed wire bytes, and desktop timings do not establish phone performance.
