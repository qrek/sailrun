import { RaceDef, raceById } from '../data/races';
import { Setup, botSetup, calibrated, isLightColor, lookOf, perfOf, styleOf } from '../data/garage';
import { genPerf, shortName } from '../data/fleet';
import { Boat, BoatEvent, activeOrder, bestSail, boatSpeed, migrateBoat, startRepair, startSleep, stepBoat } from './boat';
import { LonLat, Rng, dist } from './geo';
import { bestHeading, decideEvery, nextTarget } from './router';
import { routeTimes } from './solo';
import { SyntheticWind, WindSource, windFrom } from './wind';
import { GridWind, windGrid } from './gfsWind';

export interface BotDef {
  id: string;
  name: string;
  color: string;
  dark: boolean;
  level: number; // niveau du bateau choisi : rang visé parmi tous les bateaux (0 = le meilleur)
  smart: number; // probabilité de prendre la meilleure route
  jitter: number; // imprécision à la barre (°)
  sailLag: number; // temps de réaction pour changer de voile (h)
}

export const BOTS: BotDef[] = [
  { id: 'lea', name: 'Léa', color: '#FF4F9A', dark: false, level: 0.06, smart: 0.9, jitter: 5, sailLag: 0.2 },
  { id: 'max', name: 'Max', color: '#8B5CF6', dark: false, level: 0.3, smart: 0.5, jitter: 9, sailLag: 0.5 },
  { id: 'julien', name: 'Julien', color: '#A3E635', dark: true, level: 0.45, smart: 0.3, jitter: 12, sailLag: 0.8 },
  { id: 'sam', name: 'Sam', color: '#FACC15', dark: true, level: 0.15, smart: 0.6, jitter: 7, sailLag: 0.3 },
  { id: 'nico', name: 'Nico', color: '#EF4444', dark: false, level: 0.65, smart: 0.2, jitter: 15, sailLag: 1.2 },
];

export type RaceEvent =
  | { type: 'boat'; boat: Boat; ev: BoatEvent }
  | { type: 'chat'; boat: Boat; text: string }
  | { type: 'sys'; text: string };

const LINES = {
  any: ['Qui a pris l’option nord ?', 'Ça mouille ici, je vous raconte pas', 'Le pilote auto fait n’importe quoi', 'Quelqu’un a du café ?', 'Je vois un cargo, c’est normal ?', 'Ma playlist de quart est incroyable', 'J’ai vu des dauphins !', 'Tout le monde dort ou quoi ?'],
  lead: ['Je vous attends à l’arrivée, c’est ma tournée', 'Vous êtes où ? Je vous vois plus'],
  behind: ['Vous allez voir le retour', 'Pas de panique, la course est longue', 'Je prépare une option de fou'],
  upwind: ['Ça tape au près, j’ai mal au dos', 'On remonte au vent, c’est long'],
  downwind: ['Ça glisse tout seul au portant', 'Les alizés, enfin !', 'J’ai sorti le spi, ça part'],
  sleep: ['Je dors 2 h, ne me doublez pas', 'Sieste. Personne ne bouge.'],
  avarie: ['Aïe, j’ai cassé un truc', 'Avarie à bord, je bricole', 'Mauvaise nouvelle : il faut réparer'],
  repaired: ['C’est réparé, je repars !', 'Rafistolé au scotch, ça tiendra'],
  finish: ['Ligne franchie ! Le ti-punch est servi', 'Arrivé ! Je vous attends au bar'],
  passed: ['Pff, bien joué', 'Profite, ça va pas durer', 'Sérieux ?!'],
  reply: ['Merci !', 'Bon vent à toi aussi', 'Grave', 'On verra ça', 'Haha', 'Ok ok'],
};

export interface SavedRace {
  v: 1;
  raceId: string;
  t: number;
  seed: number;
  boats: Boat[];
  setup: Setup;
  speed: string;
  savedAt: number;
  /** heure réelle (ms UTC) du départ de cette course */
  origin?: number;
}

export function makeBoat(o: Partial<Boat> & Pick<Boat, 'id' | 'name' | 'color' | 'perf' | 'route' | 'pos' | 'hdg'>): Boat {
  return {
    dark: false,
    isPlayer: false,
    hull: 'classique',
    foils: 'c',
    mast: 'aile',
    spd: 0,
    twa: 0,
    tws: 0,
    twd: 0,
    energy: 100,
    sleep: 0,
    penalty: 0,
    avarie: null,
    repair: 0,
    auto: true,
    wp: 0,
    decide: 0,
    jitter: 0,
    trail: [],
    trailT: 0,
    finished: null,
    talk: 8,
    sail: 'foc',
    sailChange: 0,
    autoSail: true,
    sailLag: 0,
    sailLagMax: 0.5,
    lock: 'hdg',
    lockTwa: 90,
    mark: 0,
    ...o,
  } as Boat;
}

