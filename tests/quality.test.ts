import { describe, expect, it } from 'vitest';
import { FrameGate, QUALITIES, qualityFrom, qualitySettings } from '../src/render/quality';

/** nombre d'images dessinées en `seconds` avec un écran à `hz`, rendu limité à `fps` */
function drawn(hz: number, fps: number, seconds = 10, jitter = 0) {
  const gate = new FrameGate(fps);
  let n = 0;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i < hz * seconds; i++) if (gate.ready((i * 1000) / hz + jitter * rand())) n++;
  return n;
}

describe('cadence d’affichage', () => {
  it('un écran 120 Hz ne dessine que 60 images par seconde', () => {
    expect(Math.abs(drawn(120, 60) - 600)).toBeLessThan(10);
  });

  it('un écran 60 Hz dessine toutes ses images, même avec des à-coups', () => {
    expect(drawn(60, 60, 10, 1.5)).toBeGreaterThan(590);
  });

  it('un écran 144 Hz tient 60 images par seconde en moyenne', () => {
    expect(Math.abs(drawn(144, 60) - 600)).toBeLessThan(15);
  });

  it('en économie : 30 images par seconde', () => {
    expect(Math.abs(drawn(60, 30) - 300)).toBeLessThan(5);
    expect(Math.abs(drawn(120, 30) - 300)).toBeLessThan(5);
  });

  it('après une pause (onglet en arrière-plan), il redessine tout de suite', () => {
    const gate = new FrameGate(60);
    expect(gate.ready(0)).toBe(true);
    expect(gate.ready(5000)).toBe(true);
  });
});

describe('qualité graphique', () => {
  const at = (dpr: number, small = false) => QUALITIES.map((q) => qualitySettings(q, dpr, small));

  it('de haute à économie, chaque réglage coûte moins cher', () => {
    const [hi, mid, eco] = at(2);
    for (const [a, b] of [[hi, mid], [mid, eco]]) {
      expect(a.pixelRatio).toBeGreaterThan(b.pixelRatio);
      expect(a.fps).toBeGreaterThanOrEqual(b.fps);
      expect(a.ripples).toBeGreaterThan(b.ripples);
      expect(a.pipFps).toBeGreaterThan(b.pipFps);
      expect(a.windParticles).toBeGreaterThanOrEqual(b.windParticles);
    }
    expect(hi.bloom).toBe(true);
    expect(mid.bloom).toBe(false);
    expect(eco.bloom).toBe(false);
    expect(eco.fps).toBe(30);
  });

  it('jamais plus de 60 images par seconde, même en haute qualité', () => {
    for (const s of at(2)) expect(s.fps).toBeLessThanOrEqual(60);
  });

  it('jamais plus fin que l’écran', () => {
    for (const s of at(1)) expect(s.pixelRatio).toBeLessThanOrEqual(1);
    for (const s of at(1.25)) expect(s.pixelRatio).toBeLessThanOrEqual(1.25);
  });

  it('sur petit écran, la mer reste allégée et la fenêtre 3D lente', () => {
    for (const s of at(3, true)) {
      expect(s.ripples).toBeLessThanOrEqual(8);
      expect(s.pipFps).toBeLessThanOrEqual(12);
    }
  });

  it('moyenne par défaut ; le choix enregistré est repris, une valeur inconnue est ignorée', () => {
    expect(qualityFrom(null)).toBe('moyenne');
    expect(qualityFrom('eco')).toBe('eco');
    expect(qualityFrom('haute')).toBe('haute');
    expect(qualityFrom('ultra')).toBe('moyenne');
  });
});
