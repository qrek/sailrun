import { D2R, R2D, smooth } from './geo';

/**
 * Source de vent. Pour l'instant un modèle synthétique crédible de l'Atlantique Nord.
 * Plus tard : une implémentation qui lit des grilles GFS converties (voir README).
 * `t` = heures depuis l'origine météo de la course.
 * Retourne [u, v] en nœuds : u vers l'est, v vers le nord.
 */
export interface WindSource {
  at(lon: number, lat: number, t: number): [number, number];
  /** Centres d'action (pour dessiner les nuages), si la source les connaît. */
  systems?(t: number): { high: [number, number]; low: [number, number] };
}

export class SyntheticWind implements WindSource {
  /** `phase` décale la météo pour que chaque course ait sa propre situation. */
  constructor(private phase = 0) {}

  systems(t0: number): { high: [number, number]; low: [number, number] } {
    const t = t0 + this.phase;
    return {
      high: [-32 + 4 * Math.sin(t / 60), 34 + 2.5 * Math.sin(t / 41)],
      low: [-68 + ((0.55 * t) % 80), 51 + 4 * Math.sin(t / 33)],
    };
  }

  at(lon: number, lat: number, t0: number): [number, number] {
    const t = t0 + this.phase;
    const cl = Math.cos(lat * D2R);
    let u = 0;
    let v = 0;

    // Anticyclone des Açores : rotation horaire, légère divergence, il se balade un peu
    const hx = -32 + 4 * Math.sin(t / 60);
    const hy = 34 + 2.5 * Math.sin(t / 41);
    let dx = (lon - hx) * cl;
    let dy = lat - hy;
    let r = Math.hypot(dx, dy) + 1e-6;
    const R1 = 13;
    const s1 = 20 * (r / R1) * Math.exp(1 - r / R1);
    u += s1 * (dy / r) + 0.25 * s1 * (dx / r);
    v += s1 * (-dx / r) + 0.25 * s1 * (dy / r);

    // Alizés de nord-est entre 8° et 28° N
    const tb = smooth(6, 12, lat) * (1 - smooth(22, 30, lat));
    u += -9 * tb;
    v += -3 * tb;

    // Flux d'ouest au nord
    const wb = smooth(38, 50, lat);
    u += 11 * wb;
    v += 1.5 * wb;

    // Dépression qui traverse d'ouest en est par le nord (rotation anti-horaire, convergence)
    const lx = -68 + ((0.55 * t) % 80);
    const ly = 51 + 4 * Math.sin(t / 33);
    dx = (lon - lx) * cl;
    dy = lat - ly;
    r = Math.hypot(dx, dy) + 1e-6;
    const R2 = 6.5;
    const s2 = 30 * (r / R2) * Math.exp(1 - r / R2);
    u += s2 * (-dy / r) - 0.3 * s2 * (dx / r);
    v += s2 * (dx / r) - 0.3 * s2 * (dy / r);

    // Petites variations pour que le vent vive
    u += 2.2 * Math.sin(lon * 0.31 + t * 0.09) * Math.cos(lat * 0.27);
    v += 2.2 * Math.cos(lon * 0.23 - t * 0.07) * Math.sin(lat * 0.19 + 1);

    // Pot-au-noir vers 6° N
    const dd = 1 - 0.82 * Math.exp(-(((lat - 6.5) / 3.2) ** 2));
    return [u * dd, v * dd];
  }
}

/** Direction d'où vient le vent (°, convention météo). */
export function windFrom(u: number, v: number): number {
  return (Math.atan2(-u, -v) * R2D + 360) % 360;
}
