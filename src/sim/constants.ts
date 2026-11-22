// Physical constants and Apollo LM (LM-5 "Eagle") parameters.
// Values marked ~ are representative figures for the LM descent configuration, not flight-specific data.

export const FT = 0.3048;
export const G0 = 9.80665;

export const MOON = {
  mu: 4.9028e12, // m^3/s^2
  radius: 1737400, // m, LOLA/LROC reference sphere
  omega: 2.6617e-6, // rad/s sidereal rotation about +Z (Moon-fixed frame)
};

export const LM = {
  // Mass at PDI ~ LM-5 launch mass 15,103 kg less the DOI burn (76.4 ft/s) and RCS use.
  massPDI: 14_950, // kg ~
  dpsPropPDI: 8_130, // kg ~ usable DPS propellant at PDI
  rcsProp: 287, // kg RCS propellant (633 lb)
  dryLanded: 6_820, // kg ~ mass with DPS tanks dry (for gauges)
  // Descent Propulsion System
  dpsMaxThrust: 46_706, // N (10,500 lbf = 100 %)
  dpsFTP: 0.925, // fixed-throttle position (~ 9,700 lbf)
  dpsMinThrottle: 0.10,
  dpsMaxThrottle: 0.65, // throttleable range; above this the engine runs at FTP
  dpsIsp: 305, // s ~
  dpsLag: 0.25, // s first-order thrust response
  // Reaction Control System: 16 x 100 lbf jets in four quads
  rcsThrust: 445, // N
  rcsIsp: 290, // s
  rcsArm: 1.67, // m lever arm of each jet about the CG ~
  // Inertia (kg m^2) about body X (up/thrust), Y (right), Z (forward) at PDI and at landing ~
  inertiaFull: [26_000, 32_000, 30_000],
  inertiaLanded: [14_000, 19_000, 17_500],
  // Geometry in body frame (m): origin at the CG, +X up, +Z forward (front hatch/ladder), +Y right
  cgAboveFootpads: 2.45,
  footpadRadius: 4.72, // centre to footpad (31 ft footprint diagonal)
  probeLength: 1.73, // lunar surface sensing probes (68 in); Apollo 11 had none on the +Z leg
  modelHeight: 6.98, // overall height, gear deployed (22 ft 11 in)
};

// Sun and Earth directions in the Moon-fixed frame on 1969-07-20 (approximate):
// sun elevation at Tranquility Base ~10.9 deg from the east, Earth high in the western sky.
export const SUBSOLAR = { lat: 1.2, lon: 102.4 };
export const SUBEARTH = { lat: -3.5, lon: -5.0 };
