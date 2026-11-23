// Pilot input: keyboard, Gamepad API (gamepads and HOTAS joysticks) and on-screen touch controls.
import type { PilotInput } from '../sim/dap';

export type Action =
  | 'takeControl' | 'view' | 'pause' | 'rodUp' | 'rodDown' | 'throttleMode' | 'engineStop'
  | 'warpUp' | 'warpDown' | 'restart' | 'eng1' | 'eng2' | 'eng3' | 'resetView';

/**
 * Xbox controller (W3C "standard" mapping), laid out after the Microsoft Flight Simulator 2024 defaults:
 *   left stick   pitch / roll                      right stick   look around (click: reset view)
 *   LT / RT      yaw left / right                  A / B (hold)  throttle up / down
 *   X            engine cutoff / start             LB / RB       Apollo: ROD switch down / up · Starship: fewer / more Raptors
 *   View         cycle camera                      Menu          pause
 *   left stick click, or Y + B   take control / hand back to the guidance
 *   Y + A        throttle mode (auto / manual)     Y + D-pad     translation (Apollo TTCA): up/down fwd/aft, left/right
 *   D-pad ← / →  time warp down / up               D-pad ↑ / ↓   camera zoom in / out
 *   Y + View     restart
 * Y is a modifier, as in Flight Simulator: hold it first, then press the second button.
 */
export const XBOX_LAYOUT: [string, string][] = [
  ['Left stick', 'Pitch / roll'], ['LT / RT', 'Yaw left / right'], ['A / B (hold)', 'Throttle up / down'],
  ['X', 'Engine cutoff / start'], ['LB / RB', 'Apollo: ROD − / + · Starship: Raptors − / +'],
  ['Right stick', 'Look around (click: reset view)'], ['View', 'Cycle camera'], ['Menu', 'Pause'],
  ['Left stick click · Y + B', 'Take control / guidance'], ['Y + A', 'Throttle mode (auto / manual)'],
  ['Y + D-pad', 'Translation (Apollo)'], ['D-pad ← →', 'Time warp'], ['D-pad ↑ ↓', 'Zoom'], ['Y + View', 'Restart'],
];

