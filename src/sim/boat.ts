import { LonLat, Rng, dist, isLand, move, norm180, smooth } from './geo';
import { WindSource, windFrom } from './wind';

/** Multiplicateurs de performance issus du garage et du skipper. */
export interface Perf {
  up: number; // près (vent de face)
  reach: number; // travers
  down: number; // vent arrière
  light: number; // petit temps (< 10 nds)
  heavy: number; // brise (> 22 nds)
  fragility: number; // risque d'avarie
  drain: number; // fatigue du skipper
  speed: number; // bonus global (skipper)
  repair: number; // vitesse de réparation
  /** 1 = polaire IMOCA à foils (vraie classe), 0 = polaire générique des courses d'entraînement */
  imoca: number;
}

export const BASE_PERF: Perf = { up: 1, reach: 1, down: 1, light: 1, heavy: 1, fragility: 1, drain: 1, speed: 1, repair: 1, imoca: 0 };

/* Polaire d'un IMOCA à foils récent (nœuds), d'après des polaires publiques approchées. */
const IP_TWS = [0, 6, 10, 14, 18, 22, 26, 30, 40];
const IP_TWA = [0, 30, 40, 52, 60, 75, 90, 110, 130, 150, 165, 180];
const IP: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 4.5, 5.8, 6.6, 7.4, 7.8, 7.6, 7.0, 5.8, 4.9, 4.5],
  [0, 0, 7.4, 9.0, 10.2, 12.0, 13.2, 13.5, 12.6, 10.2, 8.6, 7.8],
  [0, 0, 9.2, 11.2, 13.0, 17.0, 19.5, 20.5, 19.5, 15.5, 12.5, 11.2],
  [0, 0, 10.2, 12.6, 15.0, 21.0, 24.0, 25.5, 25.0, 21.0, 16.5, 14.5],
  [0, 0, 10.8, 13.6, 16.5, 23.5, 26.5, 28.5, 28.5, 24.5, 20.0, 17.5],
  [0, 0, 11.0, 14.0, 17.0, 24.0, 27.0, 29.5, 30.0, 27.0, 22.5, 19.5],
  [0, 0, 10.5, 13.5, 16.5, 23.0, 26.0, 28.5, 29.5, 27.5, 23.5, 20.5],
  [0, 0, 8.5, 11.0, 13.5, 18.5, 21.0, 23.0, 24.5, 24.0, 21.0, 18.5],
];
function lerpIdx(xs: number[], x: number): [number, number] {
  if (x <= xs[0]) return [0, 0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return [i - 1, (x - xs[i - 1]) / (xs[i] - xs[i - 1])];
  return [xs.length - 2, 1];
}
/** Vitesse polaire IMOCA (nœuds) pour un angle et une force de vent. */
export function imocaPolar(twa: number, tws: number): number {
  const [i, fi] = lerpIdx(IP_TWS, tws);
  const [j, fj] = lerpIdx(IP_TWA, Math.abs(twa));
  const a = IP[i][j] * (1 - fj) + IP[i][j + 1] * fj;
  const b = IP[i + 1][j] * (1 - fj) + IP[i + 1][j + 1] * fj;
  return a * (1 - fi) + b * fi;
}

export type AvarieKind = 'voile' | 'safran' | 'pilote';
export const AVARIES: Record<AvarieKind, { label: string; factor: number }> = {
  voile: { label: 'Voile déchirée', factor: 0.85 },
  safran: { label: 'Safran abîmé', factor: 0.75 },
  pilote: { label: 'Pilote auto en panne', factor: 0.93 },
};
export const REPAIR_HOURS = 1.5;
export const SLEEP_HOURS = 2;

/* ---------- voiles d'avant ---------- */
export type SailId = 'foc' | 'code0' | 'spi';
export const SAILS: { id: SailId; name: string; hint: string; a: number[]; f: number[] }[] = [
  // efficacité selon l'angle au vent (|twa| en degrés)
  { id: 'foc', name: 'Foc', hint: 'au près', a: [0, 70, 90, 120, 150, 180], f: [1, 1, 0.95, 0.86, 0.8, 0.78] },
  { id: 'code0', name: 'Code 0', hint: 'au travers', a: [0, 40, 55, 70, 100, 120, 140, 180], f: [0.7, 0.8, 0.94, 1, 1, 0.96, 0.88, 0.8] },
  { id: 'spi', name: 'Spi', hint: 'au portant', a: [0, 70, 90, 110, 125, 180], f: [0.68, 0.7, 0.86, 0.97, 1, 1] },
];
export const SAIL_CHANGE_HOURS = 0.25;

export function sailFactor(sail: SailId, twa: number, tws: number): number {
  const s = SAILS.find((x) => x.id === sail) ?? SAILS[0];
  const a = Math.abs(twa);
  let f = s.f[s.f.length - 1];
  for (let i = 1; i < s.a.length; i++) {
    if (a <= s.a[i]) {
      const t = (a - s.a[i - 1]) / (s.a[i] - s.a[i - 1]);
      f = s.f[i - 1] + t * (s.f[i] - s.f[i - 1]);
      break;
    }
  }
  // le code 0 souffre dans la brise
  if (sail === 'code0' && tws > 24) f *= 1 - Math.min(0.08, (tws - 24) * 0.01);
  return f;
}

export function bestSail(twa: number, tws: number): SailId {
  let best: SailId = 'foc';
  let bf = -1;
  for (const s of SAILS) {
    const f = sailFactor(s.id, twa, tws);
    if (f > bf + 1e-6) {
      bf = f;
      best = s.id;
    }
  }
  return best;
}

export interface Boat {
  id: string;
  name: string;
  color: string;
  dark: boolean; // texte foncé sur la couleur
  isPlayer: boolean;
  perf: Perf;
  hull: string;
  foils: string;
  mast: string;
  pos: LonLat;
  hdg: number;
  spd: number;
  twa: number;
  tws: number;
  twd: number;
  energy: number;
  sleep: number;
  penalty: number;
  avarie: AvarieKind | null;
  repair: number;
  auto: boolean;
  wp: number;
  route: LonLat[];
  decide: number;
  jitter: number;
  trail: LonLat[];
  trailT: number;
  finished: number | null;
  talk: number;
  /** voile d'avant envoyée */
  sail: SailId;
  /** heures restantes de changement de voile */
  sailChange: number;
  /** la voile change toute seule (avec un temps de réaction) */
  autoSail: boolean;
  sailLag: number;
  sailLagMax: number;
  /** barre au cap fixe, ou à angle au vent constant */
  lock: 'hdg' | 'twa';
  lockTwa: number;
  /** prochaine marque de parcours à passer */
  mark: number;
  /** id de la flotte réelle (positions en direct) */
  fleetId?: string;
  /** positionné par le suivi en direct : la simulation ne le déplace pas */
  live?: boolean;
  /** programme du routage : à partir de l'heure t (h de course), cap hdg — suivi en mode Auto */
  program?: Order[];
  /** fin du programme (h de course) : au-delà, le pilote auto reprend la route conseillée */
  programEnd?: number;
}

export interface Order {
  t: number;
  hdg: number;
}

/** Ordre du programme en vigueur à l'heure t, ou null (pas de programme, ou programme terminé). */
export function activeOrder(b: Pick<Boat, 'program' | 'programEnd'>, t: number): Order | null {
  const pr = b.program;
  if (!pr?.length || b.programEnd === undefined || t >= b.programEnd) return null;
  let cur: Order | null = null;
  for (const o of pr) if (o.t <= t + 1e-6) cur = o;
  return cur ?? pr[0];
}

/** Complète un bateau venu d'une ancienne sauvegarde. */
export function migrateBoat(b: Partial<Boat>): Boat {
  const defaults = { sail: 'foc' as SailId, sailChange: 0, autoSail: true, sailLag: 0, sailLagMax: 0.5, lock: 'hdg' as const, lockTwa: b.twa || 90, mark: 0 };
  return Object.assign(defaults, b) as Boat;
}

export type BoatEvent = 'tack' | 'gybe' | 'land' | 'finish' | 'avarie' | 'repaired' | 'woke' | 'sail' | 'mark';

/* Polaire de base d'un 60 pieds, en fraction de la force du vent */
const PA = [0, 30, 38, 45, 52, 60, 75, 90, 110, 130, 150, 165, 180];
const PF = [0, 0, 0.35, 0.55, 0.65, 0.73, 0.83, 0.92, 1.02, 1.06, 0.96, 0.82, 0.72];
export function polarF(a: number): number {
  a = Math.abs(a);
  for (let i = 1; i < PA.length; i++) {
    if (a <= PA[i]) {
      const t = (a - PA[i - 1]) / (PA[i] - PA[i - 1]);
      return PF[i - 1] + t * (PF[i] - PF[i - 1]);
    }
  }
  return PF[PF.length - 1];
}

/** Vitesse cible. `sail` absent = meilleure voile pour l'angle (routage). */
export function boatSpeed(twa: number, tws: number, p: Perf, sail?: SailId): number {
  const a = Math.abs(twa);
  let s: number;
  if (p.imoca) {
    s = imocaPolar(a, tws);
  } else {
    s = tws * polarF(a);
    if (tws < 7) s *= 0.55 + (0.45 * tws) / 7;
    if (tws > 28) s *= 1 - Math.min(0.25, (tws - 28) * 0.02);
  }
  const wUp = 1 - smooth(60, 85, a);
  const wDown = smooth(105, 135, a);
  const wReach = Math.max(0, 1 - wUp - wDown);
  let m = wUp * p.up + wReach * p.reach + wDown * p.down;
  const wl = 1 - smooth(8, 13, tws);
  const wh = smooth(18, 26, tws);
  m *= 1 + wl * (p.light - 1) + wh * (p.heavy - 1);
  const sf = sailFactor(sail ?? bestSail(twa, tws), twa, tws);
  return Math.min(p.imoca ? 36 : 34, s * m * p.speed * sf);
}

/** Change de voile : quelques minutes au ralenti et un peu d'énergie. */
export function changeSail(b: Boat, sail: SailId): boolean {
  if (b.sail === sail || b.finished !== null) return false;
  b.sail = sail;
  b.sailChange = SAIL_CHANGE_HOURS * (b.energy < 25 ? 1.5 : 1);
  b.energy = Math.max(0, b.energy - 3);
  b.sailLag = 0;
  return true;
}

/** Ce qui ralentit le bateau en ce moment, dans l'ordre d'affichage. */
export function speedFactors(b: Boat): { label: string; f: number }[] {
  const out: { label: string; f: number }[] = [];
  if (b.sailChange > 0) out.push({ label: 'Changement de voile', f: 0.8 });
  if (b.penalty > 0) out.push({ label: 'Manœuvre', f: 0.6 });
  if (b.sleep > 0) out.push({ label: 'Skipper qui dort', f: 0.93 });
  if (b.energy < 25) out.push({ label: 'Skipper épuisé', f: 0.88 });
  if (b.avarie) out.push({ label: AVARIES[b.avarie].label, f: AVARIES[b.avarie].factor });
  if (b.repair > 0) out.push({ label: 'Réparation en cours', f: 0.7 });
  return out;
}

export interface StepCtx {
  t: number; // heures depuis le départ
  dt: number;
  wind: WindSource;
  rng: Rng | null; // null = pas d'aléas (projection de route)
  finish: LonLat;
  finishR: number;
  /** marques à passer avant l'arrivée */
  marks?: { pos: LonLat; r: number }[];
}

/** Fait avancer un bateau d'un pas de temps. Le cap a déjà été choisi. */
export function stepBoat(b: Boat, c: StepCtx): BoatEvent[] {
  if (b.finished !== null) {
    b.spd = 0;
    return [];
  }
  const ev: BoatEvent[] = [];
  const { dt } = c;
  const [u, v] = c.wind.at(b.pos[0], b.pos[1], c.t);
  b.tws = Math.hypot(u, v);
  b.twd = windFrom(u, v);
  // barre à angle au vent constant : le cap suit les bascules
  if (b.lock === 'twa' && !b.auto) b.hdg = (b.twd - b.lockTwa + 720) % 360;
  const twa = norm180(b.twd - b.hdg);
  if (b.twa !== 0 && Math.sign(twa) !== Math.sign(b.twa) && Math.abs(twa) > 3 && Math.abs(b.twa) > 3) {
    b.penalty = b.energy < 25 ? 0.6 : 0.4;
    ev.push(Math.abs(twa) > 90 ? 'gybe' : 'tack');
  }
  b.twa = twa;
  if (b.lock !== 'twa' || b.auto) b.lockTwa = twa;

  // voile automatique : elle réagit avec un temps de retard, et jamais pendant que le skipper dort
  if (b.autoSail && b.sailChange <= 0 && b.sleep <= 0) {
    const best = bestSail(twa, b.tws);
    if (best !== b.sail && sailFactor(best, twa, b.tws) > sailFactor(b.sail, twa, b.tws) + 0.015) {
      b.sailLag += dt;
      if (b.sailLag >= b.sailLagMax) {
        changeSail(b, best);
        ev.push('sail');
      }
    } else {
      b.sailLag = 0;
    }
  }

  let f = 1;
  if (b.sailChange > 0) {
    f *= 0.8;
    b.sailChange -= dt;
  }
  if (b.penalty > 0) {
    f *= 0.6;
    b.penalty -= dt;
  }
  if (b.sleep > 0) {
    f *= 0.93;
    b.sleep -= dt;
    b.energy = Math.min(100, b.energy + 14 * dt);
    if (b.sleep <= 0) {
      b.sleep = 0;
      ev.push('woke');
    }
  } else {
    b.energy = Math.max(0, b.energy - 2.2 * b.perf.drain * dt);
  }
  if (b.energy < 25) f *= 0.88;
  if (b.avarie) f *= AVARIES[b.avarie].factor;
  if (b.repair > 0) {
    f *= 0.7;
    b.repair -= dt;
    if (b.repair <= 0) {
      b.repair = 0;
      b.avarie = null;
      ev.push('repaired');
    }
  }
  b.spd = boatSpeed(twa, b.tws, b.perf, b.sail) * f;

  if (c.rng && !b.avarie) {
    const risk = 0.012 * b.perf.fragility * (Math.max(0, b.tws - 17) / 8) * (b.energy < 25 ? 1.6 : 1) * dt;
    if (risk > 0 && c.rng.next() < risk) {
      b.avarie = c.rng.pick<AvarieKind>(['voile', 'safran', 'pilote']);
      ev.push('avarie');
    }
  }

  const np = move(b.pos[0], b.pos[1], b.hdg, b.spd, dt);
  if (isLand(np[0], np[1])) {
    b.spd = 0;
    b.decide = 0;
    ev.push('land');
  } else {
    b.pos = np;
  }

  b.trailT -= dt;
  if (b.trailT <= 0) {
    b.trail.push([b.pos[0], b.pos[1]]);
    b.trailT = 0.5;
    if (b.trail.length > 1200) b.trail.shift();
  }

  const marks = c.marks;
  if (marks && b.mark < marks.length && dist(b.pos, marks[b.mark].pos) < marks[b.mark].r) {
    b.mark++;
    ev.push('mark');
  }
  if ((!marks || b.mark >= marks.length) && dist(b.pos, c.finish) < c.finishR) {
    b.finished = c.t + dt;
    ev.push('finish');
  }
  return ev;
}

export function startRepair(b: Boat): boolean {
  if (!b.avarie || b.repair > 0) return false;
  b.repair = REPAIR_HOURS / b.perf.repair;
  b.sleep = 0;
  return true;
}

/** Réveille le skipper (sieste interrompue, l'énergie déjà récupérée est gardée). */
export function wakeUp(b: Boat): boolean {
  if (b.sleep <= 0) return false;
  b.sleep = 0;
  return true;
}

export function startSleep(b: Boat): boolean {
  if (b.sleep > 0 || b.repair > 0 || b.finished !== null) return false;
  b.sleep = SLEEP_HOURS;
  return true;
}

export interface Projection {
  pts: LonLat[]; // un point toutes les 30 min
  dt: number;
  /** prochaine marque à passer à la fin de la projection */
  mark: number;
}

/**
 * Où sera le bateau si on ne touche à rien : même mode de barre (cap ou angle au vent),
 * même pilote, voile automatique si elle est activée. Sans aléas ni fatigue.
 */
export function projectBoat(src: Boat, t0: number, wind: WindSource, hours: number, finish: LonLat, finishR: number, steer?: (b: Boat, t: number) => void, marks?: StepCtx['marks']): Projection {
  const b: Boat = { ...src, pos: [src.pos[0], src.pos[1]], trail: [], finished: null, sleep: 0, repair: 0, penalty: 0 };
  const dt = 0.1;
  const pts: LonLat[] = [[b.pos[0], b.pos[1]]];
  let t = t0;
  let acc = 0;
  for (let i = 0; i < hours / dt; i++) {
    steer?.(b, t);
    b.energy = Math.max(b.energy, 50);
    stepBoat(b, { t, dt, wind, rng: null, finish, finishR, marks });
    t += dt;
    acc += dt;
    if (acc >= 0.5 - 1e-9) {
      pts.push([b.pos[0], b.pos[1]]);
      acc = 0;
    }
    if (b.finished !== null) break;
  }
  return { pts, dt: 0.5, mark: b.mark };
}
