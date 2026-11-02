import { describe, expect, it } from 'vitest';
import { RACES } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { Race } from '../src/sim/race';
import { move } from '../src/sim/geo';
import { forecastAlerts } from '../src/sim/alerts';

const def = RACES.find((r) => !r.fleet)!;

describe('alertes prévues pour les notifications', () => {
  it('annonce chaque checkpoint et la fin de route, à l’heure où la course les vivra', () => {
    const race = new Race(def, DEFAULT_SETUP);
    const p = race.player;
    const twd = p.twd || 0;
    const a = move(p.pos[0], p.pos[1], (twd + 140) % 360, 20, 1);
    const b = move(a[0], a[1], (twd + 160) % 360, 20, 1);
    p.checkpoints = [a, b];
    p.auto = true;
    const alerts = forecastAlerts(race, 12).filter((x) => x.kind === 'checkpoint');
    expect(alerts.map((x) => x.title)).toEqual(['Checkpoint 1/2 atteint', 'Dernier checkpoint atteint']);
    // la vraie course passe le dernier checkpoint au même moment (à un pas de simulation près)
    let real = 0;
    race.step(12, (e) => {
      if (e.type === 'boat' && e.boat === p && e.ev === 'checkpoint') real = race.originUTC + race.t * 3600000;
    });
    expect(Math.abs(real - alerts[1].at)).toBeLessThan(15 * 60000);
  });

  it('ne touche pas au vrai bateau', () => {
    const race = new Race(def, DEFAULT_SETUP);
    const p = race.player;
    const before = JSON.stringify({ pos: p.pos, hdg: p.hdg, energy: p.energy, cps: p.checkpoints });
    forecastAlerts(race, 24);
    expect(JSON.stringify({ pos: p.pos, hdg: p.hdg, energy: p.energy, cps: p.checkpoints })).toBe(before);
  });

  it('prévient quand le skipper va être épuisé', () => {
    const race = new Race(def, DEFAULT_SETUP);
    race.player.energy = 30;
    const tired = forecastAlerts(race, 24).find((x) => x.kind === 'tired');
    expect(tired).toBeTruthy();
    expect(tired!.at).toBeGreaterThan(race.originUTC + race.t * 3600000);
  });

  it('prévient quand le bateau finit contre la côte', () => {
    const race = new Race(def, DEFAULT_SETUP);
    const p = race.player;
    // cap plein est depuis le large de Saint-Malo : la Bretagne / le Cotentin arrivent vite
    p.hdg = 120;
    p.lock = 'hdg';
    expect(forecastAlerts(race, 24).some((x) => x.kind === 'land')).toBe(true);
  });
});
