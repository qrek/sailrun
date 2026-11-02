import { describe, expect, it } from 'vitest';
import { raceById } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { IMOCA_RHUM_2026 } from '../src/data/fleet';
import { Race } from '../src/sim/race';
import { dist } from '../src/sim/geo';
import { LiveFeed, applyLive, matchFleet } from '../src/sim/live';
import { buildFeed, decodeHwx, parseImoca } from '../src/net/official';

/**
 * Encodeur de test, l'inverse du format .hwx : clé xorshift, puis groupes de 8 éléments précédés d'un octet
 * de drapeaux (1 = référence arrière de `cnt` octets à `dist` en arrière, 0 = octet littéral).
 */
function encodeHwx(items: (number | [number, number])[], total: number, skip = 3): Uint8Array {
  let [a, b, c, d] = [8111253, 4544506, 13986479, 16744512];
  const step = () => {
    let t = a;
    t ^= (t << 11) & 0xffffff;
    t ^= (t >> 8) & 0xffffff;
    a = b;
    b = c;
    c = d;
    d ^= (d >> 19) & 0xffffff;
    d ^= t;
  };
  for (let i = 0; i < skip; i++) step();
  const k = (x: number) => {
    const y = x ^ (a & 0xff);
    step();
    return y;
  };
  const out = [skip, k(total >> 16), k((total >> 8) & 0xff), k(total & 0xff)];
  for (let g = 0; g < items.length; g += 8) {
    const group = items.slice(g, g + 8);
    let flags = 0;
    group.forEach((it, i) => typeof it !== 'number' && (flags |= 1 << (7 - i)));
    const p = out.length;
    out.push((flags ^ 0xa3) ^ (p & 0xff));
    for (const it of group) {
      if (typeof it === 'number') out.push(k(it));
      else {
        const [cnt, back] = it;
        out.push(k(((cnt - 3) << 4) | ((back - 1) >> 8)), k((back - 1) & 0xff));
      }
    }
  }
  return new Uint8Array(out);
}

const bytes = (s: string) => [...new TextEncoder().encode(s)];

describe('fichiers de la cartographie officielle', () => {
  it('se décodent : clé xorshift puis décompression', () => {
    // « abc » + 6 octets recopiés 3 en arrière + « XYZ »
    const enc = encodeHwx([...bytes('abc'), [6, 3], ...bytes('XYZ')], 12);
    expect(new TextDecoder().decode(decodeHwx(enc))).toBe('abcabcabcXYZ');
  });

  it('un long texte sans répétition passe aussi', () => {
    const text = 'Route du Rhum 2026 – positions officielles';
    expect(new TextDecoder().decode(decodeHwx(encodeHwx(bytes(text), bytes(text).length, 7)))).toBe(text);
  });

  it('la configuration donne les IMOCA, avec leur skipper', () => {
    const xml = `<config><boatclass id="1" name="ULTIM 32/23">
      <boat id="7" name="ACTUAL Ultim 4" trackcolor="DD272F"><crew><navigator id="1" fname="Anthony" lname="Marchand" nat="FRA" /></crew></boat>
    </boatclass><boatclass id="3" name="IMOCA" runid="40">
      <boat id="29" name="Café Joyeux" sail="" trackcolor="F7D046" photo=""><crew><navigator id="1" fname="Nicolas" lname="D&apos;estais" nat="FRA" /></crew></boat>
      <boat id="24" name="Charal" trackcolor="22252B"><crew><navigator id="1" fname="Jérémie" lname="Beyou" nat="FRA" /></crew></boat>
    </boatclass></config>`;
    const imoca = parseImoca(xml);
    expect([...imoca.keys()]).toEqual(['29', '24']);
    expect(imoca.get('29')).toEqual({ skipper: "Nicolas D'estais", boat: 'Café Joyeux', nat: 'FRA', color: '#F7D046' });
  });

  it('le dernier pointage, seulement pour les IMOCA', () => {
    const imoca = new Map([['24', { skipper: 'Jérémie Beyou', boat: 'Charal', nat: 'FRA', color: '#22252B' }]]);
    const live = {
      reports: {
        columns: ['boat', 'racestatus', 'rank', 'progress', 'dtf', 'dtl', 'dtlProgress', 'heading', 'speed', 'track'],
        history: [
          {
            date: '2026-11-02T16:00:00Z',
            lines: [
              ['5', 'RAC', 1, 0, 2705.6, 0, 0, 249, 38.7, [[1793634300, 47.42, -23.32, 2705.6]]],
              ['24', 'RAC', 4, 0, 3120.5, 0, 0, 236, 21.4, [[1793634318, 46.1, -12.5, 3120.5]]],
            ],
          },
        ],
      },
    };
    const feed = buildFeed(live, imoca);
    expect(feed.at).toBe(Date.parse('2026-11-02T16:00:00Z'));
    expect(feed.positions).toEqual([{ who: 'Jérémie Beyou', boat: 'Charal', lat: 46.1, lon: -12.5, cog: 236, sog: 21.4, ts: 1793634318000, status: 'RAC', rank: 4, dtf: 3120.5 }]);
  });
});

