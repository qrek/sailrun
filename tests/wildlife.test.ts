import { describe, expect, it } from 'vitest';
import { halfBeam } from '../src/render/buoyancy';
import { Hull } from '../src/render/buoyancy';
import { Spray } from '../src/render/spray';
import { DOLPHIN_MAX_KN, Sightings, WHALE_HALF, dolphinPod, dolphinPose, presence, whaleBlows, whaleEnd, whalePose, whaleSpec } from '../src/render/wildlife';

/** tirage reproductible */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** les apparitions sur une durée donnée */
function watch(s: Sightings, seconds: number, spd: number, day = 1) {
  const starts: { kind: string; at: number }[] = [];
  let busy = 0;
  for (let t = 0; t < seconds; t += 0.5) {
    const k = s.step(0.5, spd, day);
    if (k) starts.push({ kind: k, at: t });
    if (s.current) busy += 0.5;
  }
  return { starts, busy };
}

describe('animaux marins : quand ils apparaissent', () => {
  it('parfois, pas souvent : quelques rencontres par heure, jamais deux à la fois', () => {
    for (const seed of [1, 2, 3]) {
      const s = new Sightings(seeded(seed));
      const { starts, busy } = watch(s, 3 * 3600, 14);
      expect(starts.length).toBeGreaterThan(8);
      expect(starts.length).toBeLessThan(40);
      for (let i = 1; i < starts.length; i++) expect(starts[i].at - starts[i - 1].at).toBeGreaterThan(120);
      // la mer reste vide la plupart du temps
      expect(busy / (3 * 3600)).toBeLessThan(0.3);
    }
  });

  it('des dauphins et des baleines', () => {
    const { starts } = watch(new Sightings(seeded(7)), 3 * 3600, 14);
    expect(starts.some((s) => s.kind === 'dolphins')).toBe(true);
    expect(starts.some((s) => s.kind === 'whale')).toBe(true);
  });

  it('trop vite pour les dauphins : seulement des baleines', () => {
    const { starts } = watch(new Sightings(seeded(3)), 3 * 3600, DOLPHIN_MAX_KN + 6);
    expect(starts.length).toBeGreaterThan(3);
    expect(starts.every((s) => s.kind === 'whale')).toBe(true);
  });

  it('les dauphins décrochent quand le bateau accélère au-delà de ce qu’ils peuvent suivre', () => {
    const s = new Sightings(seeded(4));
    s.trigger('dolphins');
    for (let t = 0; t < 10; t += 0.5) s.step(0.5, 12, 1);
    expect(s.current?.kind).toBe('dolphins');
    for (let t = 0; t < 10; t += 0.5) s.step(0.5, DOLPHIN_MAX_KN + 5, 1);
    expect(s.current).toBeNull();
  });

  it('rien la nuit : on ne les verrait pas', () => {
    const { starts } = watch(new Sightings(seeded(5)), 3600, 14, 0);
    expect(starts.length).toBe(0);
  });
});

