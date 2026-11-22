// Planetarium view controls: sensor choice, labels, go-to buttons, Apollo reference photos.
import * as THREE from 'three';

export type Sensor = 'eye' | 'camera' | 'aot';

export interface RefPhoto {
  id: string; title: string; lens: string; fov: number; sensor: Sensor;
  when: 'landed' | 'pdi' | 'now';
  look: { kind: 'earth' } | { kind: 'window'; side: number; el: number };
  note: string;
}

export const REF_PHOTOS: RefPhoto[] = [
  {
    id: 'as11-37-5458', title: 'AS11-37-5458: out the right window after landing', lens: 'Hasselblad, 80 mm lens (38° field)', fov: 38,
    sensor: 'camera', when: 'landed', look: { kind: 'window', side: 25, el: -7 },
    note: 'Taken from the LM right-hand window before the moonwalk. The exposure is set for sunlit regolith, so the sky records as pure black: even Venus is about 9 magnitudes too faint for this film at 1/250 s.',
  },
  {
    id: 'as11-44-6552', title: 'AS11-44-6552: Earth above the lunar horizon', lens: 'Hasselblad, 250 mm lens (12.5° field)', fov: 12.5,
    sensor: 'camera', when: 'now', look: { kind: 'earth' },
    note: 'Taken from lunar orbit. Earth spans about 1.9°, nearly four times the Sun’s width, and shows blue oceans, white cloud and a soft terminator. The sim points the same lens at Earth from where you are now; the phase you see is the real one for that moment.',
  },
  {
    id: 'as11-37-5437', title: 'AS11-37-5437: approach to the landing site', lens: 'Hasselblad, 80 mm lens (38° field)', fov: 38,
    sensor: 'camera', when: 'pdi', look: { kind: 'window', side: 0, el: -40 },
    note: 'Taken through the LM window in the descent orbit, looking ahead at southwestern Mare Tranquillitatis. The sim jumps to PDI with the same lens.',
  },
];

export const SENSORS: Record<Sensor, { label: string; lim0: number; slope: number; La0: number; aperture: number; spikes: number; glow: number; desc: string }> = {
  eye: { label: 'Eye', lim0: 6.5, slope: 1.5, La0: 0.001, aperture: 1, spikes: 0, glow: 1, desc: 'Naked eye. Stars fade as the eye adapts to sunlit ground or glare in view.' },
  camera: { label: 'Hasselblad', lim0: -6, slope: 0, La0: 1, aperture: 1, spikes: 1, glow: 1.4, desc: 'Apollo surface exposure: Ektachrome at f/5.6 to f/11, 1/250 s. No stars record.' },
  aot: { label: 'AOT', lim0: 3.5, slope: 0.5, La0: 1, aperture: 1.3, spikes: 0, glow: 0.6, desc: 'Alignment Optical Telescope: shaded optics used for star sightings (P57) after landing.' },
};

export class SkyPanel {
  sensor: Sensor = 'eye';
  labels = false;
  onGoto: (what: 'earth' | 'sun' | 'zenith') => void = () => {};
  onPhoto: (p: RefPhoto) => void = () => {};
  onSensor: (s: Sensor) => void = () => {};
  private labelEls: HTMLElement[] = [];

  constructor() {
    const root = document.getElementById('skyui')!;
    const seg = root.querySelector('#sky-sensor')!;
    for (const b of Array.from(seg.querySelectorAll('button'))) {
      b.addEventListener('click', () => this.setSensor(b.dataset.s as Sensor));
    }
    root.querySelector('#sky-labels')!.addEventListener('click', () => {
      this.labels = !this.labels;
      root.querySelector('#sky-labels')!.classList.toggle('on', this.labels);
    });
    for (const b of Array.from(root.querySelectorAll('[data-goto]'))) {
      b.addEventListener('click', () => this.onGoto((b as HTMLElement).dataset.goto as 'earth' | 'sun' | 'zenith'));
    }
    const drawer = document.getElementById('ref-drawer')!;
    root.querySelector('#sky-photos')!.addEventListener('click', () => { drawer.hidden = !drawer.hidden; });
    drawer.querySelector('.close')!.addEventListener('click', () => { drawer.hidden = true; });
    const list = drawer.querySelector('.list')!;
    for (const p of REF_PHOTOS) {
      const card = document.createElement('button');
      card.className = 'ref-card';
      card.innerHTML = `<img src="./data/sky/ref/${p.id}.jpg" alt="${p.title}" loading="lazy"><span><b>${p.title}</b><small>${p.lens}</small></span>`;
      card.addEventListener('click', () => { drawer.hidden = true; this.showInset(p); this.onPhoto(p); });
      list.appendChild(card);
    }
    const inset = document.getElementById('ref-inset')!;
    inset.querySelector('.close')!.addEventListener('click', () => { inset.hidden = true; inset.classList.remove('overlay'); });
    inset.querySelector('img')!.addEventListener('click', () => inset.classList.toggle('overlay'));
    this.setSensor('eye');
  }

  setSensor(s: Sensor) {
    this.sensor = s;
    for (const b of Array.from(document.querySelectorAll('#sky-sensor button'))) b.classList.toggle('on', (b as HTMLElement).dataset.s === s);
    document.getElementById('aot-reticle')!.hidden = s !== 'aot' || !document.body.classList.contains('sky');
    this.onSensor(s);
  }

  showInset(p: RefPhoto) {
    const inset = document.getElementById('ref-inset')!;
    (inset.querySelector('img') as HTMLImageElement).src = `./data/sky/ref/${p.id}.jpg`;
    inset.querySelector('.cap')!.innerHTML = `<b>${p.title}</b> · ${p.lens}<br>${p.note}<br><small>NASA photo, tap it to overlay on the view.</small>`;
    inset.hidden = false;
  }

  setVisible(v: boolean) {
    document.getElementById('skyui')!.hidden = !v;
    document.body.classList.toggle('sky', v);
    document.getElementById('aot-reticle')!.hidden = !(v && this.sensor === 'aot');
    if (!v) { document.getElementById('ref-drawer')!.hidden = true; document.getElementById('ref-inset')!.hidden = true; this.drawLabels([], null); }
  }

  readout(html: string) { document.getElementById('sky-readout')!.innerHTML = html; }

  /** items: name + render-space direction; drawn when labels are on (Sun/Earth always labelled in sky view). */
  drawLabels(items: { name: string; dir: THREE.Vector3; cls?: string; always?: boolean }[], camera: THREE.PerspectiveCamera | null) {
    const layer = document.getElementById('sky-labels-layer')!;
    let k = 0;
    if (camera) {
      const w = window.innerWidth, h = window.innerHeight;
      const p = new THREE.Vector3();
      for (const it of items) {
        if (!this.labels && !it.always) continue;
        p.copy(it.dir).add(camera.position).project(camera);
        if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
        let el = this.labelEls[k];
        if (!el) { el = document.createElement('span'); layer.appendChild(el); this.labelEls.push(el); }
        el.className = 'sky-label ' + (it.cls ?? '');
        el.textContent = it.name;
        el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
        el.hidden = false;
        k++;
      }
    }
    for (; k < this.labelEls.length; k++) this.labelEls[k].hidden = true;
  }
}
