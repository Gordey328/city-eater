/** Shared, versioned arena rules. District coordinates are metres from centre. */
export const ARENA_SIZE_METRES = 3000;
export const ARENA_HALF_METRES = ARENA_SIZE_METRES / 2;
export const ARENA_SIZE = ARENA_SIZE_METRES;
export const ARENA_HALF = ARENA_HALF_METRES;
export const ARENA_AREA_M2 = ARENA_SIZE_METRES ** 2;
export const DISTRICT_GOAL_AREA_M2 = 100_000;
export const RADIUS_CAP_METRES = 500;

/** Let the rim reach the entire active square, including boundary footprints. */
export function boundaryOverrun(radius) {
  if (!Number.isFinite(radius)) throw new RangeError('Expected finite radius');
  return Math.min(RADIUS_CAP_METRES,Math.max(0,radius));
}
export function clampArenaPosition(position,radius) {
  if (!Array.isArray(position)||position.length!==2||!position.every(Number.isFinite))
    throw new TypeError('Expected a finite two-dimensional position');
  const limit=ARENA_HALF_METRES+boundaryOverrun(radius);
  return position.map(value=>Math.max(-limit,Math.min(limit,value)));
}
