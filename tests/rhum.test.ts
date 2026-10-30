import snapshot from '../public/wind/gfs-snapshot.json?raw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RHUM } from '../src/data/races';
import { DEFAULT_SETUP, SLOTS, Setup } from '../src/data/garage';
import { IMOCA_RHUM_2026, genPerf } from '../src/data/fleet';
import { GridWind, decodeGrid, setWindGrid } from '../src/sim/gfsWind';
import { Race } from '../src/sim/race';
import { realEta } from '../src/sim/eta';
import { routeTimes } from '../src/sim/solo';
import { applyLive, matchFleet } from '../src/sim/live';
import { startRepair } from '../src/sim/boat';

const grid = decodeGrid(snapshot);
beforeAll(() => setWindGrid(grid));
afterAll(() => setWindGrid(null));

describe('Route du Rhum sur la vraie météo', () => {
  it('le vent GFS est lu et raisonnable', () => {
    const w = new GridWind(grid, RHUM.startUTC);
    expect(w.horizon()).toBeGreaterThan(200);
    for (const [lon, lat] of [[-2, 48.8], [-30, 30], [-55, 17]] as const) {
      const [u, v] = w.at(lon, lat, 24);
      const s = Math.hypot(u, v);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(70);
    }
  });

  it('toute la flotte IMOCA prend le départ, passe les marques et arrive', { timeout: 120000 }, () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    expect(race.realWind).toBe(true);
    expect(race.boats.length).toBe(IMOCA_RHUM_2026.length + 1);
    race.player.isPlayer = false; // le joueur n’a plus de route calculée : ici il navigue comme un concurrent
    race.step(24 * 30, (e) => {
      if (e.type === 'boat' && e.boat.isPlayer && e.ev === 'avarie') startRepair(e.boat);
      if (e.type === 'boat' && e.boat.isPlayer && e.ev === 'repaired') e.boat.auto = true;
    });
    const late = race.boats.filter((b) => b.finished === null).map((b) => `${b.name} ${b.pos.map((x) => x.toFixed(2))}`);
    expect(late).toEqual([]);
    for (const b of race.boats) expect(b.mark).toBe(RHUM.marks!.length);
    // un IMOCA neuf bien mené met entre 10 et 22 jours
    const days = race.boats.map((b) => b.finished! / 24);
    expect(Math.min(...days)).toBeGreaterThan(9);
    expect(Math.min(...days)).toBeLessThan(22);
  });

  it('à route égale, un IMOCA à dérives droites arrive après un foiler récent', { timeout: 60000 }, () => {
    // pas sur la flotte entière : selon la météo, les options de route s'écartent de plusieurs jours,
    // plus que les générations de bateaux, et chaque bot tire sa route au hasard
    const w = new GridWind(grid, RHUM.startUTC);
    const dagger = routeTimes(RHUM, genPerf('dagger'), w);
    const recent = routeTimes(RHUM, genPerf('new'), w);
    dagger.forEach((t, i) => expect(t, `route ${i}`).toBeGreaterThan(recent[i]));
  });

  it('une option de préparation ne change le temps de course que de quelques dixièmes de pour-cent', { timeout: 60000 }, () => {
    const w = new GridWind(grid, RHUM.startUTC);
    const base = realEta(RHUM, DEFAULT_SETUP, w);
    expect(base.delta).toBe(0);
    for (const sl of SLOTS) for (const p of sl.parts) {
      const t: Setup = { ...DEFAULT_SETUP, parts: { ...DEFAULT_SETUP.parts, [sl.id]: p.id } };
      const e = realEta(RHUM, t, w);
      expect(Math.abs(e.delta) / base.h, `${sl.id}.${p.id}`).toBeLessThan(0.025);
    }
  });
});

describe('positions en direct', () => {
  it('reconnaît les skippers et les bateaux sous plusieurs écritures', () => {
    expect(matchFleet('Jérémie BEYOU')).toBe('beyou');
    expect(matchFleet('CHARAL')).toBe('beyou');
    expect(matchFleet('Violette Dorange')).toBe('dorange');
    expect(matchFleet('Nicolas d’Estais')).toBe('destais');
    expect(matchFleet('Personne Inconnue')).toBeNull();
  });
  it('recale les concurrents sur leur position officielle', () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    const n = applyLive(race, { at: Date.now(), positions: [{ who: 'Sam Goodchild', lat: 47.1, lon: -6.2, cog: 230, sog: 18, ts: Date.now() }] });
    expect(n).toBe(1);
    const b = race.boats.find((x) => x.fleetId === 'goodchild')!;
    expect(b.pos).toEqual([-6.2, 47.1]);
    expect(b.hdg).toBe(230);
  });
});
