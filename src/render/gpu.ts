// WebGL renderer setup shared by both missions, hardened for desktop Chrome on macOS (ANGLE on Metal).
//
// - Checks for WebGL 2 up front and explains how to fix it (hardware acceleration off, GPU blocklisted) instead of
//   leaving the loading screen hanging on an exception.
// - Uses the default GPU preference: asking for 'high-performance' makes Chrome switch dual-GPU MacBooks to the
//   discrete GPU, and the switch can lose the context while the page is loading.
// - Caps the drawing buffer to a pixel budget, so a Retina or 5K display at device pixel ratio 2 doesn't allocate a
//   20-megapixel multisampled framebuffer on top of the scene's textures.
// - Clamps shadow-map size and anisotropy to what the GPU reports.
// - If the context is lost on the high-fidelity set, switches to the light set and reloads once.
// - Compiles shaders (in parallel where KHR_parallel_shader_compile is available) and uploads textures a few at a time
//   behind the loading screen, so the first rendered frame doesn't stall the GPU process for seconds.
import * as THREE from 'three';
import { quality, setQuality } from '../ui/quality';

const RETRY_KEY = 'eagle.gpu-retry';
/** drawing-buffer pixel budgets: about 4K UHD on high, about 1440p on low */
const PX_BUDGET = { high: 3840 * 2160, low: 2560 * 1440 };

export class GpuError extends Error {}

function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

const GPU_HELP =
  'In Chrome, open Settings › System and turn on “Use graphics acceleration when available”, then relaunch Chrome. ' +
  'If it is already on, open chrome://gpu and check that WebGL2 is “Hardware accelerated”.';

/** Device pixel ratio capped so the drawing buffer stays inside the pixel budget. */
export function fitPixelRatio(low: boolean) {
  const dpr = Math.min(window.devicePixelRatio || 1, low ? 1.5 : 2);
  const css = Math.max(1, window.innerWidth * window.innerHeight);
  const budget = low ? PX_BUDGET.low : PX_BUDGET.high;
  return Math.max(1, Math.min(dpr, Math.sqrt(budget / css)));
}

export interface RendererOpts {
  low: boolean;
  /** shows a message on the loading screen */
  message: (m: string) => void;
}

export function createRenderer({ low, message }: RendererOpts): THREE.WebGLRenderer {
  if (!webgl2Available()) throw new GpuError(`This browser could not start WebGL 2. ${GPU_HELP}`);
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: !low || window.devicePixelRatio < 2,
      logarithmicDepthBuffer: true,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
    });
  } catch (e) {
    console.error(e);
    throw new GpuError(`Could not create the WebGL context (${(e as Error)?.message ?? e}). ${GPU_HELP}`);
  }
  renderer.setPixelRatio(fitPixelRatio(low));
  const canvas = renderer.domElement;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.error('WebGL context lost');
    let retried = false;
    try { retried = sessionStorage.getItem(RETRY_KEY) === '1'; } catch { /* storage blocked */ }
    document.getElementById('loading')!.hidden = false;
    if (quality() === 'high' && !retried) {
      try { sessionStorage.setItem(RETRY_KEY, '1'); } catch { /* storage blocked */ }
      setQuality('low');
      message('The graphics card ran out of memory on the high-fidelity set. Switching to light graphics and reloading…');
      setTimeout(() => location.reload(), 1500);
    } else {
      message('The graphics context was lost (the GPU reclaimed memory or reset). Reload the page to continue.');
    }
  }, false);
  // a session that got this far without losing the context may try high fidelity again next time
  setTimeout(() => { try { sessionStorage.removeItem(RETRY_KEY); } catch { /* storage blocked */ } }, 60000);
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  console.info('WebGL renderer:', info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    '· max texture', renderer.capabilities.maxTextureSize, '· pixel ratio', renderer.getPixelRatio().toFixed(2));
  return renderer;
}

/** Shadow-map edge length the GPU can hold. */
export const shadowSize = (r: THREE.WebGLRenderer, want: number) => Math.min(want, r.capabilities.maxTextureSize);
/** Anisotropic filtering level: 8 looks the same as 16 on terrain and costs less bandwidth. */
export const anisotropy = (r: THREE.WebGLRenderer) => Math.min(8, Math.max(1, r.capabilities.getMaxAnisotropy()));

const nextFrame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));

/**
 * Compile every material and upload every texture in the scene before the first frame, spread over several
 * animation frames. Best effort: anything left over is still uploaded on first use.
 */
export async function warmGpu(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, onProgress?: (f: number) => void) {
  try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn('shader precompile', e); }
  const textures = new Set<THREE.Texture>();
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      for (const v of Object.values(mat as any)) if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture);
      const u = (mat as THREE.ShaderMaterial).uniforms;
      if (u) for (const k in u) if (u[k]?.value?.isTexture) textures.add(u[k].value);
    }
  });
  const list = [...textures].filter((t) => (t as any).image);
  let t0 = performance.now(), done = 0;
  for (const t of list) {
    try { renderer.initTexture(t); } catch (e) { console.warn('texture upload', e); }
    done++;
    if (performance.now() - t0 > 30) { onProgress?.(done / list.length); await nextFrame(); t0 = performance.now(); }
  }
  onProgress?.(1);
}
