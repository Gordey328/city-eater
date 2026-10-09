/** Pure, bounded city selection and campaign geometry. No network calls. */
const R = 6378137;
const DEG = Math.PI / 180;
export const SECTOR_SIZE = 10000;
export const MAX_CAMPAIGN_SECTORS = 1600;
const round = value => Math.round(value * 1e7) / 1e7;
const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;

export function normalizeCoordinate(center) {
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) throw new TypeError('Укажи долготу и широту числами.');
  if (Math.abs(center[1]) > 84.9 || Math.abs(center[0]) > 540) throw new RangeError('Карта поддерживает широты от −84,9° до 84,9°.');
  return [round(wrap(center[0])), round(center[1])];
}

/** Bounds may cross the date line: west > east. Returned east is unwrapped. */
export function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new TypeError('Нужны четыре координаты границ области.');
  let [west, south, east, north] = bounds;
  if (west < -180 || west > 180 || east < -180 || east > 180 || south < -84.9 || north > 84.9 || south >= north) throw new RangeError('Проверь границы выбранной области.');
  if (east < west) east += 360;
  if (east <= west || east - west > 180) throw new RangeError('Область слишком широкая. Выбери границы города вручную.');
  return [west, south, east, north];
}

/** This is explicitly a manually chosen extent, never an inferred city boundary. */
export function deriveManualBounds(center, widthKm = 20, heightKm = 20) {
  center = normalizeCoordinate(center);
  if (![widthKm, heightKm].every(value => Number.isFinite(value) && value >= 1 && value <= 1000)) throw new RangeError('Размер области: от 1 до 1000 км по каждой стороне.');
  const halfLat = heightKm * 500 / (R * DEG);
  const halfLon = widthKm * 500 / (R * DEG * Math.cos(center[1] * DEG));
  // Preserve metric dimensions. Rounding edges to 1e-7 degrees can expand an
  // exact 10 km selection by millimetres and incorrectly allocate another row
  // or column. Campaign identity separately rounds its hash inputs.
  const bounds = [wrap(center[0] - halfLon), center[1] - halfLat, wrap(center[0] + halfLon), center[1] + halfLat];
  normalizeBounds(bounds);
  return bounds;
}

/** Candidate metadata only. A bounding box is not the administrative polygon. */
export function makeBoundaryQuery(center) {
  const [lon, lat] = normalizeCoordinate(center);
  return `[out:json][timeout:20][maxsize:16777216];is_in(${lat},${lon})->.a;rel(pivot.a)["boundary"="administrative"]["admin_level"~"^(2|3|4|5|6|7|8|9|10)$"];out tags bb;`;
}

/** Full OSM geometry for one arena only, including complete multipolygon members.
 * Server maxsize is a memory budget, NOT a response-size limit. The caller must
 * separately cap received bytes and honor cancellation/cooldowns.
 */
export function makeSectorQuery(sector) {
  const center = normalizeCoordinate(sector?.center);
  if (sector?.arenaSize !== undefined && sector.arenaSize !== SECTOR_SIZE) throw new RangeError('Запрашивать можно только один сектор 10 × 10 км.');
  const bounds = deriveManualBounds(center, 10.2, 10.2);
  const [west, south, east, north] = bounds;
  const boxes = west <= east ? [[south, west, north, east]] : [[south, west, north, 180], [south, -180, north, east]];
  const filters = [
    'wr["building"]["building"!="no"]',
    'way["highway"]',
    'wr["natural"~"^(water|wood|wetland|scrub|grassland)$"]',
    'wr["landuse"~"^(forest|grass|meadow|recreation_ground|village_green|allotments|orchard|farmland|reservoir|basin)$"]',
    'wr["leisure"~"^(park|garden|golf_course|nature_reserve|recreation_ground)$"]',
    'way["waterway"]',
  ];
  return '[out:json][timeout:60][maxsize:134217728];\n(\n' + boxes.flatMap(box => filters.map(filter => `${filter}(${box.join(',')});`)).join('\n') + '\n);\nout body geom;';
}

const comparable = value => String(value || '').normalize('NFKD').toLocaleLowerCase().replace(/\p{M}/gu, '').trim();
export function parseBoundaryCandidates(osm, selectedCityName = '') {
  if (osm?.remark) throw new Error('Сервис границ не завершил запрос. Попробуй позже или выбери область вручную.');
  if (!Array.isArray(osm?.elements)) throw new TypeError('Сервис вернул некорректные границы.');
  const result = [], seen = new Set(), expected = comparable(selectedCityName);
  for (const element of osm.elements) {
    if (element.type !== 'relation' || !Number.isSafeInteger(element.id) || element.id <= 0 || seen.has(element.id) || !element.bounds) continue;
    const tags = element.tags || {}, b = element.bounds;
    if (tags.boundary !== 'administrative') continue;
    const bounds = [b.minlon, b.minlat, b.maxlon, b.maxlat];
    try { normalizeBounds(bounds); } catch { continue; }
    const name = tags['name:ru'] || tags.name || tags['name:en'] || `Граница OSM ${element.id}`;
    const names = [tags.name, tags['name:ru'], tags['name:en'], tags.official_name, tags.short_name];
    const match = !!expected && names.some(value => comparable(value) === expected);
    result.push({ id: `r${element.id}`, osmId: element.id, name, adminLevel: Number(tags.admin_level) || null, bounds, source: 'osm-boundary-bbox', exactNameMatch: match, sourceUrl: `https://www.openstreetmap.org/relation/${element.id}` });
    seen.add(element.id);
  }
  return result.sort((a, b) => Number(b.exactNameMatch) - Number(a.exactNameMatch) || (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]));
}

