import { describe, expect, it } from 'vitest';
import { RACES, raceById } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { Race } from '../src/sim/race';
import { dist } from '../src/sim/geo';
import { FleetApi, FleetLink, FleetRow, canShare, cleanName, remoteBoat, rowOf } from '../src/net/fleet';

const rhum = () => new Race(raceById('rhum2026'), DEFAULT_SETUP);
const training = () => new Race(RACES.find((r) => !r.fleet)!, DEFAULT_SETUP);

/** une ligne de la table, telle qu'un autre joueur l'a publiée */
function row(o: Partial<FleetRow> = {}): FleetRow {
  return { player_id: 'p2', race_id: 'rhum2026', name: 'Théo', color: '#2563c9', hull: 'classique', foils: 'c', mast: 'aile', lon: -10, lat: 45, hdg: 230, spd: 15, sail: 'code0', mark: 0, finished: null, race_t: 10, ...o };
}

/** un serveur factice : garde les lignes en mémoire, compte les appels */
function fakeApi(others: FleetRow[] = []) {
  const calls = { publish: 0, list: 0 };
  let fail = false;
  const mine: FleetRow[] = [];
  const api: FleetApi = {
    async publish(r) {
      calls.publish++;
      if (fail) throw new Error('hors ligne');
      mine.push(r);
      return 'p1';
    },
    async list() {
      calls.list++;
      if (fail) throw new Error('hors ligne');
      return [...others, ...mine.slice(-1).map((r) => ({ ...r, player_id: 'p1' }))];
    },
  };
  return { api, calls, mine, setFail: (f: boolean) => (fail = f) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('flotte des joueurs : ce qu’on partage', () => {
  it('seulement sur la Route du Rhum, en temps réel', () => {
    expect(canShare(rhum(), false)).toBe(true);
    expect(canShare(training(), false)).toBe(false);
    const fast = rhum();
    fast.speed = '1m';
    expect(canShare(fast, true)).toBe(false); // temps accéléré du mode test : il serait en avance sur tout le monde
    expect(canShare(rhum(), true)).toBe(true);
  });

  it('la position, le cap, la vitesse, la voile et l’allure du bateau', () => {
    const race = rhum();
    race.t = 12.5;
    const p = race.player;
    p.hdg = -20;
    p.spd = 18.3;
    p.sail = 'spi';
    const r = rowOf(race, '  Matthieu  ');
    expect(r).toMatchObject({ race_id: 'rhum2026', name: 'Matthieu', lon: p.pos[0], lat: p.pos[1], hdg: 340, spd: 18.3, sail: 'spi', race_t: 12.5, finished: null, hull: p.hull, foils: p.foils, mast: p.mast });
    expect(r.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('un nom propre : sans retour à la ligne ni caractère de contrôle, 24 caractères au plus', () => {
    expect(cleanName('  Jean\n  Le   Cam\t')).toBe('Jean Le Cam');
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
    expect(cleanName('\u0000\u0007')).toBe('');
  });
});

describe('flotte des joueurs : ce qu’on voit des autres', () => {
  it('un bateau qui avance à son cap et à sa vitesse depuis sa dernière nouvelle', () => {
    const race = rhum();
    race.t = 11;
    const b = remoteBoat(row({ race_t: 10, spd: 15 }), race);
    expect(b.isPlayer).toBe(false);
    expect(b.live).toBe(true);
    expect(b.name).toBe('Théo');
    expect(dist([-10, 45], b.pos)).toBeCloseTo(15, 0); // 1 h à 15 nœuds
  });

  it('sans nouvelles depuis longtemps, il n’avance plus au-delà de 2 h', () => {
    const race = rhum();
    race.t = 40;
    const b = remoteBoat(row({ race_t: 10, spd: 15 }), race);
    expect(dist([-10, 45], b.pos)).toBeCloseTo(30, 0);
  });

  it('un bateau arrivé reste à l’arrivée', () => {
    const race = rhum();
    race.t = 300;
    const b = remoteBoat(row({ race_t: 250, finished: 249 }), race);
    expect(b.finished).toBe(249);
    expect(b.pos).toEqual([-10, 45]);
  });

  it('les autres joueurs sont classés avec la flotte, mais ni simulés ni sauvegardés avec ta course', () => {
    const race = rhum();
    const other = remoteBoat(row(), race);
    race.others = [other];
    expect(race.standings()).toContain(other);
    const before = other.pos.slice();
    race.step(0.5, () => {});
    expect(other.pos).toEqual(before);
    expect(race.serialize().boats.some((b) => b.id === other.id)).toBe(false);
    expect(race.allFinished).toBe(false);
  });
});

describe('flotte des joueurs : échanges avec le serveur', () => {
  it('sans nom, rien ne part ; on voit quand même les autres', async () => {
    const { api, calls } = fakeApi([row()]);
    const link = new FleetLink(api);
    const race = rhum();
    link.step(race, '', false, 0);
    await flush();
    expect(calls.publish).toBe(0);
    expect(race.others.map((b) => b.name)).toEqual(['Théo']);
  });

  it('une fois par minute, pas à chaque image', async () => {
    const { api, calls } = fakeApi([row()]);
    const link = new FleetLink(api);
    const race = rhum();
    for (let ms = 0; ms <= 125_000; ms += 1000 / 60) link.step(race, 'Matthieu', false, ms);
    await flush();
    expect(calls.publish).toBe(3);
    expect(calls.list).toBe(3);
  });

  it('on ne se voit pas soi-même en double', async () => {
    const { api } = fakeApi([row()]);
    const link = new FleetLink(api);
    const race = rhum();
    link.step(race, 'Matthieu', false, 0);
    await flush();
    await flush();
    link.step(race, 'Matthieu', false, 61_000);
    await flush();
    await flush();
    expect(race.others.map((b) => b.name)).toEqual(['Théo']);
  });

  it('serveur injoignable : la course continue, on garde la dernière flotte connue', async () => {
    const { api, setFail } = fakeApi([row()]);
    const link = new FleetLink(api);
    const race = rhum();
    link.step(race, 'Matthieu', false, 0);
    await flush();
    setFail(true);
    expect(() => link.step(race, 'Matthieu', false, 61_000)).not.toThrow();
    await flush();
    expect(race.others.map((b) => b.name)).toEqual(['Théo']);
  });

  it('hors Route du Rhum, aucun échange', async () => {
    const { api, calls } = fakeApi([row()]);
    const link = new FleetLink(api);
    const race = training();
    link.step(race, 'Matthieu', false, 0);
    await flush();
    expect(calls.publish + calls.list).toBe(0);
    expect(race.others).toEqual([]);
  });

  it('sans serveur configuré, rien ne change', async () => {
    const link = new FleetLink(null);
    const race = rhum();
    link.step(race, 'Matthieu', false, 0);
    await flush();
    expect(race.others).toEqual([]);
  });
});
