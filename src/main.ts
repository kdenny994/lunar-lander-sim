import * as THREE from 'three';
import { FT, LM, MOON } from './sim/constants';
import { skyAt, planetsFromMoon, jdUTFromSimTime } from './sim/ephemeris';
import { RenderFrame, enuAt, llrToVec, vecToLLR } from './sim/geo';
import { TerrainData } from './sim/terrainData';
import { Replay, type ReplaySample, type TrajectoryFile } from './sim/replay';
import { LMState, stepLM } from './sim/lm';
import { DigitalAutopilot } from './sim/dap';
import { TerrainRenderer } from './render/terrain';
import { LMModel } from './render/lmModel';
import { InputManager, type Action } from './ui/input';
import { setupTouch } from './ui/touch';
import { Hud } from './ui/hud';
import { SkyRenderer, type SkyData } from './render/sky';
import { SkyPanel, SENSORS, type RefPhoto } from './ui/skyPanel';

const BASE = './data';
const $ = (id: string) => document.getElementById(id)!;
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timed out loading ${what}`)), ms))]);
const loadMsg = (m: string, frac?: number) => { $('ld-msg').textContent = m; if (frac !== undefined) ($('ld-bar') as HTMLElement).style.width = `${Math.round(frac * 100)}%`; };

type Mode = 'replay' | 'flight';
type View = 'chase' | 'cockpit' | 'ground' | 'sky';

async function apolloMain() {
  loadMsg('Loading trajectory…', 0.02);
  const traj: TrajectoryFile = await fetch(`${BASE}/apollo11_trajectory.json`).then((r) => r.json());
  const terrain = await TerrainData.load(`${BASE}/terrain`, (m) => loadMsg(m, 0.08));
  const replay = new Replay(traj, terrain);
  const frame = new RenderFrame(traj.landing.lat, traj.landing.lon);

  // ---------- renderer / scene ----------
  // phones and tablets: cap the pixel ratio and shadow resolution to keep frame rate and GPU memory in check
  const mobile = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/.test(navigator.userAgent);
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile || window.devicePixelRatio < 2, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); loadMsg('The graphics context was lost (the device reclaimed GPU memory). Reload the page to continue.'); $('loading').hidden = false; });
  for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  $('app').appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 4e6);

  // Sun and Earth directions (Moon-fixed) come from the ephemeris for the current mission time
  let skyState = skyAt(0);
  const sunDirW = skyState.sunDir.clone();
  const earthDirW = skyState.earthDir.clone();
  const sun = new THREE.DirectionalLight(0xfff6ea, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16;
  scene.add(sun, sun.target);
  scene.add(new THREE.AmbientLight(0x9fb4d0, 0.05)); // earthshine
  // Sky: star catalogue, planets for the landing date, Sun and a textured Earth
  loadMsg('Loading star catalogue and Earth…', 0.12);
  let skyData: SkyData = { stars: [], named: [], lines: [] };
  try { skyData = await withTimeout(fetch(`${BASE}/sky/sky.json`).then((r) => r.json()), 30000, 'star catalogue'); } catch (e) { console.error(e); }
  let earthTex: THREE.Texture;
  try { earthTex = await withTimeout(new THREE.TextureLoader().loadAsync(`${BASE}/sky/earth.jpg`), 30000, 'Earth map'); }
  catch (e) { console.error(e); earthTex = new THREE.DataTexture(new Uint8Array([60, 100, 170, 255]), 1, 1); earthTex.needsUpdate = true; }
  const planets = planetsFromMoon(jdUTFromSimTime(700) + 39.7 / 86400);
  const sky = new SkyRenderer(skyData, planets, earthTex);
  scene.add(sky.group);

  const terrainR = new TerrainRenderer(terrain, frame, `${BASE}/terrain`);
  terrainR.anisotropy = renderer.capabilities.getMaxAnisotropy();
  scene.add(terrainR.group);
  const lm = new LMModel();
  scene.add(lm.body, lm.dustObject);
  loadMsg('Loading lunar module…', 0.15);
  try {
    await withTimeout(lm.load('./models/apollo_lm.gltf.json'), 45000, 'lunar module model');
  } catch (e) {
    console.error(e);
    lm.addPlaceholder();
    loadMsg('Lunar module model failed to load, using a simple stand-in.', 0.18);
  }
  loadMsg('Loading LROC imagery…', 0.2);
  try {
    await withTimeout(terrainR.loadTextures((d, n) => loadMsg(`Loading LROC imagery… ${d}/${n}`, 0.2 + 0.7 * (d / n))), 120000, 'LROC imagery');
  } catch (e) { console.error(e); } // continue with whatever imagery arrived

  // ---------- simulation state ----------
  const input = new InputManager();
  const touch = setupTouch(input);
  const dap = new DigitalAutopilot();
  const hud = new Hud(traj);
  const phys = new LMState();
  let mode: Mode = 'replay';
  let view: View = 'chase';
  let tRail = 0;
  let paused = false;
  const warps = [1, 2, 5, 10, 20];
  let warpI = 0;
  const rs: ReplaySample = replay.sample(0);
  const origin = new THREE.Vector3();
  const prevOrigin = new THREE.Vector3();
  let firstFrame = true;
  let lowLevelT = Infinity;

  const disp = { r: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), thrust: 0, mass: 0, dpsProp: 0, rcsProp: LM.rcsProp, t: 0, program: '63', contact: false };

  function setMode(m: Mode) {
    mode = m;
    if (m === 'flight') {
      replay.sample(tRail, rs);
      phys.r.copy(rs.r); phys.v.copy(rs.v); phys.q.copy(rs.q); phys.w.set(0, 0, 0);
      phys.dpsProp = rs.dpsProp; phys.rcsProp = disp.rcsProp; phys.thrust = rs.thrust; phys.t = tRail;
      phys.dryMass = rs.mass - rs.dpsProp - phys.rcsProp;
      phys.contact = { contactLight: false, padsDown: 0, touchdown: null }; phys.landed = false; phys.crashed = false;
      dap.engage(phys); dap.engineArmed = true;
      dap.throttleMode = tRail >= 500 ? 'p66' : 'manual';
      input.state.throttle = Math.max(LM.dpsMinThrottle, rs.thrust);
      if (warpI > 2) warpI = 2;
      hud.event('Manual control: rate command / attitude hold' + (dap.throttleMode === 'p66' ? ', P66 rate of descent' : ', manual throttle'), phys.t);
    } else {
      hud.event('Replay resumed', tRail);
    }
    hud.setMode(m, dap.throttleMode);
    touch.show(m === 'flight');
  }

  function restart(t: number, manual: boolean) {
    tRail = t; lowLevelT = Infinity;
    terrainR.warm(replay.sample(t).r, 2);
    hud.clearEvents(); hud.resetEvents(t);
    disp.rcsProp = LM.rcsProp;
    $('result').hidden = true;
    mode = 'replay';
    if (manual) setMode('flight'); else { hud.setMode('replay', dap.throttleMode); touch.show(false); }
  }

  input.on((a: Action) => {
    switch (a) {
      case 'takeControl': if (mode === 'replay') setMode('flight'); else { tRail = Math.min(phys.t, replay.duration); setMode('replay'); } break;
      case 'view': setView(view === 'chase' ? 'cockpit' : view === 'cockpit' ? 'ground' : view === 'ground' ? 'sky' : 'chase'); break;
      case 'pause': paused = !paused; break;
      case 'warpUp': warpI = Math.min(mode === 'flight' ? 2 : warps.length - 1, warpI + 1); break;
      case 'warpDown': warpI = Math.max(0, warpI - 1); break;
      case 'rodUp': if (mode === 'flight') { dap.rodClick(1); hud.flash(`ROD ${fmtRate(dap.hdotCmd)}`); } break;
      case 'rodDown': if (mode === 'flight') { dap.rodClick(-1); hud.flash(`ROD ${fmtRate(dap.hdotCmd)}`); } break;
      case 'throttleMode':
        if (mode === 'flight') {
          dap.throttleMode = dap.throttleMode === 'p66' ? 'manual' : 'p66';
          if (dap.throttleMode === 'p66') dap.engage(phys); else input.state.throttle = phys.thrust;
          hud.setMode(mode, dap.throttleMode);
        }
        break;
      case 'engineStop': if (mode === 'flight') { dap.engineArmed = !dap.engineArmed; hud.event(dap.engineArmed ? 'Engine armed' : 'Engine stop', phys.t); } break;
      case 'restart': restart(0, false); break;
    }
  });

  // ---------- buttons ----------
  $('btn-view').addEventListener('click', () => input.emit('view'));
  $('btn-pause').addEventListener('click', () => input.emit('pause'));
  $('btn-warp').addEventListener('click', () => { warpI = (warpI + 1) % (mode === 'flight' ? 3 : warps.length); });
  $('btn-take').addEventListener('click', () => input.emit('takeControl'));
  $('btn-help').addEventListener('click', () => { $('help').hidden = false; });
  $('help-close').addEventListener('click', () => { $('help').hidden = true; });
  $('res-close').addEventListener('click', () => { $('result').hidden = true; });
  $('btn-start').addEventListener('click', () => { $('start-menu').hidden = !$('start-menu').hidden; });
  for (const b of Array.from(document.querySelectorAll('#start-menu button'))) {
    b.addEventListener('click', () => {
      restart(Number((b as HTMLElement).dataset.t), ($('start-manual') as HTMLInputElement).checked);
      $('start-menu').hidden = true;
    });
  }
  $('credits').innerHTML = [
    ...traj.sources,
    (terrain.corridor.meta.source as string), (terrain.site.meta.source as string),
    'LM 3D model supplied by the project owner.',
    'Sky: Sun and Moon from Meeus, Astronomical Algorithms (ch. 47); planets from JPL approximate Keplerian elements (Standish); lunar orientation from the IAU WGCCRE 2009 model; stars from the Hipparcos / Yale Bright Star catalogues via d3-celestial (BSD-3).',
    'Earth: NASA Blue Marble (Visible Earth). Reference photos AS11-37-5458, AS11-44-6552, AS11-37-5437: NASA, images.nasa.gov.',
  ].map((s) => `• ${s}`).join('<br>');

  // ---------- camera controls (drag / wheel / pinch) ----------
  const camCtl = { az: Math.PI, el: 0.25, dist: window.innerWidth < window.innerHeight ? 46 : 28, lookYaw: 0, lookPitch: -0.55 };
  // planetarium view: look direction in local ENU (az from north, el), vertical field of view in degrees
  const skyCtl = { az: -Math.PI / 2, el: 0.75, fov: 60, eyeLogLa: -3, matchSquare: false };
  const skyPanel = new SkyPanel();
  function setView(v: View) {
    view = v;
    skyPanel.setVisible(v === 'sky');
    if (v !== 'sky') skyCtl.matchSquare = false;
  }
  const lookAt = (dirW: THREE.Vector3) => {
    const { e, n, u } = enuAt(disp.r);
    skyCtl.az = Math.atan2(dirW.dot(e), dirW.dot(n));
    skyCtl.el = Math.asin(Math.max(-1, Math.min(1, dirW.dot(u))));
  };
  skyPanel.onGoto = (w) => {
    skyCtl.matchSquare = false;
    if (w === 'earth') { lookAt(earthDirW); skyCtl.fov = Math.min(skyCtl.fov, 30); }
    else if (w === 'sun') lookAt(sunDirW);
    else { skyCtl.el = Math.PI / 2; skyCtl.fov = Math.max(skyCtl.fov, 90); }
  };
  skyPanel.onPhoto = (p: RefPhoto) => {
    if (p.when === 'landed') restart(replay.duration, false);
    else if (p.when === 'pdi') restart(0, false);
    if (p.when !== 'now') paused = true;
    skyPanel.setSensor(p.sensor);
    skyCtl.fov = p.fov; skyCtl.matchSquare = true;
    pendingLook = p;
  };
  let pendingLook: RefPhoto | null = null;
  const applyPhotoLook = (p: RefPhoto) => {
    if (p.look.kind === 'earth') { lookAt(earthDirW); return; }
    const { e, n, u } = enuAt(disp.r);
    const side = p.look.side * Math.PI / 180;
    const w = new THREE.Vector3(0, Math.sin(side), Math.cos(side)).applyQuaternion(disp.q); // body +Z = windows, +Y = right
    w.addScaledVector(u, -w.dot(u));
    skyCtl.az = Math.atan2(w.dot(e), w.dot(n));
    skyCtl.el = p.look.el * Math.PI / 180;
  };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch0 = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); renderer.domElement.setPointerCapture(e.pointerId); });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0) {
        if (view === 'sky') skyCtl.fov = Math.min(100, Math.max(2, skyCtl.fov * (pinch0 / d)));
        else camCtl.dist = Math.min(5000, Math.max(8, camCtl.dist * (pinch0 / d)));
      }
      pinch0 = d; return;
    }
    if (view === 'sky') {
      const k = (skyCtl.fov * Math.PI / 180) / window.innerHeight;
      skyCtl.az -= dx * k; skyCtl.el = Math.max(-0.6, Math.min(Math.PI / 2, skyCtl.el + dy * k));
    } else if (view === 'cockpit') {
      camCtl.lookYaw = Math.max(-1.2, Math.min(1.2, camCtl.lookYaw - dx * 0.004));
      camCtl.lookPitch = Math.max(-1.3, Math.min(0.6, camCtl.lookPitch - dy * 0.004));
    } else {
      camCtl.az -= dx * 0.006; camCtl.el = Math.max(-0.2, Math.min(1.5, camCtl.el + dy * 0.004));
    }
  });
  const up = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch0 = 0; };
  renderer.domElement.addEventListener('pointerup', up);
  renderer.domElement.addEventListener('pointercancel', up);
  renderer.domElement.addEventListener('wheel', (e) => { if (view === 'sky') { skyCtl.fov = Math.min(100, Math.max(2, skyCtl.fov * Math.exp(e.deltaY * 0.001))); e.preventDefault(); return; } camCtl.dist = Math.min(5000, Math.max(8, camCtl.dist * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
  const onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 300));

  // ---------- loop ----------
  loadMsg('Building terrain…', 0.95);
  replay.sample(0, rs);
  origin.copy(rs.r);
  terrainR.warm(origin, 3);
  $('loading').hidden = true;
  hud.resetEvents(0);
  hud.setMode('replay', dap.throttleMode);
  touch.show(false);

  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const qRender = new THREE.Quaternion();
  let physAcc = 0;
  let skyT = -1e9;
  const PHYS_DT = 0.005;


  // ---------- sky exposure: what the chosen sensor can detect ----------
  let readoutT = 0;
  const v3 = () => new THREE.Vector3();
  function updateSkyExposure(dt: number, sunR: THREE.Vector3, upR: THREE.Vector3, altCG: number) {
    const sensor = view === 'sky' ? skyPanel.sensor : 'eye';
    const S = SENSORS[sensor];
    const sunUp = sunR.dot(upR) > -0.005;
    const fwd = v3().set(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = v3().set(1, 0, 0).applyQuaternion(camera.quaternion);
    const camUp = v3().set(0, 1, 0).applyQuaternion(camera.quaternion);
    // adaptation field: what is in view, never narrower than the eye's central +/-50 deg
    const aspect = window.innerWidth / window.innerHeight;
    const half = Math.min(80, Math.max(50, (camera.fov / 2) * Math.max(1, aspect)));
    const sunAng = Math.acos(Math.max(-1, Math.min(1, fwd.dot(sunR)))) * 180 / Math.PI;
    const dip = Math.acos(MOON.radius / (MOON.radius + Math.max(0, altCG) + 2));
    const Lg = 0.12 * 127000 * Math.max(0, sunR.dot(upR)) / Math.PI; // sunlit regolith, cd/m^2
    let sum = 0, n = 0;
    const t = Math.tan(half * Math.PI / 180), d = v3();
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      d.copy(fwd).addScaledVector(right, (t * i) / 3).addScaledVector(camUp, (t * j) / 3).normalize();
      if (Math.asin(d.dot(upR)) < -dip) sum += Lg;
      n++;
    }
    let La = sum / n + (sunUp ? 0.3 : 0.001); // + sunlit cabin / visor scatter
    if (sunUp && sunAng < half) La += 1.09e5 / (2 * Math.PI * (1 - Math.cos(half * Math.PI / 180))); // the solar disc itself
    const target = Math.log10(La);
    const tau = target > skyCtl.eyeLogLa ? 0.4 : 5; // light adaptation is fast, dark adaptation slow (time-compressed)
    skyCtl.eyeLogLa += (target - skyCtl.eyeLogLa) * (1 - Math.exp(-dt / tau));
    // glare only when the Sun is in, or just outside, the field actually in view (window frames and visors shade the rest)
    const diagHalf = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.hypot(1, aspect)) * 180 / Math.PI;
    const glareField = sunUp ? Math.max(0, Math.min(1, (diagHalf + 10 - sunAng) / 15)) : 0;
    sky.starMat.uniforms.uLa0.value = S.La0;
    sky.setSensor({
      lim0: S.lim0, slope: S.slope, La: sensor === 'eye' ? Math.pow(10, skyCtl.eyeLogLa) : 0,
      glare: sensor === 'camera' ? 0 : glareField, aperture: S.aperture, spikes: S.spikes, glow: S.glow,
    }, renderer.getPixelRatio());
    sky.sun.visible = sunUp;

    if (view !== 'sky') { skyPanel.drawLabels([], null); return; }
    const { e: E, n: N } = enuAt(disp.r);
    const eastR = frame.dir(E).normalize(), northR = frame.dir(N).normalize();
    const azel = (dir: THREE.Vector3) => {
      const az = (Math.atan2(dir.dot(eastR), dir.dot(northR)) * 180 / Math.PI + 360) % 360;
      return { az, el: Math.asin(Math.max(-1, Math.min(1, dir.dot(upR)))) * 180 / Math.PI };
    };
    const eR = frame.dir(earthDirW).normalize();
    const items: { name: string; dir: THREE.Vector3; cls?: string; always?: boolean }[] = [
      { name: 'Sun', dir: sunR.clone().multiplyScalar(1000), cls: 'body', always: true },
      { name: 'Earth', dir: eR.clone().multiplyScalar(1000), cls: 'body', always: true },
    ];
    for (const p of sky.planets) items.push({ name: p.name, dir: sky.toRender(p.dir).multiplyScalar(1000), cls: 'planet' });
    for (const st of sky.named) items.push({ name: st.name, dir: sky.toRender(st.dir).multiplyScalar(1000) });
    sky.lines.visible = skyPanel.labels;
    skyPanel.drawLabels(items, camera);

    readoutT -= dt;
    if (readoutT > 0) return;
    readoutT = 0.25;
    const look = azel(fwd), sA = azel(sunR), eA = azel(eR);
    const lim = sky.limitAt(fwd, sunR);
    const lit = (1 + sunDirW.dot(v3().copy(earthDirW).negate())) / 2;
    const adapting = sensor === 'eye' && Math.abs(target - skyCtl.eyeLogLa) > 0.3;
    const utc = new Date((skyState.jdUT - 2440587.5) * 864e5).toISOString().replace('T', ' ').slice(0, 19);
    const vis = sky.planets.map((p) => ({ p, a: azel(sky.toRender(p.dir)) })).filter((x) => x.a.el > 0)
      .map((x) => `${x.p.name} ${x.p.mag >= 0 ? '+' : ''}${x.p.mag.toFixed(1)}`).join(', ');
    skyPanel.readout(
      `<b>${SENSORS[sensor].label}</b> <span class="dim desc">${SENSORS[sensor].desc}</span><br>` +
      `Looking az ${look.az.toFixed(0)}° el ${look.el.toFixed(0)}° · field ${skyCtl.fov.toFixed(1)}° · ` +
      `faintest star here ${lim < -5.5 ? 'none (sky records black)' : (lim >= 0 ? '+' : '') + lim.toFixed(1) + ' mag'}${adapting ? ' · <i>eye adapting</i>' : ''}<br>` +
      `Sun el ${sA.el.toFixed(1)}° az ${sA.az.toFixed(0)}° · Earth el ${eA.el.toFixed(1)}° az ${eA.az.toFixed(0)}°, ${(lit * 100).toFixed(0)}% lit, ` +
      `${(2 * Math.asin(6378.137 / skyState.earthDistKm) * 180 / Math.PI).toFixed(2)}° across<br>` +
      `<span class="dim">${utc} UTC${vis ? ' · planets up: ' + vis : ''}</span>`);
  }

  function frameLoop() {
    requestAnimationFrame(frameLoop);
    const dtReal = Math.min(0.1, clock.getDelta());
    input.update(dtReal);
    const warp = warps[warpI];
    const dt = paused ? 0 : dtReal * warp;

    if (mode === 'replay') {
      const t0 = tRail;
      tRail = Math.min(replay.duration + 30, tRail + dt);
      replay.sample(tRail, rs);
      disp.r.copy(rs.r); disp.v.copy(rs.v); disp.q.copy(rs.q); disp.thrust = rs.thrust; disp.mass = rs.mass; disp.dpsProp = rs.dpsProp;
      disp.t = tRail; disp.program = rs.program;
      disp.contact = tRail >= replay.duration - 1.0;
      for (const ev of replay.eventsBetween(t0, tRail)) hud.event(ev.label, ev.tfi, ev.get);
      if (tRail >= replay.duration) { disp.thrust = 0; disp.v.set(0, 0, 0); }
    } else {
      physAcc += dt;
      let n = 0;
      while (physAcc >= PHYS_DT && n < 4000) {
        const c = dap.update(phys, input.state, PHYS_DT);
        stepLM(phys, c, PHYS_DT, terrain);
        physAcc -= PHYS_DT; n++;
        if (phys.contact.contactLight && !disp.contact) { hud.event('Contact light', phys.t); }
        disp.contact = phys.contact.contactLight;
      }
      disp.r.copy(phys.r); disp.v.copy(phys.v); disp.q.copy(phys.q); disp.thrust = phys.thrust; disp.mass = phys.mass;
      disp.dpsProp = phys.dpsProp; disp.rcsProp = phys.rcsProp; disp.t = phys.t; disp.program = '66';
      if (phys.contact.touchdown && $('result').hidden && !hud.resultShown) showResult();
      if (phys.dpsProp < 520 && lowLevelT === Infinity) { lowLevelT = phys.t; hud.event('DES QTY low-level light', phys.t); }
    }

    // ---- floating origin at the LM CG ----
    prevOrigin.copy(origin);
    origin.copy(disp.r);
    if (!firstFrame) lm.shiftDust(frame.dir(tmp.copy(origin).sub(prevOrigin)));
    firstFrame = false;
    const { e: E, n: N, u: U } = enuAt(origin);
    const upR = frame.dir(U).normalize();
    const eastR = frame.dir(E).normalize();
    const northR = frame.dir(N).normalize();
    qRender.copy(frame.q).multiply(disp.q);
    lm.body.position.set(0, 0, 0);
    lm.body.quaternion.copy(qRender);
    lm.setThrust(disp.thrust);

    const { lat, lon, r } = vecToLLR(disp.r);
    const ground = MOON.radius + terrain.heightAt(lat, lon);
    const altCG = r - ground;
    const altPads = altCG - LM.cgAboveFootpads;

    // ---- ephemeris (Sun, Earth, sky orientation for the current mission time) ----
    if (Math.abs(disp.t - skyT) > 1) { skyT = disp.t; skyState = skyAt(disp.t); sunDirW.copy(skyState.sunDir); earthDirW.copy(skyState.earthDir); }

    // ---- sun / shadow ----
    const sunR = frame.dir(sunDirW).normalize();
    const sinEl = Math.max(0.05, sunR.dot(upR));
    const tGround = Math.min(2000, Math.max(0, altCG) / sinEl);
    const target = tmp.copy(sunR).multiplyScalar(-tGround);
    sun.target.position.copy(target);
    sun.position.copy(target).addScaledVector(sunR, 60);
    sc.near = 1; sc.far = 140; sc.updateProjectionMatrix();
    sun.castShadow = altCG < 1500;

    // ---- dust ----
    const groundPt = tmp2.copy(upR).multiplyScalar(-altCG);
    lm.updateDust(dt, altPads, disp.thrust, groundPt, upR);

    // ---- camera ----
    if (view === 'sky' && pendingLook) { applyPhotoLook(pendingLook); pendingLook = null; }
    lm.model.visible = view !== 'cockpit' && view !== 'sky';
    $('cockpit').hidden = view !== 'cockpit';
    if (view === 'cockpit') {
      camera.fov = 62;
      // commander's eye: left (-Y) station, looking out the forward window
      const eye = new THREE.Vector3(1.0, -0.55, 1.05).applyQuaternion(qRender);
      camera.position.copy(eye);
      const fwd = new THREE.Vector3(0, 0, 1), upB = new THREE.Vector3(1, 0, 0);
      const look = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), camCtl.lookPitch)
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), camCtl.lookYaw);
      camera.up.copy(upB.applyQuaternion(qRender));
      camera.lookAt(eye.add(look.applyQuaternion(qRender)));
    } else if (view === 'chase') {
      camera.fov = 50;
      // orbit in local ENU, azimuth relative to the direction of travel
      const vh = frame.dir(disp.v).addScaledVector(upR, -frame.dir(disp.v).dot(upR));
      const heading = vh.lengthSq() > 1 ? Math.atan2(vh.dot(eastR), vh.dot(northR)) : -Math.PI / 2;
      const az = heading + camCtl.az;
      const dir = northR.clone().multiplyScalar(Math.cos(az) * Math.cos(camCtl.el))
        .addScaledVector(eastR, Math.sin(az) * Math.cos(camCtl.el)).addScaledVector(upR, Math.sin(camCtl.el));
      camera.position.copy(dir.multiplyScalar(camCtl.dist));
      // keep the camera above the ground
      const camAlt = camera.position.dot(upR) + altCG;
      if (camAlt < 1.6) camera.position.addScaledVector(upR, 1.6 - camAlt);
      camera.up.copy(upR);
      camera.lookAt(0, 0, 0);
    } else if (view === 'sky') {
      // planetarium: commander's eye position, free look over the whole sky
      const aspect = window.innerWidth / window.innerHeight;
      // a reference photo is square: make its field span the shorter screen side
      camera.fov = skyCtl.matchSquare && aspect < 1 ? 2 * Math.atan(Math.tan(skyCtl.fov * Math.PI / 360) / aspect) * 180 / Math.PI : skyCtl.fov;
      camera.position.copy(new THREE.Vector3(1.0, -0.55, 1.05).applyQuaternion(qRender));
      const ca = Math.cos(skyCtl.el);
      const look = northR.clone().multiplyScalar(Math.cos(skyCtl.az) * ca).addScaledVector(eastR, Math.sin(skyCtl.az) * ca).addScaledVector(upR, Math.sin(skyCtl.el));
      // near the zenith keep "up" pointing away from the look azimuth so the view does not spin
      const upHint = Math.abs(skyCtl.el) > 1.45
        ? northR.clone().multiplyScalar(-Math.cos(skyCtl.az)).addScaledVector(eastR, -Math.sin(skyCtl.az))
        : upR.clone();
      camera.up.copy(upHint);
      camera.lookAt(camera.position.clone().add(look));
    } else {
      // ground observer near Tranquility Base, 120 m south-west of the landing point
      camera.fov = 40;
      const site = llrToVec(traj.landing.lat - 0.0025, traj.landing.lon - 0.003, 0);
      const sh = terrain.heightAt(traj.landing.lat - 0.0025, traj.landing.lon - 0.003);
      site.setLength(MOON.radius + sh + 1.7);
      camera.position.copy(frame.dir(site.sub(origin)));
      camera.up.copy(upR);
      camera.lookAt(0, 0, 0);
    }
    camera.updateProjectionMatrix();

    // ---- sky: positions, then what a sensor could detect ----
    camera.updateMatrixWorld();
    const eR = frame.dir(earthDirW).normalize();
    sky.update(camera, frame, skyState, sunR, eR);
    updateSkyExposure(dtReal, sunR, upR, altCG);

    terrainR.update(origin, camera.position);
    renderer.render(scene, camera);

    // ---- HUD ----
    const vR = disp.v;
    const hdot = vR.dot(U);
    // cross-pointer axes: body +Z projected on the horizontal, or -X when the LM is tilted past 45 deg
    const xb = new THREE.Vector3(1, 0, 0).applyQuaternion(disp.q);
    const fwdDir = Math.abs(xb.dot(U)) < 0.7 ? xb.clone().negate() : new THREE.Vector3(0, 0, 1).applyQuaternion(disp.q);
    fwdDir.addScaledVector(U, -fwdDir.dot(U)).normalize();
    const latDir = fwdDir.clone().cross(U).normalize(); // to the right
    const pitchFromVert = Math.acos(Math.max(-1, Math.min(1, xb.dot(U)))) * 180 / Math.PI;
    const range = mode === 'replay' ? rs.downrange : surfaceDistance(disp.r, traj.landing.lat, traj.landing.lon);
    hud.update({
      t: disp.t, program: disp.program, altitude: Math.max(0, altPads), hdot,
      vFwd: vR.dot(fwdDir), vLat: vR.dot(latDir), thrust: disp.thrust, dpsProp: disp.dpsProp, rcsProp: disp.rcsProp,
      pitch: pitchFromVert, range, contact: disp.contact, mode, throttleMode: dap.throttleMode, hdotCmd: dap.hdotCmd,
      engineArmed: mode === 'replay' ? disp.thrust > 0 : dap.engineArmed, lowLevel: disp.t >= (mode === 'replay' ? 683 : lowLevelT),
      warp, paused, view,
      lpd: computeLPD(disp, traj, frame),
    });
    if (view === 'cockpit') hud.drawLPD(camera, qRender);
  }

  function showResult() {
    const td = phys.contact.touchdown!;
    hud.resultShown = true;
    const good = td.vVert <= 3.05 && td.vHorz <= 1.22 && td.tilt <= 12;
    $('res-title').textContent = phys.crashed ? 'Crash' : good ? 'The Eagle has landed' : 'Hard landing';
    const d = surfaceDistance(phys.r, traj.landing.lat, traj.landing.lon);
    $('res-body').innerHTML = [
      `Vertical speed: ${(td.vVert / FT).toFixed(1)} ft/s (limit 10)`,
      `Horizontal speed: ${(td.vHorz / FT).toFixed(1)} ft/s (limit 4)`,
      `Tilt: ${td.tilt.toFixed(1)}° (limit 12°)`,
      `DPS propellant left: ${Math.round(phys.dpsProp)} kg (${(phys.dpsProp / (phys.thrust * LM.dpsMaxThrust / (LM.dpsIsp * 9.80665) || 4)).toFixed(0)} s)`,
      `Distance from Tranquility Base: ${d.toFixed(0)} m`,
    ].join('<br>');
    $('result').hidden = false;
  }

  frameLoop();
  (window as any).__sim = { replay, phys, setMode, restart, get mode() { return mode; }, get t() { return disp.t; }, setView: (v: View) => setView(v), skyCtl, skyPanel, camCtl, renderer };
}

function fmtRate(v: number) { const f = v / FT; return `${f >= 0 ? '+' : ''}${f.toFixed(0)} ft/s`; }

function surfaceDistance(r: THREE.Vector3, lat: number, lon: number) {
  const s = llrToVec(lat, lon, 1);
  return Math.acos(Math.min(1, r.clone().normalize().dot(s))) * MOON.radius;
}

/** Landing point designator angle: angle below body +Z of the line of sight to the target (deg). */
function computeLPD(d: { r: THREE.Vector3; q: THREE.Quaternion }, traj: TrajectoryFile, _f: RenderFrame) {
  const target = llrToVec(traj.landing.lat, traj.landing.lon, d.r.length() - 0); // direction only near target
  const siteH = 0; void siteH;
  const los = target.setLength(MOON.radius - 1930).sub(d.r).normalize();
  const inv = d.q.clone().invert();
  const b = los.applyQuaternion(inv);
  return Math.atan2(-b.x, b.z) * 180 / Math.PI;
}

// ---------- boot: mission chooser ----------
type Mission = 'apollo' | 'starship';
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const ENG_NOTES: Record<number, string> = {
  3: 'Three Raptors: the shortest, most efficient braking burn (ignition about 110 km out). Recommended.',
  2: 'Two Raptors: ignition about 160 km out, a gentler burn that still lands on the target.',
  1: 'One Raptor: 2.9 MN on a 450 t ship, so ignition comes about 320 km out and the burn takes about 7 minutes. Switching down to one engine mid-burn makes the guidance land long, downrange of the planned site.',
};

function startMission(m: Mission, ss?: { engines: number; manual: boolean }) {
  $('mission').hidden = true;
  $('loading').hidden = false;
  const fail = (e: any) => { console.error(e); loadMsg(`Failed to start: ${e?.message ?? e}`); };
  if (m === 'starship') {
    document.body.classList.add('ss');
    $('loading').querySelector('.ld-title')!.textContent = 'Starship HLS · Shackleton';
    import('./starshipMain').then((mod) => mod.starshipMain(ss ?? { engines: 3, manual: false })).catch(fail);
  } else {
    apolloMain().catch(fail);
  }
}

function boot() {
  const chooseAgain = () => { location.hash = 'choose'; location.reload(); };
  $('btn-mission').addEventListener('click', chooseAgain);
  $('help-mission').addEventListener('click', chooseAgain);
  const h = location.hash.slice(1);
  let engines = Math.min(3, Math.max(1, Number(store.get('ss-engines')) || 3));
  let manual = store.get('ss-manual') === '1';
  if (h === 'apollo') return startMission('apollo');
  if (h === 'starship') return startMission('starship', { engines, manual });

  $('loading').hidden = true;
  $('mission').hidden = false;
  let mission: Mission = store.get('mission') === 'starship' ? 'starship' : 'apollo';
  const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('#mission .mcard'));
  const engBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('#ss-eng-choice button'));
  const manualBox = $('ss-manual') as HTMLInputElement;
  const paint = () => {
    cards.forEach((c) => c.classList.toggle('on', c.dataset.m === mission));
    $('ss-options').hidden = mission !== 'starship';
    engBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === engines));
    $('ss-eng-note').textContent = ENG_NOTES[engines];
    manualBox.checked = manual;
  };
  cards.forEach((c) => c.addEventListener('click', () => { mission = c.dataset.m as Mission; paint(); }));
  cards.forEach((c) => c.addEventListener('dblclick', () => $('mission-go').click()));
  engBtns.forEach((b) => b.addEventListener('click', () => { engines = Number(b.dataset.n); paint(); }));
  manualBox.addEventListener('change', () => { manual = manualBox.checked; });
  $('mission-go').addEventListener('click', () => {
    store.set('mission', mission); store.set('ss-engines', String(engines)); store.set('ss-manual', manual ? '1' : '0');
    history.replaceState(null, '', `#${mission}`);
    startMission(mission, { engines, manual });
  });
  paint();
}
boot();
