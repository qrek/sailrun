import { RACES, RaceDef, raceDistance, raceById } from '../data/races';
import { typicalHours } from '../data/garage';
import { FLAG, GEN_LABEL, Gen } from '../data/fleet';
import { Race, SavedRace } from '../sim/race';
import { windGrid } from '../sim/gfsWind';
import { esc, fmtDuration } from './dom';
import { fmtDist } from './units';

export interface MenuHandlers {
  pick(def: RaceDef): void;
  resume(): void;
}

let timer = 0;

const ICON_FLEET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3 V17 M7 4 C10 7 12 11 12 16 H7 M16 6 V18 M16 7 C18 9 19 12 19 16 H16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 19 C7 21 17 21 21 19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_WX = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9 H15 A3 3 0 1 0 12 6 M3 14 H19 A3 3 0 1 1 16 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5 L19 12 L8 19 Z" fill="currentColor"/></svg>';

/** Petite carte du parcours (projection simple) pour illustrer une carte de course. */
function routeArt(d: RaceDef): string {
  const pts = [d.start, ...d.routes[0]];
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const x0 = Math.min(...lons) - 3;
  const x1 = Math.max(...lons) + 3;
  const y0 = Math.min(...lats) - 3;
  const y1 = Math.max(...lats) + 3;
  const sx = (lon: number) => (((lon - x0) / (x1 - x0)) * 200).toFixed(1);
  const sy = (lat: number) => ((1 - (lat - y0) / (y1 - y0)) * 90).toFixed(1);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0])},${sy(p[1])}`).join(' ');
  const a = pts[0];
  const b = pts[pts.length - 1];
  return `<svg class="mx-art" viewBox="0 0 200 90" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path d="${path}" class="r"/>
    <circle cx="${sx(a[0])}" cy="${sy(a[1])}" r="3.5" class="s"/>
    <circle cx="${sx(b[0])}" cy="${sy(b[1])}" r="4.5" class="f"/>
  </svg>`;
}

function countdown(startUTC: number): string {
  const ms = startUTC - Date.now();
  if (ms <= 0) {
    const h = -ms / 3600000;
    return h < 24 * 30 ? `En course depuis ${fmtDuration(h)}` : 'Course terminée';
  }
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${d} j ${String(h).padStart(2, '0')} h ${String(m).padStart(2, '0')} min ${String(sec).padStart(2, '0')} s`;
}

const startLabel = (utc: number) =>
  new Date(utc).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

