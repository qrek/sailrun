import { BASE_PERF, Perf } from '../sim/boat';
import type { RaceDef, RaceProfile } from './races';
import calibrationRaw from './calibration.json';

export type SlotId = 'coque' | 'foils' | 'mat';
type PerfDelta = Partial<Record<keyof Perf, number>>;

export interface Part {
  id: string;
  name: string;
  desc: string;
  mass: number;
  /** up/reach/down/light/heavy : ajout au multiplicateur ; fragility/drain : ajout au facteur (1 = neutre). */
  mod: PerfDelta;
}

export interface Slot {
  id: SlotId;
  label: string;
  plural: string;
  parts: Part[];
}

/**
 * Préparation de l'IMOCA avant le départ. La jauge IMOCA rend les bateaux très proches :
 * chaque choix est un compromis qui ne fait gagner (ou perdre) que quelques dixièmes de pour-cent,
 * selon la météo qu'on va rencontrer. Les identifiants des emplacements restent ceux du modèle 3D.
 */
export const SLOTS: Slot[] = [
  {
    id: 'coque',
    label: 'Voiles',
    plural: 'jeux de voiles',
    parts: [
      { id: 'polyvalent', name: 'Jeu polyvalent', desc: 'Le jeu de voiles standard. Aucun point faible, aucun point fort.', mass: 380, mod: {} },
      { id: 'brise', name: 'Jeu de brise', desc: 'Voiles plus plates et renforcées : meilleur quand ça souffle, un peu court dans le petit temps.', mass: 410, mod: { heavy: 0.015, light: -0.012, fragility: -0.1 } },
      { id: 'petittemps', name: 'Jeu petit temps', desc: 'Voiles plus creuses et légères : tu relances mieux dans les molles, mais elles souffrent dans la brise.', mass: 350, mod: { light: 0.015, heavy: -0.012, fragility: 0.1 } },
    ],
  },
  {
    id: 'foils',
    label: 'Foils',
    plural: 'foils',
    parts: [
      { id: 'c', name: 'Foils polyvalents', desc: 'Le réglage de série : le bateau vole dès le travers, sans prendre de risque.', mass: 380, mod: {} },
      { id: 'grands', name: 'Grands foils', desc: 'Plus de portance au reaching et au portant. Plus lents à décoller et plus durs pour le skipper.', mass: 420, mod: { reach: 0.012, down: 0.008, light: -0.012, fragility: 0.15, drain: 0.08 } },
      { id: 'compacts', name: 'Foils compacts', desc: 'Moins de traînée au près et dans le petit temps, moins de puissance une fois lancé.', mass: 350, mod: { up: 0.008, light: 0.006, reach: -0.008, down: -0.006, fragility: -0.1 } },
    ],
  },
  {
    id: 'mat',
    label: 'Centrage',
    plural: 'centrages',
    parts: [
      { id: 'neutre', name: 'Centrage neutre', desc: 'Matossage standard : sacs et ballasts au milieu du bateau.', mass: 600, mod: {} },
      { id: 'avant', name: 'Poids vers l’avant', desc: 'Le bateau pince mieux au près, mais l’étrave plonge plus au portant.', mass: 600, mod: { up: 0.008, down: -0.008 } },
      { id: 'arriere', name: 'Poids vers l’arrière', desc: 'L’étrave reste haute au portant et dans la brise, au détriment du près.', mass: 600, mod: { down: 0.008, heavy: 0.004, up: -0.008 } },
    ],
  },
];

export interface Skipper {
  id: string;
  name: string;
  role: string;
  desc: string;
  effects: string[];
  mod: PerfDelta;
}

export const SKIPPERS: Skipper[] = [
  { id: 'regleur', name: 'Régleur', role: 'Préparation technique', desc: 'Tu as passé l’hiver sur les polaires : le bateau va un poil plus vite, mais tu règles sans arrêt et tu te fatigues plus.', effects: ['Vitesse +0,4 %', 'Fatigue +5 %'], mod: { speed: 0.004, drain: 0.05 } },
  { id: 'endurant', name: 'Endurance', role: 'Préparation physique', desc: 'Préparation physique et gestion du sommeil : tu tiens plus longtemps entre deux siestes.', effects: ['Fatigue −15 %'], mod: { drain: -0.15 } },
  { id: 'bricoleur', name: 'Technique', role: 'Préparation mécanique', desc: 'Tu connais chaque pièce du bateau : moins de casse et des réparations plus rapides.', effects: ['Avaries −25 %', 'Réparations ×1,5'], mod: { fragility: -0.25, repair: 0.5 } },
];

