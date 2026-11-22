"""Build runtime terrain assets for the Apollo 11 corridor and landing site.

Inputs (data-raw/):
  lola_corridor.npz           LOLA 118 m DEM window (fetch_lola_corridor.py)
  wac_corridor.png(.json)     LROC WAC mosaic window (fetch_wac.py)
  nac/NAC_DTM_APOLLO11.TIF    LROC NAC DTM, 2 m/post
  nac/ortho_crop_*.raw        LROC NAC orthophoto M150361817, 0.5 m/px (rows 30700-37400)
Outputs (public/data/terrain/):
  corridor.json/.bin + corridor/tex_r_c.jpg   (heights int16 m, 0.5 deg chunks)
  site.json/.bin + site/tex_r_c.jpg           (heights int16 * 0.02 m + offset, 512 m chunks)
Heights are metres above the 1737.4 km reference sphere.
"""
import os, json, numpy as np, rasterio
from PIL import Image
from scipy.ndimage import map_coordinates, zoom
RAW = "data-raw"; OUT = "public/data/terrain"
os.makedirs(OUT + "/corridor", exist_ok=True); os.makedirs(OUT + "/site", exist_ok=True)
R = 1737400.0

# ---------- site (NAC DTM + ortho) ----------
SITE_LAT0, SITE_LAT1 = 0.62, 0.73
with rasterio.open(f"{RAW}/nac/NAC_DTM_APOLLO11.TIF") as r:
    dtm = r.read(1).astype(np.float64); T = r.transform; nod = r.nodata
kx = R * np.cos(np.radians(1.0)) * np.pi / 180  # m per deg lon (std parallel 1 deg)
ky = R * np.pi / 180
lon_edge0 = 180 + T.c / kx; dlon_d = T.a / kx
lat_edge0 = T.f / ky; dlat_d = T.e / ky
r0 = int(round((lat_edge0 - SITE_LAT1) / -dlat_d)); r1 = int(round((lat_edge0 - SITE_LAT0) / -dlat_d))
site = dtm[r0:r1].copy()
bad = (site < -1e30) | ~np.isfinite(site)
# trim columns with nodata at the strip edges
colbad = bad.mean(axis=0) > 0.0
good_cols = np.where(~colbad)[0]; c0, c1 = good_cols[0], good_cols[-1] + 1
site = site[:, c0:c1]; bad = bad[:, c0:c1]
assert not bad.any(), "nodata inside site crop"
s_lat0 = lat_edge0 + (r0 + 0.5) * dlat_d  # centre of first row
s_lon0 = lon_edge0 + (c0 + 0.5) * dlon_d
s_dlat, s_dlon = dlat_d, dlon_d
SH, SW = site.shape
print("site", SH, SW, s_lat0, s_lon0, s_dlat, s_dlon, site.min(), site.max())

# ---------- corridor (LOLA) ----------
z = np.load(f"{RAW}/lola_corridor.npz")
cor = z["h"].astype(np.float64)
c_lon0 = float(z["lon0"]) + float(z["dlon"]) / 2; c_lat0 = float(z["lat0"]) + float(z["dlat"]) / 2
c_dlon = float(z["dlon"]); c_dlat = float(z["dlat"])
CH, CW = cor.shape

def corridor_at(lat, lon):
    rr = (lat - c_lat0) / c_dlat; cc = (lon - c_lon0) / c_dlon
    return map_coordinates(cor, [rr, cc], order=1, mode="nearest")

# Align: report LOLA vs NAC offset, then feather NAC edges (100 m) onto LOLA surface
LAT = s_lat0 + np.arange(SH)[:, None] * s_dlat + np.zeros((1, SW))
LON = s_lon0 + np.arange(SW)[None, :] * s_dlon + np.zeros((SH, 1))
lola_on_site = corridor_at(LAT, LON)
print("NAC - LOLA mean offset (m):", float((site - lola_on_site).mean()))
edge = np.minimum.reduce([np.arange(SH)[:, None] + 0 * LON, (SH - 1 - np.arange(SH))[:, None] + 0 * LON,
                          np.arange(SW)[None, :] + 0 * LAT, (SW - 1 - np.arange(SW))[None, :] + 0 * LAT]) * 2.0
w = np.clip(edge / 100.0, 0, 1); w = w * w * (3 - 2 * w)
site_f = lola_on_site + w * (site - lola_on_site)
# corridor samples inside the site footprint take block-averaged NAC heights
for i in range(CH):
    lat = c_lat0 + i * c_dlat
    if not (s_lat0 + (SH - 1) * s_dlat <= lat <= s_lat0): continue
    for j in range(CW):
        lon = c_lon0 + j * c_dlon
        if not (s_lon0 <= lon <= s_lon0 + (SW - 1) * s_dlon): continue
        rr = (lat - s_lat0) / s_dlat; cc = (lon - s_lon0) / s_dlon
        cor[i, j] = map_coordinates(site_f, [[rr], [cc]], order=1)[0]

