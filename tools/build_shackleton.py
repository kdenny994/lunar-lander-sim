"""Build the Shackleton-rim terrain for Starship mode (south polar stereographic grids).

Sources (read with HTTP range requests, only the windows needed):
  - LOLA 5 m/px south-pole DEM 87-90 S (Barker et al. 2021, NASA GSFC; USGS Astrogeology mirror)
      ldem_87s_5mpp_cog.tif, heights in m relative to the 1737.4 km sphere, MOON_ME.
  - LOLA 118 m global DEM (USGS), for the part of the descent corridor beyond 100 km from the pole.
  - LROC NAC south-pole controlled mosaic, 1 m/px (LROC Team / USGS, Nov 2025).
Grids are pixel-centre registered in polar stereographic metres: x = rho sin(lon), y = rho cos(lon),
rho = 2 R tan((90 + lat) / 2).

Output: public/data/shackleton/terrain/{site,corridor}.json, *_h.png, site/, site_lo/, corridor/ textures.
"""
import json, os, sys
import numpy as np, rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from PIL import Image

S3 = '/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/'
LDEM5 = S3 + 'Lunar_safed/LMAP/SouthPolar/ldem_87s_5mpp_cog.tif'
NAC = S3 + 'Lunar_safed/LMAP/SouthPolar/LRO_LROC_NAC_SPOLE-90_Mosaic_1m_controlled_cog.tif'
LDEM118 = S3 + 'Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif'
OUT = 'public/data/shackleton/terrain'
RAW = 'data-raw/shackleton'
SITE = (-2757.5, -6252.5)  # chosen landing point (x, y m): 89.7746 S, 203.80 E, 0.4 deg tilt over 120 m
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_MULTIRANGE='YES', GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES',
           GDAL_HTTP_MAX_RETRY='6', GDAL_HTTP_RETRY_DELAY='2', VSI_CACHE='TRUE')

def read_ps(path, x0, x1, y0, y1, px, resampling=Resampling.average):
    """Read [x0,x1]x[y0,y1] (pixel-centre extent) at spacing px from a polar-stereographic file."""
    w = int(round((x1 - x0) / px)) + 1
    h = int(round((y1 - y0) / px)) + 1
    with rasterio.open(path) as d:
        win = from_bounds(x0 - px / 2, y0 - px / 2, x1 + px / 2, y1 + px / 2, d.transform)
        a = d.read(1, window=win, out_shape=(h, w), resampling=resampling, boundless=True, fill_value=0)
    return a

def encode_png(vals, path):
    v = (vals.astype(np.int32) + 32768).clip(0, 65535)
    rgb = np.zeros(vals.shape + (3,), np.uint8)
    rgb[..., 0] = v >> 8; rgb[..., 1] = v & 255
    Image.fromarray(rgb, 'RGB').save(path, optimize=True)

HI = [255.0]  # one global white point for every tile, set from a whole-area overview

def stretch(img):
    a = img.astype(np.float32)
    hi = HI[0]
    a = np.clip(a / max(hi, 1), 0, 1) ** 0.8 * 235
    return a.astype(np.uint8)

def nac_tile(x0, x1, y0, y1, size):
    """NAC mosaic over a pixel-edge extent, resampled to size x size."""
    with rasterio.open(NAC) as d:
        win = from_bounds(x0, y0, x1, y1, d.transform)
        return d.read(1, window=win, out_shape=(size, size), resampling=Resampling.average, boundless=True, fill_value=0)