export interface Livery {
  id: string;
  name: string;
  color: string;
  dark: boolean;
}
export const LIVERIES: Livery[] = [
  { id: 'orange', name: 'Orange', color: '#FF7A1A', dark: true },
  { id: 'cyan', name: 'Cyan', color: '#22D3EE', dark: true },
  { id: 'blanc', name: 'Blanc', color: '#F4F6F8', dark: true },
  { id: 'bleu', name: 'Bleu', color: '#3B82F6', dark: false },
];

/** équipement de base, électronique et jeu de voiles compris */
export const BASE_MASS = 610;
export const MASS_LIMIT = 5000;

export interface Setup {
  parts: Record<SlotId, string>;
  skipper: string;
  livery: string;
  /** réglages fins, de −1 à +1 (0 = réglage de série) */
  tune?: Tune;
  /** personnalisation esthétique (sans effet sur la vitesse) */
  style?: Partial<BoatStyle>;
}

export type Pattern = 'vague' | 'bande' | 'degrade' | 'eclair' | 'uni';
export type Cloth = 'carbone' | 'gris' | 'blanc';
export interface BoatStyle {
  color: string;
  accent: string;
  pattern: Pattern;
  sail: Cloth;
  name: string;
  number: string;
}
export const HULL_COLORS = ['#FF7A1A', '#E11D48', '#FACC15', '#22C55E', '#14B8A6', '#22D3EE', '#2563EB', '#1E3A8A', '#7C3AED', '#EC4899', '#F4F6F8', '#111827'];
export const ACCENT_COLORS = ['#FFFFFF', '#111827', '#FACC15', '#FF7A1A', '#E11D48', '#22D3EE', '#22C55E', '#7C3AED'];
export const PATTERNS: { id: Pattern; name: string }[] = [
  { id: 'vague', name: 'Vague' },
  { id: 'bande', name: 'Bande' },
  { id: 'degrade', name: 'Dégradé' },
  { id: 'eclair', name: 'Éclair' },
  { id: 'uni', name: 'Uni' },
];
export const CLOTHS: { id: Cloth; name: string }[] = [
  { id: 'carbone', name: 'Carbone' },
  { id: 'gris', name: 'Gris' },
  { id: 'blanc', name: 'Blanc' },
];

/** Style complet du bateau (valeurs par défaut tirées de la livrée choisie). */
export function styleOf(s: Setup): BoatStyle {
  const l = LIVERIES.find((x) => x.id === s.livery) ?? LIVERIES[0];
  return { color: l.color, accent: '#FFFFFF', pattern: 'vague', sail: 'carbone', name: 'Sail Run', number: 'FRA 1', ...(s.style ?? {}) };
}

