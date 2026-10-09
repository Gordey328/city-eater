# CITY EATER map database

© OpenStreetMap contributors. This database and its derived geometry and vector tiles are distributed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). See [OpenStreetMap copyright and attribution](https://www.openstreetmap.org/copyright).

Each level is a manually selected 10,000 × 10,000 metre arena in a local equirectangular coordinate system. X points east, Y north; origin is `manifest.center` (longitude, latitude), sphere radius 6,378,137 metres. The square extends from −5,000 to +5,000 in each local coordinate. This is an explicit local metric approximation, not a claim of survey-grade geodesic accuracy.

The raw OSM response, exact query, UTC OSM replication timestamp, source SHA-256, normalization rules and toolchain versions accompany each level. No invented buildings or supplemental game objects are included. `source.osm.json.gz` supplies the complete downloaded source excerpt; the separate playable chunks supply the derived database in editable JSON form. OSM completeness and accuracy depend on the contributors and the chosen area.

## Layout

- `catalog.json`: lightweight level list
- `<level>/manifest.json`: version, bounds, total playable area, spawn and spatial chunk index
- `<level>/chunks/x-y.json`: building geometry and gameplay metrics; each stable OSM ID appears once
- `<level>/map.pmtiles`: PMTiles v3 archive containing self-hosted MVT background layers
- `<level>/source.osm.json.gz`: unchanged original Overpass JSON response, gzip-compressed
- `<level>/provenance.json`: download and build provenance, metrics and licenses

The browser loads only a manifest, nearby chunks and PMTiles byte ranges. It does not query Overpass or public OSM tile servers. Source extracts are provided for reproducibility and licensing, not downloaded by the game.

## Coordinate and geometry contract

`x = R × radians(lon − originLon) × cos(radians(originLat))`

`y = R × radians(lat − originLat)`

`polygons` is always MultiPolygon nesting: polygon → ring → vertex → `[x,y]`; ring 0 is outer and subsequent rings are holes. `geometry` is the corresponding GeoJSON Polygon or MultiPolygon in longitude/latitude. Area subtracts courtyard holes. Radius and center describe the minimum enclosing circle of all exterior vertices, including every component. A 5 mm conservative allowance covers serialization rounding. The game checks actual vertex containment before absorption.

Buildings crossing the arena edge are excluded entirely. A relation supersedes its member ways. Duplicate normalized footprints are removed. Stable IDs are prefixed `w` (OSM way) or `r` (OSM relation), and saves additionally bind to the exact dataset version. Chunk allocation follows circle-center cell indices, while each index record includes the full geometry bounding box so large footprints can be loaded before their center cell is visible.

## Background layers

- `parks`: OSM park, garden, forest, grass, farmland and other selected natural/landuse areas; property `kind`
- `water`: OSM water, reservoir and basin polygons
- `roads`: OSM highway linework; property `kind` is the highway tag. `kind=waterway` identifies waterway centerlines and should be styled separately in blue

All layers use z9–15 MVT tiles; MapLibre may overzoom higher. No buildings are present in the background archive, so consumed buildings cannot remain in a basemap layer. The PMTiles archive is served from this repository alongside the gameplay data. Deployment must preserve HTTP byte ranges (`206 Partial Content`) and must not apply whole-file gzip transfer encoding. Same-origin hosting does not need CORS; cross-origin storage must permit the game origin and Range requests.

## Rebuild

From the project root, use Python 3.12 or newer:

```
python -m venv .venv-maps
. .venv-maps/bin/activate
python -m pip install -r scripts/map-requirements.txt
python scripts/build_maps.py
python scripts/validate_maps.py
# After publication, verify actual206 byte-range responses:
python scripts/verify_map_host.py https://YOUR-OWNER.github.io/YOUR-REPO/
```

This default rebuild is fully offline using the supplied extracts. To intentionally refresh a level, add `--download --level pushkin` or `--download --level gatchina`. Each explicit refresh performs one bounded query with a finite timeout and a custom User-Agent; it makes no automatic retries. Respect [Overpass usage guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), cache responses and do not put these queries into browser gameplay or unattended frequent jobs. A new source snapshot gets a new dataset version; saved progress must not be silently applied to a changed geometry set.

Tooling: [Protomaps PMTiles](https://github.com/protomaps/PMTiles), [Shapely](https://github.com/shapely/shapely), [mapbox-vector-tile](https://github.com/tilezen/mapbox-vector-tile), [Mercantile](https://github.com/mapbox/mercantile). The MVT format/library name does not imply use of Mapbox services or SDKs. All runtime mapping uses MapLibre and self-hosted PMTiles.
