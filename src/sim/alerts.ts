/**
 * Alertes prévues : ce qui va arriver au bateau du joueur si personne ne touche à la barre (checkpoints
 * atteints, route terminée, marque passée, côte, skipper épuisé, arrivée). On rejoue le bateau seul, dans le
 * vent prévu, comme la course le ferait ; c'est ce calendrier qu'on confie aux notifications quand le
 * joueur s'en va. Sans aléas : une avarie ne se prévoit pas.
 */
import { Boat, CP_RADIUS, bestSail, checkpointHeading, stepBoat } from './boat';
import { dist } from './geo';
import { Race } from './race';

export type AlertKind = 'checkpoint' | 'route' | 'mark' | 'land' | 'tired' | 'sail' | 'finish';

export interface Alert {
  /** heure réelle (ms UTC) */
  at: number;
  kind: AlertKind;
  title: string;
  body: string;
}

/** On ne prévoit pas plus loin : au-delà, les prévisions sont trop incertaines. */
export const ALERT_HORIZON_H = 48;
const STEP = 0.1;
const SAIL_NAME: Record<string, string> = { foc: 'Foc', code0: 'Code 0', spi: 'Spi' };

const clone = (b: Boat): Boat => ({
  ...b,
  pos: [b.pos[0], b.pos[1]],
  trail: [],
  checkpoints: b.checkpoints?.map((c) => [c[0], c[1]]),
});

export function forecastAlerts(race: Race, hours = ALERT_HORIZON_H): Alert[] {
  const src = race.player;
  if (src.finished !== null) return [];
  const b = clone(src);
  const out: Alert[] = [];
  const at = (t: number) => Math.round(race.originUTC + t * 3600000);
  const total = b.checkpoints?.length ?? 0;
  let reached = 0;
  let tired = b.energy < 25;
  let best = bestSail(b.twa, b.tws);
  let t = race.t;
  for (let i = 0; i < hours / STEP; i++) {
    // même pilote que la course : checkpoints dans l'ordre, puis cap fixe
    if (b.auto && b.checkpoints?.length) {
      while (b.checkpoints.length && dist(b.pos, b.checkpoints[0]) < CP_RADIUS) {
        b.checkpoints.shift();
        reached++;
        const last = reached === total;
        out.push({
          at: at(t),
          kind: 'checkpoint',
          title: last ? 'Dernier checkpoint atteint' : `Checkpoint ${reached}/${total} atteint`,
          body: last ? 'Le pilote garde maintenant le cap. Pose la suite de ta route.' : 'Le pilote file vers le point suivant.',
        });
      }
      const cp = b.checkpoints[0];
      if (cp) b.hdg = checkpointHeading(b.pos, cp, b.twd);
      else b.auto = false;
    }
    const mark = b.mark;
    for (const ev of stepBoat(b, { t, dt: STEP, wind: race.wind, rng: null, finish: race.def.finish, finishR: race.def.finishR, marks: race.def.marks })) {
      if (ev === 'land' && !out.some((a) => a.kind === 'land')) {
        out.push({ at: at(t), kind: 'land', title: 'Ton bateau est bloqué contre la côte', body: 'Il n’avance plus : change de cap.' });
      } else if (ev === 'finish') {
        out.push({ at: at(t), kind: 'finish', title: `Arrivée à ${race.def.to} !`, body: `Ton IMOCA franchit la ligne de la ${race.def.name}.` });
      }
    }
    if (b.mark > mark) {
      const m = race.def.marks?.[b.mark - 1];
      if (m) out.push({ at: at(t), kind: 'mark', title: `${m.name} passé`, body: 'Une marque de parcours de moins.' });
    }
    if (!tired && b.energy < 25) {
      tired = true;
      out.push({ at: at(t), kind: 'tired', title: 'Ton skipper est épuisé', body: 'Le bateau perd 12 % de vitesse. Une sieste de 2 h le remet d’aplomb.' });
    }
    // voiles réglées à la main : prévenir quand une autre devient meilleure (et le rester un moment)
    if (!b.autoSail) {
      const now = bestSail(b.twa, b.tws);
      if (now !== best) {
        best = now;
        if (now !== b.sail && !out.some((a) => a.kind === 'sail' && at(t) - a.at < 6 * 3600000)) {
          out.push({ at: at(t), kind: 'sail', title: `Le ${SAIL_NAME[now] ?? now} devient la bonne voile`, body: `Le vent a tourné : tu portes encore le ${SAIL_NAME[b.sail] ?? b.sail}.` });
        }
      }
    }
    t += STEP;
    if (b.finished !== null) break;
  }
  return out.slice(0, 12);
}
