/**
 * Instantané des prévisions GFS embarqué dans le jeu (repli quand Open-Meteo est injoignable).
 *   npm run wind                 -> télécharge les prévisions du jour
 *   npm run wind -- raw.json     -> convertit une réponse Open-Meteo déjà téléchargée
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { encodeGrid, gridFromOpenMeteo, gridPoints, openMeteoUrl } from '../src/sim/gfsWind';

async function main() {
  const file = process.argv[2];
  let points: unknown[];
  if (file) {
    points = JSON.parse(readFileSync(file, 'utf8'));
  } else {
    points = [];
    for (const part of [gridPoints()]) {
      const r = await fetch(openMeteoUrl(part));
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      points.push(...((await r.json()) as unknown[]));
    }
  }
  const g = gridFromOpenMeteo(points as never, Date.now(), 'snapshot');
  writeFileSync('public/wind/gfs-snapshot.json', encodeGrid(g));
  console.log(`GFS du ${new Date(g.meta.t0).toISOString()} · ${g.meta.nt} pas de 3 h -> public/wind/gfs-snapshot.json`);
}
main();
