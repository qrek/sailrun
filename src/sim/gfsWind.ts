import { RHUM } from '../data/races';
import {
  GRID,
  OMPoint,
  WindGrid,
  gridPoints,
  gridFromOpenMeteo,
  encodeGrid,
  decodeGrid,
  openMeteoUrl as sourceUrl,
} from './gfsSource';
import { SyntheticWind, WindSource } from './wind';

export type { GridMeta, WindGrid } from './gfsSource';
export { GRID, gridPoints, gridFromOpenMeteo, encodeGrid, decodeGrid } from './gfsSource';

/** Requête Open-Meteo de la Route du Rhum pour ces points. */
export const openMeteoUrl = (pts: [number, number][], now = Date.now()) => sourceUrl(pts, RHUM.startUTC, now);

/**
 * Vent réel : prévisions GFS (NOAA) via l'API Open-Meteo, sur une grille de 2,5° qui couvre
 * la zone de course, un pas toutes les 3 h sur 14 jours. Interpolation bilinéaire dans l'espace
 * et linéaire dans le temps. Hors de la grille ou au-delà des prévisions, on retombe en douceur
 * sur le vent synthétique.
 */

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

/** au-delà, la copie du serveur est trop vieille : on tente Open-Meteo nous-mêmes */
const SERVER_MAX_AGE = 9 * 3600000;

/**
 * Copie partagée du serveur (api/wind.ts) : une seule requête Open-Meteo par heure pour tous les joueurs,
 * donc plus de refus pour quota, et tout le monde navigue dans le même vent.
 */
async function fetchServer(base: string, signal?: AbortSignal): Promise<WindGrid> {
  const r = await fetch(`${base}api/wind`, { signal });
  if (!r.ok) throw new Error(`serveur ${r.status}`);
  const g = decodeGrid(await r.text());
  const m = g.meta;
  if (m.nlat !== GRID.nlat || m.nlon !== GRID.nlon || g.u.length !== m.nt * m.nlat * m.nlon) throw new Error('grille inattendue');
  return { ...g, meta: { ...m, source: 'server' } };
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await run(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

let current: WindGrid | null = null;
let pending: Promise<WindGrid | null> | null = null;

/** La grille déjà chargée, s'il y en a une. */
export const windGrid = () => current;

const fresh = (g: WindGrid) => Date.now() - g.meta.fetched < MAX_AGE;

/**
 * Charge les prévisions : celles en mémoire ou le cache local s'ils sont frais, sinon la copie du serveur,
 * sinon Open-Meteo, sinon les plus récentes qu'on ait, sinon l'instantané embarqué dans le jeu. À rappeler de temps
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
    const keep = (g: WindGrid) => {
      try {
        localStorage.setItem(CACHE_KEY, encodeGrid(g));
      } catch {
        /* cache plein : tant pis */
      }
      return (current = g);
    };
    // 1. la copie du serveur, la même pour tous
    let server: WindGrid | null = null;
    try {
      server = await withTimeout(20000, (sig) => fetchServer(base, sig));
      if (Date.now() - server.meta.fetched < SERVER_MAX_AGE) return keep(server);
    } catch {
      /* pas de serveur (en local) ou serveur en panne */
    }
    // 2. Open-Meteo directement
    try {
      return keep(await withTimeout(15000, fetchOpenMeteo));
    } catch {
      /* hors ligne ou API indisponible */
    }
    // 3. ce qu'on a de plus récent
    for (const g of [server, cached]) if (g && (!current || g.meta.fetched > current.meta.fetched)) current = g;
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
