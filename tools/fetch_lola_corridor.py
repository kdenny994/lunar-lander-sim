"""Fetch the LOLA 118 m global DEM over the Apollo 11 PDI-to-touchdown corridor.

Source: USGS Astrogeology, Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif
(simple cylindrical, int16, scale 0.5 m, heights relative to 1737.4 km sphere).
Reads only the window via HTTP range requests.
"""
import sys, numpy as np, rasterio
from rasterio.windows import from_bounds
URL = "/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif"
LAT0, LAT1, LON0, LON1 = -1.5, 2.5, 21.0, 42.0
R = 1737400.0
out = sys.argv[1]
with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES"):
    with rasterio.open(URL) as r:
        k = np.pi / 180 * R
        win = from_bounds(LON0 * k, LAT0 * k, LON1 * k, LAT1 * k, r.transform).round_offsets().round_lengths()
        a = r.read(1, window=win).astype(np.float32) * 0.5
        t = r.window_transform(win)
lon0 = t.c / k; lat0 = t.f / k; dlon = t.a / k; dlat = t.e / k
np.savez_compressed(out, h=a, lon0=lon0, lat0=lat0, dlon=dlon, dlat=dlat)
print(a.shape, lon0, lat0, dlon, dlat, a.min(), a.max())
