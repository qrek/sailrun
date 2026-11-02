import { describe, expect, it } from 'vitest';
import { RACES } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { Race } from '../src/sim/race';
import { move } from '../src/sim/geo';
import { AwayLog, buildRecap, snapshot } from '../src/sim/recap';
import { fmtAway } from '../src/ui/awayCard';

const def = RACES.find((r) => !r.fleet)!;

describe('récap « Pendant ton absence »', () => {
  it('raconte les checkpoints atteints et la fin de route', () => {
    const race = new Race(def, DEFAULT_SETUP);
    const p = race.player;
    const twd = p.twd || 0;
    const a = move(p.pos[0], p.pos[1], (twd + 140) % 360, 20, 1);
    const b = move(a[0], a[1], (twd + 160) % 360, 20, 1);
    p.checkpoints = [a, b];
    p.auto = true;
    const before = snapshot(race);
    const log = new AwayLog(race);
    race.step(12, log.listen);
    const r = buildRecap(race, before, log);
    expect(r.hours).toBeCloseTo(12, 5);
    expect(r.fleet).toBe(race.boats.length);
    expect(r.rankAfter).toBeGreaterThanOrEqual(1);
    expect(r.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['checkpoint', 'route']));
    expect(r.items.find((i) => i.kind === 'checkpoint')!.text).toBe('2 checkpoints atteints');
  });

  it('places gagnées : qui tu as doublé, qui t’a doublé', () => {
    const race = new Race(def, DEFAULT_SETUP);
    const p = race.player;
    // le joueur commence dernier, très loin derrière
    p.pos = move(def.start[0], def.start[1], 0, 1, 1);
    const order = race.standings();
    const before = { ...snapshot(race), order: [...order.filter((b) => b !== p).map((b) => b.id), p.id] };
    // puis on le téléporte tout près de l'arrivée
    p.pos = move(def.finish[0], def.finish[1], 90, 20, 1);
    const r = buildRecap(race, before, new AwayLog(race));
    expect(r.rankBefore).toBe(race.boats.length);
    expect(r.rankAfter).toBe(1);
    expect(r.passed.length).toBe(race.boats.length - 1);
    expect(r.passedBy).toEqual([]);
    expect(r.gained).toBeGreaterThan(0);
  });

  it('durées lisibles', () => {
    expect(fmtAway(0.5)).toBe('30 min');
    expect(fmtAway(7 + 40 / 60)).toBe('7 h 40');
    expect(fmtAway(3)).toBe('3 h');
    expect(fmtAway(76)).toBe('3 j 4 h');
  });
});