describe('dauphins', () => {
  const pod = dolphinPod(seeded(11));

  it('une petite bande, de 3 à 6', () => {
    expect(pod.length).toBeGreaterThanOrEqual(3);
    expect(pod.length).toBeLessThanOrEqual(6);
  });

  it('ils accompagnent l’étrave sans toucher la coque, sous l’eau la plupart du temps, et sautent de temps en temps', () => {
    for (const d of pod) {
      let out = 0;
      let n = 0;
      let top = -1;
      for (let t = 0; t < 60; t += 1 / 30, n++) {
        const p = dolphinPose(d, t, 1, 0.6);
        if (p.dy > 0) out++;
        top = Math.max(top, p.dy);
        expect(Math.abs(p.x)).toBeLessThan(0.5);
        expect(p.z).toBeGreaterThan(-1.1);
        expect(p.z).toBeLessThan(-0.25);
        // près de la surface, jamais dans la coque
        if (p.dy > -0.12) expect(Math.abs(p.x)).toBeGreaterThan(halfBeam(p.z) + 0.03);
      }
      expect(out / n).toBeGreaterThan(0.08);
      expect(out / n).toBeLessThan(0.35);
      expect(top).toBeGreaterThan(0.025);
    }
  });

  it('ils sortent de l’eau le nez en l’air et y rentrent le nez en avant', () => {
    const d = pod[0];
    let up = false;
    let down = false;
    let prev = dolphinPose(d, 0, 1, 0.6);
    for (let t = 1 / 30; t < 20; t += 1 / 30) {
      const p = dolphinPose(d, t, 1, 0.6);
      if (prev.dy <= 0 && p.dy > 0) up = p.pitch > 0.15;
      if (prev.dy > 0 && p.dy <= 0) down = p.pitch < -0.15;
      prev = p;
    }
    expect(up).toBe(true);
    expect(down).toBe(true);
  });

  it('ils arrivent de loin et en profondeur, puis repartent', () => {
    const d = pod[0];
    const far = dolphinPose(d, 0, 0, 0.6);
    expect(Math.hypot(far.x, far.z)).toBeGreaterThan(1.5);
    expect(far.dy).toBeLessThan(-0.15);
    expect(presence(0, 60, 0)).toBe(0);
    expect(presence(30, 60, 0)).toBe(1);
    expect(presence(60, 60, 0)).toBe(0);
  });
});

describe('baleine au loin', () => {
  const specs = [1, 2, 3, 4, 5].map((s) => whaleSpec(seeded(s)));

  it('elle passe au large du bateau', () => {
    for (const w of specs) expect(Math.abs(w.x0)).toBeGreaterThan(12);
  });

  it('elle souffle à chaque remontée', () => {
    for (const w of specs) {
      const blows = whaleBlows(w);
      expect(blows.length).toBe(w.n);
      // au souffle, l'évent est hors de l'eau
      for (const b of blows) expect(whalePose(w, b).blowhole).toBeGreaterThan(0);
    }
  });

  it('on ne voit qu’un dos qui roule, puis la queue quand elle sonde', () => {
    for (const w of specs) {
      const end = whaleEnd(w);
      expect(end).toBeGreaterThan(40);
      expect(end).toBeLessThan(100);
      let seen = 0;
      let n = 0;
      let tail = -1;
      for (let t = 0; t < end; t += 0.1, n++) {
        const p = whalePose(w, t);
        if (p.dy + WHALE_HALF > 0 || p.tail > 0) seen++;
        tail = Math.max(tail, p.tail);
      }
      expect(seen / n).toBeLessThan(0.5);
      expect(tail).toBeGreaterThan(0.1);
      expect(whalePose(w, end).tail).toBeLessThan(0);
      expect(whalePose(w, end).dy + WHALE_HALF).toBeLessThan(0);
    }
  });
});

describe('éclaboussures et souffle', () => {
  it('une bouffée part du point donné et monte', () => {
    const spray = new Spray();
    spray.puff(5, 0.02, -20, { n: 40, up: 0.7, spread: 0.05, size: 0.09, life: 3, mist: 0.9 });
    const input = { hull: new Hull(), water: () => 0, spd: 0, wind: [0, 0] as [number, number] };
    for (let i = 0; i < 20; i++) spray.step(1 / 60, input);
    const pos = spray.points.geometry.getAttribute('position');
    const life = spray.points.geometry.getAttribute('aLife');
    let n = 0;
    for (let i = 0; i < pos.count; i++) {
      if (life.getW(i) <= 0) continue;
      n++;
      expect(Math.hypot(pos.getX(i) - 5, pos.getZ(i) + 20)).toBeLessThan(0.3);
      expect(pos.getY(i)).toBeGreaterThan(0.05);
    }
    expect(n).toBeGreaterThan(30);
  });
});