# write corridor heights + meta
CHUNK_DEG = 0.5
cor.round().astype("<i2").tofile(f"{OUT}/corridor.bin")
wac = Image.open(f"{RAW}/wac_corridor.png"); wm = json.load(open(f"{RAW}/wac_corridor.png.json"))
wa = np.asarray(wac, dtype=np.float32)
lon_min, lon_max = c_lon0, c_lon0 + (CW - 1) * c_dlon
lat_max, lat_min = c_lat0, c_lat0 + (CH - 1) * c_dlat
nci = int(np.floor((lon_max - lon_min) / CHUNK_DEG)); nri = int(np.floor((lat_max - lat_min) / CHUNK_DEG))
TEX = 256
for ri in range(nri):
    for ci in range(nci):
        la1 = lat_max - ri * CHUNK_DEG; la0 = la1 - CHUNK_DEG
        lo0 = lon_min + ci * CHUNK_DEG; lo1 = lo0 + CHUNK_DEG
        u = (np.arange(TEX) + 0.5) / TEX
        lons = lo0 + u * (lo1 - lo0); lats = la1 - u * (la1 - la0)
        px = (lons - wm["lon0"]) / wm["dlon"] - 0.5; py = (lats - wm["lat0"]) / wm["dlat"] - 0.5
        PY, PX = np.meshgrid(py, px, indexing="ij")
        img = map_coordinates(wa, [PY, PX], order=1, mode="nearest")
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(f"{OUT}/corridor/tex_{ri}_{ci}.jpg", quality=88)
json.dump(dict(width=CW, height=CH, lon0=c_lon0, lat0=c_lat0, dlon=c_dlon, dlat=c_dlat, scale=1.0, offset=0.0,
               chunkDeg=CHUNK_DEG, chunkRows=nri, chunkCols=nci, chunkLon0=lon_min, chunkLat0=lat_max, texSize=TEX,
               source="Heights: LRO LOLA LDEM 118 m (USGS Astrogeology), NAC DTM blended inside site. Imagery: LROC WAC global mosaic (NASA/GSFC/ASU) via NASA Moon Trek."),
          open(f"{OUT}/corridor.json", "w"), indent=1)

# ---------- site heights + ortho textures ----------
off = float(np.floor(site_f.min())); sc = 0.02
q = np.round((site_f - off) / sc); assert q.max() < 32767
q.astype("<i2").tofile(f"{OUT}/site.bin")
ortho = np.fromfile(f"{RAW}/nac/ortho_crop_30700_37400.raw", dtype="<i2").reshape(-1, 8440).astype(np.float32)
O_L0 = 30700; o_lat_edge = 1.23650584; o_dlat = (1.23650584 - 0.31464201) / 55908
o_lon_edge = 23.37231647; o_dlon = (23.51150435 - 23.37231647) / 8440
ortho[ortho < 0] = np.nan
lo, hi = np.nanpercentile(ortho, [0.5, 99.8])
ortho = np.nan_to_num((ortho - lo) / (hi - lo) * 235, nan=0)
# hide the Apollo 11 descent stage (and its shadow) visible in the 2011 image: copy a patch from 40 m south
LMLAT, LMLON = 0.67416, 23.47314
lr = int((o_lat_edge - LMLAT) / o_dlat) - O_L0; lc = int((LMLON - o_lon_edge) / o_dlon)
ortho[lr - 22:lr + 22, lc - 16:lc + 30] = ortho[lr - 22 + 80:lr + 22 + 80, lc - 16:lc + 30]
SCH = 256  # DTM samples per chunk edge (512 m)
OTEX = 1024
nsr = int(np.ceil((SH - 1) / SCH)); nsc = int(np.ceil((SW - 1) / SCH))
for ri in range(nsr):
    for ci in range(nsc):
        rA, rB = ri * SCH, min((ri + 1) * SCH, SH - 1); cA, cB = ci * SCH, min((ci + 1) * SCH, SW - 1)
        la1 = s_lat0 + rA * s_dlat; la0 = s_lat0 + rB * s_dlat
        lo0 = s_lon0 + cA * s_dlon; lo1 = s_lon0 + cB * s_dlon
        tw = max(64, int(round(OTEX * (cB - cA) / SCH))); th = max(64, int(round(OTEX * (rB - rA) / SCH)))
        lons = lo0 + (np.arange(tw) + 0.5) / tw * (lo1 - lo0); lats = la1 - (np.arange(th) + 0.5) / th * (la1 - la0)
        px = (lons - o_lon_edge) / o_dlon - 0.5; py = (o_lat_edge - lats) / o_dlat - 0.5 - O_L0
        PY, PX = np.meshgrid(py, px, indexing="ij")
        img = map_coordinates(ortho, [PY, PX], order=1, mode="nearest")
        im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)); im.save(f"{OUT}/site/tex_{ri}_{ci}.jpg", quality=85)
        os.makedirs(f"{OUT}/site_lo", exist_ok=True)  # quarter-res tier preloaded on every device
        im.resize((max(32, tw // 4), max(32, th // 4)), Image.LANCZOS).save(f"{OUT}/site_lo/tex_{ri}_{ci}.jpg", quality=85)
json.dump(dict(width=SW, height=SH, lon0=s_lon0, lat0=s_lat0, dlon=s_dlon, dlat=s_dlat, scale=sc, offset=off,
               chunkSamples=SCH, chunkRows=nsr, chunkCols=nsc,
               lmLat=LMLAT, lmLon=LMLON,
               source="Heights: LROC NAC DTM Apollo 11 (NAC_DTM_APOLLO11, 2 m/post). Imagery: LROC NAC orthophoto M150361817 0.5 m (NASA/GSFC/ASU)."),
          open(f"{OUT}/site.json", "w"), indent=1)
print("done corridor chunks", nri, nci, "site chunks", nsr, nsc)
