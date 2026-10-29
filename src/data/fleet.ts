import { BASE_PERF, Perf } from '../sim/boat';

/**
 * Flotte IMOCA de la Route du Rhum – Destination Guadeloupe 2026, d'après les listes d'engagés
 * publiées par l'organisation et la presse spécialisée (octobre 2026).
 * La génération des bateaux et le niveau des skippers sont des estimations de jeu ;
 * les couleurs sont indicatives.
 */

/** new = foiler de dernière génération ; foil = foiler plus ancien ; dagger = dérives droites */
export type Gen = 'new' | 'foil' | 'dagger';

export interface FleetEntry {
  id: string;
  skipper: string;
  boat: string;
  nat: string;
  gen: Gen;
  /** 0 à 1 : précision à la barre, choix de route, réactivité aux voiles */
  skill: number;
  color: string;
  dark: boolean;
}

export const GEN_LABEL: Record<Gen, string> = {
  new: 'Foiler dernière génération',
  foil: 'Foiler',
  dagger: 'Dérives droites',
};

/** Écart de performance de chaque génération par rapport à un IMOCA neuf. */
export function genPerf(g: Gen): Perf {
  const p = { ...BASE_PERF, imoca: 1 };
  if (g === 'foil') {
    p.up -= 0.01;
    p.reach -= 0.06;
    p.down -= 0.06;
    p.heavy -= 0.02;
  } else if (g === 'dagger') {
    p.up -= 0.02;
    p.reach -= 0.16;
    p.down -= 0.17;
    p.light += 0.02;
    p.heavy -= 0.05;
    p.fragility -= 0.3;
    p.drain -= 0.2;
  }
  return p;
}

const E = (id: string, skipper: string, boat: string, nat: string, gen: Gen, skill: number, color: string, dark = false): FleetEntry => ({ id, skipper, boat, nat, gen, skill, color, dark });

export const IMOCA_RHUM_2026: FleetEntry[] = [
  E('beyou', 'Jérémie Beyou', 'Charal', 'FRA', 'new', 0.95, '#22252B'),
  E('goodchild', 'Sam Goodchild', 'Macif Santé Prévoyance', 'GBR', 'new', 0.92, '#1D5FBF'),
  E('simon', 'Sébastien Simon', 'Groupe Dubreuil', 'FRA', 'new', 0.9, '#D7263D'),
  E('beccaria', 'Ambrogio Beccaria', 'Allagrande Mapei', 'ITA', 'new', 0.88, '#0E7AD6'),
  E('herrmann', 'Boris Herrmann', 'Team Malizia', 'GER', 'new', 0.86, '#5B2A86'),
  E('tripon', 'Armel Tripon', 'Les P’tits Doudous', 'FRA', 'new', 0.82, '#FFC93C', true),
  E('bonafous', 'Élodie Bonafous', 'Association Petits Princes – Quéguiner', 'FRA', 'foil', 0.82, '#3FB950', true),
  E('dorange', 'Violette Dorange', 'Initiatives-Cœur', 'FRA', 'foil', 0.8, '#E5375A'),
  E('horeau', 'Corentin Horeau', 'MACSF', 'FRA', 'foil', 0.8, '#2B6CD4'),
  E('clapcich', 'Francesca Clapcich', '11th Hour Racing', 'ITA', 'foil', 0.76, '#14A39C', true),
  E('amedeo', 'Fabrice Amedeo', 'Team FDJ United WeWise', 'FRA', 'foil', 0.7, '#3D5AFE'),
  E('beaudart', 'Davy Beaudart', 'Bureau Vallée', 'FRA', 'foil', 0.7, '#C6D82F', true),
  E('boissieres', 'Arnaud Boissières', 'APRIL Marine', 'FRA', 'foil', 0.66, '#00A88F', true),
  E('attwell', 'Pierre-Louis Attwell', 'Resilient', 'FRA', 'foil', 0.62, '#8BC34A', true),
  E('garnier', 'Maël Garnier', 'DeVenir', 'FRA', 'dagger', 0.66, '#FF6F59', true),
  E('marsset', 'Sébastien Marsset', 'Foussier', 'FRA', 'dagger', 0.62, '#7A3FB0'),
  E('heer', 'Oliver Heer', 'Embrace the Challenge', 'SUI', 'dagger', 0.62, '#D52B1E'),
  E('cousin', 'Manuel Cousin', 'Coup de Pouce', 'FRA', 'dagger', 0.6, '#F28C28', true),
  E('destais', 'Nicolas d’Estais', 'Café Joyeux', 'FRA', 'dagger', 0.56, '#F7D046', true),
  E('daramy', 'Jean-Baptiste Daramy', 'ANETT-KALHYGE', 'FRA', 'dagger', 0.56, '#4FC3F7', true),
  E('shawyer', 'Scott Shawyer', 'Canada Ocean Racing – Be Water Positive', 'CAN', 'dagger', 0.56, '#B0142B'),
  E('marais', 'Robin Marais', 'Bateau à confirmer', 'FRA', 'dagger', 0.54, '#9AA5B1', true),
  E('suzuki', 'Masa Suzuki', 'Milai 22', 'JPN', 'dagger', 0.5, '#E8ECEF', true),
];

/** Nom court affiché sur la carte : « J. Beyou ». */
export function shortName(full: string): string {
  const parts = full.split(' ');
  if (parts.length < 2) return full;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

export const FLAG: Record<string, string> = {
  FRA: '🇫🇷',
  GBR: '🇬🇧',
  ITA: '🇮🇹',
  GER: '🇩🇪',
  SUI: '🇨🇭',
  CAN: '🇨🇦',
  JPN: '🇯🇵',
};
