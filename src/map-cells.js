/** Stable, bounded map selection. Pure helpers; no network or storage writes.
 *
 * Free-map rows are 10 km tall in the game's spherical equirectangular metre
 * convention. Each row uses an integer number of equal longitude columns, so
 * it closes at the date line without gaps, overlaps, or a clipped final arena.
 * Its fixed projection latitude makes every arena exactly 10,000 × 10,000 m in
 * that row's metre basis. It is chosen near the row midpoint, not at a global
 * reference latitude. These are LOCAL PLANAR squares, not geodesic squares:
 * true east–west spherical distance varies slightly across/within a row. Rows
 * can meet at T-junctions. Neither panning, zooming nor city names changes IDs.
 *
 * Supplying a campaign selects only its existing sectors, by reference. Saved
 * legacy geometry, IDs and projection conventions are never migrated here.
 */
import { SECTOR_SIZE } from './city-campaign.js';

const R = 6378137;
const DEG = Math.PI / 180;
const CIRCUMFERENCE = 2 * Math.PI * R;
const LATITUDE_STEP = SECTOR_SIZE / (R * DEG);
const ROWS_PER_HEMISPHERE = Math.floor(84.9 / LATITUDE_STEP);
const MIN_ROW = -ROWS_PER_HEMISPHERE;
const MAX_ROW = ROWS_PER_HEMISPHERE - 1;
const MAX_CAMPAIGN_INPUT = 10000;
export const MAP_GRID_VERSION = 'world-row-equirectangular-v1';
export const MAP_MAX_LATITUDE = ROWS_PER_HEMISPHERE * LATITUDE_STEP;
export const MAX_VISIBLE_MAP_CELLS = 400;
const wrap = longitude => longitude >= -180 && longitude < 180 ? longitude : ((longitude + 180) % 360 + 360) % 360 - 180;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// Round-off at an exactly shared edge must not change its canonical owner.
const snapInteger = value => Math.abs(value - Math.round(value)) < 1e-10 ? Math.round(value) : value;

function coordinate(value) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) throw new TypeError('Нужны долгота и широта числами.');
  if (Math.abs(value[1]) > 90) throw new RangeError('Широта должна быть от −90° до 90°.');
  return [wrap(value[0]), value[1]];
}

function campaignSectors(campaign) {
  if (!Array.isArray(campaign?.sectors)) throw new TypeError('В сохранённой области нет списка районов.');
  if (campaign.sectors.length > MAX_CAMPAIGN_INPUT) throw new RangeError('В сохранённой области слишком много районов.');
  return campaign.sectors;
}

function rowGeometry(row) {
  const south = row * LATITUDE_STEP;
  const north = (row + 1) * LATITUDE_STEP;
  const midpoint = (south + north) / 2;
  const columns = Math.min(Math.floor(CIRCUMFERENCE / SECTOR_SIZE), Math.max(1, Math.round(CIRCUMFERENCE * Math.cos(midpoint * DEG) / SECTOR_SIZE)));
  // Integer columns close the circle; this exact basis preserves 10 km arenas.
  const projectionLatitude = Math.sign(midpoint) * Math.acos(columns * SECTOR_SIZE / CIRCUMFERENCE) / DEG;
  return { row, south, north, midpoint, columns, projectionLatitude };
}

function worldCell(row, col) {
  const grid = rowGeometry(row);
  const west = -180 + col * 360 / grid.columns;
  const east = -180 + (col + 1) * 360 / grid.columns;
  const campaignId = `map-v1-r${row}-c${col}`;
  return {
    id: `${campaignId}/s0-0`, campaignId, title: 'Район 10 × 10 км',
    center: [(west + east) / 2, grid.midpoint],
    bounds: [west, grid.south, east, grid.north],
    arenaSize: SECTOR_SIZE, projectionLatitude: grid.projectionLatitude,
    gridVersion: MAP_GRID_VERSION, gridRow: row, gridColumn: col,
    row: 0, col: 0, index: 0,
  };
}

/** Existing bounds win. Old centre-only sectors use their original metre basis.
 * Returns an unwrapped east longitude, so date-line widths remain small.
 */
