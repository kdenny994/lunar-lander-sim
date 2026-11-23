// Starship HLS mode: powered descent from a 600 x 15 km orbit to the rim of Shackleton crater.
import * as THREE from 'three';
import { MOON } from './sim/constants';
import { skyAtJD, planetsFromMoon, type SkyState } from './sim/ephemeris';
import { RenderFrame, enuAt, llrToVec, vecToLLR } from './sim/geo';
import { TerrainData, polarInverse } from './sim/terrainData';
import { SS, SSState, stepStarship, massBudget, descentOrbitState, ascentDvAvailable, type SSControls } from './sim/starship';
import { StarshipGuidance, SSManualAP } from './sim/starshipGuidance';
import { predictTouchdown, hoverslam, type SSPrediction } from './sim/ssPredict';
import { TerrainRenderer } from './render/terrain';
import { StarshipModel } from './render/starshipModel';
import { LMModel } from './render/lmModel';
import { SkyRenderer, type SkyData } from './render/sky';
import { SkyPanel, SENSORS } from './ui/skyPanel';
import { InputManager, type Action } from './ui/input';
import { setupTouch } from './ui/touch';

const BASE = './data';
const TBASE = `${BASE}/shackleton/terrain`;
const $ = (id: string) => document.getElementById(id)!;
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timed out loading ${what}`)), ms))]);
const loadMsg = (m: string, frac?: number) => { $('ld-msg').textContent = m; if (frac !== undefined) ($('ld-bar') as HTMLElement).style.width = `${Math.round(frac * 100)}%`; };

/** touchdown planned for 2028-10-08 18:00 UTC; the sim clock starts ~6 minutes earlier in the descent orbit */
const LANDING_JD = Date.UTC(2028, 9, 8, 18, 0, 0) / 864e5 + 2440587.5;
const JD0 = LANDING_JD - 330 / 86400;
const DELTA_T_2028 = 70; // TT - UT1, s (estimate)
const G_MOON = 1.62;

type View = 'chase' | 'cockpit' | 'ground' | 'sky';
type Mode = 'auto' | 'manual';
export type StartPoint = 'orbit' | 'braking' | 'pitch' | 'final';

export interface StarshipOptions { engines: number; manual: boolean }

export async function starshipMain(opts: StarshipOptions) {
  document.title = 'Starship HLS · Shackleton';
  loadMsg('Loading Shackleton rim terrain…', 0.03);
  const terrain = await TerrainData.load(TBASE, (m) => loadMsg(m, 0.06));
  const meta = terrain.site.meta as any;
  const sll = polarInverse(meta.proj, meta.siteX, meta.siteY);
  const siteH = terrain.heightAt(sll.lat, sll.lon);
  const siteGround = llrToVec(sll.lat, sll.lon, MOON.radius + siteH);
  const peri = polarInverse(meta.proj, meta.siteX, meta.siteY - 110000);
  const from = polarInverse(meta.proj, meta.siteX, meta.siteY - 50000);
  const fromV = llrToVec(from.lat, from.lon, MOON.radius);
  const frame = new RenderFrame(sll.lat, sll.lon);
  const mb = massBudget();
  const groundRadius = (p: THREE.Vector3) => { const { lat, lon } = vecToLLR(p); return MOON.radius + terrain.heightAt(lat, lon); };

  // ---------- renderer / scene ----------
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
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 4e6);

  let skyState: SkyState = skyAtJD(JD0, DELTA_T_2028);
  const sunDirW = skyState.sunDir.clone(), earthDirW = skyState.earthDir.clone();
  const sun = new THREE.DirectionalLight(0xfff6ea, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.08;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45;
  scene.add(sun, sun.target);
  scene.add(new THREE.AmbientLight(0x9fb4d0, 0.06)); // earthshine and light scattered off the sunlit rim

  loadMsg('Loading star catalogue and Earth…', 0.1);
  let skyData: SkyData = { stars: [], named: [], lines: [] };
  try { skyData = await withTimeout(fetch(`${BASE}/sky/sky.json`).then((r) => r.json()), 30000, 'star catalogue'); } catch (e) { console.error(e); }
  let earthTex: THREE.Texture;
  try { earthTex = await withTimeout(new THREE.TextureLoader().loadAsync(`${BASE}/sky/earth.jpg`), 30000, 'Earth map'); }
  catch (e) { console.error(e); earthTex = new THREE.DataTexture(new Uint8Array([60, 100, 170, 255]), 1, 1); earthTex.needsUpdate = true; }
  const sky = new SkyRenderer(skyData, planetsFromMoon(JD0 + DELTA_T_2028 / 86400), earthTex);
  scene.add(sky.group);

  const terrainR = new TerrainRenderer(terrain, frame, TBASE, { baked: true, bgUrl: `${BASE}/terrain/moon_global.jpg` });
  terrainR.anisotropy = renderer.capabilities.getMaxAnisotropy();
  scene.add(terrainR.group);
  const ship = new StarshipModel();
  scene.add(ship.body);
  loadMsg('Loading the Starship model…', 0.1);
  await withTimeout(ship.loadShip('./models/starship_ship.gltf.json'), 90000, 'the Starship model').catch((e) => console.warn(e));
  // predicted touchdown marker (manual flight): a ring on the ground, sized to the leg footprint
  const predMarker = new THREE.Mesh(new THREE.RingGeometry(SS.padRadius + 1, SS.padRadius + 3, 48),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
  predMarker.renderOrder = 5;
  predMarker.visible = false;
  scene.add(predMarker);
  let pred: SSPrediction | null = null, predT = 0;
  let hsLit = false; // hoverslam autothrottle: engines lit
  const dustFx = new LMModel(); // reuse the LM's dust sheet, scaled up for Raptor exhaust
  scene.add(dustFx.dustObject);
  loadMsg('Loading LROC south-pole imagery…', 0.15);
  try {
    await withTimeout(terrainR.loadTextures((d, n) => loadMsg(`Loading LROC south-pole imagery… ${d}/${n}`, 0.15 + 0.75 * (d / n))), 120000, 'LROC imagery');
  } catch (e) { console.error(e); }

  // ---------- simulation ----------
  const input = new InputManager();
  const touch = setupTouch(input);
  const s = new SSState();
  const g = new StarshipGuidance(siteGround, fromV);
  g.groundRadius = groundRadius;
  const mAP = new SSManualAP();
  const ctl: SSControls = { engines: 0, throttle: 0.4, torque: new THREE.Vector3() };
  let mode: Mode = 'auto';
  let view: View = 'chase';
  let paused = false;
  const warps = [1, 2, 5, 10, 20, 50];
  let warpI = 0;
  let nSel = opts.engines; // manual: engines to run; auto: mirrors the guidance's choice
  let armed = true;
  let autoThr = true;
  let resultShown = false;
  const PHYS_DT = 0.005;

  function resetState() {
    const fresh = new SSState();
    Object.assign(s, fresh);
    descentOrbitState(s, peri, sll, 260000);
    s.prop = mb.pdiMass - SS.dryMass - SS.payload - mb.residual;
    s.residual = mb.residual;
    // reset the guidance to the surveyed site
    const g2 = new StarshipGuidance(siteGround, fromV);
    g.phase = g2.phase; g.siteCG.copy(g2.siteCG); g.siteUp.copy(g2.siteUp); g.uprange.copy(g2.uprange);
    g.landLong = 0; g.relightWait = false; g.pitching = false; g.finalOne = false;
    g.brakingEngines = opts.engines; g.landingEngines = 1;
  }

  function fastForward(until: StartPoint) {
    let n = 0;
    const done = () => {
      if (until === 'braking') return g.phase === 'braking' && s.running > 0 && s.v.length() < 1400;
      if (until === 'pitch') return g.phase === 'landing';
      if (until === 'final') return g.phase === 'landing' && !g.pitching && s.altitude(terrain) < 320;
      return true;
    };
    while (!done() && n < 400000 && !s.touchdown) {
      const c = g.update(s, PHYS_DT, null);
      stepStarship(s, c, PHYS_DT, terrain);
      n++;
    }
  }

  let lastPhase: string = '';
  let restartT = 0;
  function restart(point: StartPoint, manual: boolean) {
    resetState();
    fastForward(point);
    resultShown = false;
    $('result').hidden = true;
    clearEvents();
    lastPhase = g.phase;
    restartT = s.t;
    nSel = g.phase === 'landing' ? g.landingEngines : g.brakingEngines;
    armed = true;
    setMode(manual ? 'manual' : 'auto', true);
    terrainR.warm(s.r, 3);
    event(point === 'orbit' ? `Descent orbit, 600 × 15 km · ${opts.engines}-engine braking selected` : `Restarted: ${$('ss-start-menu').querySelector(`[data-t="${point}"]`)?.textContent ?? point}`);
  }

  function setMode(m: Mode, quiet = false) {
    mode = m;
    if (m === 'auto') { g.resume(s); g.brakingEngines = g.phase === 'landing' ? g.brakingEngines : nSel; if (!quiet) event('Guidance flying'); }
    else {
      mAP.reset();
      hsLit = s.running > 0;
      nSel = Math.max(1, s.running || nSel);
      input.state.throttle = s.running ? Math.max(0, (avgThrottle() - SS.minThrottle) / (1 - SS.minThrottle)) : 0.3;
      if (!quiet) event(`Manual control: rate command / attitude hold, ${autoThr ? 'hoverslam autothrottle' : 'manual throttle'}`);
    }
    const b = $('mode-badge');
    b.textContent = m === 'auto' ? 'GUIDANCE' : autoThr ? 'AUTO THR' : 'MAN THR';
    b.classList.toggle('manual', m === 'manual');
    const take = $('btn-take');
    take.textContent = m === 'auto' ? 'TAKE CONTROL' : 'GUIDANCE ON';
    take.classList.toggle('manual', m === 'manual');
    touch.show(m === 'manual');
  }

  function setEngines(n: number) {
    n = Math.max(1, Math.min(3, n));
    nSel = n;
    if (mode === 'auto') {
      if (g.phase === 'landing') {
        g.landingEngines = n;
        event(n === 1 ? 'Landing burn on one Raptor' : `Landing burn on ${n} Raptors, shutting down to one for the last 250 m`);
      } else {
        g.brakingEngines = n;
        const vh = horizontalSpeed();
        const d = rangeToSite();
        const aMax = (n * SS.raptorThrustVac) / s.mass;
        const warn = g.phase === 'braking' && (vh * vh) / (2 * Math.max(1, d)) > 0.85 * aMax;
        event(`Braking on ${n} Raptor${n > 1 ? 's' : ''}${warn ? ' · not enough thrust to stop at the site, guidance will land long' : ''}`);
      }
    } else event(`${n} Raptor${n > 1 ? 's' : ''} selected`);
  }

  // ---------- input ----------
  input.on((a: Action) => {
    switch (a) {
      case 'takeControl': setMode(mode === 'auto' ? 'manual' : 'auto'); break;
      case 'view': setView(view === 'chase' ? 'cockpit' : view === 'cockpit' ? 'ground' : view === 'ground' ? 'sky' : 'chase'); break;
      case 'pause': paused = !paused; break;
      case 'resetView': Object.assign(camCtl, camHome); break;
      case 'warpUp': warpI = Math.min(mode === 'manual' ? 2 : warps.length - 1, warpI + 1); break;
      case 'warpDown': warpI = Math.max(0, warpI - 1); break;
      case 'rodUp': setEngines(nSel + 1); break;
      case 'rodDown': setEngines(nSel - 1); break;
      case 'eng1': setEngines(1); break;
      case 'eng2': setEngines(2); break;
      case 'eng3': setEngines(3); break;
      case 'throttleMode':
        autoThr = !autoThr;
        if (!autoThr) input.state.throttle = Math.max(0, (avgThrottle() - SS.minThrottle) / (1 - SS.minThrottle));
        setMode(mode, true);
        event(autoThr ? 'Hoverslam autothrottle' : 'Manual throttle');
        break;
      case 'engineStop': {
        // X: crew engine cutoff / start. From the guidance this is an override: it hands over to manual first.
        const wasAuto = mode === 'auto';
        if (wasAuto) { setMode('manual', true); armed = true; }
        armed = !armed;
        const n = Math.max(1, nSel);
        const tailoff = (-Math.log(0.01 / Math.max(0.4, avgThrottle())) * SS.shutdownTau).toFixed(1);
        if (!armed) event(`${wasAuto ? 'Guidance off. ' : ''}Raptor cutoff: thrust tails off over ${tailoff} s, ${SS.shutdownProp} kg purged per engine`);
        else if (autoThr && !hsLit) event(`Raptors armed: the autothrottle starts ${n === 1 ? 'it' : 'them'} when braking is needed (ignition ${SS.engineSpin.toFixed(1)} s, minimum thrust ${SS.engineStart.toFixed(1)} s after the start command)`);
        else event(`Raptor start on ${n} engine${n > 1 ? 's' : ''}: ignition in ${SS.engineSpin.toFixed(1)} s, minimum thrust at ${SS.engineStart.toFixed(1)} s, ${SS.startProp} kg per start`);
        break;
      }
      case 'restart': restart('orbit', false); break;
    }
  });

  // ---------- buttons and menus ----------
  $('btn-view').addEventListener('click', () => input.emit('view'));
  $('btn-pause').addEventListener('click', () => input.emit('pause'));
  $('btn-warp').addEventListener('click', () => { warpI = (warpI + 1) % (mode === 'manual' ? 3 : warps.length); });
  $('btn-take').addEventListener('click', () => input.emit('takeControl'));
  $('btn-help').addEventListener('click', () => { $('help').hidden = false; });
  $('help-close').addEventListener('click', () => { $('help').hidden = true; });
  $('res-close').addEventListener('click', () => { $('result').hidden = true; });
  $('btn-start').addEventListener('click', () => { $('ss-start-menu').hidden = !$('ss-start-menu').hidden; });
  for (const b of Array.from(document.querySelectorAll('#ss-start-menu button'))) {
    b.addEventListener('click', () => {
      const t = (b as HTMLElement).dataset.t!;
      restart(t === '0' ? 'orbit' : (t as StartPoint), ($('ss-start-manual') as HTMLInputElement).checked);
      $('ss-start-menu').hidden = true;
    });
  }
  // touch switches become engine and throttle switches
  $('t-rodup').innerHTML = 'ENG +<small>more Raptors</small>';
  $('t-roddn').innerHTML = 'ENG −<small>fewer Raptors</small>';
  $('t-tmode').innerHTML = 'THR MODE<small>auto / manual</small>';
  $('t-stop').innerHTML = 'ENG ARM<small>shutdown / arm</small>';
  $('stick-l').querySelector('span')!.textContent = 'pitch / yaw';
  $('stick-r').querySelector('span')!.textContent = 'roll ↔ · throttle ↕';
  ($('get').previousElementSibling as HTMLElement).textContent = 'UTC';
  ($('prog').previousElementSibling as HTMLElement).textContent = 'PHASE';
  $('ss-panel').hidden = false;
  $('ss-budget').innerHTML = budgetHtml(mb);
  $('credits').innerHTML = [
    'Starship model: “SpaceX Starship Ship 24 & Booster 7 V4” by clarence365 (Sketchfab), CC BY 4.0, Ship stage only, simplified.',
    meta.source as string, (terrain.corridor.meta.source as string),
    'Global background: LROC WAC mosaic (NASA/GSFC/ASU).',
    'Landing point: chosen on the LOLA 5 m DEM for a 0.4° slope over a 120 m footprint on the ridge running from the Shackleton rim; 89.77° S, 203.8° E. Date chosen for a Sun 1.5° above the horizon and Earth 3.7° up.',
    'Starship HLS and Raptor 3 figures are public estimates, not SpaceX data (see the mass budget above).',
    'Sky: Sun and Moon from Meeus, Astronomical Algorithms (ch. 47); planets from JPL approximate Keplerian elements (Standish); lunar orientation from the IAU WGCCRE 2009 model; stars from the Hipparcos / Yale Bright Star catalogues via d3-celestial (BSD-3). Earth: NASA Blue Marble.',
  ].map((x) => `• ${x}`).join('<br>');

  // ---------- events ----------
  function clearEvents() { $('events').innerHTML = ''; }
  function event(label: string) {
    const el = document.createElement('div');
    el.className = 'ev';
    el.innerHTML = `<span class="t">${utc(s.t)}</span>${label}`;
    const box = $('events');
    box.prepend(el);
    while (box.children.length > 4) box.lastElementChild!.remove();
    setTimeout(() => { el.style.opacity = '0'; }, 7000);
    setTimeout(() => el.remove(), 8200);
  }

  // ---------- camera controls ----------
  const camCtl = { az: Math.PI * 0.85, el: 0.22, dist: window.innerWidth < window.innerHeight ? 260 : 170, lookYaw: 0, lookPitch: -0.35 };
  const camHome = { ...camCtl };
  const skyCtl = { az: Math.PI * 0.8, el: 0.15, fov: 60, eyeLogLa: -3 };
  const skyPanel = new SkyPanel();
  function setView(v: View) { view = v; skyPanel.setVisible(v === 'sky'); }
  const lookAtW = (dirW: THREE.Vector3) => {
    const { e, n, u } = enuAt(s.r);
    skyCtl.az = Math.atan2(dirW.dot(e), dirW.dot(n));
    skyCtl.el = Math.asin(Math.max(-1, Math.min(1, dirW.dot(u))));
  };
  skyPanel.onGoto = (w) => {
    if (w === 'earth') { lookAtW(earthDirW); skyCtl.fov = Math.min(skyCtl.fov, 30); }
    else if (w === 'sun') lookAtW(sunDirW);
    else { skyCtl.el = Math.PI / 2; skyCtl.fov = Math.max(skyCtl.fov, 90); }
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
        else camCtl.dist = Math.min(30000, Math.max(40, camCtl.dist * (pinch0 / d)));
      }
      pinch0 = d; return;
    }
    if (view === 'sky') {
      const k = (skyCtl.fov * Math.PI / 180) / window.innerHeight;
      skyCtl.az -= dx * k; skyCtl.el = Math.max(-0.6, Math.min(Math.PI / 2, skyCtl.el + dy * k));
    } else if (view === 'cockpit') {
      camCtl.lookYaw = Math.max(-1.4, Math.min(1.4, camCtl.lookYaw - dx * 0.004));
      camCtl.lookPitch = Math.max(-1.3, Math.min(0.8, camCtl.lookPitch - dy * 0.004));
    } else {
      camCtl.az -= dx * 0.006; camCtl.el = Math.max(-0.2, Math.min(1.5, camCtl.el + dy * 0.004));
    }
  });
  const up = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch0 = 0; };
  renderer.domElement.addEventListener('pointerup', up);
  renderer.domElement.addEventListener('pointercancel', up);
  renderer.domElement.addEventListener('wheel', (e) => {
    if (view === 'sky') skyCtl.fov = Math.min(100, Math.max(2, skyCtl.fov * Math.exp(e.deltaY * 0.001)));
    else camCtl.dist = Math.min(30000, Math.max(40, camCtl.dist * Math.exp(e.deltaY * 0.001)));
    e.preventDefault();
  }, { passive: false });
  const onResize = () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 300));

  // ---------- helpers ----------
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  function localUp() { return tmp2.copy(s.r).normalize(); }
  function horizontalSpeed() { const u = localUp(); return tmp.copy(s.v).addScaledVector(u, -s.v.dot(u)).length(); }
  function rangeToSite() { return Math.acos(Math.min(1, s.r.clone().normalize().dot(siteGround.clone().normalize()))) * MOON.radius; }
  function avgThrottle() { const on = s.eng.filter((x) => x > 0.01); return on.length ? on.reduce((a, b) => a + b, 0) / on.length : 0; }

  /** manual flight: crew attitude, engine count and throttle (manual, or the hoverslam autothrottle) */
  function manualControls(): SSControls {
    mAP.update(s, g, ctl, input.state.pitch, input.state.yaw, input.state.roll);
    if (autoThr) {
      // hoverslam autothrottle: holds the engines off until minimum thrust is needed, then brakes to 1 m/s at the pads
      const u = localUp();
      const xb = new THREE.Vector3(1, 0, 0).applyQuaternion(s.q);
      const aMax = (Math.max(1, nSel) * SS.raptorThrustVac) / s.mass;
      const hs = hoverslam(s.altitude(terrain), s.v.dot(u), xb.dot(u), aMax, hsLit);
      hsLit = hs.on;
      ctl.engines = armed && hsLit ? nSel : 0;
      ctl.throttle = Math.min(1, Math.max(SS.minThrottle, hs.accel / aMax));
    } else {
      ctl.engines = armed ? nSel : 0;
      ctl.throttle = SS.minThrottle + (1 - SS.minThrottle) * input.state.throttle;
    }
    return ctl;
  }

  // ---------- sky exposure (what the eye or camera could see) ----------
  let readoutT = 0;
  function updateSkyExposure(dt: number, sunR: THREE.Vector3, upR: THREE.Vector3, altCG: number) {
    const sensor = view === 'sky' ? skyPanel.sensor : 'eye';
    const S = SENSORS[sensor];
    const sunUp = sunR.dot(upR) > -0.005;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const aspect = window.innerWidth / window.innerHeight;
    const half = Math.min(80, Math.max(50, (camera.fov / 2) * Math.max(1, aspect)));
    const sunAng = Math.acos(Math.max(-1, Math.min(1, fwd.dot(sunR)))) * 180 / Math.PI;
    const dip = Math.acos(MOON.radius / (MOON.radius + Math.max(0, altCG) + 2));
    const Lg = 0.12 * 127000 * Math.max(0, sunR.dot(upR)) / Math.PI;
    let sum = 0, n = 0;
    const t = Math.tan(half * Math.PI / 180), d = new THREE.Vector3();
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      d.copy(fwd).addScaledVector(right, (t * i) / 3).addScaledVector(camUp, (t * j) / 3).normalize();
      if (Math.asin(d.dot(upR)) < -dip) sum += Lg;
      n++;
    }
    let La = sum / n + (sunUp ? 0.3 : 0.001);
    if (sunUp && sunAng < half) La += 1.09e5 / (2 * Math.PI * (1 - Math.cos(half * Math.PI / 180)));
    const target = Math.log10(La);
    skyCtl.eyeLogLa += (target - skyCtl.eyeLogLa) * (1 - Math.exp(-dt / (target > skyCtl.eyeLogLa ? 0.4 : 5)));
    const diagHalf = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.hypot(1, aspect)) * 180 / Math.PI;
    const glareField = sunUp ? Math.max(0, Math.min(1, (diagHalf + 10 - sunAng) / 15)) : 0;
    sky.starMat.uniforms.uLa0.value = S.La0;
    sky.setSensor({ lim0: S.lim0, slope: S.slope, La: sensor === 'eye' ? Math.pow(10, skyCtl.eyeLogLa) : 0,
      glare: sensor === 'camera' ? 0 : glareField, aperture: S.aperture, spikes: S.spikes, glow: S.glow }, renderer.getPixelRatio());
    sky.sun.visible = sunUp;
    if (view !== 'sky') { skyPanel.drawLabels([], null); return; }
    const { e: E, n: N } = enuAt(s.r);
    const eastR = frame.dir(E).normalize(), northR = frame.dir(N).normalize();
    const azel = (dir: THREE.Vector3) => ({ az: (Math.atan2(dir.dot(eastR), dir.dot(northR)) * 180 / Math.PI + 360) % 360, el: Math.asin(Math.max(-1, Math.min(1, dir.dot(upR)))) * 180 / Math.PI });
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
    const lit = (1 + sunDirW.dot(tmp.copy(earthDirW).negate())) / 2;
    skyPanel.readout(
      `<b>${SENSORS[sensor].label}</b> <span class="dim desc">${SENSORS[sensor].desc}</span><br>` +
      `Looking az ${look.az.toFixed(0)}° el ${look.el.toFixed(0)}° · field ${skyCtl.fov.toFixed(1)}° · faintest star here ${lim < -5.5 ? 'none' : (lim >= 0 ? '+' : '') + lim.toFixed(1) + ' mag'}<br>` +
      `Sun el ${sA.el.toFixed(1)}° az ${sA.az.toFixed(0)}° · Earth el ${eA.el.toFixed(1)}° az ${eA.az.toFixed(0)}°, ${(lit * 100).toFixed(0)}% lit<br>` +
      `<span class="dim">${new Date((skyState.jdUT - 2440587.5) * 864e5).toISOString().replace('T', ' ').slice(0, 19)} UTC · 89.77° S: the Sun skims the horizon all day</span>`);
  }

  // ---------- loop ----------
  loadMsg('Building terrain…', 0.95);
  restart('orbit', opts.manual);
  $('loading').hidden = true;

  const clock = new THREE.Clock();
  const origin = new THREE.Vector3(), prevOrigin = new THREE.Vector3();
  const qRender = new THREE.Quaternion();
  let firstFrame = true, physAcc = 0, skyT = -1e9, hudT = 0;
  let lastRunning = 0;

  function frameLoop() {
    requestAnimationFrame(frameLoop);
    const dtReal = Math.min(0.1, clock.getDelta());
    input.update(dtReal);
    // right stick: look around in the current view; D-pad up/down: zoom (Xbox layout)
    {
      const L = input.look;
      if (L.x || L.y || L.zoom) {
        if (view === 'sky') {
          const k = (skyCtl.fov * Math.PI / 180) * 0.8 * dtReal;
          skyCtl.az += L.x * k; skyCtl.el = Math.max(-0.6, Math.min(Math.PI / 2, skyCtl.el + L.y * k));
          skyCtl.fov = Math.min(100, Math.max(2, skyCtl.fov * Math.exp(L.zoom * 1.2 * dtReal)));
        } else if (view === 'cockpit') {
          camCtl.lookYaw = Math.max(-1.4, Math.min(1.4, camCtl.lookYaw - L.x * 1.5 * dtReal));
          camCtl.lookPitch = Math.max(-1.3, Math.min(0.8, camCtl.lookPitch + L.y * 1.5 * dtReal));
        } else {
          camCtl.az -= L.x * 1.8 * dtReal; camCtl.el = Math.max(-0.2, Math.min(1.5, camCtl.el - L.y * 1.2 * dtReal));
          camCtl.dist = Math.min(30000, Math.max(40, camCtl.dist * Math.exp(L.zoom * 1.5 * dtReal)));
        }
      }
    }
    const warp = warps[warpI];
    const dt = paused ? 0 : dtReal * warp;

    physAcc += dt;
    let n = 0;
    while (physAcc >= PHYS_DT && n < 12000) {
      const c = mode === 'auto' ? g.update(s, PHYS_DT, null) : manualControls();
      stepStarship(s, c, PHYS_DT, terrain);
      physAcc -= PHYS_DT; n++;
      if (s.landed || s.crashed) { physAcc = 0; break; }
    }
    // events
    if (mode === 'auto' && g.phase !== lastPhase) {
      if (g.phase === 'braking') event(`Ignition: braking burn on ${g.brakingEngines} Raptor${g.brakingEngines > 1 ? 's' : ''}`);
      if (g.phase === 'landing') event('Pitch-up to vertical for the landing burn');
      if (g.phase === 'coast' && lastPhase === 'braking' && s.t - restartT > 2) event('Shutdown: coasting to a later ignition');
      lastPhase = g.phase;
    }
    if (s.running !== lastRunning) {
      if (mode === 'auto' && g.phase === 'landing' && s.running < lastRunning && s.running > 0) event(`${s.running} Raptor${s.running > 1 ? 's' : ''} running`);
      if (mode === 'auto' && g.relightWait && s.running === 0) event('Engine off: too slow for the hoverslam, coasting to relight');
      lastRunning = s.running;
    }
    if (s.touchdown && !resultShown) { resultShown = true; setTimeout(showResult, s.crashed ? 300 : 2500); }
    if (warpI > 0 && s.altitude(terrain) < 400 && g.phase !== 'coast' && !s.touchdown) warpI = 0;

    // floating origin at the CG
    prevOrigin.copy(origin);
    origin.copy(s.r);
    if (!firstFrame) dustFx.shiftDust(frame.dir(tmp.copy(origin).sub(prevOrigin)));
    firstFrame = false;
    const { e: E, n: N, u: U } = enuAt(origin);
    const upR = frame.dir(U).normalize(), eastR = frame.dir(E).normalize(), northR = frame.dir(N).normalize();
    qRender.copy(frame.q).multiply(s.q);
    ship.body.quaternion.copy(qRender);
    ship.setEngines(s.eng);
    // predicted touchdown, refreshed four times a second while the crew flies
    predT -= dtReal;
    if (mode === 'manual' && !s.touchdown && predT <= 0) {
      predT = 0.25;
      pred = predictTouchdown(s, { engines: armed ? nSel : 0, throttle: autoThr ? null : SS.minThrottle + (1 - SS.minThrottle) * input.state.throttle }, terrain);
    }
    predMarker.visible = mode === 'manual' && !!pred && !s.touchdown && view !== 'sky';
    if (predMarker.visible && pred) {
      predMarker.position.copy(frame.dir(tmp.copy(pred.pos).addScaledVector(pred.pos.clone().normalize(), 0.6).sub(origin)));
      predMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), frame.dir(pred.pos.clone().normalize()).normalize());
      const d = predMarker.position.length();
      predMarker.scale.setScalar(Math.max(1, d / 900));
    }

    const altPads = s.altitude(terrain);
    const altCG = altPads + SS.cgAbovePads;

    if (Math.abs(s.t - skyT) > 1) { skyT = s.t; skyState = skyAtJD(JD0 + s.t / 86400, DELTA_T_2028); sunDirW.copy(skyState.sunDir); earthDirW.copy(skyState.earthDir); }
    const sunR = frame.dir(sunDirW).normalize();
    const sinEl = Math.max(0.03, sunR.dot(upR));
    const tGround = Math.min(3000, Math.max(0, altCG) / sinEl);
    sun.target.position.copy(sunR).multiplyScalar(-Math.min(tGround, 600));
    sun.position.copy(sun.target.position).addScaledVector(sunR, 150);
    sc.near = 1; sc.far = 400; sc.updateProjectionMatrix();
    sun.castShadow = altCG < 2500;

    const thrustFrac = s.thrustN / (3 * SS.raptorThrustVac);
    const exhaustPt = new THREE.Vector3(-SS.cgAboveEngines, 0, 0).applyQuaternion(qRender);
    const groundPt = exhaustPt.clone().addScaledVector(upR, -Math.max(0, altCG + exhaustPt.dot(upR)));
    dustFx.updateDust(dt, altPads / 4, Math.min(1, thrustFrac * 2), groundPt, upR);

    // camera
    ship.model.visible = view !== 'cockpit' && view !== 'sky';
    if (view === 'chase') {
      camera.fov = 50;
      const vh = frame.dir(s.v).addScaledVector(upR, -frame.dir(s.v).dot(upR));
      const heading = vh.lengthSq() > 4 ? Math.atan2(vh.dot(eastR), vh.dot(northR)) : 0;
      const az = heading + camCtl.az;
      const dir = northR.clone().multiplyScalar(Math.cos(az) * Math.cos(camCtl.el)).addScaledVector(eastR, Math.sin(az) * Math.cos(camCtl.el)).addScaledVector(upR, Math.sin(camCtl.el));
      camera.position.copy(dir.multiplyScalar(camCtl.dist));
      const camAlt = camera.position.dot(upR) + altCG;
      if (camAlt < 2) camera.position.addScaledVector(upR, 2 - camAlt);
      camera.up.copy(upR);
      camera.lookAt(0, 4, 0);
    } else if (view === 'cockpit') {
      // crew window high on the hull, looking out (body +Z) and down
      camera.fov = 65;
      const eye = ship.windowEye.clone().applyQuaternion(qRender);
      camera.position.copy(eye);
      const look = new THREE.Vector3(0, 0, 1)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), camCtl.lookPitch)
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), camCtl.lookYaw).applyQuaternion(qRender);
      camera.up.copy(new THREE.Vector3(1, 0, 0).applyQuaternion(qRender));
      camera.lookAt(eye.add(look));
    } else if (view === 'sky') {
      camera.fov = skyCtl.fov;
      camera.position.copy(ship.windowEye.clone().applyQuaternion(qRender));
      const ca = Math.cos(skyCtl.el);
      const look = northR.clone().multiplyScalar(Math.cos(skyCtl.az) * ca).addScaledVector(eastR, Math.sin(skyCtl.az) * ca).addScaledVector(upR, Math.sin(skyCtl.el));
      camera.up.copy(Math.abs(skyCtl.el) > 1.45 ? northR.clone().multiplyScalar(-Math.cos(skyCtl.az)).addScaledVector(eastR, -Math.sin(skyCtl.az)) : upR);
      camera.lookAt(camera.position.clone().add(look));
    } else {
      // surface observer 450 m from the landing point, on the Sun side so the ship is lit
      camera.fov = 35;
      const { e: e2, n: n2 } = enuAt(siteGround);
      const sunH = sunDirW.clone().addScaledVector(siteGround.clone().normalize(), -sunDirW.dot(siteGround.clone().normalize())).normalize();
      const offs = sunH.multiplyScalar(380).addScaledVector(e2.clone().add(n2).normalize(), 220);
      const p = siteGround.clone().add(offs);
      const { lat, lon } = vecToLLR(p);
      p.setLength(MOON.radius + terrain.heightAt(lat, lon) + 1.8);
      camera.position.copy(frame.dir(p.sub(origin)));
      camera.up.copy(upR);
      // frame both the ship and its touchdown point, so the ground stays in view during the descent
      const padR = frame.dir(siteGround.clone().sub(origin));
      const toShip = camera.position.clone().negate().normalize(), toPad = padR.clone().sub(camera.position).normalize();
      const span = toShip.angleTo(toPad) * 180 / Math.PI;
      camera.fov = Math.min(70, Math.max(30, span * 1.5 + 12));
      camera.lookAt(camera.position.clone().add(toShip.add(toPad).normalize()));
    }
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const eR = frame.dir(earthDirW).normalize();
    sky.update(camera, frame, skyState, sunR, eR);
    updateSkyExposure(dtReal, sunR, upR, altCG);
    document.body.classList.toggle('sky', view === 'sky');

    terrainR.update(origin, camera.position);
    renderer.render(scene, camera);

    hudT -= dtReal;
    if (hudT <= 0) { hudT = 0.07; updateHud(altPads, U, warp); }
  }

  function updateHud(altPads: number, U: THREE.Vector3, warp: number) {
    $('get').textContent = utc(s.t).slice(0, 8);
    const phaseName = s.landed ? 'LANDED' : s.crashed ? 'CRASH' : mode === 'manual' ? 'MANUAL' : g.phase === 'landing' && g.pitching ? 'PITCH-UP' : g.phase.toUpperCase();
    $('prog').textContent = phaseName;
    $('ss-phase').textContent = phaseName;
    $('ss-status').textContent = mode === 'auto' ? g.status : (autoThr ? (armed && !hsLit && !s.touchdown ? 'Hoverslam autothrottle: holding the Raptors off until minimum thrust is needed' : 'Hoverslam autothrottle: the engines brake so you reach 1 m/s at the pads') : 'Manual throttle') + (armed ? '' : ' · ENGINES CUT OFF (X to start)');
    $('btn-warp').textContent = `×${warp}`;
    $('btn-pause').textContent = paused ? '▶' : '❚❚';
    $('btn-view').textContent = `View: ${view === 'chase' ? 'Chase' : view === 'cockpit' ? 'Window' : view === 'sky' ? 'Sky' : 'Surface'}`;
    const sel = mode === 'auto' ? (g.phase === 'landing' ? g.landingEngines : g.brakingEngines) : nSel;
    for (let i = 0; i < 3; i++) {
      const el = $(`ss-e${i}`);
      el.classList.toggle('on', s.engPhase[i] === 'run');
      el.classList.toggle('start', s.engPhase[i] === 'start');
      el.classList.toggle('tail', s.engPhase[i] === 'shutdown');
      el.classList.toggle('sel', i < sel);
    }
    const pe = $('ss-pred');
    pe.hidden = mode !== 'manual' || !!s.touchdown;
    if (!pe.hidden) {
      if (!pred) pe.innerHTML = '<span class="lbl">Predicted touchdown</span> none with these settings: the ship is climbing or still in orbit';
      else {
        const { e: e0, n: n0 } = enuAt(siteGround);
        const d = pred.pos.clone().sub(siteGround);
        const dn = d.dot(n0), de = d.dot(e0), dist = Math.hypot(dn, de);
        const brg = ((Math.atan2(de, dn) * 180 / Math.PI) + 360) % 360;
        const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(brg / 45) % 8];
        const hard = pred.vVert > 4 || pred.vHorz > 2;
        pe.innerHTML = `<span class="lbl">Predicted touchdown</span> <b>${Math.abs(pred.lat).toFixed(4)}° S ${((pred.lon + 360) % 360).toFixed(3)}° E</b> · ` +
          `${dist < 1000 ? dist.toFixed(0) + ' m' : (dist / 1000).toFixed(dist < 1e4 ? 2 : 1) + ' km'} ${dist < 1 ? '' : dir + ' of target'} · in ${pred.t.toFixed(0)} s · ` +
          `<span class="${hard ? 'warn' : ''}">${pred.vVert.toFixed(1)} m/s down, ${pred.vHorz.toFixed(1)} m/s across</span>`;
      }
    }
    $('ss-esel').textContent = mode === 'auto' ? `${g.phase === 'landing' ? 'landing burn' : 'braking'}: ${sel} selected` : `${sel} selected${armed ? '' : ' · cut off'}`;
    const vz = s.v.dot(U);
    const vh = horizontalSpeed();
    $('s-alt').textContent = fmtDist(Math.max(0, altPads));
    $('s-vs').textContent = `${vz >= 0 ? '+' : ''}${Math.abs(vz) < 100 ? vz.toFixed(1) : vz.toFixed(0)} m/s`;
    $('s-hs').textContent = `${vh < 100 ? vh.toFixed(1) : vh.toFixed(0)} m/s`;
    $('s-range').textContent = fmtDist(rangeToSite());
    const thr = avgThrottle();
    $('s-thr').textContent = s.running ? `${(thr * 100).toFixed(0)} % ×${s.running}` : 'off';
    $('s-acc').textContent = `${(s.accel.length() / G_MOON).toFixed(1)} g☾`;
    const twMin = (Math.max(1, sel) * SS.raptorThrustVac * SS.minThrottle) / (s.mass * G_MOON);
    const tw = $('s-tw');
    tw.textContent = `${twMin.toFixed(1)}× wt`;
    tw.title = 'Thrust at the 40 % throttle floor of the selected engines, as a multiple of the ship’s lunar weight. Above 1 the ship cannot hover.';
    const xb = new THREE.Vector3(1, 0, 0).applyQuaternion(s.q);
    $('s-tilt').textContent = `${(Math.acos(Math.max(-1, Math.min(1, xb.dot(U)))) * 180 / Math.PI).toFixed(0)}°`;
    $('s-prop').textContent = `${(s.prop / 1000).toFixed(1)} t`;
    $('s-mass').textContent = `${(s.mass / 1000).toFixed(0)} t`;
    const dv = ascentDvAvailable(s.mass, s.residual);
    const scale = 3200;
    const bar = $('s-dvbar');
    bar.style.width = `${Math.min(100, (dv / scale) * 100)}%`;
    bar.classList.toggle('short', dv < mb.ascentReq);
    ($('s-dvneed') as HTMLElement).style.left = `${(mb.ascentReq / scale) * 100}%`;
    $('s-dv').textContent = `${dv.toFixed(0)} / ${mb.ascentReq.toFixed(0)} m/s`;
  }

  function showResult() {
    const td = s.touchdown!;
    const dvAsc = ascentDvAvailable(s.mass, s.residual);
    const rel = s.r.clone().sub(g.siteCG);
    const miss = rel.addScaledVector(g.siteUp, -rel.dot(g.siteUp)).length();
    const fromSurvey = Math.acos(Math.min(1, s.r.clone().normalize().dot(siteGround.clone().normalize()))) * MOON.radius;
    const good = td.vVert <= 2.5 && td.vHorz <= 1.0 && td.tilt <= 5;
    $('res-title').textContent = s.tipped ? 'Tipped over' : s.crashed ? 'Crash' : good ? 'Starship has landed' : 'Hard landing';
    $('res-body').innerHTML = [
      `Vertical speed: ${td.vVert.toFixed(2)} m/s (leg limit 4)`,
      `Horizontal speed: ${td.vHorz.toFixed(2)} m/s (limit 2)`,
      `Tilt: ${td.tilt.toFixed(1)}° (limit 12°)`,
      `Distance from the surveyed site: ${fromSurvey < 1000 ? fromSurvey.toFixed(0) + ' m' : (fromSurvey / 1000).toFixed(1) + ' km'}${g.landLong > 50 ? ` (guidance moved the target ${(g.landLong / 1000).toFixed(1)} km downrange; ${miss.toFixed(0)} m from that)` : ''}`,
      `Descent Δv used: ${s.dvUsed.toFixed(0)} m/s · propellant left ${(s.prop / 1000).toFixed(1)} t`,
      `Ascent Δv available: ${dvAsc.toFixed(0)} m/s of ${mb.ascentReq.toFixed(0)} needed for a 600 km orbit — ${dvAsc >= mb.ascentReq ? `<b>enough</b>, ${(dvAsc - mb.ascentReq).toFixed(0)} m/s to spare` : `<b>${(mb.ascentReq - dvAsc).toFixed(0)} m/s short</b>`}`,
    ].join('<br>');
    $('result').hidden = false;
  }

  frameLoop();
  (window as any).__sim = { s, g, restart, setMode, setView: (v: View) => setView(v), setEngines, get mode() { return mode; }, camCtl, skyCtl, renderer, terrain, mb };
}

function utc(t: number) {
  return new Date((JD0 - 2440587.5) * 864e5 + t * 1000).toISOString().slice(11, 19) + ' UTC';
}

function fmtDist(m: number) { return m < 10000 ? `${m.toFixed(m < 100 ? 1 : 0)} m` : `${(m / 1000).toFixed(m < 100000 ? 1 : 0)} km`; }

export function budgetHtml(mb: ReturnType<typeof massBudget>) {
  const t = (kg: number) => `${(kg / 1000).toFixed(1)} t`;
  return `<b>Mass and Δv budget</b> (estimates, worked backwards from a 600 km circular orbit after ascent)<br>` +
    `Dry mass ${t(SS.dryMass)} incl. legs and solar arrays · crew, cabin and cargo ${t(SS.payload)} · unusable residuals ${(SS.residualFrac * 100).toFixed(0)} % (${t(mb.residual)})<br>` +
    `Raptor 3 sea-level nozzle in vacuum: ${(SS.raptorThrustVac / 1e6).toFixed(2)} MN, Isp ${SS.raptorIsp} s, 40–100 % throttle, ±15° gimbal; only the three inner engines fire<br>` +
    `Ascent to 600 km: ${mb.ascentIdeal.toFixed(0)} m/s ideal + ${mb.ascentLosses} m/s losses + 3 % reserve = <b>${mb.ascentReq.toFixed(0)} m/s</b> → landed mass needed ${t(mb.landedNeeded)}<br>` +
    `Powered descent budget ${mb.descentBudget} m/s (the guidance uses about 1,960 m/s) → ${t(mb.pdiMass)} at ignition<br>` +
    `Deorbit 600 km circular → 600 × 15 km: ${mb.deorbit.toFixed(0)} m/s → ${t(mb.lloMass)} in lunar orbit, <b>${t(mb.propLoaded)} propellant</b> loaded<br>` +
    `One Raptor at 40 % gives ${((SS.raptorThrustVac * 0.4) / (mb.landedNeeded * 1.62)).toFixed(1)}× the landed ship's lunar weight, so it cannot hover.`;
}
