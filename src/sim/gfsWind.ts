import { RHUM } from '../data/races';
import { D2R } from './geo';
import { SyntheticWind, WindSource } from './wind';

/**
 * Vent réel : prévisions GFS (NOAA) via l'API Open-Meteo, sur une grille de 2,5° qui couvre
 * la zone de course, un pas toutes les 3 h sur 14 jours. Interpolation bilinéaire dans l'espace
 * et linéaire dans le temps. Hors de la grille ou au-delà des prévisions, on retombe en douceur
 * sur le vent synthétique.
 */

export interface GridMeta {
  lat0: number;
  dlat: number;
  nlat: number;
  lon0: number;
  dlon: number;
  nlon: number;
  /** début des prévisions (ms UTC) */
  t0: number;
  /** pas de temps (h) */
  dt: number;
  nt: number;
  /** moment où les prévisions ont été récupérées (ms) */
  fetched: number;
  source: 'live' | 'snapshot';
}

export interface WindGrid {
  meta: GridMeta;
  /** u puis v, en centièmes de nœud, indexés [t][lat][lon] */
  u: Int16Array;
  v: Int16Array;
}

/**
 * Zone de course : du golfe de Gascogne aux Antilles, jusqu'à 2,5° E pour que le départ de Saint-Malo
 * ne soit pas au bord (le vent y serait mêlé de vent simulé). 551 points = une seule requête sous la limite
 * gratuite d'Open-Meteo.
 */
export const GRID = { lat0: 7.5, dlat: 2.5, nlat: 19, lon0: -67.5, dlon: 2.5, nlon: 29, dt: 3 };

export class GridWind implements WindSource {
  private fallback: SyntheticWind;
  constructor(
    readonly grid: WindGrid,
    /** heure réelle (ms UTC) qui correspond à t = 0 */
    readonly originUTC: number,
    phase = 0,
  ) {
    this.fallback = new SyntheticWind(phase);
  }

  get meta() {
    return this.grid.meta;
  }

  /** Heures de course couvertes par les prévisions. */
  horizon(): number {
    const m = this.grid.meta;
    return (m.t0 + (m.nt - 1) * m.dt * 3600000 - this.originUTC) / 3600000;
  }

  at(lon: number, lat: number, t: number): [number, number] {
    const m = this.grid.meta;
    const gx = (lon - m.lon0) / m.dlon;
    const gy = (lat - m.lat0) / m.dlat;
    // poids de la grille : 1 à l'intérieur, 0 à 2 mailles du bord
    const inX = Math.min(gx, m.nlon - 1 - gx);
    const inY = Math.min(gy, m.nlat - 1 - gy);
    const wSpace = Math.max(0, Math.min(1, 0.5 + Math.min(inX, inY) / 2));
    const ht = (this.originUTC + t * 3600000 - m.t0) / 3600000 / m.dt;
    const over = ht - (m.nt - 1);
    const wTime = over > 0 ? Math.max(0, 1 - (over * m.dt) / 24) : 1;
    const w = wSpace * wTime;
    if (w <= 0) return this.fallback.at(lon, lat, t);
    const g = this.sample(gx, gy, Math.max(0, Math.min(m.nt - 1, ht)));
    if (w >= 1) return g;
    const f = this.fallback.at(lon, lat, t);
    return [g[0] * w + f[0] * (1 - w), g[1] * w + f[1] * (1 - w)];
  }

  private sample(gx: number, gy: number, ht: number): [number, number] {
    const m = this.grid.meta;
    const x = Math.max(0, Math.min(m.nlon - 1.001, gx));
    const y = Math.max(0, Math.min(m.nlat - 1.001, gy));
    const t = Math.min(m.nt - 1.001, ht);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const t0 = Math.floor(t);
    const fx = x - x0;
    const fy = y - y0;
    const ft = t - t0;
    const plane = m.nlat * m.nlon;
    const { u, v } = this.grid;
    let su = 0;
    let sv = 0;
    for (let k = 0; k < 2; k++) {
      const wt = k ? ft : 1 - ft;
      if (wt === 0) continue;
      const base = (t0 + k) * plane;
      const i00 = base + y0 * m.nlon + x0;
      const i10 = i00 + 1;
      const i01 = i00 + m.nlon;
      const i11 = i01 + 1;
      const a = (1 - fx) * (1 - fy);
      const b = fx * (1 - fy);
      const c = (1 - fx) * fy;
      const d = fx * fy;
      su += wt * (u[i00] * a + u[i10] * b + u[i01] * c + u[i11] * d);
      sv += wt * (v[i00] * a + v[i10] * b + v[i01] * c + v[i11] * d);
    }
    return [su / 100, sv / 100];
  }
}

/* ---------- chargement ---------- */

const CACHE_KEY = 'sailgame.gfs.v1';
const MAX_AGE = 3 * 3600000; // GFS sort toutes les 6 h : on rafraîchit toutes les 3 h

export function gridPoints(): [number, number][] {
  const pts: [number, number][] = [];
  for (let j = 0; j < GRID.nlat; j++) for (let i = 0; i < GRID.nlon; i++) pts.push([GRID.lat0 + j * GRID.dlat, GRID.lon0 + i * GRID.dlon]);
  return pts;
}

