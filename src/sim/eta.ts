import type { RaceDef } from '../data/races';
import { DEFAULT_SETUP, RaceMix, Setup, perfOf } from '../data/garage';
import { startSleep, stepBoat } from './boat';
import { smooth } from './geo';
import { makeBoat } from './race';
import { bestHeading, decideEvery, nextTarget } from './router';
import { GridWind, windGrid } from './gfsWind';
import { soloTime } from './solo';
import { WindSource } from './wind';

/** Vent de la course : GFS si chargé (et si la course le veut), sinon rien. */
export function raceWind(def: RaceDef): GridWind | null {
  const g = def.realWind ? windGrid() : null;
  return g ? new GridWind(g, def.startUTC, def.windPhase) : null;
}

const perfFor = (def: RaceDef, s: Setup) => ({ ...perfOf(s), imoca: def.fleet ? 1 : 0 });

let cache: { key: string; route: number; base: number; times: Map<string, number>; mix: RaceMix | null } | null = null;

/**
 * Temps de course estimé (h) d'une préparation sur la météo réelle, sans aléas, par la meilleure
 * option de route pour un bateau de série. Retourne aussi l'écart avec la configuration de série.
 */
export function realEta(def: RaceDef, s: Setup, wind: WindSource & { meta?: { fetched: number } }): { h: number; delta: number } {
  const key = `${def.id}:${(wind as GridWind).meta?.fetched ?? 0}`;
  if (!cache || cache.key !== key) {
    const base = perfFor(def, DEFAULT_SETUP);
    let best = 0;
    let bestT = Infinity;
    def.routes.forEach((_, i) => {
      const t = soloTime(def, base, i, null, 24 * 25, wind);
      if (t < bestT) {
        bestT = t;
        best = i;
      }
    });
    cache = { key, route: best, base: bestT, times: new Map(), mix: null };
  }
  const k = JSON.stringify(s.parts) + s.skipper + JSON.stringify(s.tune ?? {});
  let h = cache.times.get(k);
  if (h === undefined) {
    h = soloTime(def, perfFor(def, s), cache.route, null, 24 * 25, wind);
    cache.times.set(k, h);
  }
  return { h, delta: h - cache.base };
}

/**
 * Profil de la course sur la vraie météo : part du temps au près, au travers, au portant,
 * dans le petit temps et dans la brise, pour un bateau de série sur la meilleure route.
 */
export function raceMix(def: RaceDef, wind: WindSource & { meta?: { fetched: number } }): RaceMix {
  realEta(def, DEFAULT_SETUP, wind);
  if (cache!.mix) return cache!.mix;
  const perf = perfFor(def, DEFAULT_SETUP);
  const b = makeBoat({ id: 'mix', name: 'mix', color: '#fff', perf, route: def.routes[cache!.route], pos: [def.start[0], def.start[1]], hdg: def.startHeading });
  const m: RaceMix = { up: 0, reach: 0, down: 0, light: 0, heavy: 0 };
  let n = 0;
  const dt = 0.25;
  for (let t = 0; t < 24 * 25 && b.finished === null; t += dt) {
    if (b.energy < 35) startSleep(b);
    b.decide -= dt;
    if (b.decide <= 0) {
      b.hdg = bestHeading(b.pos, t, nextTarget(b), b.perf, wind);
      b.decide = decideEvery(b);
    }
    stepBoat(b, { t, dt, wind, rng: null, finish: def.finish, finishR: def.finishR, marks: def.marks });
    const a = Math.abs(b.twa);
    const up = 1 - smooth(60, 85, a);
    const down = smooth(105, 135, a);
    m.up += up;
    m.down += down;
    m.reach += Math.max(0, 1 - up - down);
    m.light += 1 - smooth(8, 13, b.tws);
    m.heavy += smooth(18, 26, b.tws);
    n++;
  }
  for (const k of Object.keys(m) as (keyof RaceMix)[]) m[k] /= Math.max(1, n);
  cache!.mix = m;
  return m;
}
