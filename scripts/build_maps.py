#!/usr/bin/env python3
"""Build CITY EATER's self-hosted OSM datasets. No data is invented.

python -m pip install -r scripts/map-requirements.txt
python scripts/build_maps.py --download --level pushkin
python scripts/build_maps.py --download --level gatchina
Without --download, rebuilds from the committed OSM extracts.
"""
from __future__ import annotations
import argparse, collections, gzip, hashlib, importlib.metadata, json, math, pathlib, sys, time, urllib.parse, urllib.request
import mercantile
import mapbox_vector_tile
import shapely
from shapely.geometry import Polygon, MultiPolygon, LineString, MultiLineString, Point, box, mapping
from shapely.ops import polygonize, unary_union, transform
from shapely.strtree import STRtree
from pmtiles.writer import write as write_pmtiles
from pmtiles.tile import Compression, TileType, zxy_to_tileid

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/data'
R = 6378137.0
ARENA = 10000
CHUNK = 1000
ENDPOINT = 'https://overpass-api.de/api/interpreter'
GREEN_NATURAL = {'wood','wetland','scrub','grassland'}
GREEN_LANDUSE = {'forest','grass','meadow','recreation_ground','village_green','allotments','orchard','farmland'}
GREEN_LEISURE = {'park','garden','golf_course','nature_reserve','recreation_ground'}

def is_green(tags):
 return tags.get('natural') in GREEN_NATURAL or tags.get('landuse') in GREEN_LANDUSE or tags.get('leisure') in GREEN_LEISURE
LEVELS = [
 {'id':'pushkin','title':'Пушкин','subtitle':'Дворцы, парки и тихие кварталы','center':[30.4158,59.7229]},
 {'id':'gatchina','title':'Гатчина','subtitle':'Озёра, частные дома и большой город','center':[30.1420,59.5665]},
]

def compact(path, obj):
 path.parent.mkdir(parents=True,exist_ok=True)
 path.write_text(json.dumps(obj,ensure_ascii=False,separators=(',',':')),encoding='utf-8')

def rounded(coords, digits):
 if isinstance(coords,(float,int)): return round(coords,digits)
 return [rounded(x,digits) for x in coords]

def projector(center):
 kx=R*math.cos(math.radians(center[1]))*math.pi/180
 ky=R*math.pi/180
 return (lambda x,y,z=None:((x-center[0])*kx,(y-center[1])*ky)), (lambda x,y,z=None:(x/kx+center[0],y/ky+center[1]))

def polygon_only(g):
 if g.is_empty:return None
 if not g.is_valid:g=shapely.make_valid(g)
 if g.geom_type=='Polygon':return g
 if g.geom_type=='MultiPolygon':return g
 if hasattr(g,'geoms'):
  polys=[]
  for sub in g.geoms:
   p=polygon_only(sub)
   if p is not None:polys.extend(list(p.geoms) if p.geom_type=='MultiPolygon' else [p])
  return unary_union(polys) if polys else None
 return None

def osm_geometry(el, polygon=True):
 """Assemble complete OSM ways/multipolygon relations; preserve interior rings."""
 if el['type']=='way':
  pts=[(p['lon'],p['lat']) for p in el.get('geometry',[]) if p and 'lon' in p]
  if len(pts)<2:return None
  if polygon:
   if len(pts)<4 or pts[0]!=pts[-1]:return None
   return polygon_only(Polygon(pts))
  return LineString(pts)
 if el['type']!='relation':return None
 outer=[];inner=[]
 for member in el.get('members',[]):
  if member['type']!='way':continue
  pts=[(p['lon'],p['lat']) for p in member.get('geometry',[]) if p and 'lon' in p]
  if len(pts)<2:continue
  (inner if member.get('role')=='inner' else outer).append(LineString(pts))
 if not outer:return None
 outer_polys=list(polygonize(unary_union(outer)))
 if not outer_polys:return None
 g=unary_union(outer_polys)
 if inner:
  holes=list(polygonize(unary_union(inner)))
  if holes:g=g.difference(unary_union(holes))
 return polygon_only(g)

