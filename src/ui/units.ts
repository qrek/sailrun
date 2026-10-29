import { fmtInt } from '../sim/geo';

/** Unité des distances affichées : kilomètres (par défaut) ou milles nautiques. */
export type DistUnit = 'km' | 'nm';
const KEY = 'sailgame.unit.v1';
let unit: DistUnit = (() => {
  try {
    return localStorage.getItem(KEY) === 'nm' ? 'nm' : 'km';
  } catch {
    return 'km';
  }
})();

export const distUnit = () => unit;

export function setDistUnit(u: DistUnit) {
  unit = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* rien */
  }
}

/** Distance en milles nautiques -> nombre dans l'unité choisie. */
export const toUnit = (nm: number) => (unit === 'km' ? nm * 1.852 : nm);
export const unitLabel = (short = true) => (unit === 'km' ? 'km' : short ? 'mi' : 'milles');

/** « 2 026 km » ou « 1 094 milles ». */
export function fmtDist(nm: number, short = false): string {
  return `${fmtInt(toUnit(nm))} ${unitLabel(short)}`;
}
