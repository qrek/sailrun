import snapshot from '../public/wind/gfs-snapshot.json?raw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RHUM } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { decodeGrid, setWindGrid } from '../src/sim/gfsWind';
import { Race } from '../src/sim/race';
import { isoRoute } from '../src/sim/isochrone';
import { activeOrder } from '../src/sim/boat';
import { isLand } from '../src/sim/geo';

const grid = decodeGrid(snapshot);
beforeAll(() => setWindGrid(grid));
afterAll(() => setWindGrid(null));

describe('routage par isochrones', () => {
  it('trouve une route sur l’eau qui rapproche de l’arrivée, et le pilote suit les ordres', { timeout: 60000 }, async () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    race.step(3, () => {});
    const p = race.player;
    const course = { marks: RHUM.marks ?? [], finish: RHUM.finish, finishR: RHUM.finishR };
    for (const h of [6, 24, 48]) {
      const t0 = performance.now();
      const plan = await isoRoute(p.pos, race.t, h, race.wind, p.perf, p.mark, course, p.hdg);
      const ms = performance.now() - t0;
      console.log(`${h} h : ${plan.steps.length} pas, ${plan.orders.length} ordres, ${Math.round(plan.remain0 - plan.remain1)} NM gagnés, ${Math.round(ms)} ms`);
      expect(plan.steps.length).toBeGreaterThan(2);
      expect(plan.remain1).toBeLessThan(plan.remain0);
      for (const s of plan.steps) expect(isLand(s.pos[0], s.pos[1])).toBe(false);
      expect(plan.orders.length).toBeGreaterThan(0);
    }
    const plan = await isoRoute(p.pos, race.t, 24, race.wind, p.perf, p.mark, course, p.hdg);
    p.auto = true;
    p.program = plan.orders.map((o) => ({ t: o.t, hdg: o.hdg }));
    p.programEnd = race.t + plan.hours;
    const rem0 = race.remaining(p);
    race.step(12, () => {});
    expect(activeOrder(p, race.t)).not.toBeNull();
    expect(race.remaining(p)).toBeLessThan(rem0);
  });
});
