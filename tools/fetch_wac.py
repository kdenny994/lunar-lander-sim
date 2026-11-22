"""Fetch the LROC WAC global mosaic (NASA Moon Trek WMTS, ~100 m/px) over the corridor
and stitch it into one equirectangular grayscale image (PNG) + bounds JSON."""
import sys, io, os, json, time, urllib.request
from PIL import Image
LAT0, LAT1, LON0, LON1 = -1.5, 2.5, 21.0, 42.0
Z = 8
URL = "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{r}/{c}.jpg"
deg = 180.0 / (2 ** Z)  # degrees per tile (matrix width 2^(z+1) over 360)
c0, c1 = int((LON0 + 180) // deg), int((LON1 + 180) // deg)
r0, r1 = int((90 - LAT1) // deg), int((90 - LAT0) // deg)
out = sys.argv[1]
cache = os.path.join(os.path.dirname(out), "wac_tiles"); os.makedirs(cache, exist_ok=True)
W, H = (c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256
mos = Image.new("L", (W, H))
for r in range(r0, r1 + 1):
    for c in range(c0, c1 + 1):
        p = os.path.join(cache, f"{Z}_{r}_{c}.jpg")
        if not os.path.exists(p):
            for attempt in range(7):
                try:
                    data = urllib.request.urlopen(URL.format(z=Z, r=r, c=c), timeout=30).read(); break
                except Exception as e:
                    time.sleep(min(30, 2 ** attempt))
            else:
                raise SystemExit(f"failed tile {r},{c}")
            open(p, "wb").write(data)
        mos.paste(Image.open(p).convert("L"), ((c - c0) * 256, (r - r0) * 256))
mos.save(out)
meta = dict(lon0=c0 * deg - 180, lat0=90 - r0 * deg, dlon=deg / 256, dlat=-deg / 256, width=W, height=H,
            source="LROC WAC Global Mosaic 303ppd v02 via NASA Moon Trek WMTS (NASA/GSFC/Arizona State University)")
json.dump(meta, open(out + ".json", "w"), indent=1)
print(meta)