export class Race {
  readonly def: RaceDef;
  readonly wind: WindSource;
  readonly rng: Rng;
  t = 0;
  boats: Boat[];
  player: Boat;
  setup: Setup;
  /** identifiant dans TIME_SCALES (mode test seulement : en jeu, tout est en temps réel) */
  speed = 'live';
  /** heure réelle (ms UTC) qui correspond à t = 0 : le vrai départ, ou le moment où tu as lancé l'entraînement */
  readonly originUTC: number;

  constructor(def: RaceDef, setup: Setup, saved?: SavedRace) {
    this.def = def;
    this.setup = setup;
    this.originUTC = saved?.origin ?? (def.fleet ? def.startUTC : Date.now());
    const grid = def.realWind ? windGrid() : null;
    this.wind = grid ? new GridWind(grid, def.startUTC, def.windPhase) : new SyntheticWind(def.windPhase);
    if (saved) {
      this.rng = new Rng(saved.seed);
      this.t = saved.t;
      this.boats = saved.boats.map((b) => migrateBoat(b));
      this.speed = saved.speed ?? 'live';
    } else {
      this.rng = new Rng(Math.floor(Math.random() * 1e9));
      this.boats = this.createBoats(setup);
    }
    this.player = this.boats.find((b) => b.isPlayer)!;
    if (!saved) {
      // vent initial, pour que l'interface soit juste dès la première image
      for (const b of this.boats) {
        const [u, v] = this.wind.at(b.pos[0], b.pos[1], 0);
        b.tws = Math.hypot(u, v);
        b.twd = windFrom(u, v);
        b.twa = ((b.twd - b.hdg + 540) % 360) - 180;
        b.spd = boatSpeed(b.twa, b.tws, b.perf, b.sail);
      }
      // cap de départ : le meilleur cap vers le premier point de la route
      for (const b of this.boats) {
        b.hdg = bestHeading(b.pos, 0, nextTarget(b), b.perf, this.wind);
        b.twa = ((b.twd - b.hdg + 540) % 360) - 180;
        b.lockTwa = b.twa;
        b.sail = bestSail(b.twa, b.tws);
        b.spd = boatSpeed(b.twa, b.tws, b.perf, b.sail);
      }
    }
  }

  /** Vent réel GFS ? */
  get realWind(): boolean {
    return this.wind instanceof GridWind;
  }

  private createBoats(setup: Setup): Boat[] {
    if (this.def.fleet) return this.createFleet(setup);
    const d = this.def;
    const st = styleOf(setup);
    const liv = { color: st.color, dark: isLightColor(st.color) };
    const player = makeBoat({
      id: 'me',
      name: 'Toi',
      color: liv.color,
      dark: liv.dark,
      isPlayer: true,
      perf: perfOf(setup),
      ...lookOf(setup),
      route: d.routes[calibrated(d.id, setup)?.r ?? 0],
      pos: [d.start[0] + 0.03, d.start[1] - 0.1],
      hdg: d.startHeading,
      auto: true,
    });
    const bots = BOTS.map((bd, i) => {
      const s = botSetup(d, () => this.rng.next(), bd.level);
      const bestR = calibrated(d.id, s)?.r ?? 0;
      const routeIdx = this.rng.next() < bd.smart ? bestR : (bestR + 1 + i) % d.routes.length;
      return makeBoat({
        id: bd.id,
        name: bd.name,
        color: bd.color,
        dark: bd.dark,
        perf: perfOf(s),
        ...lookOf(s),
        route: d.routes[routeIdx],
        pos: [d.start[0] + 0.12 * (i - 2), d.start[1] + 0.06 * ((i % 2) * 2 - 1)],
        hdg: d.startHeading + (i - 2) * 3,
        jitter: bd.jitter,
        sailLagMax: bd.sailLag,
        talk: 5 + this.rng.next() * 12,
      });
    });
    return [player, ...bots];
  }