/** Texte foncé lisible sur cette couleur ? */
export function isLightColor(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

export type TuneId = 'rake' | 'foil' | 'trim';
export type Tune = Record<TuneId, number>;
export const NEUTRAL_TUNE: Tune = { rake: 0, foil: 0, trim: 0 };

/**
 * Réglages fins façon écran de setup : chaque curseur déplace un peu de performance d'une allure
 * à l'autre, et s'éloigner du neutre coûte un peu partout (quadratique). Le bon réglage dépend
 * de la météo qu'on va rencontrer : la zone idéale est calculée sur les prévisions.
 */
export interface TuneDef {
  id: TuneId;
  label: string;
  min: string;
  max: string;
  /** effet par unité de curseur, ajouté au multiplicateur */
  gain: Partial<Record<'up' | 'reach' | 'down' | 'light' | 'heavy', number>>;
  /** perte de vitesse générale pour x = ±1 */
  cost: number;
  /** usure (casse, fatigue) quand on pousse vers +1 */
  wear?: { fragility?: number; drain?: number };
  help: string;
}

export const TUNES: TuneDef[] = [
  { id: 'rake', label: 'Quête de mât', min: 'Droit', max: 'En arrière', gain: { up: 0.01, down: -0.008 }, cost: 0.004, help: 'Mât quêté en arrière : le bateau pince mieux au près. Droit : plus de puissance au portant.' },
  { id: 'foil', label: 'Incidence des foils', min: 'Faible', max: 'Forte', gain: { reach: 0.014, down: 0.01, light: -0.014, heavy: 0.004 }, cost: 0.005, wear: { fragility: 0.2, drain: 0.1 }, help: 'Plus d’incidence : le bateau vole plus tôt et plus haut au reaching, mais traîne dans les molles et use le skipper.' },
  { id: 'trim', label: 'Centrage', min: 'Avant', max: 'Arrière', gain: { down: 0.01, heavy: 0.006, up: -0.01 }, cost: 0.004, help: 'Poids vers l’arrière : l’étrave reste haute au portant et dans la mer formée. Vers l’avant : meilleur au près.' },
];

/** Applique les réglages fins à une performance. */
export function applyTune(p: Perf, t: Tune | undefined): Perf {
  if (!t) return p;
  for (const d of TUNES) {
    const x = Math.max(-1, Math.min(1, t[d.id] ?? 0));
    for (const k of Object.keys(d.gain) as (keyof typeof d.gain)[]) p[k] += d.gain[k]! * x;
    p.speed -= d.cost * x * x;
    if (d.wear && x > 0) {
      p.fragility += (d.wear.fragility ?? 0) * x;
      p.drain += (d.wear.drain ?? 0) * x;
    }
  }
  return p;
}

/** Temps passé à chaque allure et force de vent sur la course (fractions). */
export interface RaceMix {
  up: number;
  reach: number;
  down: number;
  light: number;
  heavy: number;
}

/** Réglage idéal de chaque curseur pour ce profil de course (maximise le gain moyen). */
export function idealTune(mix: RaceMix): Tune {
  const out = { ...NEUTRAL_TUNE };
  for (const d of TUNES) {
    let g = 0;
    for (const k of Object.keys(d.gain) as (keyof typeof d.gain)[]) g += d.gain[k]! * mix[k];
    out[d.id] = Math.max(-1, Math.min(1, g / (2 * d.cost)));
  }
  return out;
}

export const DEFAULT_SETUP: Setup = {
  parts: { coque: 'polyvalent', foils: 'c', mat: 'neutre' },
  skipper: 'regleur',
  livery: 'orange',
};

export const partOf = (slot: SlotId, id: string): Part => {
  const s = SLOTS.find((x) => x.id === slot)!;
  return s.parts.find((p) => p.id === id) ?? s.parts[0];
};
export const skipperOf = (id: string) => SKIPPERS.find((s) => s.id === id) ?? SKIPPERS[0];
export const liveryOf = (id: string) => LIVERIES.find((l) => l.id === id) ?? LIVERIES[0];

export function perfOf(s: Setup): Perf {
  const p: Perf = { ...BASE_PERF };
  const mods: PerfDelta[] = SLOTS.map((sl) => partOf(sl.id, s.parts[sl.id]).mod);
  mods.push(skipperOf(s.skipper).mod);
  for (const m of mods) {
    for (const k of Object.keys(m) as (keyof Perf)[]) p[k] += m[k]!;
  }
  applyTune(p, s.tune);
  p.fragility = Math.max(0.1, p.fragility);
  p.drain = Math.max(0.3, p.drain);
  return p;
}

export function massOf(s: Setup): number {
  return BASE_MASS + SLOTS.reduce((a, sl) => a + partOf(sl.id, s.parts[sl.id]).mass, 0);
}

/* ---------- notes affichées (0 à 10) normalisées sur toutes les combinaisons ---------- */
function allSetups(): Setup[] {
  const out: Setup[] = [];
  const [a, b, c] = SLOTS;
  for (const pa of a.parts)
    for (const pb of b.parts)
      for (const pc of c.parts)
        for (const sk of SKIPPERS) out.push({ parts: { coque: pa.id, foils: pb.id, mat: pc.id }, skipper: sk.id, livery: 'orange' });
  return out;
}
export const ALL_SETUPS = allSetups();
const ALL = ALL_SETUPS;

export const setupKey = (s: Setup) => `${s.parts.coque}.${s.parts.foils}.${s.parts.mat}.${s.skipper}`;

type Calib = Record<string, Record<string, { h: number; r: number }>>;
const CALIB = calibrationRaw as unknown as Calib;

/** Temps de course simulé (heures) et meilleure route pour ce bateau, si la calibration existe. */
export function calibrated(raceId: string, s: Setup): { h: number; r: number } | undefined {
  return CALIB[raceId]?.[setupKey(s)];
}

const rawSpeed = (p: Perf) => ((p.up + p.reach + p.down + p.light + p.heavy) / 5) * p.speed;
const rawSolid = (p: Perf) => -p.fragility;
const rawComfort = (p: Perf) => -p.drain;

function range(f: (p: Perf) => number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of ALL) {
    const v = f(perfOf(s));
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return [lo, hi];
}
const R_SPEED = range(rawSpeed);
const R_SOLID = range(rawSolid);
const R_COMFORT = range(rawComfort);
const scale = (v: number, [lo, hi]: [number, number]) => 1 + (9 * (v - lo)) / (hi - lo || 1);

export interface Stats {
  vitesse: number;
  solidite: number;
  confort: number;
}
export function statsOf(s: Setup): Stats {
  const p = perfOf(s);
  return { vitesse: scale(rawSpeed(p), R_SPEED), solidite: scale(rawSolid(p), R_SOLID), confort: scale(rawComfort(p), R_COMFORT) };
}

export function fitScore(p: Perf, pr: RaceProfile): number {
  const angle = pr.up * p.up + pr.reach * p.reach + pr.down * p.down;
  const force = 1 + pr.light * (p.light - 1) + pr.heavy * (p.heavy - 1);
  return angle * force * p.speed - 0.02 * pr.heavy * (p.fragility - 1) - 0.01 * (p.drain - 1);
}

/**
 * 1 à 5 étoiles : rang du bateau parmi tous les bateaux possibles sur cette course.
 * Basé sur les temps simulés (calibration) ; à défaut, sur le profil théorique de la course.
 */
export function fitStars(s: Setup, def: RaceDef): number {
  const valid = ALL.filter((x) => massOf(x) <= MASS_LIMIT);
  const mine = calibrated(def.id, s);
  let better: number;
  if (mine) {
    better = valid.filter((x) => (calibrated(def.id, x)?.h ?? Infinity) > mine.h + 1e-9).length;
  } else {
    const sc = fitScore(perfOf(s), def.profile);
    better = valid.filter((x) => fitScore(perfOf(x), def.profile) < sc - 1e-9).length;
  }
  const pct = better / Math.max(1, valid.length - 1);
  return Math.max(1, Math.min(5, 1 + Math.floor(pct * 4.999)));
}

/** Durée estimée de la course pour ce bateau (heures), si connue. */
export function estimatedHours(s: Setup, def: RaceDef): number | null {
  return calibrated(def.id, s)?.h ?? null;
}

export function likesOf(s: Setup): string {
  const p = perfOf(s);
  const traits: [string, number][] = [
    ['le près', p.up - 1],
    ['le vent de travers', p.reach - 1],
    ['le vent arrière', p.down - 1],
    ['le petit temps', p.light - 1],
    ['la brise', p.heavy - 1],
  ];
  traits.sort((a, b) => b[1] - a[1]);
  const good = traits.filter((t) => t[1] > 0.015).slice(0, 2).map((t) => t[0]);
  if (!good.length) return 'un peu de tout';
  return good.join(' et ');
}

const rankedCache: Record<string, Setup[]> = {};
/** Bateaux autorisés, du plus rapide au plus lent sur cette course. */
export function rankedSetups(def: RaceDef): Setup[] {
  if (!rankedCache[def.id]) {
    const valid = ALL.filter((x) => massOf(x) <= MASS_LIMIT);
    const key = (x: Setup) => calibrated(def.id, x)?.h ?? 1000 - 100 * fitScore(perfOf(x), def.profile);
    rankedCache[def.id] = valid.sort((a, b) => key(a) - key(b));
  }
  return rankedCache[def.id];
}

/**
 * Configuration d'un bot. `level` = rang visé parmi tous les bateaux possibles
 * (0.05 → dans les 5 % les plus rapides, 0.6 → plutôt moyen), avec un peu de hasard.
 */
export function botSetup(def: RaceDef, rnd: () => number, level: number): Setup {
  const list = rankedSetups(def);
  const pct = Math.min(0.98, Math.max(0, level * (0.5 + rnd())));
  const best = list[Math.floor(pct * list.length)];
  return { ...best, parts: { ...best.parts } };
}

/** Durée typique d'une course (heures) : médiane des bateaux calibrés. */
export function typicalHours(def: RaceDef): number | null {
  const hs = ALL.map((x) => calibrated(def.id, x)?.h).filter((h): h is number => h !== undefined).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : null;
}

/** Écart de chaque domaine par rapport à la configuration de série (en %). */
export function perfDeltas(s: Setup): { label: string; v: number }[] {
  const p = perfOf(s);
  const b = perfOf(DEFAULT_SETUP);
  const pct = (k: keyof Perf) => (p[k] - b[k]) * 100;
  return [
    { label: 'Près', v: pct('up') + pct('speed') },
    { label: 'Travers', v: pct('reach') + pct('speed') },
    { label: 'Portant', v: pct('down') + pct('speed') },
    { label: 'Petit temps', v: pct('light') },
    { label: 'Brise', v: pct('heavy') },
  ];
}

/** Forme du bateau 3D pour une préparation (la coque et le mât sont imposés par la jauge). */
export function lookOf(s: Setup): { hull: string; foils: string; mast: string } {
  const big = s.parts.foils === 'grands' || (s.tune?.foil ?? 0) > 0.45;
  return { hull: 'classique', foils: big ? 'grands' : 'c', mast: 'aile' };
}
