// CPU-side heightfields (metres above the 1737.4 km sphere) shared by physics and rendering.

export interface GridMeta {
  width: number; height: number;
  lon0: number; lat0: number; dlon: number; dlat: number; // centre of sample (0,0) and spacing (deg)
  scale: number; offset: number;
  source: string;
  [k: string]: unknown;
}

export class HeightGrid {
  constructor(readonly meta: GridMeta, readonly data: Int16Array) {}

  sample(r: number, c: number): number {
    const m = this.meta;
    r = Math.min(Math.max(r, 0), m.height - 1);
    c = Math.min(Math.max(c, 0), m.width - 1);
    return this.data[r * m.width + c] * m.scale + m.offset;
  }

  contains(lat: number, lon: number, marginSamples = 0): boolean {
    const m = this.meta;
    const r = (lat - m.lat0) / m.dlat, c = (lon - m.lon0) / m.dlon;
    return r >= marginSamples && c >= marginSamples && r <= m.height - 1 - marginSamples && c <= m.width - 1 - marginSamples;
  }

  /** Bilinear height at lat/lon (deg). */
  heightAt(lat: number, lon: number): number {
    const m = this.meta;
    const r = (lat - m.lat0) / m.dlat, c = (lon - m.lon0) / m.dlon;
    const r0 = Math.floor(r), c0 = Math.floor(c);
    const fr = r - r0, fc = c - c0;
    const a = this.sample(r0, c0), b = this.sample(r0, c0 + 1);
    const d = this.sample(r0 + 1, c0), e = this.sample(r0 + 1, c0 + 1);
    return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
  }

  get bounds() {
    const m = this.meta;
    const latA = m.lat0, latB = m.lat0 + (m.height - 1) * m.dlat;
    const lonA = m.lon0, lonB = m.lon0 + (m.width - 1) * m.dlon;
    return { latMin: Math.min(latA, latB), latMax: Math.max(latA, latB), lonMin: Math.min(lonA, lonB), lonMax: Math.max(lonA, lonB) };
  }
}

export class TerrainData {
  constructor(readonly corridor: HeightGrid, readonly site: HeightGrid) {}

  static async load(base: string, onProgress?: (msg: string) => void): Promise<TerrainData> {
    const get = async (name: string) => {
      onProgress?.(`Loading ${name} terrain…`);
      const [meta, blob] = await Promise.all([
        fetch(`${base}/${name}.json`).then((r) => r.json()),
        fetch(`${base}/${name}_h.png`).then((r) => r.blob()),
      ]);
      return new HeightGrid(meta, await decodeHeightPng(blob, meta.width, meta.height));
    };
    const [corridor, site] = await Promise.all([get('corridor'), get('site')]);
    return new TerrainData(corridor, site);
  }

  /** Best available terrain height (m above reference sphere). */
  heightAt(lat: number, lon: number): number {
    if (this.site.contains(lat, lon, 1)) return this.site.heightAt(lat, lon);
    return this.corridor.heightAt(lat, lon);
  }
}

/**
 * Heights are stored losslessly as RGB PNG: R = high byte, G = low byte of (value + 32768).
 * Decoded in JS (zlib via DecompressionStream) so Safari's colour management can never alter the bytes.
 */
async function decodeHeightPng(blob: Blob, w: number, h: number): Promise<Int16Array> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let p = 8, width = 0, height = 0, ctype = 0;
  const idat: Uint8Array[] = [];
  while (p < buf.length) {
    const len = dv.getUint32(p); const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = dv.getUint32(p + 8); height = dv.getUint32(p + 12); ctype = buf[p + 17]; if (buf[p + 16] !== 8) throw new Error('PNG bit depth'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (width !== w || height !== h) throw new Error(`height map size ${width}x${height}, expected ${w}x${h}`);
  const bpp = ctype === 2 ? 3 : ctype === 6 ? 4 : 0;
  if (!bpp) throw new Error('PNG colour type');
  const raw = new Uint8Array(await new Response(new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = width * bpp;
  const out = new Int16Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) out[y * width + x] = ((cur[x * bpp] << 8) | cur[x * bpp + 1]) - 32768;
    const t = prev; prev = cur; cur = t;
  }
  return out;
}
