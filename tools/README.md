# Data pipeline

Run from the repository root. Raw downloads go to `data-raw/` (git-ignored, ~260 MB). Outputs go to `public/data/`.

1. `python3 tools/fetch_lola_corridor.py data-raw/lola_corridor.npz`: LOLA 118 m DEM window, read with HTTP range requests.
2. `python3 tools/fetch_wac.py data-raw/wac_corridor.png`: WAC mosaic tiles (zoom 8) from NASA Moon Trek.
3. `python3 tools/fetch_wac_global.py`: global WAC mosaic for the background Moon.
4. LROC NAC DTM and orthophoto window from PDS:
   ```
   B=https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO11
   mkdir -p data-raw/nac && cd data-raw/nac
   curl -O $B/NAC_DTM_APOLLO11.TIF
   # orthophoto rows 30700–37400 of the 0.5 m image (16,880-byte records, 1 label record)
   curl -r $((16880*30701))-$((16880*37401-1)) $B/NAC_DTM_APOLLO11_M150361817_50CM.IMG -o ortho_crop_30700_37400.raw
   ```
5. `python3 tools/build_terrain.py`: heightfield binaries and texture chunks.
6. `python3 tools/extract_p66_from_tm.py data-raw/refs/NASA-TM-20220007267_p26_fig14.svg data-raw/p66_tm.json`.
   The SVG comes from `pdftocairo -svg -f 30 -l 30 NASA-TM-20220007267.pdf`.
7. `python3 tools/build_trajectory.py`: `public/data/apollo11_trajectory.json`.
8. `python3 tools/pack_web.py`: packs heights into lossless RGB PNGs and the model into glTF JSON, so that any static host (including claude.ai artifacts) serves them. The `.bin` heights move to `data-raw/terrain/` for `npm test`.
