import { afterEach, describe, expect, it, vi } from 'vitest';
import handler, { RACE_START_UTC } from '../api/wind';
import { RHUM } from '../src/data/races';
import { GRID, decodeGrid } from '../src/sim/gfsWind';

afterEach(() => vi.unstubAllGlobals());

function omResponse(url: string) {
  const q = new URL(url).searchParams;
  const n = q.get('latitude')!.split(',').length;
  const time = Array.from({ length: 16 }, (_, k) => new Date(Date.UTC(2026, 10, 1) + k * 3 * 3600000).toISOString().slice(0, 16));
  return Array.from({ length: n }, () => ({ hourly: { time, wind_speed_10m: time.map(() => 15), wind_direction_10m: time.map(() => 0) } }));
}

describe('météo servie par le serveur (api/wind)', () => {
  it('même départ que la course', () => {
    expect(RACE_START_UTC).toBe(RHUM.startUTC);
  });

  it('une seule requête Open-Meteo, une grille au format du jeu, gardée une heure par le CDN', async () => {
    const f = vi.fn(async (url: string) => new Response(JSON.stringify(omResponse(url))));
    vi.stubGlobal('fetch', f);
    const r = await handler();
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(200);
    expect(r.headers.get('cdn-cache-control')).toContain('s-maxage=3600');
    const g = decodeGrid(await r.text());
    expect(g.meta.nlat * g.meta.nlon).toBe(GRID.nlat * GRID.nlon);
    expect(g.meta.source).toBe('server');
    expect(g.v[0]).toBe(-1500); // vent du nord : il pousse vers le sud
  });

  it('Open-Meteo refuse : 503 et rien en cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const r = await handler();
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});