export function mapCellBounds(cell) {
  coordinate(cell?.center);
  let bounds = cell.bounds;
  if (bounds === undefined) {
    const [longitude, latitude] = coordinate(cell.center);
    const basis = cell.projectionLatitude ?? latitude;
    if (!Number.isFinite(basis) || Math.abs(basis) > 84.9) throw new RangeError('Некорректная широта проекции района.');
    const dx = SECTOR_SIZE / 2 / (R * DEG * Math.cos(basis * DEG));
    const dy = LATITUDE_STEP / 2;
    bounds = [longitude - dx, latitude - dy, longitude + dx, latitude + dy];
  }
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new TypeError('Некорректные границы района.');
  const [west, south, east, north] = bounds;
  let width = east - west;
  if (width < 0) width = ((width % 360) + 360) % 360;
  if (width <= 0 || width > 180 || south >= north || south < -90 || north > 90) throw new RangeError('Некорректные границы района.');
  const start = wrap(west);
  return [start, south, start + width, north];
}

/** Half-open containment: west/south included, east/north excluded. This gives
 * shared edges one owner; +180° and −180° identify the same canonical point.
 */
export function cellContainsCoordinate(cell, value) {
  const [longitude, latitude] = coordinate(value);
  const [west, south, east, north] = mapCellBounds(cell);
  let offset = longitude - west;
  if (offset < 0) offset += 360;
  // Equivalent wrapped coordinates can differ by an ulp at the western edge.
  // Use the same tiny normalized edge snap as point-to-grid selection; without
  // it, a negative ulp becomes a nearly 360° offset and loses the shared edge.
  if (snapInteger((360 - offset) / (east - west)) === 0) offset = 0;
  const x = snapInteger(offset / (east - west));
  const y = snapInteger((latitude - south) / (north - south));
  return x >= 0 && x < 1 && y >= 0 && y < 1;
}

/** Return the containing cell, never a nearest guess. With campaign, points
 * outside its stored sectors return null. Free-map polar caps also return null.
 */
export function getMapCellAt(value, { campaign = null } = {}) {
  const point = coordinate(value);
  if (campaign) {
    // Boundary ties in old overlapping grids are deterministic, independent of
    // saved nearest-first sector order. Do not mutate the campaign's array.
    return campaignSectors(campaign).filter(cell => cellContainsCoordinate(cell, point)).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
  }
  const row = Math.floor(snapInteger(point[1] / LATITUDE_STEP)) || 0;
  if (row < MIN_ROW || row > MAX_ROW) return null;
  const grid = rowGeometry(row);
  const col = clamp(Math.floor(snapInteger((point[0] + 180) / 360 * grid.columns)), 0, grid.columns - 1);
  return worldCell(row, col);
}

function sphericalDistanceSquared(a, b) {
  const dLatitude = (a[1] - b[1]) * DEG;
  const dLongitude = wrap(a[0] - b[0]) * DEG;
  // The haversine is monotonic in spherical distance; no acos/asin needed.
  return Math.sin(dLatitude / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLongitude / 2) ** 2;
}

/** Nearest centre, explicitly separate from containment; null for empty campaigns. */
export function nearestMapCell(value, { campaign = null } = {}) {
  const point = coordinate(value);
  let candidates;
  if (campaign) candidates = campaignSectors(campaign);
  else {
    const row = clamp(Math.floor(snapInteger(point[1] / LATITUDE_STEP)), MIN_ROW, MAX_ROW);
    candidates = [];
    for (let nearby = Math.max(MIN_ROW, row - 1); nearby <= Math.min(MAX_ROW, row + 1); nearby++) {
      const { columns } = rowGeometry(nearby);
      const col = Math.floor((point[0] + 180) / 360 * columns);
      for (const offset of [-1, 0, 1]) candidates.push(worldCell(nearby, (col + offset + columns) % columns));
    }
  }
  let nearest = null, best = Infinity;
  for (const cell of candidates) {
    const distance = sphericalDistanceSquared(point, coordinate(cell.center));
    if (distance < best || (distance === best && String(cell.id) < String(nearest?.id))) { nearest = cell; best = distance; }
  }
  return nearest;
}

function viewportBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new TypeError('Нужны четыре координаты видимой карты.');
  const [west, south, east, north] = bounds;
  if (south >= north || south < -90 || north > 90 || west === east) throw new RangeError('Некорректные границы видимой карты.');
  let width = east - west;
  if (Math.abs(width) >= 360) width = 360;
  else if (width < 0) width = ((width % 360) + 360) % 360;
  const start = wrap(west);
  const intervals = width === 360 ? [[-180, 180]] : start + width <= 180 ? [[start, start + width]] : [[start, 180], [-180, start + width - 360]];
  return { south, north, intervals };
}