const DAY = 86400000;
/** 14 jours de données par requête : au-delà, Open-Meteo compte plusieurs appels. */
const WINDOW_DAYS = 14;
/** Jours de prévisions gardés devant : le curseur des prévisions va à 5 jours. */
const AHEAD_DAYS = 6;

/**
 * Requête Open-Meteo pour ces points. Une fois la Route du Rhum partie, les données remontent jusqu'au jour
 * du départ (8 jours au plus) : le rattrapage après une absence, et les concurrents simulés quand on arrive
 * en retard, naviguent dans le vent qu'il a fait. Le reste de la fenêtre, ce sont les prévisions.
 */
export function openMeteoUrl(pts: [number, number][], now = Date.now()): string {
  const past = Math.max(0, Math.min(WINDOW_DAYS - AHEAD_DAYS, Math.floor(now / DAY) - Math.floor(RHUM.startUTC / DAY)));
  return (
    'https://api.open-meteo.com/v1/gfs?latitude=' +
    pts.map((p) => p[0]).join(',') +
    '&longitude=' +
    pts.map((p) => p[1]).join(',') +
    `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&past_days=${past}&forecast_days=${WINDOW_DAYS - past}&temporal_resolution=hourly_3&timezone=GMT`
  );
}

interface OMPoint {
  hourly: { time: string[]; wind_speed_10m: (number | null)[]; wind_direction_10m: (number | null)[] };
}

/** Convertit la réponse Open-Meteo (une entrée par point, dans l'ordre demandé) en grille compacte. */
export function gridFromOpenMeteo(points: OMPoint[], fetched: number, source: GridMeta['source']): WindGrid {
  const times = points[0].hourly.time;
  const nt = times.length;
  const plane = GRID.nlat * GRID.nlon;
  const u = new Int16Array(nt * plane);
  const v = new Int16Array(nt * plane);
  points.forEach((p, idx) => {
    const sp = p.hourly.wind_speed_10m;
    const dir = p.hourly.wind_direction_10m;
    for (let k = 0; k < nt; k++) {
      const s = sp[k] ?? 0;
      const d = (dir[k] ?? 0) * D2R;
      // direction d'où vient le vent -> composantes vers où il va
      u[k * plane + idx] = Math.round(-s * Math.sin(d) * 100);
      v[k * plane + idx] = Math.round(-s * Math.cos(d) * 100);
    }
  });
  return { meta: { ...GRID, nt, t0: Date.parse(times[0] + 'Z'), fetched, source }, u, v };
}

async function fetchOpenMeteo(signal?: AbortSignal): Promise<WindGrid> {
  const pts = gridPoints();
  const parts = [pts];
  const res = await Promise.all(
    parts.map(async (part) => {
      const r = await fetch(openMeteoUrl(part), { signal });
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      return (await r.json()) as OMPoint[];
    }),
  );
  return gridFromOpenMeteo(res.flat(), Date.now(), 'live');
}

/* sérialisation compacte pour le cache local et l'instantané embarqué */
function toB64(a: Int16Array): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Int16Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new Int16Array(b.buffer);
}

export function encodeGrid(g: WindGrid): string {
  return JSON.stringify({ meta: g.meta, u: toB64(g.u), v: toB64(g.v) });
}
export function decodeGrid(s: string): WindGrid {
  const o = JSON.parse(s);
  return { meta: o.meta, u: fromB64(o.u), v: fromB64(o.v) };
}

let current: WindGrid | null = null;
let pending: Promise<WindGrid | null> | null = null;

/** La grille déjà chargée, s'il y en a une. */
export const windGrid = () => current;

const fresh = (g: WindGrid) => Date.now() - g.meta.fetched < MAX_AGE;

/**
 * Charge les prévisions : celles en mémoire ou le cache local s'ils sont frais, sinon Open-Meteo,
 * sinon les plus récentes qu'on ait, sinon l'instantané embarqué dans le jeu. À rappeler de temps
 * en temps : tant que les prévisions sont fraîches, ça ne coûte rien.
 * Ne rejette jamais : null = on reste sur le vent synthétique.
 */
export function loadWindGrid(base = import.meta.env?.BASE_URL ?? '/'): Promise<WindGrid | null> {
  if (current && fresh(current)) return Promise.resolve(current);
  if (pending) return pending;
  pending = (async () => {
    let cached: WindGrid | null = null;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) cached = decodeGrid(raw);
    } catch {
      cached = null;
    }
    if (cached && fresh(cached)) return (current = cached);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const g = await fetchOpenMeteo(ctl.signal);
      clearTimeout(timer);
      try {
        localStorage.setItem(CACHE_KEY, encodeGrid(g));
      } catch {
        /* cache plein : tant pis */
      }
      return (current = g);
    } catch {
      /* hors ligne ou API indisponible */
    }
    if (cached && (!current || cached.meta.fetched > current.meta.fetched)) current = cached;
    if (current) return current;
    try {
      const r = await fetch(`${base}wind/gfs-snapshot.json`);
      if (r.ok) return (current = decodeGrid(await r.text()));
    } catch {
      /* rien */
    }
    return null;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** Pour les tests : injecte une grille. */
export function setWindGrid(g: WindGrid | null) {
  current = g;
  pending = null;
}