def build_grid(name, x0, x1, y0, y1, px, chunk, tex, scale, heights):
    W = int(round((x1 - x0) / px)) + 1
    H = int(round((y1 - y0) / px)) + 1
    assert heights.shape == (H, W), (heights.shape, H, W)
    offset = float(np.round((heights.max() + heights.min()) / 2))
    q = np.round((heights - offset) / scale)
    assert q.min() >= -32768 and q.max() <= 32767, (q.min(), q.max())
    os.makedirs(OUT, exist_ok=True)
    encode_png(q, f'{OUT}/{name}_h.png')
    rows = int(np.ceil((H - 1) / chunk)); cols = int(np.ceil((W - 1) / chunk))
    meta = dict(width=W, height=H, proj='sps', x0=x0, y0=y1, dx=px, dy=-px, scale=scale, offset=offset,
                chunkSamples=chunk, chunkRows=rows, chunkCols=cols, texSize=tex)
    os.makedirs(f'{OUT}/{name}', exist_ok=True)
    if name == 'site': os.makedirs(f'{OUT}/site_lo', exist_ok=True)
    for ri in range(rows):
        for ci in range(cols):
            r0, c0 = ri * chunk, ci * chunk
            r1, c1 = min(r0 + chunk, H - 1), min(c0 + chunk, W - 1)
            # texture spans sample centres r0..r1, c0..c1 exactly (uv 0..1 at those vertices)
            tx0, tx1 = x0 + c0 * px, x0 + c1 * px
            ty1, ty0 = y1 - r0 * px, y1 - r1 * px
            img = stretch(nac_tile(tx0, tx1, ty0, ty1, tex))
            im = Image.fromarray(img)
            im.save(f'{OUT}/{name}/tex_{ri}_{ci}.jpg', quality=86)
            if name == 'site': im.resize((tex // 4, tex // 4), Image.LANCZOS).save(f'{OUT}/site_lo/tex_{ri}_{ci}.jpg', quality=85)
            print(name, ri, ci, flush=True)
    return meta

def main():
    os.makedirs(RAW, exist_ok=True)
    with rasterio.Env(**ENV):
        ov = nac_tile(-24000, 24000, -150000, 14000, 1024).astype(np.float32)
        HI[0] = float(np.percentile(ov[ov > 3], 99.0))
        print('NAC white point', HI[0])
        # ---- site: +-3 km around the landing point at 5 m ----
        sx, sy = SITE
        sx0, sx1, sy0, sy1 = sx - 3000, sx + 3000, sy - 3000, sy + 3000
        site_h = read_ps(LDEM5, sx0, sx1, sy0, sy1, 5.0, Resampling.nearest)
        np.save(f'{RAW}/site_h.npy', site_h)
        site = build_grid('site', sx0, sx1, sy0, sy1, 5.0, 400, 1024, 0.05, site_h)
        site['source'] = ('Heights: LOLA 5 m/px south-pole DEM (Barker et al. 2021, NASA GSFC). '
                          'Imagery: LROC NAC south-pole controlled mosaic, 1 m/px (NASA/GSFC/ASU, USGS).')
        site.update(siteX=sx, siteY=sy)
        json.dump(site, open(f'{OUT}/site.json', 'w'), indent=1)

        # ---- corridor: x +-24 km, y -150 km .. +14 km at 100 m ----
        cx0, cx1, cy0, cy1 = -24000.0, 24000.0, -150000.0, 14000.0
        px = 100.0
        W = int((cx1 - cx0) / px) + 1; H = int((cy1 - cy0) / px) + 1
        near = read_ps(LDEM5, cx0, cx1, -99900.0, cy1, px)  # LOLA 5 m footprint (+-100 km)
        hgt = np.zeros((H, W), np.float32)
        nrows = near.shape[0]
        hgt[:nrows] = near
        # beyond 100 km: LOLA 118 m global DEM warped to polar stereographic
        with rasterio.open(LDEM5) as d5: ps_crs = d5.crs
        with rasterio.open(LDEM118) as g:
            far_y1 = -99900.0 - px
            fh = H - nrows
            tr = rasterio.transform.from_origin(cx0 - px / 2, far_y1 + px / 2, px, px)
            with WarpedVRT(g, crs=ps_crs, transform=tr, width=W, height=fh, resampling=Resampling.bilinear) as v:
                far = v.read(1).astype(np.float32) * 0.5
        hgt[nrows:] = far
        # blend the seam over 3 km so the two DEMs meet without a step
        step = np.median(hgt[nrows - 1] - hgt[nrows])
        print('seam step (m):', step)
        ramp = np.clip((np.arange(fh) * px) / 3000.0, 0, 1)[:, None]
        hgt[nrows:] += step * (1 - ramp)
        np.save(f'{RAW}/corridor_h.npy', hgt)
        cor = build_grid('corridor', cx0, cx1, cy0, cy1, px, 240, 1024, 0.25, hgt)
        cor['source'] = ('Heights: LOLA 5 m south-pole DEM (Barker et al. 2021) to 100 km from the pole, LOLA 118 m global DEM beyond '
                         '(USGS Astrogeology). Imagery: LROC NAC south-pole controlled mosaic (NASA/GSFC/ASU, USGS).')
        json.dump(cor, open(f'{OUT}/corridor.json', 'w'), indent=1)

if __name__ == '__main__':
    main()
