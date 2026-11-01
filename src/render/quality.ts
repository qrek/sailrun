/**
 * Qualité graphique : ce que coûte une image. Sur un écran Retina à 120 Hz, tout dessiner en pleine résolution
 * 120 fois par seconde fait souffler l'ordinateur pour rien. Trois niveaux, au choix dans les options :
 * - haute : résolution de l'écran (×2 au plus), halo du soleil sur l'eau, mer la plus fine ;
 * - moyenne (par défaut) : 3D en ×1,5, sans halo, mer un peu moins détaillée — l'interface reste nette ;
 * - éco : 3D en ×1, 30 images par seconde, traits de vent allégés.
 * Jamais plus de 60 images par seconde : la voile n'a pas besoin de plus.
 */

export type Quality = 'haute' | 'moyenne' | 'eco';

export const QUALITIES: Quality[] = ['haute', 'moyenne', 'eco'];

export interface QualitySettings {
  /** images par seconde au plus */
  fps: number;
  /** densité de pixels de la 3D (vue immersive, globe, garage) */
  pixelRatio: number;
  /** halo lumineux sur les reflets du soleil */
  bloom: boolean;
  /** couches de rides fines dans le shader de la mer */
  ripples: number;
  /** cadence de la fenêtre 3D posée sur la carte */
  pipFps: number;
  /** traits de vent sur la carte : densité de pixels et part des traits dessinés */
  windRatio: number;
  windParticles: number;
}

const LEVELS: Record<Quality, QualitySettings> = {
  haute: { fps: 60, pixelRatio: 2, bloom: true, ripples: 12, pipFps: 20, windRatio: 2, windParticles: 1 },
  moyenne: { fps: 60, pixelRatio: 1.5, bloom: false, ripples: 8, pipFps: 15, windRatio: 2, windParticles: 1 },
  eco: { fps: 30, pixelRatio: 1, bloom: false, ripples: 6, pipFps: 10, windRatio: 1, windParticles: 0.5 },
};

/** Réglages d'un niveau pour cet écran (`dpr` : densité de l'écran ; `small` : téléphone). */
export function qualitySettings(q: Quality, dpr: number, small: boolean): QualitySettings {
  const s = LEVELS[q];
  return {
    ...s,
    pixelRatio: Math.min(dpr, s.pixelRatio),
    windRatio: Math.min(dpr, s.windRatio),
    // un téléphone garde la mer allégée et la fenêtre 3D lente
    ripples: small ? Math.min(8, s.ripples) : s.ripples,
    pipFps: small ? Math.min(12, s.pipFps) : s.pipFps,
  };
}

/** Le niveau enregistré, ou « moyenne ». */
export function qualityFrom(stored: string | null): Quality {
  return QUALITIES.includes(stored as Quality) ? (stored as Quality) : 'moyenne';
}

const KEY = 'sailgame.quality';

export function loadQuality(): Quality {
  try {
    return qualityFrom(localStorage.getItem(KEY));
  } catch {
    return 'moyenne';
  }
}

export function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* rien */
  }
}

/**
 * Dit s'il faut dessiner l'image proposée par l'écran à l'instant `now` (ms) pour ne pas dépasser `fps`.
 * Le reste de l'intervalle est reporté : un écran 144 Hz tient bien 60 images par seconde en moyenne, et les
 * petits à-coups d'un écran 60 Hz ne font pas sauter d'image.
 */
export class FrameGate {
  /** prochaine échéance (ms) */
  private next = -Infinity;

  constructor(public fps: number) {}

  ready(now: number): boolean {
    const step = 1000 / this.fps;
    if (now < this.next - 2) return false;
    // une échéance tous les 1/fps ; après une pause, on repart de maintenant
    this.next = this.next + step < now - step ? now + step : this.next + step;
    return true;
  }
}