def get_query(level):
 _,inverse=projector(level['center'])
 west,south=inverse(-5100,-5100);east,north=inverse(5100,5100)
 bounds=f'{south:.7f},{west:.7f},{north:.7f},{east:.7f}'
 query=f'''[out:json][timeout:120][maxsize:268435456];
(
 wr["building"]["building"!="no"]({bounds});
 way["highway"]({bounds});
 wr["natural"~"^(water|wood|wetland|scrub|grassland)$"]({bounds});
 wr["landuse"~"^(forest|grass|meadow|recreation_ground|village_green|allotments|orchard|farmland|reservoir|basin)$"]({bounds});
 wr["leisure"~"^(park|garden|golf_course|nature_reserve|recreation_ground)$"]({bounds});
 way["waterway"]({bounds});
);
out meta geom;'''
 return query,[west,south,east,north]

def fetch(level, dest):
 query,bounds=get_query(level)
 request=urllib.request.Request(ENDPOINT,data=urllib.parse.urlencode({'data':query}).encode(),headers={'User-Agent':'CITY-EATER/0.1 (open-source bounded OSM map build)','Content-Type':'application/x-www-form-urlencoded'})
 print(f'Downloading one bounded OSM excerpt for {level["id"]}...',flush=True)
 # No unattended retries or parallel jobs against the public Overpass service.
 with urllib.request.urlopen(request,timeout=150) as response:raw=response.read(100*1024*1024)
 source=json.loads(raw)
 if source.get('remark'):raise RuntimeError(source['remark'])
 if not source.get('elements'):raise RuntimeError('Empty OSM response')
 dest.parent.mkdir(parents=True,exist_ok=True)
 dest.write_bytes(gzip.compress(raw,mtime=0))
 compact(dest.with_suffix('.provenance.json'),{'endpoint':ENDPOINT,'query':query,'queryBounds':bounds,'downloadedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'rawSha256':hashlib.sha256(raw).hexdigest(),'osmTimestamp':source['osm3s']['timestamp_osm_base'],'generator':source['generator']})
 return source,raw

def choose_spawn(buildings,geometries):
 """Closest sampled free circle to the center, without creating game objects."""
 tree=STRtree(geometries)
 candidates=[(0,0)]
 for radius in range(10,401,10):
  for i in range(max(16,int(2*math.pi*radius/10))):
   angle=2*math.pi*i/max(16,int(2*math.pi*radius/10))
   candidates.append((radius*math.cos(angle),radius*math.sin(angle)))
 for x,y in candidates:
  disk=Point(x,y).buffer(18)
  if not any(geometries[i].intersects(disk) for i in tree.query(disk)):
   return [round(x,2),round(y,2)]
 raise RuntimeError('No free spawn close to the level center; manually choose another real center')

def background_tiles(level,features,destination,bounds):
 def mercator(x,y,z=None):
  # Shapely transform may supply tuples, so vectorize with NumPy.
  import numpy as np
  return np.asarray(x)*math.pi*R/180,R*np.log(np.tan(math.pi/4+np.asarray(y)*math.pi/360))
 projected=[]
 for layer,g,props,oid in features:
  g=transform(mercator,g)
  if not g.is_empty:projected.append((layer,g,props,oid))
 geometries=[f[1] for f in projected]
 tree=STRtree(geometries)
 tiles=[]
 for z in range(9,16):
  for tile in mercantile.tiles(*bounds,z):
   tiles.append((zxy_to_tileid(tile.z,tile.x,tile.y),tile))
 tiles.sort(key=lambda x:x[0])
 num=0;max_bytes=0
 temporary=destination.with_suffix('.pmtiles.tmp')
 with write_pmtiles(str(temporary)) as writer:
  for tid,tile in tiles:
   b=mercantile.xy_bounds(tile)
   region=box(b.left,b.bottom,b.right,b.top)
   pixel=(b.right-b.left)/4096
   clip=region.buffer(pixel*8,join_style='mitre')
   layers=collections.defaultdict(list)
   for i in tree.query(clip):
    layer,g,props,oid=projected[i]
    # Smaller simplification at high zoom; no gameplay geometry is simplified.
    g=g.intersection(clip).simplify(pixel*.35,preserve_topology=True)
    if g.is_empty:continue
    if layer!='roads' and g.geom_type not in ('Polygon','MultiPolygon'):continue
    if layer=='roads' and g.geom_type not in ('LineString','MultiLineString'):continue
    layers[layer].append({'geometry':g,'properties':props,'id':oid})
   if not layers:continue
   payload=mapbox_vector_tile.encode([{'name':name,'features':fs} for name,fs in sorted(layers.items())],default_options={'quantize_bounds':(b.left,b.bottom,b.right,b.top),'extents':4096})
   payload=gzip.compress(payload,mtime=0)
   max_bytes=max(max_bytes,len(payload));writer.write_tile(tid,payload);num+=1
  metadata={'name':f'CITY EATER — {level["title"]}','description':'Real OSM roads, water and green areas. Building visuals come from independent gameplay chunks.','attribution':'© OpenStreetMap contributors','license':'ODbL-1.0','format':'pbf','type':'baselayer','version':'1','bounds':','.join(str(x) for x in bounds),'vector_layers':[{'id':name,'fields':{'kind':'String','name':'String'},'minzoom':9,'maxzoom':15} for name in ('parks','water','roads')]}
  writer.finalize({'tile_type':TileType.MVT,'tile_compression':Compression.GZIP,'min_lon_e7':round(bounds[0]*1e7),'min_lat_e7':round(bounds[1]*1e7),'max_lon_e7':round(bounds[2]*1e7),'max_lat_e7':round(bounds[3]*1e7),'center_lon_e7':round(level['center'][0]*1e7),'center_lat_e7':round(level['center'][1]*1e7),'center_zoom':14},metadata)
 temporary.replace(destination)
 return {'tiles':num,'maxCompressedTileBytes':max_bytes,'bytes':destination.stat().st_size}

def build(level,download):
 dest=OUT/level['id'];dest.mkdir(parents=True,exist_ok=True)
 source_path=dest/'source.osm.json.gz'
 if download:source,raw=fetch(level,source_path)
 else:raw=gzip.decompress(source_path.read_bytes());source=json.loads(raw)
 provenance=json.loads(source_path.with_suffix('.provenance.json').read_text())
 elements=source['elements'];forward,inverse=projector(level['center'])
 arena=box(-5000,-5000,5000,5000)
 west,south=inverse(-5000,-5000);east,north=inverse(5000,5000)
 bounds=[west,south,east,north]
 arena_ll=box(*bounds)
 version='osm-'+source['osm3s']['timestamp_osm_base'].replace(':','').replace('-','')+'-'+hashlib.sha256(raw).hexdigest()[:10]+'-v1'
 buildings=[];geometries=[];seen=set();members=set();stats=collections.Counter()
 # Relation footprints take priority over their constituent ways.
 relations=[]
 for el in elements:
  if el['type']=='relation' and el.get('tags',{}).get('building') not in (None,'no'):
   g=osm_geometry(el)
   if g is not None:
    relations.append((el,g))
    members.update(m['ref'] for m in el.get('members',[]) if m['type']=='way')
 candidates=relations+[(el,None) for el in elements if el['type']=='way' and el.get('tags',{}).get('building') not in (None,'no') and el['id'] not in members]
 for el,g in candidates:
  if g is None:g=osm_geometry(el)
  if g is None:stats['invalidOrIncompleteBuilding']+=1;continue
  local=transform(forward,g)
  if not arena.covers(local):stats['boundaryExcluded']+=1;continue
  if local.area<1:stats['subSquareMeterExcluded']+=1;continue
  key=shapely.normalize(local).wkb
  if key in seen:stats['duplicateExcluded']+=1;continue
  seen.add(key)
  circle=shapely.minimum_bounding_circle(local)
  center=circle.centroid
  radius=float(shapely.minimum_bounding_radius(local))
  p=local if local.geom_type=='MultiPolygon' else MultiPolygon([local])
  coords=rounded(mapping(p)['coordinates'],3)
  # Roundoff is covered by 5mm added to enclosing radius.
  ident=('r' if el['type']=='relation' else 'w')+str(el['id'])
  tags=el.get('tags',{})
  b={'id':ident,'geometry':{'type':g.geom_type,'coordinates':rounded(mapping(g)['coordinates'],7)},'polygons':coords,'area':round(local.area,3),'center':[round(center.x,3),round(center.y,3)],'radius':round(radius+.005,3),'bbox':rounded(local.bounds,3),'osmVersion':el.get('version',1),'kind':tags.get('building','yes')}
  if tags.get('name'):b['name']=tags['name']
  try:
   if tags.get('height'):b['height']=float(tags['height'].replace(' m','').replace(',','.'))
   elif tags.get('building:levels'):b['height']=float(tags['building:levels'])*3
  except ValueError:pass
  buildings.append(b);geometries.append(local)
 buildings_and_geoms=sorted(zip(buildings,geometries),key=lambda pair:pair[0]['id'])
 buildings=[p[0] for p in buildings_and_geoms];geometries=[p[1] for p in buildings_and_geoms]
 if not buildings:raise RuntimeError('No valid buildings; refusing synthetic replacement')
 spawn=choose_spawn(buildings,geometries)
 chunks=collections.defaultdict(list)
 for b in buildings:
  x=min(9,max(0,math.floor((b['center'][0]+5000)/CHUNK)))
  y=min(9,max(0,math.floor((b['center'][1]+5000)/CHUNK)))
  chunks[(x,y)].append(b)
 index=[]
 for (x,y),bs in sorted(chunks.items()):
  name=f'{x}-{y}'
  p=dest/'chunks'/f'{name}.json'
  compact(p,{'version':version,'buildings':bs})
  bbox=[min(b['bbox'][0] for b in bs),min(b['bbox'][1] for b in bs),max(b['bbox'][2] for b in bs),max(b['bbox'][3] for b in bs)]
  index.append({'id':name,'x':x,'y':y,'url':f'chunks/{name}.json','buildingCount':len(bs),'area':round(sum(b['area'] for b in bs),3),'bbox':bbox,'bytes':p.stat().st_size})
 # Only OSM features: no generated trees, roads, shorelines or extra buildings.
 features=[];background_seen=set();background_members=set()
 for el in elements:
  if el['type']=='relation':
   tags=el.get('tags',{})
   if tags.get('building') not in (None,'no'):continue
   if tags.get('natural')=='water' or tags.get('landuse') in ('reservoir','basin') or is_green(tags):
    if osm_geometry(el) is not None:background_members.update(m['ref'] for m in el.get('members',[]) if m['type']=='way')
 for el in elements:
  tags=el.get('tags',{})
  # Never bake building-tagged footprints into the immutable basemap.
  if tags.get('building') not in (None,'no'):continue
  if tags.get('waterway')=='riverbank':
   layer='water';g=osm_geometry(el);kind='riverbank'
  elif tags.get('highway'):
   layer='roads';g=osm_geometry(el,False);kind=tags['highway']
  elif tags.get('waterway') and el['type']=='way':
   line=osm_geometry(el,False)
   # Keep actual waterway centerlines in roads layer for thin blue line styling.
   layer='roads';g=line;kind='waterway'
  else:
   if el['type']=='way' and el['id'] in background_members:continue
   if tags.get('natural')=='water' or tags.get('landuse') in ('reservoir','basin'):layer='water'
   elif is_green(tags):layer='parks'
   else:continue
   g=osm_geometry(el);kind=tags.get('natural') or tags.get('leisure') or tags.get('landuse')
  if g is None:continue
  g=g.intersection(arena_ll)
  if g.is_empty:continue
  key=(layer,shapely.normalize(g).wkb)
  if key in background_seen:continue
  background_seen.add(key)
  props={'kind':kind}
  if tags.get('name'):props['name']=tags['name']
  features.append((layer,g,props,el['id']))
 print(f'{level["id"]}: {len(buildings)} buildings, {len(features)} background features; making tiles...',flush=True)
 tiles=background_tiles(level,features,dest/'map.pmtiles',bounds)
 nearby=[b for b in buildings if math.dist(b['center'],spawn)<300]
 manifest={**level,'version':version,'arenaSize':ARENA,'chunkSize':CHUNK,'totalBuildingArea':round(sum(b['area'] for b in buildings),3),'buildingCount':len(buildings),'spawn':spawn,'initialRadius':18,'targetPercent':80,'pmtiles':'map.pmtiles','sourceLayers':{'roads':'roads','water':'water','parks':'parks'},'chunks':index,'bounds':bounds,'projection':{'type':'local-equirectangular','radius':R,'origin':level['center'],'units':'meters','x':'east','y':'north'},'attribution':'© OpenStreetMap contributors','license':'ODbL-1.0','licenseUrl':'https://opendatacommons.org/licenses/odbl/1-0/','sourceTimestamp':source['osm3s']['timestamp_osm_base'],'sourceUrl':'source.osm.json.gz','provenance':'provenance.json'}
 compact(dest/'manifest.json',manifest)
 metrics={'buildingCount':len(buildings),'totalArea':manifest['totalBuildingArea'],'chunks':len(index),'buildingsWithin300mSpawn':len(nearby),'edibleWithin300mSpawnAt18m':sum(b['radius']<=18 for b in nearby),'minRadius':min(b['radius'] for b in buildings),'maxRadius':max(b['radius'] for b in buildings),'backgroundLayers':dict(collections.Counter(f[0] for f in features)),'excluded':dict(stats),'pmtiles':tiles,'chunkBytes':sum(x['bytes'] for x in index)}
 compact(dest/'provenance.json',{**provenance,'datasetVersion':version,'license':'ODbL-1.0','copyright':'© OpenStreetMap contributors','copyrightUrl':'https://www.openstreetmap.org/copyright','licenseUrl':'https://opendatacommons.org/licenses/odbl/1-0/','pipeline':'scripts/build_maps.py','dependencies':{p:importlib.metadata.version(p) for p in ('shapely','pmtiles','mapbox-vector-tile','mercantile')},'arenaBounds':bounds,'metrics':metrics,'normalization':['Full building polygons must be inside the metric arena; boundary-intersecting footprints are excluded.','Multipolygon outer members assembled, inner rings subtracted; parent relation supersedes member ways.','Identical normalized geometries deduplicated; no generated/synthetic objects.','Invalid polygons repaired with GEOS make_valid; incomplete rings and sub-square-meter remnants excluded.','GEOS minimum enclosing circle calculated over every polygon; area subtracts courtyard holes.','Building coordinates are stored at 1mm local / 7-decimal lon-lat precision; enclosing radius adds 5mm.','Background geometry clipped to arena; zoom-dependent simplification applies only to background tiles.','OSM building:levels is an optional 3m-per-level height estimate, not measured height.']})
 print(json.dumps({'level':level['id'],'spawn':spawn,**metrics},ensure_ascii=False,indent=2),flush=True)
 return manifest

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--download',action='store_true');ap.add_argument('--level',choices=[x['id'] for x in LEVELS]);args=ap.parse_args()
 for level in LEVELS:
  if not args.level or args.level==level['id']:build(level,args.download)
 catalog=[]
 for level in LEVELS:
  p=OUT/level['id']/'manifest.json'
  if p.exists():
   m=json.loads(p.read_text());catalog.append({k:m[k] for k in ('id','title','subtitle','center','version','arenaSize','buildingCount','totalBuildingArea','sourceTimestamp')})
 compact(OUT/'catalog.json',{'schemaVersion':1,'levels':catalog,'attribution':'© OpenStreetMap contributors','license':'ODbL-1.0'})

if __name__=='__main__':main()