  /** Vraie flotte : chaque bot porte le nom d'un skipper engagé. */
  private createFleet(setup: Setup): Boat[] {
    const d = this.def;
    const fleet = d.fleet!;
    const st = styleOf(setup);
    const liv = { color: st.color, dark: isLightColor(st.color) };
    // classement des options de route avec la météo du moment, pour un IMOCA neuf
    const times = routeTimes(d, genPerf('new'), this.wind);
    const order = times.map((t, i) => [t, i] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    this.routeOrder = order;
    const n = fleet.length + 1;
    const slot = (i: number): LonLat => [d.start[0] + 0.02 * ((i % 3) - 1), d.start[1] - 0.05 + (0.11 * i) / n];
    const playerPerf = { ...perfOf(setup), imoca: 1 };
    const player = makeBoat({
      id: 'me',
      name: 'Toi',
      color: liv.color,
      dark: liv.dark,
      isPlayer: true,
      perf: playerPerf,
      ...lookOf(setup),
      route: d.routes[order[0]],
      pos: slot(Math.floor(n / 2)),
      hdg: d.startHeading,
      auto: true,
    });
    const bots = fleet.map((f, i) => {
      const perf = genPerf(f.gen);
      perf.speed *= 0.975 + 0.025 * f.skill;
      const r = this.rng.next();
      const pick = r < f.skill * f.skill ? 0 : r < 0.85 ? 1 + Math.floor(this.rng.next() * 2) : 3 + Math.floor(this.rng.next() * 2);
      const routeIdx = order[Math.min(order.length - 1, pick)];
      return makeBoat({
        id: f.id,
        fleetId: f.id,
        name: shortName(f.skipper),
        color: f.color,
        dark: f.dark,
        perf,
        hull: 'classique',
        foils: f.gen === 'dagger' ? 'derives' : f.gen === 'new' ? 'grands' : 'c',
        mast: 'aile',
        route: d.routes[routeIdx],
        pos: slot(i >= Math.floor(n / 2) ? i + 1 : i),
        hdg: d.startHeading,
        jitter: 2 + (1 - f.skill) * 14,
        sailLagMax: 0.15 + (1 - f.skill) * 1.1,
        talk: 1e9,
      });
    });
    return [player, ...bots];
  }

  /** Options de route de la plus rapide à la plus lente (vraie flotte). */
  routeOrder: number[] = [];

  /** Bots qui parlent à la radio : jamais avec de vrais skippers. */
  get chatty(): boolean {
    return !this.def.fleet;
  }

  /** Prochaine marque du bateau, s'il en reste une. */
  nextMark(b: Boat) {
    const m = this.def.marks;
    return m && b.mark < m.length ? m[b.mark] : null;
  }

  /** Heures de course écoulées en temps réel (négatif avant le départ). */
  realT(now = Date.now()): number {
    return (now - this.originUTC) / 3600000;
  }

  get bots(): Boat[] {
    return this.boats.filter((b) => !b.isPlayer);
  }

  /** Distance restante (milles) : par les marques qui restent, puis la ligne. */
  remaining(b: Boat): number {
    if (b.finished !== null) return 0;
    const m = this.def.marks;
    if (!m || b.mark >= m.length) return dist(b.pos, this.def.finish);
    let d = dist(b.pos, m[b.mark].pos);
    for (let i = b.mark; i < m.length - 1; i++) d += dist(m[i].pos, m[i + 1].pos);
    return d + dist(m[m.length - 1].pos, this.def.finish);
  }

  standings(): Boat[] {
    return this.boats.slice().sort((a, b) => {
      if (a.finished !== null && b.finished !== null) return a.finished - b.finished;
      if (a.finished !== null) return -1;
      if (b.finished !== null) return 1;
      return this.remaining(a) - this.remaining(b);
    });
  }

  get allFinished(): boolean {
    return this.boats.every((b) => b.finished !== null);
  }

  /** Avance la course de `hours` heures en pas de 6 minutes max. */
  step(hours: number, emit: (e: RaceEvent) => void): void {
    while (hours > 1e-9) {
      const dt = Math.min(0.1, hours);
      hours -= dt;
      this.stepOnce(dt, emit);
      if (this.allFinished) break;
    }
  }

  private stepOnce(dt: number, emit: (e: RaceEvent) => void): void {
    const ctx = { t: this.t, dt, wind: this.wind, rng: this.rng, finish: this.def.finish, finishR: this.def.finishR, marks: this.def.marks };
    for (const b of this.boats) {
      if (b.finished !== null || b.live) continue;
      if (!b.isPlayer) this.botBrain(b, dt, emit);
      if (b.isPlayer && b.avarie === 'pilote' && b.auto) b.auto = false;
      const order = b.auto ? activeOrder(b, this.t) : null;
      if (order) {
        // mode Auto avec un programme de routage : le cap suit les ordres, à l'heure dite
        b.hdg = order.hdg;
        nextTarget(b);
      } else if (b.auto) {
        b.decide -= dt;
        if (b.decide <= 0) {
          const target: LonLat = nextTarget(b);
          const jitter = b.jitter ? b.jitter * (this.rng.next() - 0.5) : 0;
          b.hdg = (bestHeading(b.pos, this.t, target, b.perf, this.wind) + jitter + 360) % 360;
          b.decide = decideEvery(b);
        }
      } else {
        nextTarget(b);
      }
      for (const ev of stepBoat(b, ctx)) {
        emit({ type: 'boat', boat: b, ev });
        if (!b.isPlayer) this.botReact(b, ev, emit);
      }
    }
    this.t += dt;
  }

  private botBrain(b: Boat, dt: number, emit: (e: RaceEvent) => void) {
    if (b.avarie && b.repair <= 0) startRepair(b);
    if (b.energy < 35 && b.sleep <= 0 && b.repair <= 0 && this.rng.next() < 0.05) {
      startSleep(b);
      if (this.chatty && this.rng.next() < 0.5) emit({ type: 'chat', boat: b, text: this.line(LINES.sleep) });
    }
    b.talk -= dt;
    if (this.chatty && b.talk <= 0) {
      b.talk = 10 + this.rng.next() * 22;
      const order = this.standings();
      const idx = order.indexOf(b);
      let pool = LINES.any;
      const r = this.rng.next();
      if (Math.abs(b.twa) < 65 && r < 0.4) pool = LINES.upwind;
      else if (Math.abs(b.twa) > 125 && r < 0.4) pool = LINES.downwind;
      else if (idx === 0 && r < 0.6) pool = LINES.lead;
      else if (idx >= 4 && r < 0.6) pool = LINES.behind;
      emit({ type: 'chat', boat: b, text: this.line(pool) });
    }
  }

  private botReact(b: Boat, ev: BoatEvent, emit: (e: RaceEvent) => void) {
    if (!this.chatty) return;
    const r = this.rng.next();
    if (ev === 'avarie' && r < 0.7) emit({ type: 'chat', boat: b, text: this.line(LINES.avarie) });
    if (ev === 'repaired' && r < 0.4) emit({ type: 'chat', boat: b, text: this.line(LINES.repaired) });
    if (ev === 'finish') emit({ type: 'chat', boat: b, text: this.line(LINES.finish) });
  }

  /** Réplique d'un bot quand on le double ou qu'on lui écrit. */
  quip(kind: 'passed' | 'reply'): { boat: Boat; text: string } {
    const racing = this.bots.filter((b) => b.finished === null);
    const boat = this.rng.pick(racing.length ? racing : this.bots);
    return { boat, text: this.line(LINES[kind]) };
  }

  private recent: string[] = [];
  /** Tire une réplique en évitant les répétitions récentes. */
  private line(pool: string[]): string {
    let t = this.rng.pick(pool);
    for (let i = 0; i < 4 && this.recent.includes(t); i++) t = this.rng.pick(pool);
    this.recent.push(t);
    if (this.recent.length > 8) this.recent.shift();
    return t;
  }

  serialize(): SavedRace {
    return {
      v: 1,
      raceId: this.def.id,
      t: this.t,
      seed: this.rng.state,
      boats: this.boats.map((b) => ({ ...b, trail: b.trail.slice(-600) })),
      setup: this.setup,
      speed: this.speed,
      savedAt: Date.now(),
      origin: this.originUTC,
    };
  }

  static restore(s: SavedRace): Race {
    return new Race(raceById(s.raceId), s.setup, s);
  }
}

/* ---------- sauvegarde locale ---------- */
const KEY = 'sailgame.race.v1';
export function saveRace(r: Race) {
  try {
    localStorage.setItem(KEY, JSON.stringify(r.serialize()));
  } catch {
    /* stockage indisponible : on continue sans sauvegarde */
  }
}
export function loadRace(): SavedRace | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedRace;
    return s.v === 1 ? s : null;
  } catch {
    return null;
  }
}
export function clearRace() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* rien */
  }
}

/** Vitesses du temps : heures de course par seconde réelle. */
export const TIME_SCALES = [
  { id: 'live', label: 'Temps réel', hoursPerSecond: 1 / 3600 },
  { id: '10m', label: '1 s = 10 min', hoursPerSecond: 1 / 6 },
  { id: '30m', label: '1 s = 30 min', hoursPerSecond: 0.5 },
  { id: '2h', label: '1 s = 2 h', hoursPerSecond: 2 },
];

export const timeScaleOf = (id: string) => TIME_SCALES.find((t) => t.id === id) ?? TIME_SCALES[2];
