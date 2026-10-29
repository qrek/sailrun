import { Boat, Perf, boatSpeed, stepBoat } from './boat';
import { D2R, LonLat, bearing, dist, isLand, move, norm180, norm360 } from './geo';
import { WindSource, windFrom } from './wind';
import { hardRadius } from '../data/races';

const LONG = [0.05, 0.1, 0.15, 0.25, 0.4, 0.75, 1.5, 3, 5, 8];
const SHORT = [0.05, 0.1, 0.2, 0.35];

/** Vérifie qu'aucune terre ne se trouve sur les prochaines heures de route. */
export function clearAhead(lon: number, lat: number, hdg: number, spd: number, horizon: number[] = LONG): boolean {
  const s = Math.max(spd, 6);
  for (const h of horizon) {
    const p = move(lon, lat, hdg, s, h);
    if (isLand(p[0], p[1])) return false;
  }
  return true;
}

/** Meilleur cap pour progresser vers `target` (VMG), sans viser une côte ni rester face au vent. */
export function bestHeading(pos: LonLat, t: number, target: LonLat, perf: Perf, wind: WindSource): number {
  const [u, v] = wind.at(pos[0], pos[1], t);
  const tws = Math.hypot(u, v);
  const twd = windFrom(u, v);
  const brg = bearing(pos, target);
  // près d'une marque, on ne regarde pas plus loin que la marque elle-même (sinon la côte voisine
  // bloque l'approche)
  const dT = dist(pos, target);
  const near = (hs: number[]) => {
    const out = hs.filter((h) => h * 14 <= dT + 4);
    return out.length >= 2 ? out : hs.slice(0, 2);
  };
  const pick = (maxOff: number, step: number, horizon0: number[]) => {
    const horizon = near(horizon0);
    let best: number | null = null;
    let bestV = -1e9;
    for (let off = -maxOff; off <= maxOff; off += step) {
      const h = norm360(brg + off);
      const s = boatSpeed(norm180(twd - h), tws, perf);
      if (s < 1) continue;
      if (!clearAhead(pos[0], pos[1], h, s, horizon)) continue;
      const vmg = s * Math.cos(off * D2R);
      if (vmg > bestV) {
        bestV = vmg;
        best = h;
      }
    }
    return best;
  };
  // 1. route normale vers la cible ; 2. n'importe quel cap dégagé ; 3. s'écarter de la côte
  return pick(110, 5, LONG) ?? pick(180, 10, LONG) ?? pick(180, 10, SHORT) ?? brg;
}

/** Passe au point de passage suivant quand on l'a atteint ou dépassé. */
export function nextTarget(b: Boat): LonLat {
  while (b.wp < b.route.length - 1) {
    const w = b.route[b.wp];
    const n = b.route[b.wp + 1];
    const hardR = hardRadius(w);
    if (hardR !== undefined ? dist(b.pos, w) < hardR : dist(b.pos, w) < 90 || dist(b.pos, n) < dist(w, n)) b.wp++;
    else break;
  }
  return b.route[b.wp];
}

/** Projette la route conseillée depuis la position d'un bateau : un point par heure. */
export function planRoute(src: Boat, t0: number, wind: WindSource, finish: LonLat, finishR: number, maxHours: number, marks?: { pos: LonLat; r: number }[]): LonLat[] {
  const b: Boat = {
    ...src,
    pos: [src.pos[0], src.pos[1]],
    trail: [],
    energy: 100,
    sleep: 0,
    penalty: 0,
    avarie: null,
    repair: 0,
    decide: 0,
    twa: 0,
    finished: null,
  };
  const pts: LonLat[] = [];
  let t = t0;
  let acc = 0;
  const dt = 0.25;
  for (let i = 0; i < maxHours / dt; i++) {
    b.decide -= dt;
    if (b.decide <= 0) {
      b.hdg = bestHeading(b.pos, t, nextTarget(b), b.perf, wind);
      b.decide = decideEvery(b);
    }
    b.energy = 100;
    stepBoat(b, { t, dt, wind, rng: null, finish, finishR, marks });
    t += dt;
    acc += dt;
    if (acc >= 1) {
      pts.push([b.pos[0], b.pos[1]]);
      acc = 0;
    }
    if (b.finished !== null) {
      pts.push([b.pos[0], b.pos[1]]);
      break;
    }
  }
  return pts;
}

/** Intervalle entre deux décisions du pilote (h) : plus court à l'approche d'une marque. */
export function decideEvery(b: Boat): number {
  const d = dist(b.pos, b.route[b.wp]);
  return d < 25 ? 0.1 : 0.5;
}
