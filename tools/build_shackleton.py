"""Build the Shackleton-rim terrain for Starship mode (south polar stereographic grids).

Sources (read with HTTP range requests, only the windows needed):
  - LOLA 5 m/px south-pole DEM 87-90 S (Barker et al. 2021, NASA GSFC; USGS Astrogeology mirror)
      ldem_87s_5mpp_cog.tif, heights in m relative to the 1737.4 km sphere, MOON_ME.
  - LOLA 118 m global DEM (USGS), for the part of the descent corridor beyond 100 km from the pole.
  - LROC NAC south-pole controlled mosaic, 1 m/px (LROC Team / USGS, Nov 2025).
The sources are south polar stereographic (rho = 2 R tan((90 + lat) / 2)). Every output grid and texture is
reprojected to south polar ORTHOGRAPHIC metres, pixel-centre registered: x = rho sin(lon), y = rho cos(lon),
rho = R cos(lat). Both projections share the azimuth, so the warp is a radial rescale.

Output: public/data/shackleton/terrain/{site,corridor}.json, *_h.png, site/, site_lo/, corridor/ textures, and
polar_cap.jpg / polar_ring.jpg: +-190 km and +-800 km orthographic images of the polar cap (NAC, LOLA hillshade,
WAC global map at the edge) that replace the pinched equirectangular global map around the pole.

  python3 tools/build_shackleton.py            # full build (reads the remote COGs)
  python3 tools/build_shackleton.py --reuse    # heights from data-raw/shackleton/*_sps.npy, imagery re-read
  python3 tools/build_shackleton.py --caps-only  # only the two orthographic polar-cap images
"""
import json, os, sys
import numpy as np, rasterio
from scipy.ndimage import map_coordinates
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
SITE_SPS = (-2757.5, -6252.5)  # chosen landing point, stereographic (x, y m): 89.7746 S, 203.80 E, 0.4 deg tilt over 120 m
R = 1737400.0
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_MULTIRANGE='YES', GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES',
           GDAL_HTTP_MAX_RETRY='6', GDAL_HTTP_RETRY_DELAY='2', VSI_CACHE='TRUE')

def spo_to_sps(x, y):
    """orthographic -> stereographic (same azimuth, radial rescale)"""
    ro = np.hypot(x, y)
    c = np.arcsin(np.clip(ro / R, 0, 1))
    k = np.where(ro > 1e-6, 2 * R * np.tan(c / 2) / np.maximum(ro, 1e-6), 1.0)
    return x * k, y * k

def sps_to_spo(x, y):
    rs = np.hypot(x, y)
    c = 2 * np.arctan(rs / (2 * R))
    k = np.where(rs > 1e-6, R * np.sin(c) / np.maximum(rs, 1e-6), 1.0)
    return x * k, y * k

def sample_sps(arr, ax0, ay1, apx, xs, ys, order=1):
    """bilinear sample of an sps grid (pixel centre (0,0) at (ax0, ay1), spacing apx, rows going south) at sps points"""
    return map_coordinates(arr.astype(np.float32), [(ay1 - ys) / apx, (xs - ax0) / apx], order=order, mode='nearest')

def warp_ortho(read, ox, oy, px):
    """values at orthographic points (ox, oy arrays): read(x0, x1, y0, y1, px) returns the sps pixel-centre grid"""
    sx, sy = spo_to_sps(ox, oy)
    x0, x1 = sx.min() - 2 * px, sx.max() + 2 * px
    y0, y1 = sy.min() - 2 * px, sy.max() + 2 * px
    x1 = x0 + np.ceil((x1 - x0) / px) * px; y0 = y1 - np.ceil((y1 - y0) / px) * px
    a = read(x0, x1, y0, y1, px)
    return sample_sps(a, x0, y1, px, sx, sy)

def ortho_grid(x0, x1, y0, y1, px):
    """pixel-centre ortho grid over [x0,x1]x[y0,y1], rows from y1 down"""
    w = int(round((x1 - x0) / px)) + 1; h = int(round((y1 - y0) / px)) + 1
    xs = x0 + np.arange(w) * px; ys = y1 - np.arange(h) * px
    return np.meshgrid(xs, ys)

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

