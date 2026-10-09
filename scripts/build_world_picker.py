#!/usr/bin/env python3
"""Prepare the self-hosted city picker. No runtime geocoder or tile API.

python scripts/build_world_picker.py --download
Sources: Natural Earth public-domain 110m country boundaries, GeoNames CC-BY4
cities15000 (population >15000 or capitals). Search coverage is not
every settlement: arbitrary map coordinates remain selectable.
"""
import argparse, datetime, hashlib, io, json, pathlib, re, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/data/world'
SOURCES = {
    'countries': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson',
    'cities': 'https://download.geonames.org/export/dump/cities15000.zip',
}

def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

def build(countries_raw, cities_raw):
    OUT.mkdir(parents=True, exist_ok=True)
    countries = json.loads(countries_raw)
    for feature in countries['features']:
        p = feature['properties']
        feature['properties'] = {'name': p.get('NAME_EN') or p.get('NAME'), 'nameRu': p.get('NAME_RU') or p.get('NAME'), 'code': p.get('ISO_A3')}
    dump(OUT / 'land.geojson', countries)
    with zipfile.ZipFile(io.BytesIO(cities_raw)) as archive:
        rows = archive.read('cities15000.txt').decode('utf-8').splitlines()
    cities = []
    for line in rows:
        cols = line.split('\t')
        if len(cols) < 19 or cols[6] != 'P':
            continue
        lat, lon = float(cols[4]), float(cols[5])
        if abs(lat) > 84.9:
            continue
        aliases = list(dict.fromkeys(a.strip() for a in cols[3].split(',') if a.strip() and a not in (cols[1], cols[2]) and len(a) <= 120))
        # Russian UI: keep a Cyrillic alias first, then native-script alternatives.
        aliases.sort(key=lambda a: (0 if re.fullmatch('[А-Яа-яЁё\\W\\d]+', a) and re.search('[А-Яа-яЁё]', a) else 1 if re.search('[\u0400-\u04ff]', a) else 2 if re.search('[^\x00-\x7f]', a) else 3))
        aliases = aliases[:3]
        cities.append({'id': 'geonames:' + cols[0], 'name': cols[1], 'asciiName': cols[2], 'alternateNames': ','.join(aliases), 'country': cols[8], 'lat': round(lat, 5), 'lon': round(lon, 5), 'population': int(cols[14] or 0)})
    cities.sort(key=lambda city: (-city['population'], city['id']))
    dump(OUT / 'cities.json', cities)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    dump(OUT / 'provenance.json', {
        'preparedAt': now, 'script': 'scripts/build_world_picker.py',
        'countries': {'sourceUrl': SOURCES['countries'], 'sourceSha256': hashlib.sha256(countries_raw).hexdigest(), 'features': len(countries['features']), 'license': 'Public domain', 'licenseUrl': 'https://www.naturalearthdata.com/about/terms-of-use/', 'modifications': 'Removed non-display properties. Geometry unchanged.'},
        'cities': {'sourceUrl': SOURCES['cities'], 'sourceSha256': hashlib.sha256(cities_raw).hexdigest(), 'features': len(cities), 'license': 'CC-BY-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/', 'attribution': 'GeoNames', 'attributionUrl': 'https://www.geonames.org/', 'documentationUrl': 'https://download.geonames.org/export/dump/readme.txt', 'modifications': 'Retained populated-place IDs, names, country, coordinates and population. Retained up to three distinct aliases of at most 120 characters each, prioritizing Cyrillic then other non-ASCII spellings for the Russian UI. Coordinates rounded to five decimal places for the picker only. Sorted by population; excluded polar coordinates unsupported by the map.'},
        'limits': 'The city-name index covers GeoNames cities15000 (population over 15000 or capitals), not all settlements and not every spelling. Country outlines are generalized for navigation and are not city or gameplay boundaries. Any supported coordinate can be chosen without search.'
    })
    print(json.dumps({'countries': len(countries['features']), 'cities': len(cities), 'landBytes': (OUT / 'land.geojson').stat().st_size, 'citiesBytes': (OUT / 'cities.json').stat().st_size}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--countries-source', type=pathlib.Path)
    parser.add_argument('--cities-source', type=pathlib.Path)
    args = parser.parse_args()
    if args.download:
        def get(url):
            request = urllib.request.Request(url, headers={'User-Agent': 'CITY-EATER-world-data-preparation/0.1'})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(30 * 1024 * 1024)
                if len(data) == 30 * 1024 * 1024:
                    raise RuntimeError('Source exceeded download limit')
                return data
        build(get(SOURCES['countries']), get(SOURCES['cities']))
    elif args.countries_source and args.cities_source:
        build(args.countries_source.read_bytes(), args.cities_source.read_bytes())
    else:
        parser.error('Use --download or provide both --countries-source and --cities-source.')
