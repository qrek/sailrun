import type { RaceDef } from '../data/races';
import { Setup, perfOf } from '../data/garage';
import { startRepair, startSleep, stepBoat } from './boat';
import { Rng } from './geo';
import { makeBoat } from './race';
import { bestHeading, decideEvery, nextTarget } from './router';
import { SyntheticWind, WindSource } from './wind';
import { Perf } from './boat';

/**
 * Course en solo d'un bateau piloté proprement (pilote auto, sommeil et réparations gérés).
 * Sert à calibrer le garage et à choisir la meilleure route. Retourne la durée en heures.
 */
export function soloTime(def: RaceDef, setup: Setup | Perf, routeIdx: number, seed: number | null, maxHours = 24 * 25, windSrc?: WindSource): number {
  const wind = windSrc ?? new SyntheticWind(def.windPhase);
  const rng = seed === null ? null : new Rng(seed);
  const perf = 'parts' in setup ? perfOf(setup) : setup;
  const b = makeBoat({ id: 'solo', name: 'solo', color: '#fff', perf, route: def.routes[routeIdx], pos: [def.start[0], def.start[1]], hdg: def.startHeading });
  const dt = 0.1;
  let t = 0;
  while (t < maxHours) {
    if (b.avarie && b.repair <= 0) startRepair(b);
    if (b.energy < 35) startSleep(b);
    b.decide -= dt;
    if (b.decide <= 0) {
      b.hdg = bestHeading(b.pos, t, nextTarget(b), b.perf, wind);
      b.decide = decideEvery(b);
    }
    stepBoat(b, { t, dt, wind, rng, finish: def.finish, finishR: def.finishR, marks: def.marks });
    t += dt;
    if (b.finished !== null) return b.finished;
  }
  return maxHours;
}

/** Index de la route la plus rapide pour ce bateau (sans aléas). */
export function bestRouteIndex(def: RaceDef, setup: Setup | Perf, wind?: WindSource): number {
  let best = 0;
  let bestT = Infinity;
  def.routes.forEach((_, i) => {
    const t = soloTime(def, setup, i, null, 24 * 25, wind);
    if (t < bestT) {
      bestT = t;
      best = i;
    }
  });
  return best;
}

/** Temps de course (h) de chaque option de route, sans aléas. */
export function routeTimes(def: RaceDef, perf: Perf, wind: WindSource): number[] {
  return def.routes.map((_, i) => soloTime(def, perf, i, null, 24 * 25, wind));
}
