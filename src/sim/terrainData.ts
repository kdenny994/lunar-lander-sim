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

/** Heights are stored losslessly as RGB PNG: R = high byte, G = low byte of (value + 32768). */
async function decodeHeightPng(blob: Blob, w: number, h: number): Promise<Int16Array> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Int16Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = ((px[i * 4] << 8) | px[i * 4 + 1]) - 32768;
  bmp.close();
  return out;
}
