/**
 * Relais des positions officielles de la Route du Rhum (fonction Vercel) : lit la cartographie de la course
 * et sert le dernier pointage des IMOCA en JSON. Mis en cache 10 minutes par le CDN : la cartographie n'est
 * interrogée qu'une fois par période, quel que soit le nombre de joueurs.
 */

import { fetchOfficial } from '../src/net/official';

export async function GET(): Promise<Response> {
  try {
    const feed = await fetchOfficial();
    return Response.json(feed, { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' } });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502, headers: { 'Cache-Control': 'public, s-maxage=60' } });
  }
}
