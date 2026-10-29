import { it, expect } from 'vitest';
import { RACES } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { Race } from '../src/sim/race';
import { startRepair } from '../src/sim/boat';
it('beaucoup de graines : personne ne reste bloqué', () => {
  const fails: string[] = [];
  for (const def of RACES) for (let k = 0; k < (def.fleet ? 4 : 25); k++) {
    const race = new Race(def, DEFAULT_SETUP);
    race.player.auto = true;
    race.player.isPlayer = false; // le joueur n’a plus de route calculée : ici il navigue comme un concurrent
    race.step(24 * 30, (e) => { if (e.type === 'boat' && e.boat.isPlayer && e.ev === 'avarie') { startRepair(e.boat); } if (e.type === 'boat' && e.boat.isPlayer && e.ev === 'repaired') e.boat.auto = true; });
    for (const b of race.boats) if (b.finished === null) fails.push(`${def.id} ${b.name} ${b.pos.map(x => x.toFixed(2))}`);
  }
  expect(fails).toEqual([]);
}, 120000);
