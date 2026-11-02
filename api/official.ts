/**
 * Relais des positions officielles de la Route du Rhum (fonction Vercel) : lit la cartographie de la course
 * et sert le dernier pointage des IMOCA en JSON ; avec `?tracks`, leurs trajectoires depuis le départ. Le CDN
 * garde la réponse 10 minutes (15 pour les trajectoires) : la cartographie n'est interrogée qu'une fois par
 * période (et par région du CDN), quel que soit le nombre de joueurs.
 * Runtime edge, comme api/wind : Vercel regroupe le code, imports de src/ compris.
 */
import { fetchOfficial, fetchOfficialTracks } from '../src/net/official';
import { RACE_START_UTC } from './wind';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  try {
    const tracks = new URL(req.url).searchParams.has('tracks');
    const body = tracks ? await fetchOfficialTracks(RACE_START_UTC) : await fetchOfficial();
    const cdn = tracks ? 900 : 600;
    return new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        // navigateur : 5 min ; CDN : 10 à 15 min, puis l'ancienne copie pendant qu'il en cherche une neuve
        'cache-control': 'public, max-age=300',
        'cdn-cache-control': `public, s-maxage=${cdn}, stale-while-revalidate=${2 * cdn}`,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
