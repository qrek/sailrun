import { LonLat, dist } from '../sim/geo';
import { FleetEntry, IMOCA_RHUM_2026 } from './fleet';

/** Répartition attendue des allures et des forces de vent, pour noter l'adéquation d'un bateau. */
export interface RaceProfile {
  up: number;
  reach: number;
  down: number;
  light: number;
  heavy: number;
}

export interface RaceDef {
  id: string;
  name: string;
  from: string;
  to: string;
  start: LonLat;
  finish: LonLat;
  finishR: number; // rayon de la zone d'arrivée (milles)
  startHeading: number;
  startUTC: number; // heure réelle du départ (jour/nuit)
  windPhase: number; // décalage de la météo synthétique
  /** Options de route : la première est la route conseillée, les bots se répartissent les autres. */
  routes: LonLat[][];
  profile: RaceProfile;
  profileLabel: string;
  blurb: string;
  /** Marques à passer dans l'ordre avant de pouvoir couper la ligne. */
  marks?: Mark[];
  /** Vraie flotte : les bots portent le nom des skippers engagés. */
  fleet?: FleetEntry[];
  /** Classe imposée (affichage). */
  klass?: string;
  /** Vent réel GFS plutôt que le vent synthétique. */
  realWind?: boolean;
  /** Course officielle mise en avant au menu. */
  featured?: boolean;
  /** Infos d'affichage */
  officialName?: string;
  distanceLabel?: string;
  /** Distance officielle (milles), si elle diffère de la route conseillée */
  officialNm?: number;
}

export interface Mark {
  name: string;
  short: string;
  pos: LonLat;
  /** rayon (milles) dans lequel la marque est validée */
  r: number;
}

/**
 * Points de route « durs » : le pilote doit vraiment s'en approcher (rayon en milles) avant de passer
 * au suivant, au lieu de couper le virage à 90 milles comme pour un simple point de route.
 */
const HARD_POINTS = new Map<string, number>();
const hard = (p: LonLat, r: number): LonLat => {
  HARD_POINTS.set(`${p[0]},${p[1]}`, r);
  return p;
};
/** Rayon d'un point de route dur (par valeur : les sauvegardes perdent l'identité des tableaux). */
export const hardRadius = (p: LonLat): number | undefined => HARD_POINTS.get(`${p[0]},${p[1]}`);

const LORIENT_OFF: LonLat = [-4.6, 47.35];

const ACORES: LonLat = [-25.55, 37.55];
const ANTIGUA: LonLat = [-61.4, 17.05];
const MARTINIQUE: LonLat = [-60.55, 14.62];

/* ---------- Route du Rhum – Destination Guadeloupe 2026 ---------- */
// Départ au large de la pointe du Grouin, Cap Fréhel à laisser à bâbord, puis l'Atlantique.
// En Guadeloupe : on descend la côte sous le vent de Basse-Terre, on passe la bouée de Basse-Terre,
// on remonte par le sud jusqu'à la ligne de Pointe-à-Pitre.
const RDR_START: LonLat = [-1.95, 48.84];
const FREHEL: LonLat = hard([-2.33, 48.84], 4);
const OUESSANT: LonLat = hard([-5.65, 48.35], 18);
const NORD_GUA: LonLat = hard([-61.7, 16.75], 10);
const DESHAIES: LonLat = hard([-61.93, 16.42], 5);
const BOUEE_BT: LonLat = hard([-61.78, 15.96], 2.5);
const SUD_BT: LonLat = hard([-61.55, 15.93], 4);
const PTP: LonLat = [-61.5, 16.19];
const GUADELOUPE_END: LonLat[] = [NORD_GUA, DESHAIES, BOUEE_BT, SUD_BT, PTP];

export const RHUM_MARKS: Mark[] = [
  { name: 'Cap Fréhel', short: 'Fréhel', pos: FREHEL, r: 6 },
  { name: 'Bouée de Basse-Terre', short: 'Basse-Terre', pos: BOUEE_BT, r: 3 },
];

