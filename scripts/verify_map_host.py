#!/usr/bin/env python3
"""Verify the published game's same-origin map paths and real HTTP byte ranges.
Usage: python scripts/verify_map_host.py https://owner.github.io/city-eater/
Uses only Python's standard library; no full map downloads.
"""
import argparse,json,urllib.parse,urllib.request

def get(url,headers=None):
 request=urllib.request.Request(url,headers={'User-Agent':'CITY-EATER-deployment-check/1.0',**(headers or {})})
 with urllib.request.urlopen(request,timeout=30) as response:
  return response.status,dict(response.headers.items()),response.read(1024*1024)

def main():
 parser=argparse.ArgumentParser();parser.add_argument('url');args=parser.parse_args()
 base=args.url.rstrip('/')+'/'
 status,_,body=get(urllib.parse.urljoin(base,'data/catalog.json'))
 assert status==200
 catalog=json.loads(body)
 for level in catalog['levels']:
  level_url=urllib.parse.urljoin(base,f'data/{level["id"]}/')
  status,_,body=get(urllib.parse.urljoin(level_url,'manifest.json'))
  assert status==200
  manifest=json.loads(body)
  status,headers,body=get(urllib.parse.urljoin(level_url,manifest['pmtiles']),{'Range':'bytes=0-126','Accept-Encoding':'identity'})
  headers={k.lower():v for k,v in headers.items()}
  assert status==206,f'{level["id"]}: Range request returned HTTP{status}, expected206'
  assert len(body)==127,f'{level["id"]}: got{len(body)}bytes, expected127'
  assert headers.get('content-range','').startswith('bytes 0-126/'),headers
  assert headers.get('content-encoding','identity')=='identity','Do not whole-file gzip PMTiles'
  assert body[:8]==b'PMTiles\x03','Invalid PMTiles v3 header'
  spawn=manifest['spawn'];chunks=manifest['chunks']
  nearest=min(chunks,key=lambda c:(c['x']-(spawn[0]+5000)/manifest['chunkSize'])**2+(c['y']-(spawn[1]+5000)/manifest['chunkSize'])**2)
  status,_,body=get(urllib.parse.urljoin(level_url,nearest['url']))
  assert status==200
  chunk=json.loads(body)
  assert chunk['version']==manifest['version'] and chunk['buildings']
  print(f'PASS {level["id"]}: manifest, streamed chunk and PMTiles HTTP206 ({headers["content-range"]})')
 print('Same-origin hosting verified. Cross-origin storage additionally needs appropriate CORS.')

if __name__=='__main__':main()
