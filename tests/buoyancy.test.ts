import { describe, expect, it } from 'vitest';
import { Wave, seaState, surfaceAt } from '../src/render/immersive';
import { Hull } from '../src/render/buoyancy';

const D2R = Math.PI / 180;

/** La surface telle que le shader la dessine : chaque point de l'eau est décalé (Gerstner), puis monté. */
function displaced(ws: Wave[], x: number, z: number, t: number): [number, number, number] {
  let dx = 0;
  let dz = 0;
  let h = 0;
  for (const w of ws) {
    const ph = w.k * (w.dx * x + w.dz * z) - w.w * t;
    dx += w.q * w.a * w.dx * Math.cos(ph);
    dz += w.q * w.a * w.dz * Math.cos(ph);
    h += w.a * Math.sin(ph);
  }
  return [x + dx, z + dz, h];
}

/** Une houle simple : une seule vague, bien plus longue que le bateau. */
const swell = (a: number, len: number): Wave[] => {
  const k = (2 * Math.PI) / len;
  return [{ dx: 0, dz: -1, k, a, q: 0, w: Math.sqrt((9.81 / 18) * k) }];
};

describe('hauteur de la mer', () => {
  it('donne la hauteur de la surface dessinée, crêtes décalées comprises (mer formée, grosse houle)', () => {
    const ws = seaState(28, 0, -1, 2.5);
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const [x, z, h] = displaced(ws, -6 + (i % 20) * 0.61, -6 + Math.floor(i / 20) * 0.63, i * 0.37);
      worst = Math.max(worst, Math.abs(surfaceAt(ws, x, z, i * 0.37) - h));
    }
    expect(worst).toBeLessThan(1e-4);
  });
});

describe('flottabilité de la coque', () => {
  it('lâchée au-dessus d’une mer plate, elle retombe et se pose à sa flottaison', () => {
    const hull = new Hull();
    hull.y = 0.2;
    hull.pitch = 0.1;
    hull.roll = -0.15;
    for (let i = 0; i < 600; i++) hull.step(1 / 60, () => 0);
    expect(Math.abs(hull.y)).toBeLessThan(0.002);
    expect(Math.abs(hull.pitch)).toBeLessThan(0.002);
    expect(Math.abs(hull.roll)).toBeLessThan(0.005);
  });

  it('suit une longue houle : monte avec la vague et lève l’étrave quand l’eau monte devant', () => {
    const ws = swell(0.06, 6);
    const hull = new Hull();
    let t = 0;
    const ys: number[] = [];
    const hs: number[] = [];
    const ps: number[] = [];
    const slopes: number[] = [];
    for (let i = 0; i < 1200; i++) {
      hull.step(1 / 60, (x, z) => surfaceAt(ws, x, z, t));
      t += 1 / 60;
      if (i < 300) continue; // le temps de s'installer
      ys.push(hull.y);
      hs.push(surfaceAt(ws, 0, 0, t));
      ps.push(hull.pitch);
      slopes.push(surfaceAt(ws, 0, -0.3, t) - surfaceAt(ws, 0, 0.3, t)); // > 0 : l'eau est plus haute à l'étrave
    }
    expect(corr(ys, hs)).toBeGreaterThan(0.9);
    expect(corr(ps, slopes)).toBeGreaterThan(0.8);
  });

  it('passé la crête, rien ne retient l’étrave en l’air : elle bascule dans le creux', () => {
    const hull = new Hull();
    hull.pitch = 0.1; // étrave levée par la vague qui vient de passer sous le milieu du bateau
    for (let i = 0; i < 60; i++) hull.step(1 / 60, (_x, z) => (z < 0 ? -0.15 : 0));
    expect(hull.pitch).toBeLessThan(-5 * D2R);
  });

  it('au près dans une mer formée, le bateau pique du nez après chaque crête', () => {
    const ws = seaState(22, Math.sin(45 * D2R), -Math.cos(45 * D2R), 1.8);
    const hull = new Hull();
    const v = 13 * 0.0286 * 1.4; // vitesse du bateau dans la vue, en longueurs / s
    let lowest = 0;
    let fastest = 0;
    let prev = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const t = i / 60;
      hull.step(1 / 60, (x, z) => surfaceAt(ws, x, z - v * t, t));
      if (i > 600) {
        lowest = Math.min(lowest, hull.pitch);
        fastest = Math.min(fastest, (hull.pitch - prev) * 60);
      }
      prev = hull.pitch;
    }
    expect(lowest).toBeLessThan(-8 * D2R);
    expect(fastest).toBeLessThan(-35 * D2R); // en degrés par seconde : une vraie bascule, pas un balancement
  });

  it('les foils soulagent la coque : elle flotte plus haut à pleine vitesse', () => {
    const slow = new Hull();
    const fast = new Hull();
    for (let i = 0; i < 600; i++) {
      slow.step(1 / 60, () => 0, 0);
      fast.step(1 / 60, () => 0, 0.6);
    }
    expect(fast.y).toBeGreaterThan(slow.y + 0.01);
    expect(fast.pitch).toBeGreaterThan(0); // l'étrave se lève un peu
  });

  it('reste stable même avec de grands pas de temps (onglet qui se réveille)', () => {
    const hull = new Hull();
    const ws = seaState(35, 0.6, -0.8, 3);
    let t = 0;
    for (let i = 0; i < 200; i++) {
      hull.step(0.5, (x, z) => surfaceAt(ws, x, z, t));
      t += 0.5;
    }
    expect(Number.isFinite(hull.y) && Math.abs(hull.y) < 1).toBe(true);
    expect(Math.abs(hull.pitch)).toBeLessThan(0.8);
    expect(Math.abs(hull.roll)).toBeLessThan(0.8);
  });
});

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}
