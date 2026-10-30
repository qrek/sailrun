/**
 * Le vent dans la toile (vue immersive) : risées qui vont et viennent, voile qui se creuse et s'aplatit avec elles,
 * chute qui bat, guindant du spi qui se replie et se regonfle, penons qui filent ou pendent.
 * Fonctions pures du temps et du vent : le modèle du bateau les applique à ses voiles à chaque image.
 *
 * Sur une voile, u va du guindant (0) à la chute (1) et v du bas (0) au haut (1). Déplacements en longueurs de
 * coque, perpendiculaires à la toile.
 */

export type Cloth = 'main' | 'jib' | 'spi';

export interface SailAir {
  /** secondes */
  time: number;
  /** charge du vent apparent dans la toile : 0 (calme) → 1 (30 nœuds et plus) */
  strength: number;
  /** risée : 1 = vent moyen, plus = risée, moins = molle */
  gust: number;
}

/** hauteur des lattes de la grand-voile, de la bôme vers la têtière */
export const MAIN_BATTENS = [0.14, 0.3, 0.46, 0.62, 0.78, 0.92];

const TAU = 2 * Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Risées : quelques ondulations de périodes sans rapport entre elles, autour du vent moyen (± 20 % au plus). */
export function gustAt(t: number): number {
  return (
    1 +
    0.07 * Math.sin((TAU * t) / 9.7 + 0.8) +
    0.05 * Math.sin((TAU * t) / 5.3 + 2.1) +
    0.03 * Math.sin((TAU * t) / 3.1 + 4) +
    0.04 * Math.sin((TAU * t) / 13.9 + 1.2)
  );
}

/** L'air dans les voiles d'un bateau : vent réel (nœuds), angle au vent (°), vitesse du bateau (nœuds). */
export function sailAir(time: number, tws: number, twa: number, spd: number): SailAir {
  const c = Math.cos((twa * Math.PI) / 180);
  const aws = Math.sqrt(Math.max(0, tws * tws + spd * spd + 2 * tws * spd * c));
  return { time, strength: clamp(aws / 30, 0, 1), gust: gustAt(time) };
}

/** La toile se creuse en risée et s'aplatit dans la molle ; le vrillage suit (la chute s'ouvre). */
export function breath(air: SailAir): number {
  return 1 + 0.6 * (air.gust - 1) * Math.min(1, air.strength * 2);
}

/** Le guindant du spi qui se replie : 0 = bien gonflé, 1 = replié. Plus souvent dans les molles. */
function curl(air: SailAir): number {
  const t = air.time;
  const n = 0.5 + 0.35 * Math.sin((TAU * t) / 4.3 + 0.5) + 0.2 * Math.sin((TAU * t) / 2.9 + 1.7) - 1.5 * (air.gust - 1);
  return smoothstep(0.62, 0.95, n) * Math.min(1, air.strength * 2);
}

/** Facteur appliqué au creux de la toile en (u, v) ; négatif : la toile se replie. */
export function camberAt(kind: Cloth, u: number, v: number, air: SailAir): number {
  let k = breath(air);
  if (kind === 'spi') k *= 1 - 2.2 * curl(air) * (1 - smoothstep(0, 0.3, u)) * (0.4 + 0.6 * Math.sin(Math.PI * v));
  return k;
}

/** La grand-voile ne bat qu'entre ses lattes (et pas le long de la bôme) : 0 sur une latte, 1 à mi-chemin. */
function betweenBattens(v: number): number {
  let d = v;
  for (const b of MAIN_BATTENS) d = Math.min(d, Math.abs(v - b));
  return Math.min(1, d / 0.08);
}

/**
 * Battement de la toile en (u, v) : la chute vibre vite (quelques hertz, une onde qui monte le long de la chute),
 * le reste ondule doucement ; rien au guindant, tenu par le mât ou l'étai.
 */
export function flutter(kind: Cloth, u: number, v: number, air: SailAir): number {
  if (air.strength <= 0) return 0;
  const t = air.time;
  const s = air.strength * (0.6 + 0.4 * air.gust);
  const fast = 0.0055 * smoothstep(0.55, 1, u) * (0.5 + 0.5 * v) * Math.sin(TAU * 5.5 * t - v * 22 + u * 3);
  const slow = 0.0016 * u * Math.sin(TAU * 0.8 * t + u * 4 + v * 6);
  return s * (kind === 'main' ? betweenBattens(v) : 1) * (fast + slow);
}

/**
 * Forme d'un penon accroché à la chute, au point `s` de sa longueur (0 = attache, 1 = bout) : [vers l'arrière,
 * sur le côté, vers le haut], en longueurs de penon. Il file tendu dans le vent et bat ; sans vent, il pend.
 */
export function telltale(s: number, air: SailAir, phase: number): [number, number, number] {
  if (s <= 0) return [0, 0, 0];
  const lift = Math.min(1, air.strength * 3);
  const sag = 1 - lift;
  const t = air.time;
  const flap = 0.22 * Math.pow(s, 1.5) * (0.3 + 0.7 * lift) * Math.sin(TAU * (2 + 5 * air.strength) * t - s * 7 + phase);
  const wander = 0.05 * s * Math.sin(TAU * 0.4 * t + phase);
  return [s * (1 - 0.8 * sag), flap + wander, -s * 0.95 * sag * (0.3 + 0.7 * s)];
}
