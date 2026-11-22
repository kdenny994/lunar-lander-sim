// On-screen virtual sticks for iPad / touch devices.
import type { InputManager } from './input';

function stick(el: HTMLElement, onMove: (x: number, y: number) => void, spring = true) {
  const knob = el.querySelector('.knob') as HTMLElement;
  let id: number | null = null;
  const set = (x: number, y: number) => {
    const r = el.clientWidth / 2;
    knob.style.transform = `translate(${x * r * 0.62}px, ${y * r * 0.62}px)`;
    onMove(x, -y);
  };
  const handle = (e: PointerEvent) => {
    const b = el.getBoundingClientRect();
    let x = (e.clientX - b.left - b.width / 2) / (b.width / 2 * 0.8);
    let y = (e.clientY - b.top - b.height / 2) / (b.height / 2 * 0.8);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    set(x, y);
  };
  el.addEventListener('pointerdown', (e) => { id = e.pointerId; el.setPointerCapture(e.pointerId); handle(e); e.preventDefault(); });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === id) handle(e); });
  const end = (e: PointerEvent) => { if (e.pointerId !== id) return; id = null; if (spring) set(0, 0); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

export function setupTouch(input: InputManager) {
  const root = document.getElementById('touch')!;
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  root.hidden = !isTouch;
  document.body.classList.toggle('touch', isTouch);
  input.touch.active = true;
  stick(document.getElementById('stick-l')!, (x, y) => { input.touch.roll = x; input.touch.pitch = y; });
  stick(document.getElementById('stick-r')!, (x, y) => { input.touch.yaw = x; input.touch.throttleDelta = y * 0.5; });
  const tap = (id: string, a: Parameters<InputManager['emit']>[0]) =>
    document.getElementById(id)!.addEventListener('pointerdown', (e) => { e.preventDefault(); input.emit(a); });
  tap('t-rodup', 'rodUp');
  tap('t-roddn', 'rodDown');
  tap('t-tmode', 'throttleMode');
  tap('t-stop', 'engineStop');
  return { show: (v: boolean) => { root.hidden = !v || !isTouch; } };
}
