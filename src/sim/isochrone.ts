import { Order, Perf, SailId, bestSail, boatSpeed } from './boat';
import { LonLat, bearing, dist, isLand, move, norm180 } from './geo';
import { WindSource, windFrom } from './wind';

/**
 * Routage par isochrones, simple et rapide : depuis la position du bateau, on essaie tous les caps
 * tous les 6°, pas de temps par pas de temps, sur les vraies prévisions. À chaque pas on ne garde,
 * dans chaque secteur autour du point de départ, que le point le plus avancé vers l'arrivée
 * (en passant par les marques). Virements et empannages coûtent un peu de distance.
 */

export interface PlanStep {
  pos: LonLat;
  t: number;
  hdg: number;
  twa: number;
  tws: number;
  spd: number;
  sail: SailId;
}

export interface RoutePlan {
  t0: number;
  hours: number;
  steps: PlanStep[];
  orders: (Order & { sail: SailId; twa: number; spd: number })[];
  /** distance restante (milles) au départ et à la fin du plan */
  remain0: number;
  remain1: number;
  /** distance parcourue (milles) */
  sailed: number;
}

interface Node {
  pos: LonLat;
  parent: number; // index dans la couche précédente
  hdg: number;
  twa: number;
  tws: number;
  spd: number;
  mark: number;
  rem: number;
}

export interface Course {
  marks: { pos: LonLat; r: number }[];
  finish: LonLat;
  finishR: number;
}

/** Distance restante en passant par les marques, à partir de la marque `mark`. */
export function remainingFrom(pos: LonLat, mark: number, c: Course): number {
  const m = c.marks;
  if (mark >= m.length) return dist(pos, c.finish);
  let d = dist(pos, m[mark].pos);
  for (let i = mark; i < m.length - 1; i++) d += dist(m[i].pos, m[i + 1].pos);
  return d + dist(m[m.length - 1].pos, c.finish);
}

const HSTEP = 6;
const BINS = 150;

export async function isoRoute(
  start: LonLat,
  t0: number,
  hours: number,
  wind: WindSource,
  perf: Perf,
  mark0: number,
  course: Course,
  hdg0: number,
  progress?: (k: number) => void,
): Promise<RoutePlan> {
  const dt = hours <= 12 ? 0.5 : 1;
  const nSteps = Math.round(hours / dt);
  const layers: Node[][] = [[{ pos: start, parent: -1, hdg: hdg0, twa: 0, tws: 0, spd: 0, mark: mark0, rem: remainingFrom(start, mark0, course) }]];
  let t = t0;
  for (let s = 0; s < nSteps; s++) {
    const prev = layers[layers.length - 1];
    const bins: (Node | null)[] = new Array(BINS).fill(null);
    let arrived: Node | null = null;
    for (let i = 0; i < prev.length; i++) {
      const n = prev[i];
      const [u, v] = wind.at(n.pos[0], n.pos[1], t);
      const tws = Math.hypot(u, v);
      const twd = windFrom(u, v);
      for (let h = 0; h < 360; h += HSTEP) {
        const twa = norm180(twd - h);
        if (Math.abs(twa) < 34) continue;
        let spd = boatSpeed(twa, tws, perf, bestSail(twa, tws));
        if (spd < 0.5) continue;
        // virement ou empannage : on perd environ un quart d'heure de route sur ce pas
        if (s > 0 && n.twa !== 0 && Math.sign(twa) !== Math.sign(n.twa)) spd *= Math.max(0.5, 1 - 0.25 / dt);
        const p = move(n.pos[0], n.pos[1], h, spd, dt);
        const mid = move(n.pos[0], n.pos[1], h, spd, dt / 2);
        if (isLand(p[0], p[1]) || isLand(mid[0], mid[1])) continue;
        let mark = n.mark;
        // marque franchie si on passe dans son rayon pendant le pas
        while (mark < course.marks.length) {
          const mk = course.marks[mark];
          if (dist(p, mk.pos) < mk.r || dist(mid, mk.pos) < mk.r) mark++;
          else break;
        }
        const rem = remainingFrom(p, mark, course);
        const node: Node = { pos: p, parent: i, hdg: h, twa, tws, spd, mark, rem };
        if (mark >= course.marks.length && dist(p, course.finish) < course.finishR) {
          if (!arrived || rem < arrived.rem) arrived = node;
          continue;
        }
        const b = Math.floor(((bearing(start, p) + 360) % 360) / (360 / BINS)) % BINS;
        const cur = bins[b];
        if (!cur || rem < cur.rem) bins[b] = node;
      }
    }
    const next = arrived ? [arrived] : (bins.filter(Boolean) as Node[]);
    if (!next.length) break;
    layers.push(next);
    t += dt;
    progress?.((s + 1) / nSteps);
    if (arrived) break;
    // laisse respirer l'interface entre deux pas
    await new Promise((r) => setTimeout(r, 0));
  }

  // meilleur point de la dernière couche, puis on remonte le chemin
  const last = layers[layers.length - 1];
  let best = last[0];
  for (const n of last) if (n.rem < best.rem) best = n;
  const chain: Node[] = [];
  let node: Node | undefined = best;
  for (let l = layers.length - 1; l >= 0 && node; l--) {
    chain.unshift(node);
    node = node.parent >= 0 ? layers[l - 1]?.[node.parent] : undefined;
  }
  const steps: PlanStep[] = chain.map((n, k) => ({ pos: n.pos, t: t0 + k * dt, hdg: n.hdg, twa: n.twa, tws: n.tws, spd: n.spd, sail: bestSail(n.twa, n.tws) }));
  // ordres : un par changement de cap sensible (le cap d'un pas s'applique depuis le point précédent)
  const orders: RoutePlan['orders'] = [];
  let sailed = 0;
  for (let k = 1; k < steps.length; k++) {
    const st = steps[k];
    sailed += dist(steps[k - 1].pos, st.pos);
    const tStart = steps[k - 1].t;
    const lastO = orders[orders.length - 1];
    if (!lastO || Math.abs(norm180(st.hdg - lastO.hdg)) > 10) orders.push({ t: tStart, hdg: st.hdg, sail: st.sail, twa: st.twa, spd: st.spd });
  }
  return { t0, hours: steps.length > 1 ? steps[steps.length - 1].t - t0 : 0, steps, orders, remain0: layers[0][0].rem, remain1: best.rem, sailed };
}
