/** Current user rules: buildings never block movement; only the arena edge does. */
export function advanceHole(position,displacement,radius,arenaHalf=5000) {
  const limit=Math.max(0,arenaHalf-radius);
  const clamp=value=>Math.max(-limit,Math.min(limit,value));
  return [clamp(position[0]+displacement[0]),clamp(position[1]+displacement[1])];
}
