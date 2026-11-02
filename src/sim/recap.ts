/**
 * Récap « Pendant ton absence » : on photographie la course avant le rattrapage, on note ce qui arrive
 * au joueur pendant qu'il rattrape, puis on compare. Pur calcul, sans interface (voir ui/awayCard.ts).
 */
import { BoatEvent } from './boat';
import { Race, RaceEvent } from './race';

/** En dessous, pas de récap : un simple message suffit. */
export const RECAP_MIN_HOURS = 0.25;

export interface AwaySnapshot {
  t: number;
  /** ids du classement, du premier au dernier */
  order: string[];
  remaining: number;
  /** pilote en route vers des checkpoints */
  following: boolean;
  checkpoints: number;
  finished: boolean;
}

export type RecapKind = 'mark' | 'checkpoint' | 'route' | 'avarie' | 'repaired' | 'land' | 'finish' | 'manoeuvre' | 'sail';

export interface RecapItem {
  kind: RecapKind;
  text: string;
}

export interface Recap {
  hours: number;
  rankBefore: number;
  rankAfter: number;
  fleet: number;
  /** milles gagnés vers l'arrivée */
  gained: number;
  /** vitesse moyenne vers l'arrivée (nœuds) */
  vmg: number;
  /** concurrents doublés, concurrents qui t'ont doublé */
  passed: string[];
  passedBy: string[];
  items: RecapItem[];
}

export function snapshot(race: Race): AwaySnapshot {
  const p = race.player;
  return {
    t: race.t,
    order: race.standings().map((b) => b.id),
    remaining: race.remaining(p),
    following: p.auto && !!p.checkpoints?.length,
    checkpoints: p.checkpoints?.length ?? 0,
    finished: p.finished !== null,
  };
}

/** Ce qui arrive au joueur pendant le rattrapage. */
export class AwayLog {
  private counts = new Map<BoatEvent, number>();
  private marks: string[] = [];

  constructor(private race: Race) {}

  /** À brancher sur race.step pendant le rattrapage. */
  readonly listen = (e: RaceEvent) => {
    if (e.type !== 'boat' || !e.boat.isPlayer) return;
    this.counts.set(e.ev, (this.counts.get(e.ev) ?? 0) + 1);
    if (e.ev === 'mark') {
      const m = this.race.def.marks?.[e.boat.mark - 1];
      if (m) this.marks.push(m.name);
    }
  };

  count(ev: BoatEvent): number {
    return this.counts.get(ev) ?? 0;
  }

  get markNames(): string[] {
    return this.marks;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export function buildRecap(race: Race, before: AwaySnapshot, log: AwayLog): Recap {
  const p = race.player;
  const hours = Math.max(0, race.t - before.t);
  // même liste de bateaux avant et après (la flotte des joueurs peut changer entre-temps)
  const known = new Set(before.order);
  const full = race.standings().map((b) => b.id);
  const after = full.filter((id) => known.has(id));
  const was = before.order.indexOf(p.id) + 1;
  const is = after.indexOf(p.id) + 1;
  const ahead = new Set(before.order.slice(0, was - 1));
  const aheadNow = new Set(after.slice(0, is - 1));
  // affiché : la place du classement complet (comme le bandeau), et l'écart mesuré sur les mêmes bateaux
  const rankAfter = full.indexOf(p.id) + 1;
  const rankBefore = rankAfter + (was - is);
  const name = (id: string) => [...race.boats, ...race.others].find((b) => b.id === id)?.name ?? id;
  const passed = [...ahead].filter((id) => !aheadNow.has(id)).map(name);
  const passedBy = [...aheadNow].filter((id) => !ahead.has(id)).map(name);
  const gained = before.remaining - race.remaining(p);

  const items: RecapItem[] = [];
  for (const m of log.markNames) items.push({ kind: 'mark', text: `${m} passé` });
  const cps = log.count('checkpoint');
  if (cps) items.push({ kind: 'checkpoint', text: `${plural(cps, 'checkpoint atteint', 'checkpoints atteints')}` });
  if (before.following && !(p.auto && p.checkpoints?.length) && p.finished === null) {
    items.push({ kind: 'route', text: `Route terminée : le bateau garde le cap ${Math.round(((p.hdg % 360) + 360) % 360)}°` });
  }
  const av = log.count('avarie');
  if (av) items.push({ kind: 'avarie', text: log.count('repaired') >= av ? `${plural(av, 'avarie', 'avaries')}, réparée${av > 1 ? 's' : ''}` : 'Avarie à bord, réparation en cours' });
  if (log.count('land')) items.push({ kind: 'land', text: 'Côte en vue : vérifie ton cap' });
  const man = log.count('tack') + log.count('gybe');
  if (man) items.push({ kind: 'manoeuvre', text: [log.count('tack') && plural(log.count('tack'), 'virement', 'virements'), log.count('gybe') && plural(log.count('gybe'), 'empannage', 'empannages')].filter(Boolean).join(', ') });
  const sails = log.count('sailset');
  if (sails) items.push({ kind: 'sail', text: plural(sails, 'changement de voile', 'changements de voile') });
  if (!before.finished && p.finished !== null) items.push({ kind: 'finish', text: 'Ligne d’arrivée franchie !' });

  return {
    hours,
    rankBefore,
    rankAfter,
    fleet: full.length,
    gained,
    vmg: hours > 0 ? gained / hours : 0,
    passed,
    passedBy,
    items,
  };
}
