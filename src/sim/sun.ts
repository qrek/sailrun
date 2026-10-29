import { D2R, R2D } from './geo';

/** Hauteur du soleil (°) à une position et une heure UTC données. Approximation suffisante pour jour / nuit. */
export function sunElevation(lon: number, lat: number, utcMs: number): number {
  const d = new Date(utcMs);
  const doy = Math.floor((utcMs - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  const dec = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10)) * D2R;
  const hUtc = d.getUTCHours() + d.getUTCMinutes() / 60;
  const H = (hUtc + lon / 15 - 12) * 15 * D2R;
  const la = lat * D2R;
  return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)) * R2D;
}