def nac_sps(x0, x1, y0, y1, size):
    """NAC mosaic over a stereographic pixel-edge extent, resampled to size x size."""
    with rasterio.open(NAC) as d:
        win = from_bounds(x0, y0, x1, y1, d.transform)
        return d.read(1, window=win, out_shape=(size, size), resampling=Resampling.average, boundless=True, fill_value=0)

def nac_tile(x0, x1, y0, y1, size):
    """NAC mosaic over an ORTHOGRAPHIC pixel-edge extent, size x size: read the covering sps window, then warp."""
    p = (x1 - x0) / size
    ox, oy = np.meshgrid(x0 + (np.arange(size) + 0.5) * p, y1 - (np.arange(size) + 0.5) * p)
    def read(a0, a1, b0, b1, px):
        n = int(round((a1 - a0) / px)) + 1; m = int(round((b1 - b0) / px)) + 1
        with rasterio.open(NAC) as d:
            win = from_bounds(a0 - px / 2, b0 - px / 2, a1 + px / 2, b1 + px / 2, d.transform)
            return d.read(1, window=win, out_shape=(m, n), resampling=Resampling.average, boundless=True, fill_value=0)
    return np.clip(warp_ortho(read, ox, oy, p), 0, None)

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
    meta = dict(width=W, height=H, proj='spo', x0=x0, y0=y1, dx=px, dy=-px, scale=scale, offset=offset,
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

SHADE = 'mosaic/Lunar_LRO_LOLA_Shade_Global_128ppd_v04.tif'  # LOLA hillshade, 128 px/deg, equirectangular
SHADE_LAT = -62.0  # rows read: 62 S .. 90 S

def lola_shade():
    path = f'{RAW}/lola_shade_62s.npy'
    if not os.path.exists(path):
        from rasterio.windows import Window
        with rasterio.open(S3.replace('mosaic/', '') + SHADE) as d:
            r0 = int(round((90 - SHADE_LAT) * 128))
            np.save(path, d.read(1, window=Window(0, r0, d.width, d.height - r0)))
    return np.load(path).astype(np.float32)

def match_hist(src, ref, n=256):
    """quantile-map src values so their distribution matches ref"""
    q = np.linspace(0, 100, n)
    return np.interp(src, np.percentile(src, q), np.percentile(ref, q))

def polar_image(name, half, size, nac_r=178000.0, global_edge=True):
    """orthographic image of the cap within `half` m of the pole, rows from +y down: the NAC mosaic inside its
    182 km footprint, the LOLA hillshade (tone-matched to the NAC) beyond it, and (outer image) the WAC global map at the edge"""
    p = 2 * half / size
    ox, oy = np.meshgrid(-half + (np.arange(size) + 0.5) * p, half - (np.arange(size) + 0.5) * p)
    ro = np.hypot(ox, oy)
    lat = -np.degrees(np.arccos(np.clip(ro / R, 0, 1))); lon = np.degrees(np.arctan2(ox, oy))
    sh = lola_shade()
    shv = map_coordinates(sh, [(SHADE_LAT - lat) * 128 - 0.5, ((lon + 180) * 128 - 0.5) % sh.shape[1]], order=1, mode='wrap')
    inner = ro < min(nac_r, half)
    if inner.any():
        nac = stretch(nac_tile(-half, half, -half, half, size)).astype(np.float32)
        ring = (ro > 120000) & (ro < 175000) & (nac > 2)
        shv = match_hist(shv, nac[ring])
    else:
        nac = np.zeros_like(shv)
    w = np.clip((nac_r - ro) / 15000, 0, 1)
    out = w * nac + (1 - w) * shv
    if not global_edge:
        Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(f'{OUT}/{name}', quality=85)
        return dict(url=name, half=half)
    g = np.asarray(Image.open('public/data/terrain/moon_global.jpg').convert('L'), np.float32)
    gv = map_coordinates(g, [(90 - lat) / 180 * g.shape[0] - 0.5, ((lon + 180) / 360 * g.shape[1] - 0.5) % g.shape[1]], order=1, mode='wrap')
    edge = (ro > 0.85 * half) & (ro < 0.97 * half)
    gv = match_hist(gv, out[edge]) if edge.any() else gv
    we = np.clip((0.97 * half - ro) / (0.1 * half), 0, 1)
    out = np.clip(we * out + (1 - we) * gv, 0, 255).astype(np.uint8)
    Image.fromarray(out).save(f'{OUT}/{name}', quality=85)
    return dict(url=name, half=half)

def polar_caps():
    """inner cap (+-190 km, 93 m/px) and outer cap (+-800 km, 390 m/px), both orthographic"""
    return dict(polarCaps=[polar_image('polar_cap.jpg', 190000.0, 4096, global_edge=False), polar_image('polar_ring.jpg', 800000.0, 4096)])

def main():
    reuse = '--reuse' in sys.argv
    os.makedirs(RAW, exist_ok=True)
    with rasterio.Env(**ENV):
        ov = nac_sps(-24000, 24000, -150000, 14000, 1024).astype(np.float32)
        HI[0] = float(np.percentile(ov[ov > 3], 99.0))
        print('NAC white point', HI[0])
        if '--caps-only' in sys.argv:
            cor = json.load(open(f'{OUT}/corridor.json'))
            cor.pop('polarCap', None); cor.update(polar_caps())
            json.dump(cor, open(f'{OUT}/corridor.json', 'w'), indent=1)
            return
        # ---- site: +-3 km around the landing point at 5 m (orthographic) ----
        sx, sy = [float(np.round(v * 2) / 2) for v in sps_to_spo(np.array(SITE_SPS[0]), np.array(SITE_SPS[1]))]
        print('site (ortho)', sx, sy)
        sx0, sx1, sy0, sy1 = sx - 3000, sx + 3000, sy - 3000, sy + 3000
        if reuse:
            a = np.load(f'{RAW}/site_h_sps.npy')  # sps grid: centres x = SITE_SPS[0]-3000.., y = SITE_SPS[1]+3000..
            ox, oy = ortho_grid(sx0, sx1, sy0, sy1, 5.0)
            site_h = sample_sps(a, SITE_SPS[0] - 3000, SITE_SPS[1] + 3000, 5.0, *spo_to_sps(ox, oy))
        else:
            ox, oy = ortho_grid(sx0, sx1, sy0, sy1, 5.0)
            site_h = warp_ortho(lambda x0, x1, y0, y1, px: read_ps(LDEM5, x0, x1, y0, y1, px, Resampling.nearest), ox, oy, 5.0)
        np.save(f'{RAW}/site_h.npy', site_h)
        site = build_grid('site', sx0, sx1, sy0, sy1, 5.0, 400, 1024, 0.05, site_h)
        site['source'] = ('Heights: LOLA 5 m/px south-pole DEM (Barker et al. 2021, NASA GSFC). '
                          'Imagery: LROC NAC south-pole controlled mosaic, 1 m/px (NASA/GSFC/ASU, USGS). '
                          'Reprojected to south polar orthographic.')
        site.update(siteX=sx, siteY=sy)
        json.dump(site, open(f'{OUT}/site.json', 'w'), indent=1)

        # ---- corridor: x +-24 km, y -150 km .. +14 km at 100 m (orthographic) ----
        cx0, cx1, cy0, cy1 = -24000.0, 24000.0, -150000.0, 14000.0
        px = 100.0
        if not os.path.exists(f'{RAW}/corridor_h_sps.npy'):
            raise SystemExit('run the stereographic corridor build first (data-raw/shackleton/corridor_h_sps.npy)')
        a = np.load(f'{RAW}/corridor_h_sps.npy')  # sps grid over the same numbers, built from LOLA 5 m + 118 m
        ox, oy = ortho_grid(cx0, cx1, cy0, cy1, px)
        hgt = sample_sps(a, cx0, cy1, px, *spo_to_sps(ox, oy))
        np.save(f'{RAW}/corridor_h.npy', hgt)
        cor = build_grid('corridor', cx0, cx1, cy0, cy1, px, 240, 1024, 0.25, hgt)
        cor['source'] = ('Heights: LOLA 5 m south-pole DEM (Barker et al. 2021) to 100 km from the pole, LOLA 118 m global DEM beyond '
                         '(USGS Astrogeology). Imagery: LROC NAC south-pole controlled mosaic (NASA/GSFC/ASU, USGS). '
                         'Reprojected to south polar orthographic.')
        cor.update(polar_caps())
        json.dump(cor, open(f'{OUT}/corridor.json', 'w'), indent=1)

if __name__ == '__main__':
    main()
