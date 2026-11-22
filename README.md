# Eagle Descent: Apollo 11 lunar landing simulator

A browser-based simulator of the Apollo 11 powered descent, from PDI (102:33:05 GET) to touchdown at
Tranquility Base (102:45:40). You can watch the reconstructed descent on rails, or take control at any
moment and fly the 6-DOF flight model with a keyboard, a gamepad or flight stick, or iPad touch controls.

```
npm install
npm run dev        # http://localhost:5173 (use --host to reach it from an iPad on the same network)
npm run build      # static site in dist/ — host anywhere (GitHub Pages, S3, Netlify…)
npm test           # headless flight-model checks
```

## What is simulated

**Replay (on rails).** The trajectory is a function of time from PDI, laid along the approach ground track to the
LM's actual position at Tranquility Base.
- PDI → P66 (0–615 s): Bennett, *Apollo Lunar Descent and Ascent Trajectories*, NASA TM X-58040 (1970).
  It uses the Table I premission event states (velocity, altitude rate, altitude) retimed to the flown event times in Table IV.
  The braking-phase deceleration is shaped by the DPS thrust and the rocket equation (13 % trim for 26 s, then fixed throttle),
  and it matches each Table I knot exactly. The result is PDI 260.5 nmi from the landing site (Bennett: "approximately 260")
  and high gate at 4.5 nmi and 7,515 ft.
- P66 → touchdown (615–753 s): Miller, Grauer, Pei & Nelson, *Reconstruction of the Apollo 11 Moon Landing Final
  Descent Trajectory*, NASA/TM-20220007267 (2022), Fig. 14. The range, altitude and pitch histories were extracted at 5 Hz
  straight from the PDF's vector plot paths (`tools/extract_p66_from_tm.py`), so they are not hand-digitized.
- Attitude, thrust and mass are derived from the trajectory. The thrust vector is the kinematic acceleration minus lunar gravity
  and the rotating-frame terms. The yaw to windows-up at 102:36:57–102:37:59 is included, and P66 pitch comes from the TM.
  The flight model reproduces the replay to within about 1 cm over 2 s of braking (`npm test`).
- Events from Table IV appear as captions: 1202/1201 alarms, P64, landing-point redesignation, P66, low-level light, contact.

**Flight model (manual).** The flight model integrates rigid-body dynamics in the Moon-fixed rotating frame at 200 Hz.
- Point-mass lunar gravity, Coriolis and centrifugal terms.
- DPS: 10,500 lbf at 100 %, throttleable 10–65 %, fixed-throttle position 92.5 %, Isp 305 s, thrust lag and propellant depletion.
- RCS: 16 × 100 lbf jets as quad couples, Isp 290 s, own propellant. Inertia varies with mass.
- Digital autopilot: ACA rate command (20°/s full deflection) with attitude hold, and P66 rate-of-descent mode.
  In P66 the ROD switch changes the commanded descent rate by 1 ft/s per click. Manual throttle mode is also available.
- Landing gear: four footpads with spring/damper/friction on the real terrain. The three 68 in probes trigger the contact light.
  Touchdown is scored against the 10 ft/s vertical, 4 ft/s horizontal and 12° tilt limits.

## Terrain and imagery

| Region | Heights | Imagery |
|---|---|---|
| Approach corridor, 21–42°E, 1.5°S–2.5°N | LRO LOLA LDEM 118 m (USGS Astrogeology) | LROC WAC global mosaic, ~100 m/px (NASA Moon Trek WMTS) |
| Tranquility Base, 4 × 3.3 km | LROC NAC DTM `NAC_DTM_APOLLO11`, 2 m/post | LROC NAC orthophoto M150361817, 0.5 m/px |
| Rest of the Moon | sphere | LROC WAC global mosaic (zoom 3) |

LROC data products are NASA/PDS public domain. Credit NASA/GSFC/Arizona State University.
The NAC data now lives on `pds.mcp.nasa.gov`; `pds.lroc.im-ldi.com` redirects there.
The Eagle's descent stage, which is visible in the 2011 orthophoto, is patched out so the simulated LM doesn't land on its own image.
The touchdown point (0.67416°N, 23.47314°E) is the descent stage's location in that image.

The 0.5 m imagery covers only the final ~1.5 km of the approach. Before that, the ground is WAC/LOLA at ~100 m.
That matches what an LROC-based approach can show today: NAC strips of the whole 480 km corridor exist, but they would be
tens of GB of uncontrolled, differently lit images. They are a good next step for the P64 approach (8 km → site).

Regenerate everything with the scripts in `tools/` (Python 3 + numpy, scipy, rasterio, Pillow):
`fetch_lola_corridor.py`, `fetch_wac.py`, `fetch_wac_global.py`, `build_terrain.py`, `build_trajectory.py`.
The NAC DTM and orthophoto window download commands are noted in `tools/README.md`.

## Controls

- Keyboard: Space take control / back to replay · W/S pitch · A/D roll · Q/E yaw · R/F ROD · T throttle mode ·
  Shift/Ctrl throttle · I/K/J/L RCS translation · X engine stop · V view · P pause · , . time warp.
- Gamepad (standard mapping): left stick ACA, right stick yaw and fore/aft translation, triggers throttle, d-pad ROD.
- Flight stick / HOTAS: roll, pitch, twist yaw, throttle lever. Axis indices are in `src/ui/input.ts` (`hotas`).
- iPad: on-screen sticks and switches. Views: chase (drag to orbit, pinch to zoom), commander's window with
  the LPD scale, and a surface observer at Tranquility Base.

## Known approximations

- The trajectory is planar, so crossrange is ignored. The approach azimuth is due west, so Apollo 11's ~400 ft
  crossrange manoeuvring in P66 is not shown.
- LM mass properties and inertia are representative LM-5 figures, not flight-specific data. The replay's landed mass
  is 7,253 kg, with about 270 kg of DPS propellant left.
- Gravity is a point mass with no mascons. The Sun and Earth directions are approximate for 20 July 1969
  (Sun 10.9° above the eastern horizon at the site).
- The LM model is exterior only. The interior view is the commander's window with an etched LPD scale.
