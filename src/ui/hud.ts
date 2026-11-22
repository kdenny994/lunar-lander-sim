// Heads-down instruments: DSKY, gauges, cross pointer, caution lights, event captions, LPD window scale.
import * as THREE from 'three';
import { FT, LM } from '../sim/constants';
import type { TrajectoryFile } from '../sim/replay';

const $ = (id: string) => document.getElementById(id)!;

export interface HudData {
  t: number; program: string; altitude: number; hdot: number; vFwd: number; vLat: number; thrust: number;
  dpsProp: number; rcsProp: number; pitch: number; range: number; contact: boolean; mode: string; throttleMode: string;
  hdotCmd: number; engineArmed: boolean; lowLevel: boolean; warp: number; paused: boolean; view: string; lpd: number;
}

const PDI_GET = 102 * 3600 + 33 * 60 + 5;

export class Hud {
  resultShown = false;
  private last = 0;
  private alarmUntil = 0;
  private xp = ($('xpointer') as HTMLCanvasElement).getContext('2d')!;
  private lpdBuilt = false;

  constructor(private traj: TrajectoryFile) {}

  setMode(mode: string, tmode: string) {
    const b = $('mode-badge');
    b.textContent = mode === 'replay' ? 'REPLAY' : tmode === 'p66' ? 'MANUAL · P66 ROD' : 'MANUAL · THROTTLE';
    b.classList.toggle('manual', mode !== 'replay');
    const take = $('btn-take');
    take.textContent = mode === 'replay' ? 'TAKE CONTROL' : 'BACK TO REPLAY';
    take.classList.toggle('manual', mode !== 'replay');
    if (mode === 'replay') this.resultShown = false;
  }

  clearEvents() { $('events').innerHTML = ''; }
  resetEvents(_t: number) { this.alarmUntil = 0; }

  event(label: string, tfi: number, get?: string) {
    if (/120[12]/.test(label)) this.alarmUntil = tfi + 6;
    const el = document.createElement('div');
    el.className = 'ev';
    el.innerHTML = `<span class="t">${get ?? fmtGET(tfi)}</span>${label}`;
    const box = $('events');
    box.prepend(el);
    while (box.children.length > 4) box.lastElementChild!.remove();
    setTimeout(() => { el.style.opacity = '0'; }, 7000);
    setTimeout(() => el.remove(), 8200);
  }

  flash(msg: string) { this.event(msg, -1, ' '); }

  update(d: HudData) {
    const now = performance.now();
    if (now - this.last < 66) return;
    this.last = now;
    $('get').textContent = fmtGET(d.t);
    $('prog').textContent = d.program;
    $('btn-warp').textContent = `×${d.warp}`;
    $('btn-pause').textContent = d.paused ? '▶' : '❚❚';
    $('btn-view').textContent = `View: ${d.view === 'chase' ? 'Chase' : d.view === 'cockpit' ? 'Interior' : 'Surface'}`;
    const altFt = d.altitude / FT;
    // DSKY
    $('d-prog').textContent = d.program;
    let noun = '63', r1l = 'ΔH', r1 = '+00000';
    if (d.program === '64') { noun = '64'; r1l = 'LPD'; r1 = `${String(Math.max(0, Math.round(this.lpdTime(d.t)))).padStart(2, '0')} ${String(Math.round(Math.max(0, Math.min(99, d.lpd)))).padStart(2, '0')}`; }
    else if (d.program === '66' || d.program === '68') { noun = '60'; r1l = 'FWD VEL'; r1 = sgn(d.vFwd / FT * 10, 5); }
    $('d-noun').textContent = noun;
    $('r1l').textContent = r1l; $('r1').textContent = r1;
    $('r2').textContent = sgn(d.hdot / FT * 10, 5);
    $('r3').textContent = sgn(altFt, 5);
    // gauges (imperial, as flown)
    $('g-alt').textContent = altFt > 10000 ? `${(altFt / 1000).toFixed(1)} kft` : `${altFt.toFixed(0)} ft`;
    $('g-hdot').textContent = `${(d.hdot / FT).toFixed(1)} ft/s`;
    $('g-fwd').textContent = `${(d.vFwd / FT).toFixed(Math.abs(d.vFwd / FT) > 200 ? 0 : 1)} ft/s`;
    $('g-lat').textContent = `${(d.vLat / FT).toFixed(1)} ft/s`;
    $('g-thr').textContent = `${(d.thrust * 100).toFixed(0)} %`;
    const propPct = (d.dpsProp / LM.dpsPropPDI) * 100;
    $('g-prop').textContent = `${propPct.toFixed(1)} %`;
    $('g-rcs').textContent = `${((d.rcsProp / LM.rcsProp) * 100).toFixed(0)} %`;
    $('g-pitch').textContent = `${d.pitch.toFixed(0)}°`;
    $('g-range').textContent = d.range > 5000 ? `${(d.range / 1852).toFixed(1)} nmi` : `${(d.range / FT).toFixed(0)} ft`;
    $('g-tmode').textContent = d.mode === 'replay' ? 'AUTO' : d.throttleMode === 'p66' ? `ROD ${(d.hdotCmd / FT).toFixed(0)}` : 'MAN';
    // lights
    $('l-contact').classList.toggle('on', d.contact);
    $('l-alarm').classList.toggle('on', d.mode === 'replay' && d.t < this.alarmUntil && Math.floor(now / 400) % 2 === 0);
    $('l-low').classList.toggle('on', d.lowLevel);
    $('l-eng').classList.toggle('on', d.engineArmed);
    this.drawCross(d.vFwd / FT, d.vLat / FT);
  }

