#!/usr/bin/env python3
"""Independently validate map coverage, source identity, gameplay metrics and tiles."""
import collections,gzip,hashlib,json,math,pathlib
import mapbox_vector_tile
from shapely.geometry import MultiPolygon,Polygon,Point,shape
from pmtiles.reader import Reader,all_tiles
from pmtiles.tile import TileType,Compression
ROOT=pathlib.Path(__file__).resolve().parents[1]/'public/data'

def check(level):
 root=ROOT/level['id'];m=json.loads((root/'manifest.json').read_text())
 provenance=json.loads((root/'provenance.json').read_text())
 raw=gzip.decompress((root/'source.osm.json.gz').read_bytes())
 assert hashlib.sha256(raw).hexdigest()==provenance['rawSha256']
 source=json.loads(raw)
 sources={(('r' if e['type']=='relation' else 'w')+str(e['id'])):e for e in source['elements']}
 assert m['arenaSize']==10000 and m['chunkSize']==1000
 assert m['projection']['radius']==6378137 and m['sourceTimestamp']==source['osm3s']['timestamp_osm_base']
 ids=set();total=0;all_buildings=[];max_error=0;max_roundtrip_error=0;holes=0;multipolygons=0
 for c in m['chunks']:
  doc=json.loads((root/c['url']).read_text());bs=doc['buildings']
  assert doc['version']==m['version']
  assert len(bs)==c['buildingCount']
  assert abs(sum(b['area'] for b in bs)-c['area'])<.002
  for b in bs:
   assert b['id'] not in ids and b['id'] in sources
   assert sources[b['id']]['tags'].get('building') not in (None,'no')
   ids.add(b['id']);total+=b['area'];all_buildings.append(b)
   assert 0<=c['x']<=9 and 0<=c['y']<=9
   assert c['x']==min(9,max(0,math.floor((b['center'][0]+5000)/1000)))
   assert c['y']==min(9,max(0,math.floor((b['center'][1]+5000)/1000)))
   polygons=[Polygon(p[0],p[1:]) for p in b['polygons']]
   g=MultiPolygon(polygons)
   assert g.is_valid and not g.is_empty and g.area>0
   assert all(-5000<=n<=5000 for n in g.bounds),b['id']
   assert c['bbox'][0]<=g.bounds[0]+.001 and c['bbox'][1]<=g.bounds[1]+.001 and c['bbox'][2]>=g.bounds[2]-.001 and c['bbox'][3]>=g.bounds[3]-.001
   area_error=abs(g.area-b['area']);max_error=max(max_error,area_error)
   # Millimetre point rounding can perturb large/complex polygon area slightly.
   assert area_error<max(1,g.length*.002), (b['id'],area_error)
   holes+=sum(len(p)-1 for p in b['polygons']);multipolygons+=len(b['polygons'])>1
   for p in b['polygons']:
    for ring in p:
     assert ring[0]==ring[-1]
     for pt in ring:assert math.dist(pt,b['center'])<=b['radius']+.002,(b['id'],pt)
   ll=shape(b['geometry']);llpolys=[ll] if ll.geom_type=='Polygon' else list(ll.geoms)
   for lp,pp in zip(llpolys,b['polygons']):
    for lr,pr in zip([lp.exterior,*lp.interiors],pp):
     for (lon,lat),(x,y) in zip(lr.coords,pr):
      xx=6378137*math.radians(lon-m['center'][0])*math.cos(math.radians(m['center'][1]))
      yy=6378137*math.radians(lat-m['center'][1])
      error=math.hypot(xx-x,yy-y);max_roundtrip_error=max(max_roundtrip_error,error)
      assert error<.001, (b['id'],error)
 assert len(ids)==m['buildingCount'] and abs(total-m['totalBuildingArea'])<.01
 disk=Point(*m['spawn']).buffer(17.99)
 for b in all_buildings:
  g=MultiPolygon([Polygon(p[0],p[1:]) for p in b['polygons']])
  assert not disk.intersects(g),'spawn intersects '+b['id']
 pm=(root/m['pmtiles']).read_bytes();reader=Reader(lambda off,size:pm[off:off+size])
 header=reader.header();assert header['tile_type']==TileType.MVT and header['tile_compression']==Compression.GZIP
 assert header['min_zoom']==9 and header['max_zoom']==15
 layers=set();n=0;features=0
 for zxy,encoded in all_tiles(lambda off,size:pm[off:off+size]):
  tile=mapbox_vector_tile.decode(gzip.decompress(encoded));n+=1
  for name,contents in tile.items():
   assert name in ('roads','water','parks')
   assert contents['extent']==4096 and contents['version']==2
   layers.add(name);features+=len(contents['features'])
 assert layers=={'roads','water','parks'}
 assert n==header['addressed_tiles_count']
 assert max(p.stat().st_size for p in root.rglob('*') if p.is_file())<100*1024*1024
 report={'level':m['id'],'buildings':len(ids),'totalArea':round(total,3),'holes':holes,'multiComponentBuildings':multipolygons,'tilesDecoded':n,'tileFeaturesDecoded':features,'maxAreaRoundingErrorM2':round(max_error,4),'maxProjectionRoundtripErrorM':round(max_roundtrip_error,6),'spawn':m['spawn'],'nearbyEdibleBuildings':sum(b['radius']<=18 and math.dist(b['center'],m['spawn'])<300 for b in all_buildings),'result':'PASS'}
 print(json.dumps(report,ensure_ascii=False,indent=2))
 return report

if __name__=='__main__':
 catalog=json.loads((ROOT/'catalog.json').read_text());reports=[check(l) for l in catalog['levels']]
 (ROOT/'validation.json').write_text(json.dumps({'checks':reports},ensure_ascii=False,indent=2)+'\n')
