"""Fetch the LROC WAC global mosaic at zoom 3 (4096x2048 equirectangular) for the background Moon."""
import sys, os, time, urllib.request
from PIL import Image
Z = 3
URL = "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{r}/{c}.jpg"
cache = "data-raw/wac_tiles"; os.makedirs(cache, exist_ok=True)
W, H = 2 ** (Z + 1), 2 ** Z
mos = Image.new("L", (W * 256, H * 256))
for r in range(H):
    for c in range(W):
        p = f"{cache}/{Z}_{r}_{c}.jpg"
        if not os.path.exists(p):
            for a in range(7):
                try:
                    open(p, "wb").write(urllib.request.urlopen(URL.format(z=Z, r=r, c=c), timeout=30).read()); break
                except Exception:
                    time.sleep(min(30, 2 ** a))
            else:
                raise SystemExit(f"failed {r},{c}")
        mos.paste(Image.open(p).convert("L"), (c * 256, r * 256))
os.makedirs("public/data/terrain", exist_ok=True)
mos.save("public/data/terrain/moon_global.jpg", quality=85)
print(mos.size)