  private lpdTime(t: number) {
    // time remaining in P64 (approach) for landing point redesignation
    return Math.max(0, this.traj.tP66 - t);
  }

  private drawCross(fwd: number, lat: number) {
    const g = this.xp, W = 160, c = W / 2;
    g.clearRect(0, 0, W, W);
    g.strokeStyle = '#2f3532'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.arc(c, c, (i * c) / 4, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(0, c); g.lineTo(W, c); g.moveTo(c, 0); g.lineTo(c, W); g.stroke();
    // scale: +-20 ft/s full deflection (LO scale) / +-200 when fast
    const scale = Math.max(Math.abs(fwd), Math.abs(lat)) > 20 ? 200 : 20;
    const x = c + Math.max(-1, Math.min(1, lat / scale)) * (c - 6);
    const y = c - Math.max(-1, Math.min(1, fwd / scale)) * (c - 6);
    g.strokeStyle = '#f2efe6'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, 6); g.lineTo(x, W - 6); g.moveTo(6, y); g.lineTo(W - 6, y); g.stroke();
    g.fillStyle = '#8f8a7f'; g.font = '11px system-ui'; g.fillText(`±${scale}`, 6, W - 8);
  }

  /** Etched LPD scale on the window: ticks every 10 deg below the +Z boresight, in the body X-Z plane. */
  drawLPD(camera: THREE.PerspectiveCamera, qBody: THREE.Quaternion) {
    const box = $('lpd');
    if (!this.lpdBuilt) {
      box.innerHTML = '';
      const line = document.createElement('div'); line.className = 'lpd-line'; box.appendChild(line);
      for (let a = 0; a <= 80; a += 5) {
        const t = document.createElement('div'); t.className = 'lpd-tick'; t.dataset.a = String(a); box.appendChild(t);
        if (a % 10 === 0) { const n = document.createElement('div'); n.className = 'lpd-num'; n.dataset.a = String(a); n.textContent = String(a); box.appendChild(n); }
      }
      this.lpdBuilt = true;
    }
    const W = window.innerWidth, H = window.innerHeight;
    const eye = camera.position;
    const proj = (a: number) => {
      const r = (a * Math.PI) / 180;
      // direction in body: forward +Z rotated toward -X by a; offset sideways to the CDR's window centre
      const dir = new THREE.Vector3(-Math.sin(r), 0, Math.cos(r)).applyQuaternion(qBody);
      const p = eye.clone().addScaledVector(dir, 50).project(camera);
      return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H, ok: p.z < 1 && p.z > -1 };
    };
    let top = Infinity, bot = -Infinity, lx = 0;
    for (const el of Array.from(box.children) as HTMLElement[]) {
      const a = el.dataset.a;
      if (a === undefined) continue;
      const p = proj(Number(a));
      el.style.display = p.ok ? '' : 'none';
      if (el.className === 'lpd-tick') {
        const w = Number(a) % 10 === 0 ? 22 : 12;
        el.style.left = `${p.x - w / 2}px`; el.style.top = `${p.y}px`; el.style.width = `${w}px`;
        if (p.ok) { top = Math.min(top, p.y); bot = Math.max(bot, p.y); lx = p.x; }
      } else {
        el.style.left = `${p.x + 16}px`; el.style.top = `${p.y}px`;
      }
    }
    const line = box.querySelector('.lpd-line') as HTMLElement;
    if (Number.isFinite(top)) { line.style.left = `${lx}px`; line.style.top = `${top}px`; line.style.height = `${bot - top}px`; }
  }
}

function sgn(v: number, digits: number) {
  const s = v < 0 ? '-' : '+';
  return s + String(Math.min(10 ** digits - 1, Math.round(Math.abs(v)))).padStart(digits, '0');
}

export function fmtGET(tfi: number) {
  const t = Math.max(0, PDI_GET + tfi);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