export const RHUM: RaceDef = {
  id: 'rhum2026',
  name: 'Route du Rhum',
  officialName: 'Route du Rhum – Destination Guadeloupe',
  klass: 'IMOCA',
  from: 'Saint-Malo',
  to: 'Pointe-à-Pitre',
  start: RDR_START,
  finish: PTP,
  finishR: 3,
  startHeading: 275,
  // dimanche 1er novembre 2026, 13 h 02 à Saint-Malo (UTC+1)
  startUTC: Date.UTC(2026, 10, 1, 12, 2),
  windPhase: 30,
  routes: [
    // option médiane : on longe le Portugal de loin, on coupe vers les alizés
    [FREHEL, OUESSANT, [-12, 44], [-22, 33], [-42, 21.5], [-56, 18.2], ...GUADELOUPE_END],
    // option sud : Madère puis les alizés à fond
    [FREHEL, OUESSANT, [-11, 43.5], [-19, 30], [-34, 20.5], [-52, 17.6], ...GUADELOUPE_END],
    // option nord : la route directe, à travers les dépressions
    [FREHEL, OUESSANT, [-17, 44], [-33, 33], [-50, 22], ...GUADELOUPE_END],
    // option très sud : on descend jusqu'aux Canaries
    [FREHEL, OUESSANT, [-10.5, 42.5], [-17.5, 27], [-30, 19], [-50, 16.8], ...GUADELOUPE_END],
    // option très nord : on attrape le flux d'ouest et on plonge plus tard
    [FREHEL, OUESSANT, [-22, 45], [-40, 33], [-54, 21], ...GUADELOUPE_END],
  ],
  profile: { up: 0.2, reach: 0.35, down: 0.45, light: 0.2, heavy: 0.3 },
  profileLabel: 'Mixte',
  blurb: '3 542 milles en solitaire de Saint-Malo à la Guadeloupe. La Manche, le golfe de Gascogne en novembre, puis les alizés et le tour de Basse-Terre.',
  marks: RHUM_MARKS,
  fleet: IMOCA_RHUM_2026,
  realWind: true,
  featured: true,
  distanceLabel: '3 542 milles',
  officialNm: 3542,
};

export const RACES: RaceDef[] = [
  RHUM,
  {
    id: 'acores',
    name: 'Sprint des Açores',
    from: 'Lorient',
    to: 'Ponta Delgada',
    start: LORIENT_OFF,
    finish: ACORES,
    finishR: 14,
    startHeading: 245,
    startUTC: Date.UTC(2026, 9, 12, 13, 0),
    windPhase: 0,
    routes: [[ACORES], [[-13.5, 45.2], ACORES], [[-10.5, 43.9], [-18, 39.5], ACORES], [[-16, 44.5], ACORES]],
    profile: { up: 0.45, reach: 0.4, down: 0.15, light: 0.3, heavy: 0.25 },
    profileLabel: 'Près',
    blurb: 'Un sprint contre les vents d’ouest. Il faut un bateau qui remonte bien au vent.',
  },
  {
    id: 'alizes',
    name: 'Route des Alizés',
    from: 'Gran Canaria',
    to: 'Antigua',
    start: [-15.0, 27.45],
    finish: ANTIGUA,
    finishR: 14,
    startHeading: 230,
    startUTC: Date.UTC(2026, 10, 22, 11, 0),
    windPhase: 140,
    routes: [[[-24, 22], ANTIGUA], [ANTIGUA], [[-21, 24.5], ANTIGUA], [[-30, 19.5], ANTIGUA], [[-27, 21], ANTIGUA]],
    profile: { up: 0.02, reach: 0.25, down: 0.73, light: 0.15, heavy: 0.2 },
    profileLabel: 'Vent arrière',
    blurb: 'Plein vent arrière dans les alizés. Les grands foils et les spis vont se régaler.',
  },
  {
    id: 'transat',
    name: 'Transat des Potes',
    from: 'Lorient',
    to: 'Fort-de-France',
    start: LORIENT_OFF,
    finish: MARTINIQUE,
    finishR: 20,
    startHeading: 232,
    startUTC: Date.UTC(2026, 10, 8, 12, 0),
    windPhase: 60,
    routes: [
      [[-11.5, 43.3], [-20, 27], MARTINIQUE],
      [[-11.5, 43.3], [-19.5, 28], MARTINIQUE],
      [[-11.5, 43.3], [-22, 23], MARTINIQUE],
      [[-11.5, 43.3], [-19, 31], MARTINIQUE],
      [[-12.5, 42.5], [-26, 30], MARTINIQUE],
      [[-11.5, 43.3], [-20.5, 25.5], MARTINIQUE],
    ],
    profile: { up: 0.15, reach: 0.35, down: 0.5, light: 0.2, heavy: 0.25 },
    profileLabel: 'Mixte',
    blurb: 'La grande traversée : on descend le long du Portugal, on attrape les alizés, et cap sur les Antilles.',
  },
];

export const raceById = (id: string) => RACES.find((r) => r.id === id) ?? RACES[0];

/** Courses d'entraînement (vent simulé, 5 bots). */
export const TRAINING = () => RACES.filter((r) => !r.featured);

/** Distance de la route conseillée. */
export function raceDistance(r: RaceDef): number {
  if (r.officialNm) return r.officialNm;
  let d = 0;
  let p = r.start;
  for (const w of r.routes[0]) {
    d += dist(p, w);
    p = w;
  }
  return d;
}
