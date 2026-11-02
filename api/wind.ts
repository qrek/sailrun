/**
 * Météo partagée : cette fonction demande la grille GFS à Open-Meteo et la renvoie au format du jeu.
 * Le CDN de Vercel garde la réponse une heure : Open-Meteo ne voit qu'une requête par heure (et par région
 * du CDN) au lieu d'une par joueur, et tous les joueurs naviguent dans le même vent.
 * Si Open-Meteo refuse, on répond 503 sans cache : le jeu tente alors Open-Meteo lui-même, puis son cache.
 */
import { encodeGrid, gridFromOpenMeteo, gridPoints, openMeteoUrl, OMPoint } from '../src/sim/gfsSource';

export const config = { runtime: 'edge' };

/** Départ de la Route du Rhum 2026 : le même que RHUM.startUTC (vérifié par tests/windServer.test.ts). */
export const RACE_START_UTC = Date.UTC(2026, 10, 1, 12, 2);

export default async function handler(): Promise<Response> {
  try {
    const r = await fetch(openMeteoUrl(gridPoints(), RACE_START_UTC), { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const g = gridFromOpenMeteo((await r.json()) as OMPoint[], Date.now(), 'server');
    return new Response(encodeGrid(g), {
      headers: {
        'content-type': 'application/json',
        // navigateur : 10 min ; CDN : 1 h, puis on sert l'ancienne copie pendant qu'il en cherche une neuve
        'cache-control': 'public, max-age=600',
        'cdn-cache-control': 'public, s-maxage=3600, stale-while-revalidate=21600',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
