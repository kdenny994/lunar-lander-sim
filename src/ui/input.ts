// Pilot input: keyboard, Gamepad API (gamepads and HOTAS joysticks) and on-screen touch controls.
import type { PilotInput } from '../sim/dap';

export type Action =
  | 'takeControl' | 'view' | 'pause' | 'rodUp' | 'rodDown' | 'throttleMode' | 'engineStop'
  | 'warpUp' | 'warpDown' | 'restart';

export class InputManager {
  readonly state: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.4, fwd: 0, right: 0, ullage: false };
  private keys = new Set<string>();
  private listeners: ((a: Action) => void)[] = [];
  private prevButtons: boolean[] = [];
  touch = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, active: false };
  gamepadName = '';
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
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      this.gamepadName = gp.id;
      const ax = (i: number) => (gp.axes[i] ?? 0);
      const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
      const btn = (i: number) => !!gp.buttons[i]?.pressed;
      if (gp.mapping === 'standard') {
        // left stick: ACA pitch/roll; right stick X: yaw; triggers: throttle down/up; d-pad up/down: ROD
        pitch += -dz(ax(1)); roll += dz(ax(0)); yaw += dz(ax(2));
        fwd += -dz(ax(3)); // right stick Y: TTCA forward/aft translation
        thrDelta += ((gp.buttons[7]?.value ?? 0) - (gp.buttons[6]?.value ?? 0)) * 0.4 * dt;
        if (btn(4)) right -= 1; if (btn(5)) right += 1;
        this.edge(gp.index, 12, btn(12), 'rodUp');
        this.edge(gp.index, 13, btn(13), 'rodDown');
        this.edge(gp.index, 0, btn(0), 'takeControl');
        this.edge(gp.index, 3, btn(3), 'view');
        this.edge(gp.index, 2, btn(2), 'throttleMode');
        this.edge(gp.index, 1, btn(1), 'engineStop');
        this.edge(gp.index, 9, btn(9), 'pause');
        this.edge(gp.index, 15, btn(15), 'warpUp');
        this.edge(gp.index, 14, btn(14), 'warpDown');
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

  private edge(pad: number, i: number, pressed: boolean, a: Action) {
    const key = pad * 32 + i;
    if (pressed && !this.prevButtons[key]) this.emit(a);
    this.prevButtons[key] = pressed;
  }
}
