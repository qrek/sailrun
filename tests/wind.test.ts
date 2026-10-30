import { afterEach, describe, expect, it, vi } from 'vitest';
import { RHUM, RHUM_MARKS, raceById } from '../src/data/races';
import { DEFAULT_SETUP } from '../src/data/garage';
import { GRID, GridWind, gridFromOpenMeteo, loadWindGrid, setWindGrid, windGrid } from '../src/sim/gfsWind';
import { Race } from '../src/sim/race';

/** Réponse Open-Meteo factice : le même vent sur toute la grille, 48 h à partir du jour du départ. */
function omPoints(kn: number, from: number) {
  const day = Date.UTC(2026, 10, 1);
  const time = Array.from({ length: 16 }, (_, k) => new Date(day + k * 3 * 3600000).toISOString().slice(0, 16));
  return Array.from({ length: GRID.nlat * GRID.nlon }, () => ({
    hourly: { time, wind_speed_10m: time.map(() => kn), wind_direction_10m: time.map(() => from) },
  }));
}
const uniform = (kn: number, from: number, fetched = Date.now()) => gridFromOpenMeteo(omPoints(kn, from), fetched, 'live');

const DAY = 86400000;

/** Open-Meteo factice : respecte past_days et forecast_days, un pas toutes les 3 h depuis minuit UTC. */
function fakeOpenMeteo(url: string) {
  const q = new URL(url).searchParams;
  const past = Number(q.get('past_days') ?? 0);
  const days = past + Number(q.get('forecast_days') ?? 7);
  const from = Math.floor(Date.now() / DAY) * DAY - past * DAY;
  const time = Array.from({ length: days * 8 }, (_, k) => new Date(from + k * 3 * 3600000).toISOString().slice(0, 16));
  return q.get('latitude')!.split(',').map(() => ({
    hourly: { time, wind_speed_10m: time.map(() => 12), wind_direction_10m: time.map(() => 270) },
  }));
}

/** Charge les prévisions comme si on était `now` : période couverte (ms UTC) et nombre de jours demandés. */
async function loadAt(now: number) {
  setWindGrid(null);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(fakeOpenMeteo(url)))));
  const m = (await loadWindGrid())!.meta;
  return { from: m.t0, to: m.t0 + (m.nt - 1) * m.dt * 3600000, days: (m.nt * m.dt) / 24 };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setWindGrid(null);
});

describe('prévisions GFS', () => {
  it('au départ et à Fréhel, le vent vient entièrement des prévisions', () => {
    const w = new GridWind(uniform(20, 270), RHUM.startUTC);
    for (const p of [RHUM.start, RHUM_MARKS[0].pos]) {
      const [u, v] = w.at(p[0], p[1], 0);
      expect(u, `${p}`).toBeCloseTo(20, 1); // vent d'ouest : il pousse vers l'est
      expect(v, `${p}`).toBeCloseTo(0, 1);
    }
  });

  it('les prévisions se rechargent quand elles ont plus de 3 h', async () => {
    setWindGrid(uniform(10, 270, Date.now() - 4 * 3600000));
    const fetch = vi.fn(async () => new Response(JSON.stringify(omPoints(25, 0))));
    vi.stubGlobal('fetch', fetch);
    const g = await loadWindGrid();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(g!.meta.fetched).toBeGreaterThan(Date.now() - 60000);
    expect(windGrid()).toBe(g);
  });

  it('tant qu’elles sont fraîches, pas de nouvelle requête', async () => {
    const fresh = uniform(10, 270);
    setWindGrid(fresh);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await loadWindGrid()).toBe(fresh);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('fenêtre des prévisions', () => {
  const MOMENTS = [Date.UTC(2026, 9, 30, 10), Date.UTC(2026, 10, 5, 10), Date.UTC(2026, 10, 25, 10)];

  it('quatre jours après le départ, le vent remonte jusqu’au départ (rattrapage, arrivée en retard)', async () => {
    const w = await loadAt(Date.UTC(2026, 10, 5, 10));
    expect(w.from).toBeLessThanOrEqual(RHUM.startUTC);
  });

  it('jamais plus de 14 jours de données par requête (au-delà, Open-Meteo compte plusieurs appels)', async () => {
    for (const now of MOMENTS) expect((await loadAt(now)).days, new Date(now).toISOString()).toBeLessThanOrEqual(14);
  });

  it('les prévisions couvrent toujours le curseur de 5 jours', async () => {
    for (const now of MOMENTS) expect((await loadAt(now)).to - now, new Date(now).toISOString()).toBeGreaterThanOrEqual(5 * DAY);
  });
});

describe('course en cours', () => {
  it('prend les nouvelles prévisions sans redémarrer', () => {
    setWindGrid(uniform(10, 270));
    const race = new Race(RHUM, DEFAULT_SETUP);
    const next = uniform(25, 0);
    expect(race.setWindGrid(next)).toBe(true);
    const [u, v] = race.wind.at(-30, 30, 0);
    expect(Math.hypot(u, v)).toBeCloseTo(25, 1);
    expect(race.setWindGrid(next)).toBe(false); // déjà à jour
  });

  it('partie sans prévisions, passe au vent réel dès qu’elles arrivent', () => {
    setWindGrid(null);
    const race = new Race(RHUM, DEFAULT_SETUP);
    expect(race.realWind).toBe(false);
    expect(race.setWindGrid(uniform(10, 270))).toBe(true);
    expect(race.realWind).toBe(true);
  });

  it('un entraînement garde son vent simulé', () => {
    const race = new Race(raceById('acores'), DEFAULT_SETUP);
    expect(race.setWindGrid(uniform(10, 270))).toBe(false);
    expect(race.realWind).toBe(false);
  });
});

describe('heure de départ', () => {
  it('la Route du Rhum part à l’heure de la course, pas à celle gardée dans la sauvegarde', () => {
    const saved = { ...new Race(RHUM, DEFAULT_SETUP).serialize(), origin: RHUM.startUTC - 3 * 24 * 3600000 };
    expect(Race.restore(saved).originUTC).toBe(RHUM.startUTC);
  });

  it('un entraînement garde le moment où il a été lancé', () => {
    const saved = { ...new Race(raceById('acores'), DEFAULT_SETUP).serialize(), origin: 1234 };
    expect(Race.restore(saved).originUTC).toBe(1234);
  });
});
