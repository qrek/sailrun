import landRaw from '../data/land.json';

/** [longitude, latitude] en degrés. */
export type LonLat = [number, number];

/** Côtes Natural Earth 1:50m découpées sur l'Atlantique : polygones → anneaux → [lon, lat, lon, lat, ...]. */
export const LAND = landRaw as unknown as number[][][];

export const LONMIN = -95;
export const LONMAX = 22;
export const LATMIN = -12;
export const LATMAX = 68;

/** Origine de la projection 3D (1 unité = 1° de latitude = 60 milles). */
export const LON0 = -37;
export const LAT0 = 30;
export const KX = Math.cos((30 * Math.PI) / 180);

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const NM_PER_DEG = 60;

export const toX = (lon: number) => (lon - LON0) * KX;
export const toZ = (lat: number) => -(lat - LAT0);
export const fromX = (x: number) => x / KX + LON0;
export const fromZ = (z: number) => -z + LAT0;

/* ---------- masque terre / mer (10 px par degré, ≈ 6 milles) ---------- */
const RES = 10;
const MW = (LONMAX - LONMIN) * RES;
const MH = (LATMAX - LATMIN) * RES;
const mask = buildMask();

function buildMask(): Uint8Array {
  const m = new Uint8Array(MW * MH);
  // pré-calcul des bornes de chaque anneau pour ne parcourir que les anneaux utiles
  const rings: { r: number[]; ymin: number; ymax: number }[] = [];
  for (const poly of LAND) {
    for (const r of poly) {
      let ymin = Infinity;
      let ymax = -Infinity;
      for (let i = 1; i < r.length; i += 2) {
        if (r[i] < ymin) ymin = r[i];
        if (r[i] > ymax) ymax = r[i];
      }
      rings.push({ r, ymin, ymax });
    }
  }
  const xs: number[] = [];
  for (let row = 0; row < MH; row++) {
    const lat = LATMAX - (row + 0.5) / RES;
    xs.length = 0;
    for (const { r, ymin, ymax } of rings) {
      if (lat < ymin || lat > ymax) continue;
      for (let i = 0; i < r.length - 2; i += 2) {
        const y1 = r[i + 1];
        const y2 = r[i + 3];
        if (y1 <= lat !== y2 <= lat) {
          const x1 = r[i];
          const x2 = r[i + 2];
          xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const j0 = Math.max(0, Math.ceil((xs[k] - LONMIN) * RES - 0.5));
      const j1 = Math.min(MW - 1, Math.floor((xs[k + 1] - LONMIN) * RES - 0.5));
      for (let j = j0; j <= j1; j++) m[row * MW + j] = 1;
    }
  }
  return m;
}

export function isLand(lon: number, lat: number): boolean {
  if (lon < LONMIN || lon >= LONMAX || lat <= LATMIN || lat > LATMAX) return true;
  const i = ((LATMAX - lat) * RES) | 0;
  const j = ((lon - LONMIN) * RES) | 0;
  return mask[i * MW + j] === 1;
}

/* ---------- maths ---------- */
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export const norm180 = (a: number) => ((((a % 360) + 540) % 360) - 180);
export const norm360 = (a: number) => (((a % 360) + 360) % 360);

/** Distance orthodromique en milles nautiques. */
export function dist(a: LonLat, b: LonLat): number {
  const p1 = a[1] * D2R;
  const p2 = b[1] * D2R;
  const dp = p2 - p1;
  const dl = (b[0] - a[0]) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cap initial (°) de a vers b. */
export function bearing(a: LonLat, b: LonLat): number {
  const p1 = a[1] * D2R;
  const p2 = b[1] * D2R;
  const dl = (b[0] - a[0]) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(Math.atan2(y, x) * R2D);
}

/** Avance de `spd` nœuds pendant `dt` heures au cap `hdg`. */
export function move(lon: number, lat: number, hdg: number, spd: number, dt: number): LonLat {
  const d = (spd * dt) / NM_PER_DEG;
  const lat2 = lat + d * Math.cos(hdg * D2R);
  const lon2 = lon + (d * Math.sin(hdg * D2R)) / Math.cos(((lat + lat2) / 2) * D2R);
  return [lon2, lat2];
}

/** Générateur pseudo-aléatoire déterministe (mulberry32), état sérialisable. */
export class Rng {
  constructor(public state: number) {}
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.next() * a.length)];
  }
}

export const fmtInt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
