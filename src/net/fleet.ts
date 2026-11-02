/**
 * Flotte des joueurs : sur la Route du Rhum, chaque joueur publie sa position une fois par minute et voit celles
 * des autres. Chaque bateau reste simulé et sauvegardé dans le navigateur de son joueur ; le serveur ne fait que
 * relayer les positions. Serveur injoignable : la course continue comme avant, avec la dernière flotte connue.
 */

import { Boat, BASE_PERF, SailId } from '../sim/boat';
import { isLightColor } from '../data/garage';
import { move, norm180, norm360 } from '../sim/geo';
import { Race, makeBoat } from '../sim/race';
import { windFrom } from '../sim/wind';

/** Une ligne de la table `positions` (voir supabase/migrations). */
export interface FleetRow {
  player_id?: string;
  race_id: string;
  name: string;
  color: string;
  hull: string;
  foils: string;
  mast: string;
  lon: number;
  lat: number;
  hdg: number;
  spd: number;
  sail: SailId;
  mark: number;
  /** heures de course à l'arrivée, null : encore en mer */
  finished: number | null;
  /** heures de course au moment de la position */
  race_t: number;
}

/** Le serveur : publier sa position (renvoie son identifiant de joueur), lister celles d'une course. */
export interface FleetApi {
  publish(row: FleetRow): Promise<string>;
  list(raceId: string): Promise<FleetRow[]>;
}

/** sans nouvelles depuis plus longtemps (heures de course), on n'extrapole plus */
const EXTRAPOLATE_H = 2;

/** Seulement la Route du Rhum (même départ pour tous), et jamais en temps accéléré (mode test). */
export function canShare(race: Race, dev: boolean): boolean {
  return !!race.def.fleet && !(dev && race.speed !== 'live');
}

/** Nom affiché aux autres : une ligne, sans caractère de contrôle, 24 caractères au plus. */
export function cleanName(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim();
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Ce que publie le joueur : sa position et de quoi dessiner son bateau. */
export function rowOf(race: Race, name: string): FleetRow {
  const p = race.player;
  return {
    race_id: race.def.id,
    name: cleanName(name),
    color: HEX.test(p.color) ? p.color : '#ff7a1a',
    hull: p.hull,
    foils: p.foils,
    mast: p.mast,
    lon: p.pos[0],
    lat: p.pos[1],
    hdg: Math.round(norm360(p.hdg) * 10) / 10 % 360,
    spd: Math.max(0, Math.min(60, Math.round(p.spd * 10) / 10)),
    sail: p.sail,
    mark: p.mark,
    finished: p.finished,
    race_t: Math.max(0, race.t),
  };
}

/**
 * Le bateau d'un autre joueur, tel qu'on le voit : à sa dernière position, avancé à son cap et à sa vitesse
 * depuis (2 h au plus). Positionné par le serveur : la simulation ne le déplace pas.
 */
export function remoteBoat(r: FleetRow, race: Race): Boat {
  const late = Math.max(0, Math.min(EXTRAPOLATE_H, race.t - r.race_t));
  const pos = r.finished !== null ? ([r.lon, r.lat] as [number, number]) : move(r.lon, r.lat, r.hdg, r.spd, late);
  const [u, v] = race.wind.at(pos[0], pos[1], race.t);
  const twd = windFrom(u, v);
  return makeBoat({
    id: `joueur:${r.player_id ?? r.name}`,
    name: r.name,
    color: r.color,
    dark: isLightColor(r.color),
    perf: BASE_PERF,
    route: [],
    pos,
    hdg: r.hdg,
    spd: r.finished !== null ? 0 : r.spd,
    twd,
    tws: Math.hypot(u, v),
    twa: norm180(twd - r.hdg),
    hull: r.hull,
    foils: r.foils,
    mast: r.mast,
    sail: r.sail,
    mark: r.mark,
    finished: r.finished,
    auto: false,
    talk: 1e9,
    live: true,
    remote: r.race_t,
  });
}

/** Échanges avec le serveur, une fois par minute au plus ; `race.others` reçoit les autres joueurs. */
export class FleetLink {
  /** mon identifiant de joueur, une fois la première position publiée */
  private me: string | null = null;
  private next = -Infinity;
  private rows: FleetRow[] = [];
  private raceId = '';
  private redraw = -Infinity;

  constructor(
    private api: FleetApi | null,
    private every = 60_000,
  ) {}

  get enabled(): boolean {
    return this.api !== null;
  }

  /** À appeler à chaque image (`now` en ms) ; `name` vide : on regarde sans se montrer. */
  step(race: Race, name: string, dev: boolean, now: number): void {
    if (!this.api || !race.def.fleet) return;
    if (race.def.id !== this.raceId) {
      this.raceId = race.def.id;
      this.rows = [];
      this.next = -Infinity;
    }
    if (now >= this.next) {
      this.next = now + this.every;
      void this.sync(race, cleanName(name), dev);
    } else if (now >= this.redraw && this.rows.length) {
      // entre deux nouvelles, les bateaux avancent à leur cap
      this.redraw = now + 5000;
      this.show(race);
    }
  }

  private async sync(race: Race, name: string, dev: boolean) {
    const api = this.api!;
    if (name && canShare(race, dev)) {
      try {
        this.me = await api.publish(rowOf(race, name));
      } catch {
        /* serveur injoignable : on réessaiera à la prochaine minute */
      }
    }
    try {
      const rows = await api.list(race.def.id);
      this.rows = rows.filter((r) => r.player_id !== this.me && r.race_id === race.def.id);
      this.show(race);
    } catch {
      /* on garde la dernière flotte connue */
    }
  }

  private show(race: Race) {
    race.others = this.rows.map((r) => remoteBoat(r, race));
  }
}

const NAME_KEY = 'sailgame.fleetName';

export function loadFleetName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveFleetName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, cleanName(name));
  } catch {
    /* rien */
  }
}
