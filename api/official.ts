/**
 * Relais des positions officielles de la Route du Rhum (fonction Vercel) : lit la cartographie de la course
 * et sert le dernier pointage des IMOCA en JSON. Le CDN garde la réponse 10 minutes : la cartographie n'est
 * interrogée qu'une fois par période (et par région du CDN), quel que soit le nombre de joueurs.
 * Runtime edge, comme api/wind : Vercel regroupe le code, imports de src/ compris.
 */
import { fetchOfficial } from '../src/net/official';

export const config = { runtime: 'edge' };

export default async function handler(): Promise<Response> {
  try {
    const feed = await fetchOfficial();
    return new Response(JSON.stringify(feed), {
      headers: {
        'content-type': 'application/json',
        // navigateur : 5 min ; CDN : 10 min, puis l'ancienne copie pendant qu'il en cherche une neuve
        'cache-control': 'public, max-age=300',
        'cdn-cache-control': 'public, s-maxage=600, stale-while-revalidate=1200',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