function intersectsViewport(cell, viewport) {
  const [west, south, east, north] = mapCellBounds(cell);
  if (south >= viewport.north || north <= viewport.south) return false;
  return viewport.intervals.some(([left, right]) => [-360, 0, 360].some(shift => west + shift < right && east + shift > left));
}

/** Bounded all-or-none visible grid. Too-dense views return no arbitrary sample.
 * Bounds may cross ±180°, span the world, or use unwrapped MapLibre longitudes.
 * At most 1,890 row descriptors are considered before allocating any cells.
 */
export function getVisibleMapCells(bounds, { campaign = null, maxCells = MAX_VISIBLE_MAP_CELLS } = {}) {
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > MAX_CAMPAIGN_INPUT) throw new RangeError('Предел видимых районов: от 1 до 10000.');
  const viewport = viewportBounds(bounds);
  if (campaign) {
    const cells = campaignSectors(campaign).filter(cell => intersectsViewport(cell, viewport));
    return { cells: cells.length <= maxCells ? cells : [], tooDense: cells.length > maxCells, totalCount: cells.length };
  }
  const firstRow = Math.max(MIN_ROW, Math.floor(snapInteger(viewport.south / LATITUDE_STEP)));
  const lastRow = Math.min(MAX_ROW, Math.ceil(snapInteger(viewport.north / LATITUDE_STEP)) - 1);
  const ranges = [];
  let totalCount = 0;
  for (let row = firstRow; row <= lastRow; row++) {
    const { columns } = rowGeometry(row);
    const rowRanges = viewport.intervals.map(([west, east]) => [
      clamp(Math.floor(snapInteger((west + 180) / 360 * columns)), 0, columns - 1),
      clamp(Math.ceil(snapInteger((east + 180) / 360 * columns)) - 1, 0, columns - 1),
    ]).sort((a, b) => a[0] - b[0]);
    // A narrow full-width cell can occur in both split date-line intervals.
    const merged = [];
    for (const [first, last] of rowRanges) {
      const previous = merged.at(-1);
      if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
      else merged.push([first, last]);
    }
    for (const [first, last] of merged) { totalCount += last - first + 1; ranges.push({ row, first, last }); }
  }
  if (totalCount > maxCells) return { cells: [], tooDense: true, totalCount };
  const cells = [];
  for (const { row, first, last } of ranges) for (let col = first; col <= last; col++) cells.push(worldCell(row, col));
  return { cells, tooDense: false, totalCount };
}

/** GeoJSON splits old date-line arenas instead of drawing a world-spanning edge. */
export function mapCellFeature(cell, properties = {}) {
  const [west, south, east, north] = mapCellBounds(cell);
  const polygon = (left, right) => [[[left, south], [right, south], [right, north], [left, north], [left, south]]];
  const geometry = east <= 180 ? { type: 'Polygon', coordinates: polygon(west, east) } : { type: 'MultiPolygon', coordinates: [polygon(west, 180), polygon(-180, east - 360)] };
  return { type: 'Feature', id: cell.id, properties: { id: cell.id, campaignId: cell.campaignId, title: cell.title, ...properties }, geometry };
}

/** Stable single-square campaign, compatible with the existing loader/cache.
 * Look up campaignId in storage first to retain saved progress. Titles are only
 * presentation and cannot change the square's identity or projection.
 */
export function makeMapCellCampaign(cell, { title = 'Район 10 × 10 км' } = {}) {
  if (cell?.gridVersion !== MAP_GRID_VERSION || !Number.isSafeInteger(cell.gridRow) || !Number.isSafeInteger(cell.gridColumn)) throw new TypeError('Нужен район мировой сетки.');
  if (cell.gridRow < MIN_ROW || cell.gridRow > MAX_ROW || cell.gridColumn < 0 || cell.gridColumn >= rowGeometry(cell.gridRow).columns) throw new RangeError('Район вне мировой сетки.');
  const canonical = worldCell(cell.gridRow, cell.gridColumn);
  const label = String(title).trim().slice(0, 120) || 'Район 10 × 10 км';
  const sector = { ...canonical, title: label };
  return {
    id: canonical.campaignId, schemaVersion: 2, gridVersion: MAP_GRID_VERSION,
    projectionLatitude: canonical.projectionLatitude, title: label,
    center: [...canonical.center], bounds: [...canonical.bounds], source: 'manual',
    coverageKind: 'manual', boundaryId: null,
    extentLabel: 'Район, выбранный на карте', boundaryIsPolygon: false,
    sectorSize: SECTOR_SIZE, rows: 1, columns: 1, sectorCount: 1, sectors: [sector],
  };
}
