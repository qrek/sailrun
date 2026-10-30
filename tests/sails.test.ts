import { BASE_PERF, sailSwitch } from '../src/sim/boat';
import { describe, expect, it } from 'vitest';
import { RACES } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { Race } from '../src/sim/race';
import { sailShow } from '../src/render/sailAnim';
import { BoatEvent, SAIL_STEPS, SailId, changeSail, sailRemaining, sailStep, speedFactors, startSleep, targetSail, workingSail } from '../src/sim/boat';

const MIN = 1 / 60;

/** Une course d'entraînement, voile auto coupée, avec le foc à poste. */
function setup() {
  const race = new Race(RACES.find((r) => !r.fleet)!, DEFAULT_SETUP);
  const p = race.player;
  p.autoSail = false;
  p.sail = 'foc';
  p.energy = 100;
  const events: BoatEvent[] = [];
  const run = (minutes: number) => {
    for (let i = 0; i < Math.round(minutes); i++) race.step(MIN, (e) => e.type === 'boat' && e.boat === p && events.push(e.ev));
  };
  return { race, p, run, events };
}

describe('changement de voile en 4 étapes', () => {
  it('passe par les 4 étapes dans l’ordre, en 15 minutes', () => {
    const { p, run, events } = setup();
    expect(changeSail(p, 'spi')).toBe('start');
    const seen: number[] = [];
    for (let m = 0; m < 15; m++) {
      const s = sailStep(p);
      if (seen[seen.length - 1] !== s) seen.push(s);
      run(1);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(p.sail).toBe('spi');
    expect(p.sailTo).toBeNull();
    expect(sailStep(p)).toBe(-1);
    expect(events).toContain('sailset');
  });

  it('l’ancienne voile travaille jusqu’au déroulé, puis la nouvelle', () => {
    const { p, run } = setup();
    changeSail(p, 'code0');
    run(10);
    expect(workingSail(p)).toBe('foc');
    run(2);
    expect(workingSail(p)).toBe('code0');
    expect(targetSail(p)).toBe('code0');
  });

  it('chaque étape a son propre malus de vitesse', () => {
    const { p, run } = setup();
    changeSail(p, 'spi');
    for (const [minute, step] of [[2, 0], [8, 1], [12, 2], [14, 3]] as const) {
      run(minute - Math.round((p.sailT ?? 0) * 60));
      expect(sailStep(p)).toBe(step);
      const f = speedFactors(p).find((x) => x.label.startsWith('Changement de voile'));
      expect(f?.f).toBe(SAIL_STEPS[step].f);
    }
  });

  it('annuler au bout de 5 minutes prend 5 minutes, et on garde l’ancienne voile', () => {
    const { p, run, events } = setup();
    changeSail(p, 'spi');
    run(5);
    expect(changeSail(p, 'foc')).toBe('cancel');
    expect(targetSail(p)).toBe('foc');
    expect(sailRemaining(p)).toBeCloseTo(5 * MIN, 6);
    run(4);
    expect(p.sailTo).toBe('spi');
    run(1);
    expect(p.sailTo).toBeNull();
    expect(p.sail).toBe('foc');
    expect(events).toContain('sailkept');
  });

  it('reprendre pendant une annulation repart en avant', () => {
    const { p, run } = setup();
    changeSail(p, 'code0');
    run(8);
    changeSail(p, 'foc');
    run(3);
    expect(changeSail(p, 'code0')).toBe('resume');
    run(10);
    expect(p.sail).toBe('code0');
    expect(p.sailTo).toBeNull();
  });

  it('la troisième voile est refusée tant qu’un changement est en cours', () => {
    const { p } = setup();
    changeSail(p, 'spi');
    expect(changeSail(p, 'code0')).toBeNull();
    expect(changeSail(p, 'spi')).toBeNull();
    expect(p.sailTo).toBe('spi');
  });

  it('pas de sieste pendant un changement', () => {
    const { p } = setup();
    changeSail(p, 'spi');
    expect(startSleep(p)).toBe(false);
  });

  it('un skipper épuisé met 1,5 fois plus de temps', () => {
    const { p, run } = setup();
    p.energy = 20;
    changeSail(p, 'spi' as SailId);
    run(20);
    expect(p.sailTo).toBe('spi');
    run(3);
    expect(p.sail).toBe('spi');
  });
});

describe('ce qu’on voit des voiles en 3D', () => {
  const at = (min: number) => sailShow({ sail: 'foc', sailTo: 'spi', sailT: min * MIN, sailDur: 0.25 });
  it('hors changement, seule la voile à poste est gonflée', () => {
    const s = sailShow({ sail: 'code0', sailTo: null, sailT: 0, sailDur: 0.25 });
    expect(Object.keys(s)).toEqual(['code0']);
    expect(s.code0?.open).toBe(1);
  });
  it('préparation, hissage, déroulé, enroulement : chaque étape se voit', () => {
    expect(at(3).spi).toMatchObject({ open: 0, hoist: 0 });
    expect(at(3).spi!.deck).toBeGreaterThan(0);
    expect(at(8).spi!.hoist).toBeGreaterThan(0.2);
    expect(at(8).spi!.hoist).toBeLessThan(0.8);
    expect(at(8).foc!.open).toBe(1);
    expect(at(12).spi!.open).toBeGreaterThan(0.2);
    expect(at(12).foc!.open).toBe(1);
    expect(at(13.5).foc!.open).toBeLessThan(1);
    expect(at(14.9).foc!.hoist).toBeLessThan(0.1);
    expect(at(14.9).spi!.open).toBe(1);
  });
  it('une annulation repasse par les mêmes images, à l’envers', () => {
    const back = sailShow({ sail: 'foc', sailTo: 'spi', sailT: 8 * MIN, sailDur: 0.25 });
    expect(back).toEqual(at(8));
  });
});

describe('rentabilité d’un changement de voile', () => {
  it('au portant, passer du foc au spi va plus vite et se rattrape vite ; l’inverse est plus lent', () => {
    const b = { sail: 'foc' as const, perf: { ...BASE_PERF, imoca: 1 }, energy: 80 };
    const up = sailSwitch(b, 'spi', 150, 16);
    expect(up.vTo).toBeGreaterThan(up.vNow);
    expect(up.lossNm).toBeGreaterThan(0);
    expect(up.breakEven).not.toBeNull();
    expect(up.breakEven!).toBeLessThan(2);
    const down = sailSwitch({ ...b, sail: 'spi' }, 'foc', 150, 16);
    expect(down.breakEven).toBeNull();
  });
});
