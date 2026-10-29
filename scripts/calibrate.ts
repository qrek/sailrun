/**
 * Calibre le garage : simule chaque combinaison de bateau sur chaque course
 * et enregistre le temps de course et la meilleure route dans src/data/calibration.json.
 * À relancer après toute modification des pièces, des courses ou du modèle de vent :
 *   npm run calibrate
 */
import { writeFileSync } from 'node:fs';
import { RACES } from '../src/data/races';
import { ALL_SETUPS, MASS_LIMIT, massOf, setupKey } from '../src/data/garage';
import { soloTime } from '../src/sim/solo';

const out: Record<string, Record<string, { h: number; r: number }>> = {};
const t0 = Date.now();
for (const def of RACES) {
  const table: Record<string, { h: number; r: number }> = {};
  for (const s of ALL_SETUPS) {
    if (massOf(s) > MASS_LIMIT) continue;
    let best = 0;
    let bestT = Infinity;
    def.routes.forEach((_, i) => {
      const t = soloTime(def, s, i, null);
      if (t < bestT) {
        bestT = t;
        best = i;
      }
    });
    const seeded = [11, 23].map((seed) => soloTime(def, s, best, seed));
    const h = (bestT + seeded[0] + seeded[1]) / 3;
    table[setupKey(s)] = { h: Math.round(h * 100) / 100, r: best };
  }
  out[def.id] = table;
  const hs = Object.values(table).map((x) => x.h);
  console.log(`${def.name}: ${Object.keys(table).length} bateaux, de ${(Math.min(...hs) / 24).toFixed(2)} à ${(Math.max(...hs) / 24).toFixed(2)} jours`);
}
writeFileSync(new URL('../src/data/calibration.json', import.meta.url), JSON.stringify(out));
console.log(`Terminé en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