export class InputManager {
  readonly state: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.4, fwd: 0, right: 0, ullage: false };
  private keys = new Set<string>();
  private listeners: ((a: Action) => void)[] = [];
  private prevButtons: boolean[] = [];
  touch = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, active: false };
  gamepadName = '';
  /** camera look from the right stick (rad/s-scaled, -1..1) and zoom (-1 in .. +1 out) */
  readonly look = { x: 0, y: 0, zoom: 0 };
  /** generic (non-"standard") joystick axis mapping */
  hotas = { roll: 0, pitch: 1, throttle: 2, yaw: 5 };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.keys.has(e.code)) this.onKeyPress(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  on(fn: (a: Action) => void) { this.listeners.push(fn); }
  emit(a: Action) { for (const l of this.listeners) l(a); }

  private onKeyPress(code: string) {
    const map: Record<string, Action> = {
      Space: 'takeControl', KeyV: 'view', KeyP: 'pause', KeyR: 'rodUp', KeyF: 'rodDown', KeyT: 'throttleMode',
      KeyX: 'engineStop', Period: 'warpUp', Comma: 'warpDown', Backspace: 'restart',
      Digit1: 'eng1', Digit2: 'eng2', Digit3: 'eng3', Numpad1: 'eng1', Numpad2: 'eng2', Numpad3: 'eng3',
    };
    const a = map[code];
    if (a) this.emit(a);
  }

  update(dt: number) {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    let pitch = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
    let roll = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
    let yaw = k('KeyE') - k('KeyQ');
    let fwd = k('KeyI') - k('KeyK');
    let right = k('KeyL') - k('KeyJ');
    let thrDelta = (k('ShiftLeft') + k('ShiftRight') - k('ControlLeft') - k('ControlRight')) * 0.5 * dt;
    let throttleAbs: number | null = null;
    const ullage = this.keys.has('KeyU');

    // ---- gamepads ----
    this.look.x = 0; this.look.y = 0; this.look.zoom = 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      this.gamepadName = gp.id;
      const ax = (i: number) => (gp.axes[i] ?? 0);
      const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
      const btn = (i: number) => !!gp.buttons[i]?.pressed;
      if (gp.mapping === 'standard') {
        const y = btn(3); // modifier
        pitch += -dz(ax(1)); roll += dz(ax(0));
        yaw += (gp.buttons[7]?.value ?? 0) - (gp.buttons[6]?.value ?? 0);
        this.look.x += dz(ax(2)); this.look.y += -dz(ax(3));
        if (!y) {
          thrDelta += ((btn(0) ? 1 : 0) - (btn(1) ? 1 : 0)) * 0.4 * dt;
          this.look.zoom += (btn(13) ? 1 : 0) - (btn(12) ? 1 : 0);
        } else {
          fwd += (btn(12) ? 1 : 0) - (btn(13) ? 1 : 0);
          right += (btn(15) ? 1 : 0) - (btn(14) ? 1 : 0);
        }
        this.edge(gp.index, 0, btn(0), 'throttleMode', y);
        this.edge(gp.index, 1, btn(1), 'takeControl', y);
        this.edge(gp.index, 2, btn(2), 'engineStop');
        this.edge(gp.index, 4, btn(4), 'rodDown');
        this.edge(gp.index, 5, btn(5), 'rodUp');
        this.edge(gp.index, 8, btn(8), 'view', !y);
        this.edge(gp.index, 24, btn(8), 'restart', y); // own edge slot (24) for Y + View
        this.edge(gp.index, 9, btn(9), 'pause');
        this.edge(gp.index, 10, btn(10), 'takeControl');
        this.edge(gp.index, 11, btn(11), 'resetView');
        this.edge(gp.index, 14, btn(14), 'warpDown', !y);
        this.edge(gp.index, 15, btn(15), 'warpUp', !y);
      } else {
        // flight stick / HOTAS: roll, pitch, throttle lever, twist yaw
        roll += dz(ax(this.hotas.roll)); pitch += -dz(ax(this.hotas.pitch));
        if (gp.axes.length > this.hotas.yaw) yaw += dz(ax(this.hotas.yaw));
        if (gp.axes.length > this.hotas.throttle) throttleAbs = (1 - ax(this.hotas.throttle)) / 2;
        this.edge(gp.index, 0, btn(0), 'takeControl');
        this.edge(gp.index, 1, btn(1), 'view');
        this.edge(gp.index, 2, btn(2), 'rodDown');
        this.edge(gp.index, 3, btn(3), 'rodUp');
        this.edge(gp.index, 4, btn(4), 'throttleMode');
        this.edge(gp.index, 5, btn(5), 'engineStop');
      }
    }

    // ---- touch ----
    if (this.touch.active) {
      pitch += this.touch.pitch; roll += this.touch.roll; yaw += this.touch.yaw;
    }
    thrDelta += this.touch.throttleDelta * dt;

    const cl = (v: number) => Math.max(-1, Math.min(1, v));
    const s = this.state;
    s.pitch = cl(pitch); s.roll = cl(roll); s.yaw = cl(yaw); s.fwd = cl(fwd); s.right = cl(right); s.ullage = ullage;
    s.throttle = throttleAbs ?? Math.max(0, Math.min(1, s.throttle + thrDelta));
  }

  /** fire `a` on the press edge of button i; `when` gates it (e.g. on the Y modifier) without losing the edge */
  private edge(pad: number, i: number, pressed: boolean, a: Action, when = true) {
    const key = pad * 32 + i;
    if (pressed && !this.prevButtons[key] && when) this.emit(a);
    this.prevButtons[key] = pressed;
  }
}
