// Graphics quality. Desktops default to the high-fidelity assets (full-resolution site imagery everywhere, the full
// Starship mesh, larger shadow maps and native pixel ratio); iPhone, iPad and other handhelds default to the light
// set to stay inside their GPU memory. The player can override it from Help, remembered per browser.
export type Quality = 'high' | 'low';
const KEY = 'eagle.quality';

/** iPhone / iPad / Android. iPadOS reports a Mac user agent, so it is told apart by its touch screen. */
export const isHandheld = () =>
  /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export function quality(): Quality {
  try { const q = localStorage.getItem(KEY); if (q === 'high' || q === 'low') return q; } catch { /* storage blocked */ }
  return isHandheld() ? 'low' : 'high';
}

export function setQuality(q: Quality) {
  try { localStorage.setItem(KEY, q); } catch { /* storage blocked: applies to this load only */ }
}
