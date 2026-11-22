"""Pack the sky data for the planetarium view.

Inputs (data-raw/sky/, fetched from github.com/ofrohn/d3-celestial, BSD-3; star data from the
Hipparcos/Yale Bright Star catalogues via that project):
  stars.6.json, starnames.json, constellations.lines.json
  bm.jpg: NASA Blue Marble land_ocean_ice_cloud_2048 (NASA Visible Earth, public domain)
  ref/*.jpg: Apollo 11 Hasselblad frames from images.nasa.gov (public domain)
Outputs: public/data/sky/sky.json, earth.jpg, ref/*.jpg
"""
import json, os
from PIL import Image
S = 'data-raw/sky'
O = 'public/data/sky'
os.makedirs(O + '/ref', exist_ok=True)
stars = json.load(open(f'{S}/stars.6.json'))['features']
names = json.load(open(f'{S}/starnames.json'))
out = []
named = []
for f in stars:
    p = f['properties']; ra, dec = f['geometry']['coordinates']
    mag = p['mag']
    if mag > 6.2: continue
    try: bv = float(p.get('bv') or 0.6)
    except ValueError: bv = 0.6
    ra = ra % 360
    out.append([round(ra, 3), round(dec, 3), round(mag, 2), round(bv, 2)])
    nm = names.get(str(f['id']), {}).get('name', '')
    if nm and mag < 2.6: named.append([nm, round(ra, 3), round(dec, 3), round(mag, 2)])
lines = []
for f in json.load(open(f'{S}/constellations.lines.json'))['features']:
    for seg in f['geometry']['coordinates']:
        lines.append([[round(c[0] % 360, 2), round(c[1], 2)] for c in seg])
json.dump({'source': 'd3-celestial (Hipparcos / Yale BSC), J2000', 'stars': out, 'named': named, 'lines': lines},
          open(f'{O}/sky.json', 'w'), separators=(',', ':'))
print(len(out), 'stars', len(named), 'named', len(lines), 'line strips', os.path.getsize(f'{O}/sky.json'))
Image.open(f'{S}/bm.jpg').convert('RGB').save(f'{O}/earth.jpg', quality=88)
for fn in ['as11-37-5458.jpg', 'as11-44-6552.jpg', 'as11-37-5437.jpg']:
    im = Image.open(f'{S}/ref/{fn}').convert('RGB'); im.thumbnail((1280, 1280))
    im.save(f'{O}/ref/{fn}', quality=84)
    print(fn, os.path.getsize(f'{O}/ref/{fn}'))
