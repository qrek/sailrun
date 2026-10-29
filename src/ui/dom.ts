const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENT[c]);

export function q<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`élément introuvable : ${sel}`);
  return el as T;
}

/** « 3 j 6 h », « 14 h », « 25 min » */
export function fmtDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  if (d === 0) return `${h} h`;
  return h === 0 ? `${d} j` : `${d} j ${h} h`;
}

export const ICON = {
  left: '<svg width="16" height="22" viewBox="0 0 16 22" aria-hidden="true"><path d="M12,3 L4,11 L12,19" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg width="16" height="22" viewBox="0 0 16 22" aria-hidden="true"><path d="M4,3 L12,11 L4,19" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10,2 L2,10 L10,18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pause: '<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M2,1 V15 M12,1 V15" stroke="currentColor" stroke-width="4"/></svg>',
  wind: '<svg width="22" height="18" viewBox="0 0 22 18" aria-hidden="true"><path d="M1,6 H14 a3,3 0 1,0 -3,-3 M1,12 H18 a3,3 0 1,1 -3,3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  sun: '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="5" fill="#FFD84D"/><path d="M11,1 V4 M11,18 V21 M1,11 H4 M18,11 H21 M3.9,3.9 L6,6 M16,16 L18.1,18.1 M3.9,18.1 L6,16 M16,6 L18.1,3.9" stroke="#FFD84D" stroke-width="2" stroke-linecap="round"/></svg>',
  moon: '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M15,3 A8.5,8.5 0 1,0 19,15 A7,7 0 0,1 15,3 Z" fill="#CFE0F2"/></svg>',
};

/** Jour de course (J1 = jour du départ) et heure UTC, pour `t` heures après le départ. */
export function raceClock(startUTC: number, t: number): string {
  const d = new Date(startUTC + t * 3600000);
  const s = new Date(startUTC);
  const day = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate())) / 86400000) + 1;
  return `J${day} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