describe('recalage des pros sur les pointages officiels', () => {
  const RHUM = raceById('rhum2026');
  const official = (o: Partial<LiveFeed['positions'][number]> = {}) => ({ who: 'Sam Goodchild', lat: 47, lon: -12, cog: 270, sog: 20, ts: Date.now(), status: 'RAC', ...o });
  /** un pointage qui couvre toute la flotte du jeu, comme le vrai */
  const fullFeed = (extra: LiveFeed['positions'] = []): LiveFeed => ({
    at: Date.now(),
    positions: [...IMOCA_RHUM_2026.map((f, i) => official({ who: f.skipper, lat: 46 + i * 0.05, lon: -12 })), ...extra],
  });

  it('les noms de la cartographie retrouvent les skippers du jeu', () => {
    expect(matchFleet("Nicolas D'estais")).toBe('destais');
    expect(matchFleet('Pierre-louis Attwell')).toBe('attwell');
    expect(matchFleet('Elodie Bonafous')).toBe('bonafous');
    expect(matchFleet('Maxime Sorel')).toBe('sorel');
    expect(matchFleet('Nicolas Rouger')).toBe('rouger');
  });

  it('la position officielle est avancée jusqu’à maintenant, à son cap et à sa vitesse', () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    const now = Date.now();
    const feed = fullFeed();
    feed.positions = feed.positions.filter((p) => matchFleet(p.who) !== 'goodchild');
    feed.positions.push(official({ ts: now - 3600_000, lat: 47, lon: -12, cog: 270, sog: 20 }));
    applyLive(race, feed, now);
    const b = race.boats.find((x) => x.fleetId === 'goodchild')!;
    expect(dist([-12, 47], b.pos)).toBeCloseTo(20, 0);
    expect(b.hdg).toBe(270);
  });

  it('ceux qui n’ont pas pris le départ ou ont abandonné quittent la course ; un arrivé est arrivé', () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    const feed = fullFeed();
    feed.positions = feed.positions.filter((p) => matchFleet(p.who) !== 'marsset');
    feed.positions.find((p) => matchFleet(p.who) === 'cousin')!.status = 'ABD';
    feed.positions.find((p) => matchFleet(p.who) === 'beyou')!.status = 'ARV';
    applyLive(race, feed);
    expect(race.boats.some((b) => b.fleetId === 'marsset')).toBe(false);
    expect(race.boats.some((b) => b.fleetId === 'cousin')).toBe(false);
    expect(race.boats.find((b) => b.fleetId === 'beyou')!.finished).not.toBeNull();
    expect(race.player).toBe(race.boats.find((b) => b.isPlayer));
  });

  it('un pointage partiel ne vide pas la flotte', () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    const before = race.boats.length;
    applyLive(race, { at: Date.now(), positions: [official()] });
    expect(race.boats.length).toBe(before);
  });

  it('un engagé officiel absent d’une course sauvegardée plus tôt la rejoint', () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    race.boats = race.boats.filter((b) => b.fleetId !== 'sorel');
    applyLive(race, fullFeed());
    const sorel = race.boats.find((b) => b.fleetId === 'sorel')!;
    expect(sorel).toBeDefined();
    expect(sorel.live).not.toBe(true);
    expect(sorel.name).toBe('M. Sorel');
  });

  it('le joueur n’est jamais déplacé', () => {
    const race = new Race(RHUM, DEFAULT_SETUP);
    const pos = race.player.pos.slice();
    applyLive(race, fullFeed([official({ who: 'Toi' })]));
    expect(race.player.pos).toEqual(pos);
  });
});
