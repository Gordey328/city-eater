import {makeSectorQuery} from './city-campaign.js';

/** One complete building index for exactly the selected 10 km arena. Public
 * Overpass is not used as a scrolling-map tile backend: no prefetch, geographic
 * subdivision or per-building requests. The existing 100 m selection margin
 * and full relation geometry are preserved; the importer rejects edge crossings.
 */
export function makeBuildingSectorQuery(sector) {
  return makeSectorQuery(sector, {includeBackground: false});
}
