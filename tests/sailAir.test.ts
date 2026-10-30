import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAIN_BATTENS, SailAir, camberAt, flutter, gustAt, sailAir, telltale } from '../src/render/sailAir';
import { BoatRig, trimBoat } from '../src/render/boatModel';

const windy = (time: number, gust = 1): SailAir => ({ time, strength: 1, gust });
const calm = (time: number): SailAir => ({ time, strength: 0, gust: 1 });

/** amplitude d'un signal sur une minute */
function swing(f: (t: number) => number, seconds = 60) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t < seconds; t += 1 / 60) {
    const y = f(t);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return hi - lo;
}

describe('le vent dans les voiles', () => {
  it('les risées vont et viennent en quelques secondes, autour du vent moyen', () => {
    const gs: number[] = [];
    for (let t = 0; t < 120; t += 1 / 60) gs.push(gustAt(t));
    const mean = gs.reduce((s, g) => s + g, 0) / gs.length;
    const sd = Math.sqrt(gs.reduce((s, g) => s + (g - mean) ** 2, 0) / gs.length);
    expect(Math.abs(mean - 1)).toBeLessThan(0.02);
    expect(sd).toBeGreaterThan(0.05);
    expect(Math.min(...gs)).toBeGreaterThan(0.78);
    expect(Math.max(...gs)).toBeLessThan(1.22);
    // pas d'à-coups d'une image à l'autre
    const jump = Math.max(...gs.slice(1).map((g, i) => Math.abs(g - gs[i])));
    expect(jump).toBeLessThan(0.01);
  });

  it('le vent apparent compte : au près la toile est chargée, au portant beaucoup moins', () => {
    expect(sailAir(0, 20, 40, 14).strength).toBeGreaterThan(2 * sailAir(0, 20, 160, 18).strength);
  });

  it('sans vent, la toile ne bouge pas', () => {
    for (const kind of ['main', 'jib', 'spi'] as const) {
      expect(swing((t) => flutter(kind, 0.9, 0.5, calm(t)))).toBe(0);
      expect(camberAt(kind, 0.5, 0.5, calm(3))).toBe(1);
    }
  });

  it('la chute bat, le guindant reste tenu', () => {
    const leech = swing((t) => flutter('jib', 1, 0.6, windy(t)));
    const luff = swing((t) => flutter('jib', 0.1, 0.6, windy(t)));
    expect(leech).toBeGreaterThan(0.004);
    expect(leech).toBeGreaterThan(4 * luff);
    expect(swing((t) => flutter('jib', 0, 0.6, windy(t)))).toBe(0);
  });

  it('plus de vent, plus de battement', () => {
    const at = (strength: number) => swing((t) => flutter('jib', 1, 0.6, { time: t, strength, gust: 1 }));
    expect(at(1)).toBeGreaterThan(2 * at(0.3));
  });

  it('grand-voile : les lattes tiennent la toile, elle ne bat qu’entre elles', () => {
    for (const v of MAIN_BATTENS) expect(swing((t) => flutter('main', 1, v, windy(t)))).toBe(0);
    const mid = (MAIN_BATTENS[2] + MAIN_BATTENS[3]) / 2;
    expect(swing((t) => flutter('main', 1, mid, windy(t)))).toBeGreaterThan(0.002);
  });

  it('en risée la voile se creuse, dans la molle elle s’aplatit', () => {
    const at = (gust: number) => camberAt('jib', 0.5, 0.5, windy(0, gust));
    expect(at(1.15)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThan(at(0.85));
  });

  it('le guindant du spi se replie de temps en temps, puis se regonfle', () => {
    let folded = 0;
    let n = 0;
    for (let t = 0; t < 120; t += 1 / 30, n++) if (camberAt('spi', 0.03, 0.5, windy(t)) < 0) folded++;
    expect(folded).toBeGreaterThan(0);
    expect(folded / n).toBeLessThan(0.3);
  });

  it('les penons filent vers l’arrière dans le vent et pendent quand il n’y en a pas', () => {
    const [along, , drop] = telltale(1, windy(0), 0);
    expect(along).toBeGreaterThan(0.85);
    expect(Math.abs(drop)).toBeLessThan(0.1);
    const [, , hang] = telltale(1, calm(0), 0);
    expect(hang).toBeLessThan(-0.6);
    expect(telltale(0, windy(2), 1)).toEqual([0, 0, 0]); // attaché à la chute
  });

  it('les penons battent au vent, surtout au bout', () => {
    const tail = swing((t) => telltale(1, windy(t), 0)[1]);
    const mid = swing((t) => telltale(0.3, windy(t), 0)[1]);
    expect(tail).toBeGreaterThan(0.15);
    expect(tail).toBeGreaterThan(2 * mid);
  });

  it('en risée le bateau gîte davantage', () => {
    const heel = (gust: number) => {
      const g = () => new THREE.Group();
      const rig = { main: g(), jib: g(), heel: g() } as unknown as BoatRig;
      trimBoat(rig, 60, 22, gust);
      return (rig.heel.rotation.z * 180) / Math.PI;
    };
    expect(heel(1.15) - heel(1)).toBeGreaterThan(2);
    expect(heel(1) - heel(0.85)).toBeGreaterThan(2);
  });
});
