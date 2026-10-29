import { describe, expect, it } from 'vitest';
import { RACES } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { Race } from '../src/sim/race';
import { CP_CLOSE, checkpointHeading } from '../src/sim/boat';
import { dist, move, norm180 } from '../src/sim/geo';

describe('checkpoints du joueur', () => {
  it('cap droit sur le point, ou au plus près quand il est face au vent', () => {
    // vent du nord (twd 0) : un point plein sud se vise droit, un point plein nord se serre à 42°
    expect(Math.round(checkpointHeading([0, 40], [0, 39], 0))).toBe(180);
    const h = checkpointHeading([0, 40], [0.05, 41], 0);
    expect(Math.abs(norm180(0 - h))).toBeCloseTo(CP_CLOSE, 5);
  });

  it('le pilote passe les checkpoints dans l’ordre, puis garde son cap', () => {
    const def = RACES.find((r) => !r.fleet)!;
    const race = new Race(def, DEFAULT_SETUP);
    const p = race.player;
    // deux points sous le vent du bateau, à 20 et 40 milles
    const twd = p.twd || 0;
    const a = move(p.pos[0], p.pos[1], (twd + 140) % 360, 20, 1);
    const b = move(a[0], a[1], (twd + 160) % 360, 20, 1);
    p.checkpoints = [a, b];
    p.auto = true;
    let passed = 0;
    race.step(12, (e) => {
      if (e.type === 'boat' && e.boat === p && e.ev === 'checkpoint') passed++;
    });
    expect(passed).toBe(2);
    expect(p.checkpoints.length).toBe(0);
    expect(p.auto).toBe(false);
    expect(dist(p.pos, b)).toBeGreaterThan(0);
  });

  it('sans checkpoint, le joueur garde son cap (aucune route calculée)', () => {
    const def = RACES.find((r) => !r.fleet)!;
    const race = new Race(def, DEFAULT_SETUP);
    const p = race.player;
    p.hdg = 200;
    race.step(2, () => {});
    expect(p.hdg).toBe(200);
    expect(p.auto).toBe(false);
  });
});
