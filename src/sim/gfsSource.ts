/**
 * Format de la grille de vent GFS et requête Open-Meteo, sans aucune dépendance : partagé par le jeu
 * (src/sim/gfsWind.ts), le script d'instantané et la fonction serveur qui sert la météo (api/wind.ts).
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
  /** live : Open-Meteo depuis le navigateur ; server : copie partagée du serveur ; snapshot : instantané embarqué */
  source: 'live' | 'server' | 'snapshot';
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
export function openMeteoUrl(pts: [number, number][], raceStartUTC: number, now = Date.now()): string {
  const past = Math.max(0, Math.min(WINDOW_DAYS - AHEAD_DAYS, Math.floor(now / DAY) - Math.floor(raceStartUTC / DAY)));
  return (
    'https://api.open-meteo.com/v1/gfs?latitude=' +
    pts.map((p) => p[0]).join(',') +
    '&longitude=' +
    pts.map((p) => p[1]).join(',') +
    `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&past_days=${past}&forecast_days=${WINDOW_DAYS - past}&temporal_resolution=hourly_3&timezone=GMT`
  );
}

export interface OMPoint {
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
      const d = (dir[k] ?? 0) * (Math.PI / 180);
      // direction d'où vient le vent -> composantes vers où il va
      u[k * plane + idx] = Math.round(-s * Math.sin(d) * 100);
      v[k * plane + idx] = Math.round(-s * Math.cos(d) * 100);
    }
  });
  return { meta: { ...GRID, nt, t0: Date.parse(times[0] + 'Z'), fetched, source }, u, v };
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
