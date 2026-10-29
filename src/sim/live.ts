import { IMOCA_RHUM_2026 } from '../data/fleet';
import type { Race } from './race';

/**
 * Positions officielles en direct. La source (cartographie de la course) n'est publiée qu'au départ :
 * l'adaptateur attend un JSON normalisé, servi par un petit relais (voir README, « Positions en direct »).
 * Sans relais configuré (VITE_LIVE_URL), les concurrents restent simulés.
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

export const LIVE_URL: string | undefined = import.meta.env?.VITE_LIVE_URL || undefined;

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
 * Recale les concurrents sur leur position officielle. Entre deux pointages, la simulation les fait
 * avancer avec le vent réel. Ne sert qu'en temps réel, quand l'horloge de course suit la vraie heure.
 * Retourne le nombre de bateaux recalés.
 */
export function applyLive(race: Race, feed: LiveFeed): number {
  let n = 0;
  for (const p of feed.positions) {
    const id = matchFleet(p.who);
    if (!id) continue;
    const b = race.boats.find((x) => x.fleetId === id);
    if (!b || b.finished !== null) continue;
    b.pos = [p.lon, p.lat];
    if (p.cog !== undefined) b.hdg = ((p.cog % 360) + 360) % 360;
    if (p.sog !== undefined) b.spd = p.sog;
    b.decide = 0;
    n++;
  }
  return n;
}
