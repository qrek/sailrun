import { IMOCA_RHUM_2026 } from '../data/fleet';
import { dist, move, norm360 } from './geo';
import type { Race } from './race';

/**
 * Positions officielles en direct : le relais api/official lit la cartographie de la course
 * (src/net/official.ts) et sert le dernier pointage dans ce format. Relais injoignable : les concurrents
 * restent simulés.
 */
export interface LivePos {
  /** id de la flotte, ou nom du skipper / du bateau tel que publié */
  who: string;
  lat: number;
  lon: number;
  /** cap fond (°) et vitesse fond (nœuds), si publiés */
  cog?: number;
  sog?: number;
  /** horodatage de la position (ms UTC) */
  ts: number;
  boat?: string;
  /** RAC en course, ARV arrivé ; autre chose (abandon, non-partant…) : hors course */
  status?: string;
  rank?: number;
  /** distance à l'arrivée (milles) */
  dtf?: number;
}

export interface LiveFeed {
  at: number;
  positions: LivePos[];
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Retrouve l'id de flotte d'une position publiée (id, nom complet, nom de famille ou nom du bateau). */
export function matchFleet(who: string): string | null {
  const w = norm(who);
  for (const f of IMOCA_RHUM_2026) {
    if (w === f.id || w === norm(f.skipper) || w === norm(f.boat)) return f.id;
  }
  for (const f of IMOCA_RHUM_2026) {
    const last = norm(f.skipper.split(' ').slice(1).join(' '));
    if (last.length > 2 && w.includes(last)) return f.id;
  }
  return null;
}

export const LIVE_URL: string = import.meta.env?.VITE_LIVE_URL || '/api/official';

export async function fetchLive(url = LIVE_URL): Promise<LiveFeed | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as LiveFeed;
    return Array.isArray(j.positions) ? j : null;
  } catch {
    return null;
  }
}

/**
 * Recale les concurrents sur leur position officielle, avancée jusqu'à `now` à leur cap et à leur vitesse
 * (2 h au plus). Entre deux pointages, la simulation les fait avancer avec le vent réel. Un pointage complet
 * fait aussi la liste : hors course (abandon, non-partant) on quitte la flotte, un engagé absent la rejoint.
 * Ne sert qu'en temps réel, quand l'horloge de course suit la vraie heure. Retourne le nombre de bateaux recalés.
 */
export function applyLive(race: Race, feed: LiveFeed, now = Date.now()): number {
  const fleet = race.def.fleet ?? [];
  const seen = new Set<string>();
  let n = 0;
  for (const p of feed.positions) {
    const id = matchFleet(p.who);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const status = p.status ?? 'RAC';
    let b = race.boats.find((x) => x.fleetId === id);
    if (status !== 'RAC' && status !== 'ARV') {
      if (b) race.removeBoat(b);
      continue;
    }
    if (!b) {
      const f = fleet.find((x) => x.id === id);
      if (!f) continue;
      b = race.addFleetBoat(f);
    }
    if (b.finished !== null) continue;
    const late = Math.max(0, Math.min(2, (now - p.ts) / 3_600_000));
    const pos = p.cog !== undefined && p.sog !== undefined && status === 'RAC' ? move(p.lon, p.lat, p.cog, p.sog, late) : ([p.lon, p.lat] as [number, number]);
    // un saut : la trace simulée jusque-là ne veut plus rien dire
    if (dist(b.pos, pos) > 5) b.trail = [];
    b.pos = pos;
    if (p.cog !== undefined) b.hdg = norm360(p.cog);
    if (p.sog !== undefined) b.spd = p.sog;
    b.decide = 0;
    if (status === 'ARV') b.finished = race.t;
    n++;
  }
  // pointage complet : ceux qui n'y figurent pas ne sont pas en course
  if (seen.size >= fleet.length / 2) {
    for (const b of race.boats.filter((x) => x.fleetId && !seen.has(x.fleetId))) race.removeBoat(b);
  }
  return n;
}