/** Accueil façon menu de jeu : la carte en fond, la course officielle en vedette, un carrousel de modes. */
export function renderMenu(root: HTMLElement, saved: SavedRace | null, h: MenuHandlers) {
  window.clearInterval(timer);
  const featured = RACES.find((r) => r.featured) ?? RACES[0];
  const training = RACES.filter((r) => r !== featured);

  let resume = '';
  if (saved) {
    const def = raceById(saved.raceId);
    let line = '';
    try {
      const r = Race.restore(saved);
      const rank = r.standings().indexOf(r.player) + 1;
      line = `J${Math.floor(r.t / 24) + 1} · ${rank}<sup>${rank === 1 ? 'er' : 'e'}</sup>/${r.boats.length} · ${fmtDist(r.remaining(r.player))}`;
    } catch {
      line = 'Course en cours';
    }
    resume = `
      <button type="button" class="mx-card resume" data-resume>
        <span class="mx-ill">${routeArt(def)}<span class="mx-badge">${ICON_PLAY} Reprendre</span></span>
        <span class="mx-t"><b>${esc(def.name)}</b><small>${line}</small></span>
      </button>`;
  }

  const card = (d: RaceDef, feat = false) => `
      <button type="button" class="mx-card${feat ? ' feat' : ''}" data-race="${d.id}">
        <span class="mx-ill">${routeArt(d)}${feat ? '<span class="mx-badge live">Officielle</span>' : '<span class="mx-badge">Entraînement</span>'}</span>
        <span class="mx-t"><b>${esc(d.name)}</b><small>${esc(d.from)} → ${esc(d.to)} · ${fmtDist(raceDistance(d))}${feat ? '' : ` · ≈ ${fmtDuration(typicalHours(d) ?? raceDistance(d) / 14)}`}</small></span>
      </button>`;

  const g = windGrid();
  const gfs = g ? `GFS ${new Date(g.meta.t0).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })} ${String(new Date(g.meta.t0).getUTCHours()).padStart(2, '0')}Z${g.meta.source === 'snapshot' ? ' · hors ligne' : ''}` : 'Météo GFS · chargement';

  root.innerHTML = `
    <div class="mx">
      <header class="mx-top">
        <div class="mx-logo"><b>SAIL RUN</b><small>Course au large · saison 2026</small></div>
        <div class="mx-wx"><i class="${g ? 'ok' : ''}"></i>${esc(gfs)}</div>
      </header>

      <section class="mx-hero">
        <span class="mx-eyebrow">${esc(featured.klass ? `Classe ${featured.klass}` : '')} · ${featured.fleet?.length ?? 0} engagés · météo réelle</span>
        <h1>${esc(featured.name)}</h1>
        <p class="mx-sub">${esc((featured.officialName ?? featured.name).replace(featured.name, '').replace(/^\s*–\s*/, ''))} · ${esc(featured.from)} → ${esc(featured.to)} · ${esc(featured.distanceLabel ?? fmtDist(raceDistance(featured)))}</p>
        <div class="mx-count"><small>Départ ${esc(startLabel(featured.startUTC))}</small><b data-count>${countdown(featured.startUTC)}</b></div>
        <p class="mx-blurb">${esc(featured.blurb)}</p>
        <div class="mx-cta-row">
          <button type="button" class="mx-cta" data-race="${featured.id}">${ICON_PLAY}<span>Préparer mon IMOCA</span></button>
          <button type="button" class="mx-ghost" data-fleet>${ICON_FLEET}<span>Les engagés</span></button>
        </div>
      </section>

      <div class="mx-rail" role="list">
        ${resume}
        ${card(featured, true)}
        ${training.map((d) => card(d)).join('')}
      </div>

      <nav class="mx-bar" aria-label="Menu">
        <button type="button" data-fleet>${ICON_FLEET}<span>Flotte</span></button>
        <span class="mx-note">${ICON_WX}<span>Vent GFS (NOAA) via Open-Meteo · positions des concurrents simulées jusqu’au départ</span></span>
      </nav>

      <div class="mx-fleet" data-fleet-panel hidden>
        <div class="mx-fleet-in card">
          <div class="mx-fh"><span class="eyebrow">${esc(featured.name)} · ${esc(featured.klass ?? '')} · ${featured.fleet?.length ?? 0} engagés</span><button type="button" class="x" data-fleet-close aria-label="Fermer">✕</button></div>
          ${(['new', 'foil', 'dagger'] as Gen[])
            .map((gen) => {
              const list = (featured.fleet ?? []).filter((f) => f.gen === gen);
              if (!list.length) return '';
              return `<h3>${esc(GEN_LABEL[gen])}</h3><ul>${list
                .map((f) => `<li><i style="background: ${f.color}"></i><span class="fl">${FLAG[f.nat] ?? ''}</span><b>${esc(f.skipper)}</b><span>${esc(f.boat)}</span></li>`)
                .join('')}</ul>`;
            })
            .join('')}
          <p class="mx-fnote">Liste des engagés d’après l’organisation et la presse (octobre 2026). Génération des bateaux et niveau des skippers : estimations de jeu.</p>
        </div>
      </div>
    </div>`;

  root.querySelector('[data-resume]')?.addEventListener('click', () => h.resume());
  root.querySelectorAll<HTMLButtonElement>('[data-race]').forEach((b) => b.addEventListener('click', () => h.pick(raceById(b.dataset.race!))));
  const panel = root.querySelector<HTMLElement>('[data-fleet-panel]')!;
  root.querySelectorAll('[data-fleet]').forEach((b) => b.addEventListener('click', () => (panel.hidden = false)));
  root.querySelector('[data-fleet-close]')?.addEventListener('click', () => (panel.hidden = true));
  panel.addEventListener('click', (e) => {
    if (e.target === panel) panel.hidden = true;
  });
  const cnt = root.querySelector('[data-count]');
  timer = window.setInterval(() => {
    if (!cnt?.isConnected) return window.clearInterval(timer);
    cnt.textContent = countdown(featured.startUTC);
  }, 1000);
}
