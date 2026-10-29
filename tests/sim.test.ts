import { describe, expect, it } from 'vitest';
import { RACES } from '../src/data/races';
import { DEFAULT_SETUP, MASS_LIMIT, SLOTS, Setup, fitStars, massOf, perfDeltas, statsOf } from '../src/data/garage';
import { isLand } from '../src/sim/geo';
import { Race } from '../src/sim/race';
import { bestSail, projectBoat, startRepair } from '../src/sim/boat';
import { planRoute } from '../src/sim/router';

describe('géographie', () => {
  it('les départs, arrivées et points de passage sont en mer', () => {
    for (const r of RACES) {
      expect(isLand(...r.start), `${r.id} départ`).toBe(false);
      expect(isLand(...r.finish), `${r.id} arrivée`).toBe(false);
      for (const route of r.routes) for (const w of route) expect(isLand(...w), `${r.id} ${w}`).toBe(false);
    }
  });
  it('les terres sont bien des terres', () => {
    expect(isLand(2.35, 48.85)).toBe(true); // Paris
    expect(isLand(-16.6, 28.3)).toBe(true); // Tenerife
    expect(isLand(-61.0, 14.65)).toBe(true); // Martinique
  });
});

describe('garage', () => {
  it('la config par défaut respecte la jauge', () => {
    expect(massOf(DEFAULT_SETUP)).toBeLessThanOrEqual(MASS_LIMIT);
  });
  it('chaque option est un petit compromis (jamais plus de 2 % sur un domaine)', () => {
    for (const sl of SLOTS) for (const p of sl.parts) {
      const t: Setup = { ...DEFAULT_SETUP, parts: { ...DEFAULT_SETUP.parts, [sl.id]: p.id } };
      expect(massOf(t)).toBeLessThanOrEqual(MASS_LIMIT);
      for (const d of perfDeltas(t)) expect(Math.abs(d.v), `${sl.id}.${p.id} ${d.label}`).toBeLessThanOrEqual(2);
    }
  });
  it('les notes et les étoiles restent dans leurs bornes', () => {
    const s = statsOf(DEFAULT_SETUP);
    for (const v of Object.values(s)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(10);
    }
    for (const r of RACES) {
      const st = fitStars(DEFAULT_SETUP, r);
      expect(st).toBeGreaterThanOrEqual(1);
      expect(st).toBeLessThanOrEqual(5);
    }
  });
});

describe('courses complètes', () => {
  for (const def of RACES) {
    it(`${def.name} : tous les bateaux arrivent`, { timeout: 60000 }, () => {
      const race = new Race(def, DEFAULT_SETUP);
      race.player.auto = true;
      race.player.isPlayer = false; // le joueur n’a plus de route calculée : ici il navigue comme un concurrent
      let landHits = 0;
      race.step(24 * 30, (e) => {
        if (e.type === 'boat' && e.ev === 'land') landHits++;
        if (e.type === 'boat' && e.boat.isPlayer && e.ev === 'avarie') startRepair(e.boat);
        if (e.type === 'boat' && e.boat.isPlayer && e.ev === 'repaired') e.boat.auto = true;
      });
      const days = race.boats.map((b) => (b.finished ?? Infinity) / 24);
      expect(race.allFinished, `arrivées ${days.map((d) => d.toFixed(1)).join(' ')}`).toBe(true);
      expect(Math.max(...days)).toBeLessThan(def.marks ? 26 : 20);
      if (def.marks) for (const b of race.boats) expect(b.mark, b.name).toBe(def.marks.length);
      expect(landHits).toBeLessThan(200);
    });
    it(`${def.name} : la route conseillée mène à l'arrivée`, { timeout: 30000 }, () => {
      const race = new Race(def, DEFAULT_SETUP);
      const pts = planRoute(race.player, 0, race.wind, def.finish, def.finishR, 600, def.marks);
      const last = pts[pts.length - 1];
      expect(Math.hypot(last[0] - def.finish[0], last[1] - def.finish[1])).toBeLessThan(1);
    });
  }
});

describe('voiles, barre et projection', () => {
  it('chaque voile est la meilleure dans sa plage d’angles', () => {
    expect(bestSail(50, 15)).toBe('foc');
    expect(bestSail(90, 15)).toBe('code0');
    expect(bestSail(150, 15)).toBe('spi');
  });
  it('la barre à angle constant garde l’angle au vent', () => {
    const race = new Race(RACES[1], DEFAULT_SETUP);
    const p = race.player;
    p.auto = false;
    p.lock = 'twa';
    p.lockTwa = 130;
    race.step(6, () => {});
    expect(Math.abs(p.twa - 130)).toBeLessThan(1);
  });
  it('la projection suit le bateau sans le modifier', () => {
    const race = new Race(RACES[0], DEFAULT_SETUP);
    const p = race.player;
    p.auto = false;
    const before = [...p.pos];
    const pr = projectBoat(p, race.t, race.wind, 24, race.def.finish, race.def.finishR);
    expect(pr.pts.length).toBeGreaterThan(40);
    expect(p.pos).toEqual(before);
    const again = projectBoat(p, race.t, race.wind, 24, race.def.finish, race.def.finishR);
    expect(again.pts[40]).toEqual(pr.pts[40]);
  });
});
