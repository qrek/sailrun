/**
 * Flottabilité de la coque (vue immersive) : un corps rigide qui pilonne, tangue et roule sur la houle.
 * Douze sondes réparties sur la carène mesurent l'eau ; chacune pousse selon son enfoncement, jusqu'à ce que
 * son coin de coque sorte de l'eau (il ne porte plus que son poids) ou soit noyé (la poussée plafonne).
 * Les inerties sont réglées pour des périodes propres réalistes (pilonnement ≈ 1,9 s, tangage ≈ 2,2 s,
 * roulis ≈ 3,2 s). Seule la partie mouillée est freinée par l'eau, et par rapport à l'eau qui bouge : passé une
 * crête, l'étrave qui n'est plus portée tombe sous son poids, et le bateau pique du nez dans le creux suivant.
 *
 * Unités : 1 = une longueur de coque (≈ 18 m). Étrave vers -z, tribord vers +x, flottaison au repos en y = 0.
 * Tangage > 0 : étrave levée. Roulis > 0 : tribord levé (comme rotation.x et rotation.z de three.js).
 */

const G = 9.81 / 18; // gravité en longueurs de coque / s²
/** enfoncement de la carène au repos : un coin qui remonte d'autant sort de l'eau */
const DRAFT = 0.05;
/** au-delà, le coin est noyé : la poussée n'augmente plus */
const FREEBOARD = 0.12;
const K = G / DRAFT; // raideur de la poussée, par unité de masse

// demi-largeur de la flottaison le long de la coque : étroite à l'étrave, large à l'arrière (carène d'IMOCA)
const STATIONS: [number, number][] = [
  [-0.42, 0.03],
  [-0.26, 0.07],
  [-0.08, 0.11],
  [0.12, 0.13],
  [0.3, 0.14],
  [0.46, 0.14],
];
const TOTAL = STATIONS.reduce((s, [, b]) => s + 2 * b, 0);
/** sondes : position sur la carène et part de la flottaison qu'elles portent */
const PROBES = STATIONS.flatMap(([z, b]) => [-1, 1].map((side) => ({ x: side * b, z, w: b / TOTAL })));

const omega = (period: number) => (2 * Math.PI) / period;
const W_HEAVE = Math.sqrt(K);
const W_PITCH = omega(2.2);
const W_ROLL = omega(3.2);
// inerties (par unité de masse) qui donnent ces périodes avec la raideur des sondes
const I_PITCH = (K * PROBES.reduce((s, p) => s + p.w * p.z * p.z, 0)) / (W_PITCH * W_PITCH);
const I_ROLL = (K * PROBES.reduce((s, p) => s + p.w * p.x * p.x, 0)) / (W_ROLL * W_ROLL);
// amortissement (fraction de l'amortissement critique)
/** l'eau, sur chaque sonde mouillée : ≈ 0,4 en pilonnement quand toute la carène est dans l'eau */
const C_WATER = 2 * 0.4 * W_HEAVE;
/** tangage : un peu les safrans et les voiles, beaucoup les foils quand ils portent */
const C_PITCH = 2 * 0.08 * W_PITCH;
const C_FOIL = 2 * 0.6 * W_PITCH;
/** roulis : la quille, les foils et les voiles, toujours */
const C_ROLL = 2 * 0.2 * W_ROLL;
/** assiette visée par les foils et les plans porteurs des safrans : étrave un peu levée (≈ 3,5°) */
const FOIL_TRIM = 0.06;
/** le foil porte de moins en moins en approchant de la surface : plus rien quand la coque est montée d'autant */
const FOIL_RISE = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** demi-largeur de la flottaison à la station `z` (0 au-delà de l'étrave et du tableau arrière) */
export function halfBeam(z: number): number {
  if (z < STATIONS[0][0] - 0.06 || z > STATIONS[STATIONS.length - 1][0]) return 0;
  if (z < STATIONS[0][0]) return STATIONS[0][1] * (1 - (STATIONS[0][0] - z) / 0.06);
  let i = 0;
  while (z > STATIONS[i + 1][0]) i++;
  const [z0, b0] = STATIONS[i];
  const [z1, b1] = STATIONS[i + 1];
  return b0 + ((b1 - b0) * (z - z0)) / (z1 - z0);
}

export class Hull {
  y = 0;
  vy = 0;
  pitch = 0;
  vp = 0;
  roll = 0;
  vr = 0;
  /** l'eau sous chaque sonde au pas précédent, pour sa vitesse verticale */
  private last: number[] | null = null;

  /** hauteur de la carène sous un point du bateau (repère du bateau) */
  keel(x: number, z: number): number {
    return this.y - z * Math.sin(this.pitch) + x * Math.sin(this.roll);
  }

  /**
   * Avance de `dt` secondes. `surf(x, z)` donne la hauteur de l'eau sous un point de la carène (repère du bateau).
   * `lift` : part du poids que les foils peuvent porter (0 = coque seule, 0,5 = pleine vitesse au portant).
   */
  step(dt: number, surf: (x: number, z: number) => number, lift = 0): void {
    // l'eau ne change pas pendant le pas : on mesure une fois, puis petits pas d'intégration
    const water = PROBES.map((p) => surf(p.x, p.z));
    const last = this.last;
    // bornée : quand l'état de la mer change d'un coup (vent qui tourne, vue rouverte), l'eau ne « saute » pas
    const rise = water.map((w, i) => (last && dt > 0 ? clamp((w - last[i]) / dt, -0.5, 0.5) : 0));
    this.last = water;
    let left = Math.min(dt, 0.25);
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 120);
      left -= h;
      const sp = Math.sin(this.pitch);
      const sr = Math.sin(this.roll);
      const cp = Math.cos(this.pitch);
      const cr = Math.cos(this.roll);
      let f = 0;
      let tp = 0;
      let tr = 0;
      PROBES.forEach((p, i) => {
        const keel = this.y - p.z * sp + p.x * sr;
        const depth = water[i] - keel;
        // freinée par l'eau seulement là où elle est mouillée, selon sa vitesse par rapport à l'eau
        const wet = clamp(depth / DRAFT + 1, 0, 1);
        const v = this.vy - p.z * cp * this.vp + p.x * cr * this.vr - rise[i];
        const push = K * p.w * clamp(depth, -DRAFT, FREEBOARD) - C_WATER * p.w * wet * v;
        f += push;
        tp -= push * p.z;
        tr += push * p.x;
      });
      // les foils allègent le bateau (sans couple : ils portent près du centre de gravité) et, avec les safrans,
      // tiennent l'assiette même quand l'étrave sort de l'eau
      const foil = lift * clamp(1 - this.y / FOIL_RISE, 0, 1.5);
      const ay = f + G * foil;
      const ap = tp / I_PITCH + W_PITCH * W_PITCH * lift * (FOIL_TRIM - this.pitch) - (C_PITCH + C_FOIL * lift) * this.vp;
      const ar = tr / I_ROLL - C_ROLL * this.vr;
      this.vy += ay * h;
      this.vp += ap * h;
      this.vr += ar * h;
      this.y += this.vy * h;
      this.pitch += this.vp * h;
      this.roll += this.vr * h;
    }
  }
}
