import { SAIL_STEPS, SailId } from '../sim/boat';

/**
 * Ce qu'on voit de chaque voile d'avant pendant un changement, étape par étape :
 * - open : part de la voile déroulée (0 = roulée sur son câble, 1 = bien gonflée) ;
 * - hoist : hauteur du boudin hissé le long de l'étai (0 = en bas, 1 = en tête) ;
 * - roll : épaisseur du boudin (1 = voile entièrement roulée, 0 = plus rien autour du câble) ;
 * - deck : longueur du boudin couché sur le pont avant ; slide : il glisse de l'écoutille vers l'amure ;
 * - flap : la voile fasseye pendant qu'elle se déroule ou s'enroule.
 * Fonction pure de l'avancement : une annulation rejoue donc tout à l'envers.
 */
export interface SailShow {
  open: number;
  hoist: number;
  roll: number;
  deck: number;
  slide: number;
  flap: number;
}

export interface SailChangeState {
  sail: SailId;
  sailTo: SailId | null;
  sailT: number;
  sailDur: number;
}

const UP: SailShow = { open: 1, hoist: 1, roll: 0, deck: 0, slide: 1, flap: 0 };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (t: number) => t * t * (3 - 2 * t);

export function sailShow(b: SailChangeState): Partial<Record<SailId, SailShow>> {
  if (b.sailTo === null) return { [b.sail]: UP };
  const p = clamp01(b.sailT / b.sailDur);
  const [e1, e2, e3] = SAIL_STEPS.map((s) => s.end);
  const k = (a: number, z: number) => clamp01((p - a) / (z - a));
  let next: SailShow;
  if (p < e1) {
    // préparation : le boudin sort de l'écoutille avant et glisse jusqu'à l'amure
    const t = k(0, e1);
    next = { open: 0, hoist: 0, roll: 1, deck: Math.min(1, t / 0.25), slide: ease(t), flap: 0 };
  } else if (p < e2) {
    // hissage : il monte le long de l'étai, ce qui reste sur le pont raccourcit
    const t = ease(k(e1, e2));
    next = { open: 0, hoist: t, roll: 1, deck: 1 - t, slide: 1, flap: 0 };
  } else if (p < e3) {
    // déroulé : la voile s'ouvre en fasseyant, le boudin s'amincit
    const t = k(e2, e3);
    next = { open: ease(t), hoist: 1, roll: 1 - t, deck: 0, slide: 1, flap: Math.sin(Math.PI * t) };
  } else {
    next = UP;
  }
  let old = UP;
  if (p >= e3) {
    // enroulement de l'ancienne, puis on l'affale sur le pont
    const t = k(e3, 1);
    old = t < 0.6
      ? { open: 1 - ease(t / 0.6), hoist: 1, roll: t / 0.6, deck: 0, slide: 1, flap: 0.7 * Math.sin((Math.PI * t) / 0.6) }
      : { open: 0, hoist: 1 - ease((t - 0.6) / 0.4), roll: 1, deck: (t - 0.6) / 0.4, slide: 1, flap: 0 };
  }
  return { [b.sail]: old, [b.sailTo]: next };
}
