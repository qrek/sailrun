/**
 * Positions officielles de la Route du Rhum, lues dans la cartographie de la course (carto.routedurhum.com).
 * Ses fichiers .hwx sont brouillés (flot de clés xorshift) et compressés (LZSS) ; une fois décodés :
 * la configuration en XML (classes, bateaux, skippers) et les pointages en JSON. Le navigateur ne peut pas les
 * lire directement (pas d'en-tête CORS) : le relais api/official les lit, met le résultat en cache et le sert au jeu.
 */

import type { LiveFeed, LivePos } from '../sim/live';

const TRACKER = 'https://carto.routedurhum.com/data';
const SEEDS = [8111253, 4544506, 13986479, 16744512];

/** Décode un fichier .hwx de la cartographie. */
export function decodeHwx(buf: Uint8Array): Uint8Array {
  let [a, b, c, d] = SEEDS;
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
  for (let i = 0; i < buf[0]; i++) step();
  const key = (x: number) => {
    const y = x ^ (a & 0xff);
    step();
    return y;
  };
  const n = (key(buf[1]) << 16) + (key(buf[2]) << 8) + key(buf[3]);
  const out = new Uint8Array(n);
  let o = 0;
  let p = 4;
  while (p < buf.length && o < n) {
    // un octet de drapeaux pour 8 éléments : octet littéral, ou recopie d'un passage déjà décodé
    const flags = (buf[p] ^ (p & 0xff)) ^ 0xa3;
    p++;
    for (let bit = 7; bit >= 0; bit--) {
      if (!(flags & (1 << bit))) {
        out[o++] = key(buf[p++]);
      } else {
        const x = key(buf[p]);
        const cnt = (x >> 4) + 3;
        const back = (((x & 0xf) << 8) | key(buf[p + 1])) + 1;
        p += 2;
        for (let k = 0; k < cnt; k++, o++) out[o] = out[o - back];
      }
      if (p >= buf.length) break;
    }
  }
  return out.subarray(0, Math.min(o, n));
}

export interface ImocaEntry {
  skipper: string;
  boat: string;
  nat: string;
  color: string;
}

const unescapeXml = (s: string) =>
  s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : '';
};

/** Les IMOCA de la configuration, par identifiant de bateau de la cartographie. */
export function parseImoca(xml: string): Map<string, ImocaEntry> {
  const out = new Map<string, ImocaEntry>();
  const start = xml.search(/<boatclass [^>]*name="IMOCA"/);
  if (start < 0) return out;
  const block = xml.slice(start, xml.indexOf('</boatclass>', start));
  for (const m of block.matchAll(/<boat\s[^>]*>[\s\S]*?<\/boat>/g)) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const nav = /<navigator\s[^>]*>/.exec(m[0])?.[0] ?? '';
    const color = attr(tag, 'trackcolor');
    out.set(attr(tag, 'id'), {
      skipper: `${attr(nav, 'fname')} ${attr(nav, 'lname')}`.trim(),
      boat: attr(tag, 'name'),
      nat: attr(nav, 'nat'),
      color: /^[0-9a-f]{6}$/i.test(color) ? `#${color.toUpperCase()}` : '',
    });
  }
  return out;
}

interface TrackerLive {
  reports: { columns: string[]; history: { date: string; lines: unknown[][] }[] };
}

/** Le dernier pointage des IMOCA, au format du recalage (src/sim/live.ts). */
export function buildFeed(live: TrackerLive, imoca: Map<string, ImocaEntry>): LiveFeed {
  const { columns, history } = live.reports;
  const last = history[history.length - 1];
  const col = (line: unknown[], name: string) => line[columns.indexOf(name)];
  const positions: LivePos[] = [];
  for (const line of last?.lines ?? []) {
    const who = imoca.get(String(col(line, 'boat')));
    const track = col(line, 'track') as number[][] | undefined;
    const fix = track?.[track.length - 1];
    if (!who || !fix) continue;
    positions.push({
      who: who.skipper,
      boat: who.boat,
      lat: fix[1],
      lon: fix[2],
      cog: Number(col(line, 'heading')),
      sog: Number(col(line, 'speed')),
      ts: fix[0] * 1000,
      status: String(col(line, 'racestatus')),
      rank: Number(col(line, 'rank')),
      dtf: Number(col(line, 'dtf')),
    });
  }
  return { at: last ? Date.parse(last.date) : Date.now(), positions };
}

async function hwx(name: string): Promise<string> {
  // le serveur de la cartographie coupe parfois la connexion : deux nouvelles tentatives
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${TRACKER}/${name}.hwx?v=${Date.now()}`, { headers: { 'User-Agent': 'SailRun (jeu entre amis)' } });
      if (!r.ok) throw new Error(`${name} : ${r.status}`);
      return new TextDecoder('utf-8').decode(decodeHwx(new Uint8Array(await r.arrayBuffer())));
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1)));
    }
  }
  const cause = (last as { cause?: unknown })?.cause;
  throw new Error(`${name} : ${String(last)}${cause ? ` (${String((cause as { code?: string }).code ?? cause)})` : ''}`);
}

/** Lit la cartographie officielle (côté serveur : relais api/official et serveur de développement). */
export async function fetchOfficial(): Promise<LiveFeed> {
  const [config, live] = await Promise.all([hwx('tracker_config'), hwx('tracker_live')]);
  return buildFeed(JSON.parse(live) as TrackerLive, parseImoca(config));
}
