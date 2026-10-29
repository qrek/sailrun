/**
 * Instantané des prévisions GFS embarqué dans le jeu (repli quand Open-Meteo est injoignable).
 *   npm run wind                 -> télécharge les prévisions du jour
 *   npm run wind -- raw.json     -> convertit une réponse Open-Meteo déjà téléchargée
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GRID, encodeGrid, gridFromOpenMeteo } from '../src/sim/gfsWind';

async function main() {
  const file = process.argv[2];
  let points: unknown[];
  if (file) {
    points = JSON.parse(readFileSync(file, 'utf8'));
  } else {
    const pts: [number, number][] = [];
    for (let j = 0; j < GRID.nlat; j++) for (let i = 0; i < GRID.nlon; i++) pts.push([GRID.lat0 + j * GRID.dlat, GRID.lon0 + i * GRID.dlon]);
    points = [];
    for (const part of [pts]) {
      const url = `https://api.open-meteo.com/v1/gfs?latitude=${part.map((p) => p[0]).join(',')}&longitude=${part.map((p) => p[1]).join(',')}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=14&temporal_resolution=hourly_3&timezone=GMT`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      points.push(...((await r.json()) as unknown[]));
    }
  }
  const g = gridFromOpenMeteo(points as never, Date.now(), 'snapshot');
  writeFileSync('public/wind/gfs-snapshot.json', encodeGrid(g));
  console.log(`GFS du ${new Date(g.meta.t0).toISOString()} · ${g.meta.nt} pas de 3 h -> public/wind/gfs-snapshot.json`);
}
main();