function hash(value) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(36);
}

/**
 * A city campaign covers its chosen extent with complete 10 km × 10 km arenas.
 * Rows share exact latitude edges. Each row uses its midpoint latitude for the
 * same local-equirectangular metre convention as gameplay. Longitude edges join
 * exactly within a row; rows can have different column counts. There is no
 * positive-area overlap or uncovered area inside the chosen extent. Edge cells
 * extend beyond it. An administrative envelope includes some surrounding land.
 */
export function makeCampaign({ name, title: requestedTitle, center, bounds, boundaryId = null, source, coverageKind, maxSectors = MAX_CAMPAIGN_SECTORS }) {
  source = source || (coverageKind === 'osm-boundary-envelope' ? 'osm-boundary-bbox' : 'manual');
  center = normalizeCoordinate(center);
  const extent = normalizeBounds(bounds);
  if (!['manual', 'osm-boundary-bbox'].includes(source)) throw new TypeError('Неизвестный источник границ.');
  if (source === 'osm-boundary-bbox' && !/^r[1-9]\d*$/.test(String(boundaryId))) throw new TypeError('Для границ OSM нужен идентификатор отношения.');
  if (!Number.isSafeInteger(maxSectors) || maxSectors < 1 || maxSectors > 10000) throw new RangeError('Некорректный предел числа секторов.');
  const [west, south, east, north] = extent;
  const dLat = SECTOR_SIZE / (R * DEG);
  const rows = Math.ceil((north - south) / dLat - 1e-10);
  if (rows > maxSectors || south + rows * dLat > 84.95) throw new RangeError('Область слишком большая или близка к полюсу. Уточни её границы.');
  const id = `city-${boundaryId || 'manual'}-${hash(JSON.stringify(bounds.map(round)))}`;
  const title = String(name || requestedTitle || 'Выбранная область').trim().slice(0, 120) || 'Выбранная область';
  const sectors = [];
  for (let row = 0; row < rows; row++) {
    const s = south + row * dLat, n = s + dLat, lat = (s + n) / 2;
    const dLon = SECTOR_SIZE / (R * DEG * Math.cos(lat * DEG));
    const columns = Math.ceil((east - west) / dLon - 1e-10);
    if (sectors.length + columns > maxSectors) throw new RangeError(`В области больше ${maxSectors} секторов. Выбери меньшие границы, не весь регион.`);
    for (let col = 0; col < columns; col++) {
      const w = west + col * dLon, e = w + dLon;
      sectors.push({ id: `${id}/s${row}-${col}`, campaignId: id, title: `${title} · ${row + 1}:${col + 1}`, center: [wrap((w + e) / 2), lat], bounds: [wrap(w), s, wrap(e), n], arenaSize: SECTOR_SIZE, row, col });
    }
  }
  const distance = sector => {
    const dx = wrap(sector.center[0] - center[0]) * Math.cos(center[1] * DEG);
    return dx * dx + (sector.center[1] - center[1]) ** 2;
  };
  sectors.sort((a, b) => distance(a) - distance(b) || a.row - b.row || a.col - b.col);
  sectors.forEach((sector, index) => { sector.index = index; });
  return { id, schemaVersion: 1, title, center, bounds: [...bounds], source, coverageKind: source === 'osm-boundary-bbox' ? 'osm-boundary-envelope' : 'manual', boundaryId, extentLabel: source === 'osm-boundary-bbox' ? 'Прямоугольник административных границ OSM' : 'Область, выбранная вручную', boundaryIsPolygon: false, sectorSize: SECTOR_SIZE, rows, sectorCount: sectors.length, sectors };
}

/** Lazy progress: unprepared sectors have no known building-area denominator. */
export function summarizeCampaign(campaign, progress = {}) {
  let completed = 0, prepared = 0, consumedArea = 0, knownTotalArea = 0;
  for (const sector of campaign.sectors) {
    const value = progress instanceof Map ? progress.get(sector.id) : progress[sector.id];
    if (!value) continue;
    if (value.completed || value.won) completed++;
    if (Number.isFinite(value.totalBuildingArea) && value.totalBuildingArea >= 0) {
      prepared++; knownTotalArea += value.totalBuildingArea;
      consumedArea += Math.min(value.totalBuildingArea, Math.max(0, Number(value.consumedArea) || 0));
    }
  }
  return { completed, total: campaign.sectors.length, prepared, consumedArea, knownTotalArea, completionPercent: campaign.sectors.length ? completed / campaign.sectors.length * 100 : 0, knownAreaPercent: knownTotalArea ? consumedArea / knownTotalArea * 100 : 0, wholeCityAreaKnown: prepared === campaign.sectors.length };
}
