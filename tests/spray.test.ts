import { describe, expect, it } from 'vitest';
import { Hull } from '../src/render/buoyancy';
import { Spray, SprayInput } from '../src/render/spray';

const flat = () => 0;
/** vent apparent : de tribord vers bâbord, et vers l'arrière (le bateau avance) */
const WIND: [number, number] = [-0.8, 0.9];

/** les gouttes en vol, telles que la carte graphique les reçoit */
function alive(spray: Spray) {
  const pos = spray.points.geometry.getAttribute('position');
  const life = spray.points.geometry.getAttribute('aLife');
  const ps: { x: number; y: number; z: number; age: number }[] = [];
  for (let i = 0; i < pos.count; i++) {
    if (life.getW(i) > 0) ps.push({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i), age: life.getX(i) });
  }
  return ps;
}

function run(spray: Spray, input: SprayInput, seconds: number, each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    each?.(t);
    spray.step(1 / 60, input);
  }
}

describe('embruns d’étrave', () => {
  it('rien à petite vitesse', () => {
    const spray = new Spray();
    run(spray, { hull: new Hull(), water: flat, spd: 5, wind: WIND }, 2);
    expect(alive(spray).length).toBe(0);
  });

  it('rien quand les foils ont sorti l’étrave de l’eau', () => {
    const hull = new Hull();
    hull.y = 0.08;
    const spray = new Spray();
    run(spray, { hull, water: flat, spd: 25, wind: WIND }, 2);
    expect(alive(spray).length).toBe(0);
  });

  it('à vitesse, l’étrave mouillée lance des embruns qui partent sous le vent et vers l’arrière', () => {
    const spray = new Spray();
    // relevé régulier des gouttes déjà avancées dans leur vie
    const old: ReturnType<typeof alive> = [];
    let seen = 0;
    run(spray, { hull: new Hull(), water: flat, spd: 20, wind: WIND }, 4, (t) => {
      if (t < 1 || Math.round(t * 60) % 6) return;
      const ps = alive(spray);
      seen += ps.length;
      old.push(...ps.filter((p) => p.age > 0.5));
    });
    expect(seen).toBeGreaterThan(300);
    expect(old.length).toBeGreaterThan(50);
    const mean = (f: (p: (typeof old)[number]) => number) => old.reduce((s, p) => s + f(p), 0) / old.length;
    expect(mean((p) => p.x)).toBeLessThan(-0.05); // sous le vent (bâbord)
    expect(mean((p) => p.z)).toBeGreaterThan(-0.25); // en arrière de l'étrave
  });

  it('une étrave qui plonge dans une vague lance une gerbe bien plus forte et plus haute', () => {
    const calm = new Spray();
    run(calm, { hull: new Hull(), water: flat, spd: 20, wind: WIND }, 0.6);

    // la vague monte devant le bateau plus vite que l'étrave ne se lève
    let h = 0;
    const slam = new Spray();
    run(slam, { hull: new Hull(), water: (_x, z) => (z < 0 ? h : 0), spd: 20, wind: WIND }, 0.6, (t) => {
      h = Math.min(0.06, t * 0.25);
    });

    expect(alive(slam).length).toBeGreaterThan(3 * alive(calm).length);
    const top = (s: Spray) => Math.max(...alive(s).map((p) => p.y));
    expect(top(slam)).toBeGreaterThan(top(calm) + 0.03);
  });

  it('la gerbe est à la mesure du choc : un plongeon bien plus qu’une étrave qui entre dans la vague', () => {
    const splash = (speed: number) => {
      let h = 0;
      const spray = new Spray();
      run(spray, { hull: new Hull(), water: (_x, z) => (z < 0 ? h : 0), spd: 20, wind: WIND }, 0.2, (t) => {
        h = t * speed;
      });
      return alive(spray).length;
    };
    // étrave qui entre dans la vague (≈ 2 m/s) puis qui y plonge (≈ 8 m/s)
    expect(splash(0.45)).toBeGreaterThan(3 * splash(0.12));
  });

  it('les gouttes qui retombent disparaissent dans l’eau', () => {
    const spray = new Spray();
    const water = (x: number, z: number) => 0.02 * Math.sin(x * 9 + z * 5);
    run(spray, { hull: new Hull(), water, spd: 22, wind: WIND }, 4);
    for (const p of alive(spray)) expect(p.y).toBeGreaterThan(water(p.x, p.z) - 0.005);
  });

  it('reste raisonnable après un long pas (onglet qui se réveille)', () => {
    const spray = new Spray();
    const input = { hull: new Hull(), water: flat, spd: 25, wind: WIND };
    run(spray, input, 1);
    spray.step(5, input);
    for (const p of alive(spray)) expect(Math.hypot(p.x, p.y, p.z)).toBeLessThan(3);
  });
});
