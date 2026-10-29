/**
 * Courants et houle réels en un point (API marine d'Open-Meteo, modèles Mercator / MFWAM).
 * Chargés à la demande pour la sonde de la carte, mis en cache par case de 0,25°.
 * Purement informatif : la simulation de vitesse ne tient pas encore compte du courant.
 */
export interface MarineSeries {
  t0: number;
  /** courant : vitesse (nœuds) et direction vers laquelle il porte (°) */
  cur: number[];
  curDir: number[];
  /** houle : hauteur (m) et direction d'où elle vient (°) */
  wave: number[];
  waveDir: number[];
}

const cache = new Map<string, Promise<MarineSeries | null>>();

export function fetchMarine(lon: number, lat: number): Promise<MarineSeries | null> {
  const la = Math.round(lat * 4) / 4;
  const lo = Math.round(lon * 4) / 4;
  const key = `${la},${lo}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(
          `https://marine-api.open-meteo.com/v1/marine?latitude=${la}&longitude=${lo}&hourly=ocean_current_velocity,ocean_current_direction,wave_height,wave_direction&forecast_days=16&timezone=GMT`,
        );
        if (!r.ok) return null;
        const j = await r.json();
        const h = j.hourly;
        if (!h?.time?.length) return null;
        return {
          t0: Date.parse(h.time[0] + 'Z'),
          cur: (h.ocean_current_velocity as (number | null)[]).map((v) => (v ?? NaN) / 1.852),
          curDir: (h.ocean_current_direction as (number | null)[]).map((v) => v ?? NaN),
          wave: (h.wave_height as (number | null)[]).map((v) => v ?? NaN),
          waveDir: (h.wave_direction as (number | null)[]).map((v) => v ?? NaN),
        };
      } catch {
        return null;
      }
    })();
    cache.set(key, p);
  }
  return p;
}

/** Valeurs à une heure donnée (ms UTC), ou null hors des prévisions / à terre. */
export function marineAt(s: MarineSeries, utc: number): { cur: number; curDir: number; wave: number; waveDir: number } | null {
  const i = Math.round((utc - s.t0) / 3600000);
  if (i < 0 || i >= s.cur.length) return null;
  const v = { cur: s.cur[i], curDir: s.curDir[i], wave: s.wave[i], waveDir: s.waveDir[i] };
  return Number.isNaN(v.cur) && Number.isNaN(v.wave) ? null : v;
}
