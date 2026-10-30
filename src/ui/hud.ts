import { AVARIES, Boat, REPAIR_HOURS, SAILS, SAIL_STEPS, SailId, bestSail, boatSpeed, sailFactor, sailRemaining, sailStep, sailSwitch, speedFactors, targetSail, workingSail } from '../sim/boat';
import { bearing, dist, fmtInt, move, norm180 } from '../sim/geo';
import { Race, TIME_SCALES } from '../sim/race';
import { GridWind } from '../sim/gfsWind';
import { FLAG, IMOCA_RHUM_2026 } from '../data/fleet';
import { clearAhead } from '../sim/router';
import { windFrom } from '../sim/wind';
import { ICON, esc, fmtDuration, q, raceClock } from './dom';
import { SAIL_ART, crossoverSvg, dialAngle, pilotDial, setPilotDial } from './instruments';
import { DistUnit, distUnit, fmtDist, setDistUnit, toUnit, unitLabel } from './units';

export type LayerId = 'wind' | 'clouds';
export type ViewMode = '2d' | '3d' | 'reset' | 'immersive';

export type PilotMode = 'auto' | 'hdg';

export interface HudHandlers {
  steer(delta: number): void;
  /** carte en relief 3D ou à plat */
  map3d(on: boolean): void;
  /** consigne de cap en cours de réglage (aperçu sur la carte), null = aucun */
  preview(hdg: number | null): void;
  /** applique la consigne réglée */
  commit(hdg: number): void;
  setAuto(on: boolean): void;
  sleep(): void;
  repair(): void;
  bearAway(): void;
  speed(id: string): void;
  pause(): void;
  /** mode test : vent et houle imposés à la vue immersive (null = ceux de la course) */
  devSea(o: { tws: number | null; twa: number | null; swell: number }): void;
  /** mode test : fait venir des dauphins ou une baleine tout de suite */
  devLife(kind: 'dolphins' | 'whale'): void;
  view(mode: ViewMode): void;
  menu(): void;
  say(text: string): void;
  sail(id: SailId): void;
  autoSail(on: boolean): void;
  lock(mode: 'hdg' | 'twa'): void;
  forecast(hours: number): void;
  units(u: DistUnit): void;
  forecastPlay(): void;
  layer(id: LayerId, on: boolean): void;
  /** Barre (on navigue) ou Route (on pose ses points sur la carte) */
  setMode(m: 'barre' | 'route'): void;
  cpDelete(i: number): void;
  /** le prochain point posé s'insère après le point i */
  cpInsertAfter(i: number): void;
  cpClear(): void;
  /** frise du temps : heures depuis maintenant */
  scrub(h: number): void;
  /** fenêtre 3D : ouverte / réduite, ou plein écran */
  pip(open: boolean): void;
  pipFull(): void;
}

/** Bulle d'un point de route, posée à côté du repère sur la carte. */
export interface CpBubble {
  n: number;
  x: number;
  y: number;
  eta: string;
  dist: string;
  hdg: number;
  pace: string;
  upwind: boolean;
}

/** Barre de route : résumé, points sur la frise, suivi. */
export interface RouteBar {
  count: number;
  total: string;
  arrival: string;
  following: boolean;
  /** position des points sur la frise (0 à 1) */
  marks: number[];
  /** graduations de la frise */
  ticks: { at: number; label: string; day: boolean }[];
  inserting: number | null;
  /** durée couverte par la frise (h) */
  hours: number;
}

type AlertAction = 'sleep' | 'repair' | 'bear' | 'sail';

const QUICK = ['Bon vent !', 'GG', 'On se voit à l’arrivée', 'Qui a du café ?'];

/** Couleurs des voiles, partagées par le sélecteur et la polaire. */
export const SAIL_COLOR: Record<SailId, string> = { foc: '#22D3EE', code0: '#A78BFA', spi: '#FB7185' };
const SAIL_WHY: Record<SailId, string> = {
  foc: 'petite voile plate : elle permet de remonter au vent, à moins de 70°.',
  code0: 'grande voile légère : la reine du vent de travers (70 à 110°), mais elle souffre au-delà de 24 nds.',
  spi: 'énorme voile creuse : elle pousse fort quand le vent vient de l’arrière, au-delà de 120°.',
};
const FC_MAX = 120;

const ICON_PLAY = '<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M2,1.5 L12.5,8 L2,14.5 Z" fill="currentColor"/></svg>';
const ICON_ROUTE = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 18 V3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M5 3.5 H15 L12.5 7 L15 10.5 H5" fill="currentColor" fill-opacity="0.35" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const ICON_FLAG = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 11 V1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M2.5 2 H10 L8.3 4.3 L10 6.6 H2.5 Z" fill="currentColor"/></svg>';
const ICON_HELM = '<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="1.8" fill="currentColor"/><path d="M10 1.5 V4 M10 16 V18.5 M1.5 10 H4 M16 10 H18.5 M4 4 L5.8 5.8 M14.2 14.2 L16 16 M4 16 L5.8 14.2 M14.2 5.8 L16 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_POLAR = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3,2 V18 M3,4 C10,4 16,8 16,12 C16,15 12,17 3,17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_TROPHY = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 2 H13 V7 A4 4 0 0 1 5 7 Z M5 4 H2 A3 3 0 0 0 5 8 M13 4 H16 A3 3 0 0 1 13 8 M9 11 V14 M6 16 H12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WINDS = '<svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true"><path d="M1 5 H12 A3 3 0 1 0 9 2 M1 10 H16 A3 3 0 1 1 13 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_RADIO = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="12" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 7 L 8 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="8" y="10" width="6" height="4" rx="1" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="13" cy="18" r="1.2" fill="currentColor"/><path d="M19.5 9 A5 5 0 0 1 19.5 16 M21.5 7 A8 8 0 0 1 21.5 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_LOCK = '<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><rect x="1.5" y="7" width="11" height="8" rx="1.5" fill="currentColor"/><path d="M4 7 V5 A3 3 0 0 1 10 5 V7" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const ICON_MOON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M11 1.5 A6.5 6.5 0 1 0 14.5 11 A5.2 5.2 0 0 1 11 1.5 Z" fill="currentColor"/></svg>';
const ICON_TELE = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 15 L6 9 L10 12 L14 5 L18 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 18 H18" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_SKIPPER = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3 18 C4 12.5 16 12.5 17 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
const ICON_RELIEF = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M1 16 L7 6 L10.5 11 L13 8 L19 16 Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>';
const ICON_EYE = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10 C4 5 16 5 18.5 10 C16 15 4 15 1.5 10 Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/></svg>';
const ICON_TARGET = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="1.8" fill="currentColor"/><path d="M10 1 V4 M10 16 V19 M1 10 H4 M16 10 H19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_GEAR = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 1.5 V4 M10 16 V18.5 M1.5 10 H4 M16 10 H18.5 M4 4 L5.8 5.8 M14.2 14.2 L16 16 M4 16 L5.8 14.2 M14.2 5.8 L16 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2,2 L12,12 M12,2 L2,12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/** Têtes du skipper selon sa forme (dans la jauge d'énergie). */
const FACE: Record<string, string> = {
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" class="h"/><circle cx="9" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/><path d="M8.5 14 Q12 17.5 15.5 14" class="l"/></svg>',
  mid: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" class="h"/><path d="M7.5 10 H10.5 M13.5 10 H16.5" class="l"/><path d="M9 15 H15" class="l"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" class="h"/><path d="M7.5 9 L10.5 11 M16.5 9 L13.5 11" class="l"/><path d="M8.5 16 Q12 13 15.5 16" class="l"/></svg>',
  sleep: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" class="h"/><path d="M7.5 11 Q9 12.5 10.5 11 M13.5 11 Q15 12.5 16.5 11" class="l"/><path d="M10.5 15.5 H13.5" class="l"/><text x="17" y="6" class="z">z</text></svg>',
};

const pct = (f: number) => `${Math.round(f * 100)} %`;
const kn = (v: number) => v.toFixed(1).replace('.', ',');
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const cardinal = (deg: number) => CARD[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** Interface de course : classement, alertes, barre, voiles, prévisions, énergie, tchat. */
export class Hud {
  private toastT = 0;
  private alertAction: AlertAction | null = null;
  private lastOrder: string[] | null = null;
  private polarOpen = false;
  private lastPolarKey = '';
  onPassed: ((who: Boat, byMe: boolean) => void) | null = null;

  constructor(
    private root: HTMLElement,
    private h: HudHandlers,
    layers: Record<LayerId, boolean>,
  ) {
    root.innerHTML = `
      <div class="card rank" data-rank role="button" tabindex="0" aria-label="Classement">
        <div class="num pos"><span data-pos>P1</span><span class="of" data-of>/6</span></div>
        <div class="meta">
          <span class="eyebrow" data-race></span>
          <span class="remain" data-remain></span>
          <span class="mk" data-mark hidden></span>
        </div>
        <div class="rk-clock"><span data-sky>${ICON.sun}</span><b class="num" data-clock>J1 · 12:00</b><small>UTC · temps réel</small></div>
      </div>
      <div class="card prestart" data-prestart hidden>
        <span class="eyebrow">Départ dans</span>
        <b class="num" data-pre-count>—</b>
        <small>Règle ton cap et ta voile : le départ est donné à l'heure réelle.</small>
      </div>
      <div class="card seg devspeed" data-devspeed role="group" aria-label="Vitesse du temps (test)" hidden>
        <button type="button" data-pause aria-label="Pause" aria-pressed="false">${ICON.pause}</button>
        ${TIME_SCALES.map((t) => `<button type="button" data-speed="${t.id}" aria-pressed="false">${esc(t.label)}</button>`).join('')}
      </div>
      <div class="card devsea" data-devsea role="group" aria-label="Vent et houle de la vue immersive (test)" hidden>
        <span class="eyebrow">Test · vent et houle</span>
        <label><span>Vent</span><input type="range" data-dev="tws" min="0" max="45" step="1" aria-label="Force du vent (nœuds)" /><b data-dev-v="tws"></b></label>
        <label><span>Angle</span><input type="range" data-dev="twa" min="-180" max="180" step="5" aria-label="Angle au vent (degrés)" /><b data-dev-v="twa"></b></label>
        <label><span>Houle</span><input type="range" data-dev="swell" min="0.2" max="3" step="0.1" value="1" aria-label="Taille de la houle" /><b data-dev-v="swell"></b></label>
        <div class="devbtns"><button type="button" data-dev-reset aria-label="Revenir au vent de la course">Vent de la course</button><button type="button" data-dev-life="dolphins">Dauphins</button><button type="button" data-dev-life="whale">Baleine</button></div>
      </div>

      <nav class="rail" aria-label="Outils">
        <button type="button" data-open="fc" aria-expanded="false">${ICON_WINDS}<span>Prévisions</span><b class="rbadge" data-fc-badge hidden></b></button>
        <button type="button" data-open="tele" aria-expanded="false">${ICON_TELE}<span>Télémétrie</span></button>
        <button type="button" data-open="board" aria-expanded="false" data-board-btn>${ICON_TROPHY}<span>Classement</span></button>
        <button type="button" data-open="skip" aria-expanded="false">${ICON_SKIPPER}<span>Skipper</span><b class="rbadge warn" data-sk-badge hidden>!</b></button>
        <button type="button" data-open="polar" aria-expanded="false" data-polar>${ICON_POLAR}<span>Polaire</span></button>
        <button type="button" data-map3d aria-pressed="false">${ICON_RELIEF}<span>Relief 3D</span></button>
        <button type="button" data-view="immersive" aria-pressed="false">${ICON_EYE}<span>Immersif</span></button>
        <button type="button" data-view="reset">${ICON_TARGET}<span>Recentrer</span></button>
        <button type="button" data-open="set" aria-expanded="false">${ICON_GEAR}<span>Options</span></button>
      </nav>

      <div class="card panel fc" data-panel="fc" data-fc-panel hidden>
        <div class="p-head"><span class="fc-info"><span class="fc-label" data-fc-label>Prévisions</span><span class="fc-sub" data-fc-sub>Glisse pour voir le vent à venir</span></span><button type="button" class="x" data-close aria-label="Fermer">${ICON_CLOSE}</button></div>
        <div class="fc-row">
          <button type="button" class="fc-play" data-fc-play aria-label="Faire défiler les prévisions">${ICON_PLAY}</button>
          <div class="fc-track">
            <input type="range" min="0" max="${FC_MAX}" step="1" value="0" data-fc-range aria-label="Prévisions : heures à venir">
            <div class="fc-ticks" aria-hidden="true"><span>Maint.</span><span>+24 h</span><span>+48 h</span><span>+72 h</span><span>+96 h</span><span>+5 j</span></div>
          </div>
        </div>
        <button type="button" class="pill fc-now" data-fc-now hidden>Revenir à maintenant</button>
        <p class="p-note">Clique sur la mer pour poser une sonde : vent, courant et houle à cet endroit.</p>
      </div>

      <div class="card panel tele" data-panel="tele" data-tele hidden>
        <div class="p-head"><span class="eyebrow">Télémétrie</span><span class="tele-src" data-tele-src></span><button type="button" class="x" data-close aria-label="Fermer">${ICON_CLOSE}</button></div>
        <div class="tele-body" data-tele-body>
          <div class="tg">
            <div class="tc"><small>BSP</small><b data-t="bsp">0,0</b><i>nds</i></div>
            <div class="tc"><small>Cible polaire</small><b data-t="tgt">0,0</b><i data-t="eff">0 %</i></div>
            <div class="tc"><small>TWS</small><b data-t="tws">0</b><i>nds</i></div>
            <div class="tc"><small>TWD</small><b data-t="twd">000°</b><i data-t="twdc">N</i></div>
            <div class="tc"><small>TWA</small><b data-t="twa">0°</b><i data-t="side">TRI</i></div>
            <div class="tc"><small>HDG</small><b data-t="hdg">000°</b><i>vrai</i></div>
            <div class="tc"><small>VMG marque</small><b data-t="vmg">0,0</b><i>nds</i></div>
            <div class="tc"><small>Écart leader</small><b data-t="gap">—</b><i data-t="gapu"></i></div>
          </div>
          <div class="eff-bar" aria-hidden="true"><i data-t="effbar"></i></div>
          <div class="foil" data-t="foil"><span class="eyebrow">Foils</span><span class="fstate" data-t="fstate">Archimédien</span><span class="fbar"><i data-t="fload"></i></span></div>
          <div class="tline"><span class="eyebrow">Prochaine marque</span><span data-t="mark">—</span></div>
          <div class="tline"><span class="eyebrow">Dernier checkpoint</span><span data-t="eta">—</span></div>
        </div>
      </div>

      <div class="card panel board-pop" data-panel="board" data-board-pop hidden>
        <div class="p-head"><span class="eyebrow" data-board-title>Classement</span><button type="button" class="x" data-close aria-label="Fermer">${ICON_CLOSE}</button></div>
        <ol class="board" data-board aria-label="Classement"></ol>
      </div>

      <div class="card panel skip" data-panel="skip" hidden>
        <div class="p-head"><span class="eyebrow">Skipper</span><button type="button" class="x" data-close aria-label="Fermer">${ICON_CLOSE}</button></div>
        <div class="skip-row">
          <div class="skipper-g" data-en-ring>
            <svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" class="bg"/><circle cx="22" cy="22" r="18" class="fg" pathLength="100" data-en-arc/></svg>
            <span class="face" data-en-face></span>
          </div>
          <span class="en-state" data-en-state>En forme · 100 %</span>
        </div>
        <button type="button" class="nap" data-sleep>${ICON_MOON}<span>Sieste 2 h</span></button>
        <p class="p-note">Ton skipper perd environ 2 points d’énergie par heure. Sous 25 %, le bateau va 12 % moins vite. Une sieste de 2 h rend 28 points ; pendant ce temps personne ne règle les voiles, et toucher la barre ou les voiles le réveille.</p>
      </div>

      <div class="card panel polar" data-panel="polar" data-polar-panel hidden>
        <div class="p-head"><span class="eyebrow" data-pol-title>Polaire</span><button type="button" class="x" data-close aria-label="Fermer">${ICON_CLOSE}</button></div>
        <div class="xo" data-xover></div>
        <div class="pol-body">
          <svg class="pol-svg" viewBox="-16 -150 186 300" data-pol-svg role="img" aria-label="Vitesse du bateau selon l’angle au vent, pour chaque voile"></svg>
          <div class="pol-side">
            <ul class="pol-key">${SAILS.map((s) => `<li><i style="background: ${SAIL_COLOR[s.id]}"></i>${esc(s.name)} <span class="muted">${esc(s.hint)}</span></li>`).join('')}</ul>
            <p class="pol-why" data-pol-why></p>
          </div>
        </div>
        <span class="eyebrow">D’où vient ta vitesse</span>
        <ul class="pol-break" data-pol-break></ul>
      </div>

      <div class="card panel set" data-panel="set" hidden>
        <div class="p-head"><span class="eyebrow">Options</span><button type="button" class="x" data-close aria-label="Fermer">${ICON_CLOSE}</button></div>
        <div class="set-row"><span>Distances</span><div class="seg mini" role="group" aria-label="Unité des distances">
          <button type="button" data-unit="km" aria-pressed="${distUnit() === 'km'}">km</button>
          <button type="button" data-unit="nm" aria-pressed="${distUnit() === 'nm'}">milles</button>
        </div></div>
        <div class="set-row"><span>Vent sur la carte</span><div class="seg mini" role="group" aria-label="Vent sur la carte">
          <button type="button" data-layer="wind" aria-pressed="${layers.wind}">Traits</button>
        </div></div>
        <button type="button" class="pill" data-menu>Retour au menu</button>
      </div>

      <div class="alert" data-alert role="status" hidden>
        ${ICON.wind}
        <span class="msg" data-alert-msg></span>
        <button type="button" data-alert-btn></button>
      </div>
      <div class="toast" data-toast style="opacity: 0" aria-live="polite"></div>
      <div class="pick" data-pick hidden></div>
      <div class="card probe" data-probe hidden>
        <div class="pr-head"><span class="eyebrow">Sonde</span><span class="pr-pos" data-pr-pos></span><button type="button" class="x" data-pr-close aria-label="Retirer la sonde">${ICON_CLOSE}</button></div>
        <div class="pr-row"><span class="k">Vent</span><b data-pr-wind></b></div>
        <div class="pr-row"><span class="k">Courant</span><b data-pr-cur>…</b></div>
        <div class="pr-row"><span class="k">Houle</span><b data-pr-wave>…</b></div>
        <div class="pr-row"><span class="k">Depuis toi</span><b data-pr-from></b></div>
        <div class="pr-row"><span class="k">Ton TWA là-bas</span><b data-pr-twa></b></div>
        <span class="pr-time" data-pr-time></span>
      </div>

      <div class="cockpit">
        <div class="card helm2">
          <div class="seg mini modes" role="group" aria-label="Mode de pilotage">
            <button type="button" data-mode="hdg" aria-pressed="false" title="Le bateau garde le cap que tu as validé">${ICON_LOCK} Cap fixe</button>
            <button type="button" data-mode="auto" aria-pressed="false" title="Le pilote suit ta route, point après point">${ICON_FLAG} Suivre la route</button>
          </div>
          <div class="h-auto" data-auto-info></div>
          ${pilotDial()}
          <div class="h-read"><span>BSP <b data-bsp>0,0</b></span><span>Vent <b data-tws>0</b> nds</span></div>
          <div class="h-pend" data-pend hidden><span data-pend-info></span><span class="warn" data-pend-warn></span></div>
          <div class="h-act">
            <button type="button" class="nb" data-nudge="-10" aria-label="10° à gauche">−10</button>
            <button type="button" class="nb" data-nudge="-1" aria-label="1° à gauche">−1</button>
            <button type="button" class="ok" data-pend-ok disabled><span data-pend-v>OK</span></button>
            <button type="button" class="nb" data-nudge="1" aria-label="1° à droite">+1</button>
            <button type="button" class="nb" data-nudge="10" aria-label="10° à droite">+10</button>
          </div>
        </div>
        <div class="card sailc">
          <div class="sx-now" data-sx-now></div>
          <div class="sx-chg" data-sx-chg hidden aria-live="polite">
            <div class="sx-chg-h">
              <span class="sx-pair" aria-hidden="true"><span class="sx-mini" data-sx-from></span><i>→</i><span class="sx-mini" data-sx-to></span></span>
              <span class="sx-t"><small data-sx-kind>Changement de voile</small><b data-sx-title></b></span>
            </div>
            <ol class="sx-steps">
              ${SAIL_STEPS.map((s, i) => `<li data-sx-step="${i}"><span class="sx-n">${esc(s.name)}</span><span class="sx-w" data-sx-w></span><span class="sx-f">−${Math.round((1 - s.f) * 100)} %</span><span class="sx-bar"><i data-sx-fill></i></span></li>`).join('')}
            </ol>
            <p class="sx-what" data-sx-what></p>
            <div class="sx-foot"><span data-sx-left></span><button type="button" class="sx-x" data-sx-cancel>Annuler</button></div>
          </div>
          <div class="sx-head">
            <span class="eyebrow">Changer</span>
            <div class="seg mini" role="group" aria-label="Changement de voile">
              <button type="button" data-autosail="1" aria-pressed="true" title="Change de voile tout seul quand une autre est meilleure">Auto</button>
              <button type="button" data-autosail="0" aria-pressed="false" title="Garde la voile actuelle">${ICON_LOCK}</button>
            </div>
          </div>
          <div class="sails" role="group" aria-label="Voiles">
            ${SAILS.map((s) => `<button type="button" class="sail" data-sail="${s.id}" aria-pressed="false" style="--sc: ${SAIL_COLOR[s.id]}" title="${esc(s.name)} : ${esc(s.hint)}"><svg viewBox="0 0 56 60" aria-hidden="true">${SAIL_ART[s.id]}</svg><span class="sn">${esc(s.name)}</span><span class="sp" data-sp="${s.id}">100 %</span><span class="sv" data-sv="${s.id}"></span></button>`).join('')}
          </div>
        </div>
      </div>

      <div class="modesw" role="tablist" aria-label="Mode de jeu">
        <button type="button" role="tab" data-msw="barre" aria-selected="true">${ICON_HELM}<span>Barre</span></button>
        <button type="button" role="tab" data-msw="route" aria-selected="false">${ICON_ROUTE}<span>Route</span><b class="msw-n" data-msw-n hidden>0</b></button>
      </div>

      <div class="card routebar" data-routebar hidden>
        <div class="rb-top">
          <div class="rb-sum" data-rb-sum><b>Touche la mer pour poser ton premier point</b><small>Le pilote filera droit d’un point à l’autre. Face au vent, il serre le vent au plus près : place tes points pour tirer tes bords.</small></div>
          <div class="rb-act">
            <button type="button" class="pill ghost" data-rb-clear hidden>Effacer</button>
            <button type="button" class="rb-go" data-rb-go disabled>Lancer la route</button>
          </div>
        </div>
        <div class="tstrip" data-tstrip>
          <button type="button" class="ts-play" data-ts-play aria-label="Faire défiler le temps">${ICON_PLAY}</button>
          <div class="ts-track">
            <div class="ts-ticks" data-ts-ticks></div>
            <div class="ts-marks" data-ts-marks></div>
            <input type="range" min="0" max="${FC_MAX}" step="0.5" value="0" data-ts-range aria-label="Heure affichée sur la carte">
          </div>
          <span class="ts-now" data-ts-label>Maintenant</span>
        </div>
      </div>

      <div class="cpbub" data-cpbub hidden>
        <div class="cb-h"><b data-cb-n>Point 1</b><span data-cb-eta></span></div>
        <div class="cb-r" data-cb-r></div>
        <div class="cb-a"><button type="button" data-cb-ins>+ Point après</button><button type="button" class="del" data-cb-del>Supprimer</button></div>
      </div>

      <div class="pipw" data-pip>
        <div class="pip-frame" data-pip-frame role="button" tabindex="0" aria-label="Vue 3D du bateau : toucher pour le plein écran"><span class="pip-l">Vue bateau · direct</span><span class="pip-full">Plein écran</span></div>
        <button type="button" class="pip-min" data-pip-min aria-label="Réduire la vue 3D">−</button>
        <button type="button" class="pip-open" data-pip-open aria-label="Afficher la vue 3D">${ICON_EYE}<span>3D</span></button>
      </div>

      <div class="vhf" data-vhf>
        <div class="card vhf-panel" data-vhf-panel hidden>
          <div class="vhf-head">
            <span class="vhf-ch"><b>VHF</b> canal 16</span>
            <span class="vhf-sub">Radio entre les bateaux de la course</span>
            <button type="button" class="x" data-vhf-close aria-label="Fermer la radio">${ICON_CLOSE}</button>
          </div>
          <div class="feed" data-feed aria-live="polite"></div>
          <div class="quick">${QUICK.map((t) => `<button type="button" data-say>${esc(t)}</button>`).join('')}</div>
        </div>
        <button type="button" class="vhf-btn" data-vhf-btn aria-expanded="false" aria-label="Radio VHF">${ICON_RADIO}<b class="vhf-badge" data-vhf-badge hidden>0</b></button>
      </div>`;
    this.bind();
  }

  private openPanel: string | null = null;
  /** Un seul panneau ouvert à la fois, ouvert depuis la barre d'outils. */
  private toggle(id: string | null) {
    const r = this.root;
    const next = id === this.openPanel ? null : id;
    if (this.openPanel === 'fc' && next !== 'fc') this.h.forecast(0);
    this.openPanel = next;
    r.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== next));
    r.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.open === next)));
    this.polarOpen = next === 'polar';
    this.lastPolarKey = '';
  }

  private bind() {
    const r = this.root;
    // cadran du pilote : on attrape la couronne et on tourne, puis OK juste en dessous
    const dial = q(r, '[data-pdial]');
    let dialOn = false;
    const fromDial = (e: PointerEvent) => {
      // cadran nord en haut : l'angle du pointeur est directement le cap
      const a = dialAngle(dial, e.clientX, e.clientY);
      this.setPending(Math.round(a));
    };
    dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dial.setPointerCapture(e.pointerId);
      dialOn = true;
      dial.classList.add('drag');
      fromDial(e);
    });
    dial.addEventListener('pointermove', (e) => {
      if (dialOn) fromDial(e);
    });
    const dend = () => {
      dialOn = false;
      dial.classList.remove('drag');
    };
    dial.addEventListener('pointerup', dend);
    dial.addEventListener('pointercancel', dend);
    dial.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        this.nudge(k === 'ArrowLeft' ? -2 : 2);
      } else if (k === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.commitPending();
      }
    });
    r.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach((b) => b.addEventListener('click', () => this.nudge(Number(b.dataset.nudge))));
    q(r, '[data-pend-ok]').addEventListener('click', () => this.commitPending());
    r.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = b.dataset.mode as PilotMode;
        this.cancelPending();
        if (m === 'auto') {
          if (this.cpCount) this.h.setAuto(true);
          else this.h.setMode('route'); // pas encore de route : on va la tracer
        } else this.h.lock('hdg');
      }),
    );
    q(r, '[data-sleep]').addEventListener('click', () => this.h.sleep());
    q(r, '[data-pause]').addEventListener('click', () => this.h.pause());
    r.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => b.addEventListener('click', () => this.h.speed(b.dataset.speed!)));
    r.querySelectorAll<HTMLInputElement>('[data-dev]').forEach((inp) =>
      inp.addEventListener('input', () => {
        this.devSea[inp.dataset.dev as 'tws' | 'twa' | 'swell'] = Number(inp.value);
        this.h.devSea({ ...this.devSea });
        this.showDevSea();
      }),
    );
    r.querySelectorAll<HTMLButtonElement>('[data-dev-life]').forEach((b) =>
      b.addEventListener('click', () => this.h.devLife(b.dataset.devLife as 'dolphins' | 'whale')),
    );
    q(r, '[data-dev-reset]').addEventListener('click', () => {
      this.devSea = { tws: null, twa: null, swell: 1 };
      this.h.devSea({ ...this.devSea });
      this.showDevSea();
    });
    r.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => this.h.view(b.dataset.view as ViewMode)));
    q(r, '[data-map3d]').addEventListener('click', () => {
      const b = q(r, '[data-map3d]');
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      this.h.map3d(on);
    });
    q(r, '[data-menu]').addEventListener('click', () => this.h.menu());
    r.querySelectorAll<HTMLButtonElement>('[data-say]').forEach((b) => b.addEventListener('click', () => this.h.say(b.textContent ?? '')));
    r.querySelectorAll<HTMLButtonElement>('[data-sail]').forEach((b) => b.addEventListener('click', () => this.h.sail(b.dataset.sail as SailId)));
    r.querySelectorAll<HTMLButtonElement>('[data-autosail]').forEach((b) => b.addEventListener('click', () => this.h.autoSail(b.dataset.autosail === '1')));
    // annuler : on reclique sur l'ancienne voile ; reprendre : sur la nouvelle
    q(r, '[data-sx-cancel]').addEventListener('click', () => {
      const b = this.view.boat;
      if (b?.sailTo) this.h.sail(b.sailBack ? b.sailTo : b.sail);
    });
    r.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((b) =>
      b.addEventListener('click', () => {
        const u = b.dataset.unit as DistUnit;
        setDistUnit(u);
        r.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.unit === u)));
        this.h.units(u);
      }),
    );
    // barre d'outils et panneaux
    r.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => b.addEventListener('click', () => this.toggle(b.dataset.open!)));
    r.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => this.toggle(null)));
    q(r, '[data-rank]').addEventListener('click', () => this.toggle('board'));
    // radio VHF
    const vpan = q(r, '[data-vhf-panel]');
    const vbtn = q(r, '[data-vhf-btn]');
    vbtn.addEventListener('click', () => {
      const open = !!vpan.hidden;
      vpan.hidden = !open;
      vbtn.setAttribute('aria-expanded', String(open));
      if (open) this.setUnread(0);
    });
    q(r, '[data-vhf-close]').addEventListener('click', () => {
      vpan.hidden = true;
      vbtn.setAttribute('aria-expanded', 'false');
    });
    r.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((b) =>
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        this.h.layer(b.dataset.layer as LayerId, on);
      }),
    );
    // prévisions
    const range = q<HTMLInputElement>(r, '[data-fc-range]');
    range.addEventListener('input', () => this.h.forecast(Number(range.value)));
    q(r, '[data-fc-play]').addEventListener('click', () => this.h.forecastPlay());
    q(r, '[data-fc-now]').addEventListener('click', () => this.h.forecast(0));

    // mode Barre / Route
    r.querySelectorAll<HTMLButtonElement>('[data-msw]').forEach((b) => b.addEventListener('click', () => this.h.setMode(b.dataset.msw as 'barre' | 'route')));
    q(r, '[data-rb-go]').addEventListener('click', () => (this.cpFollowing ? this.h.lock('hdg') : this.h.setAuto(true)));
    q(r, '[data-rb-clear]').addEventListener('click', () => this.h.cpClear());
    q(r, '[data-cb-del]').addEventListener('click', () => this.h.cpDelete(this.bubN));
    q(r, '[data-cb-ins]').addEventListener('click', () => this.h.cpInsertAfter(this.bubN));
    // frise du temps
    const ts = q<HTMLInputElement>(r, '[data-ts-range]');
    ts.addEventListener('input', () => this.h.scrub(Number(ts.value)));
    q(r, '[data-ts-play]').addEventListener('click', () => this.h.forecastPlay());
    // fenêtre 3D
    q(r, '[data-pip-min]').addEventListener('click', () => this.h.pip(false));
    q(r, '[data-pip-open]').addEventListener('click', () => this.h.pip(true));
    q(r, '[data-pip-frame]').addEventListener('click', () => this.h.pipFull());

    q(r, '[data-alert-btn]').addEventListener('click', () => {
      const a = this.alertAction;
      if (a === 'sleep') this.h.sleep();
      else if (a === 'repair') this.h.repair();
      else if (a === 'bear') this.h.bearAway();
      else if (a === 'sail') this.h.autoSail(true);
    });
  }

  /** Avant le départ : compte à rebours ; null = course lancée. */
  setPrestart(ms: number | null) {
    const el = q(this.root, '[data-prestart]');
    el.hidden = ms === null;
    if (ms === null) return;
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    q(el, '[data-pre-count]').textContent = `${d ? `${d} j ` : ''}${String(h).padStart(2, '0')} h ${String(m).padStart(2, '0')} min ${String(s % 60).padStart(2, '0')} s`;
  }

  /** Mode test : accélération du temps visible (?dev dans l'adresse). */
  setDev(on: boolean) {
    this.dev = on;
    q(this.root, '[data-devspeed]').hidden = !on;
  }

  private dev = false;
  /** vent et houle imposés à la vue immersive (mode test), null = ceux de la course */
  private devSea: { tws: number | null; twa: number | null; swell: number } = { tws: null, twa: null, swell: 1 };

  /** Réglages de test : valeurs affichées, curseurs calés sur la course tant qu'on n'y a pas touché. */
  private showDevSea(p = this.view.boat) {
    const s = this.devSea;
    const tws = s.tws ?? Math.round(p?.tws ?? 0);
    const twa = s.twa ?? Math.round(p?.twa ?? 0);
    const set = (k: string, v: number, text: string) => {
      const inp = q<HTMLInputElement>(this.root, `[data-dev="${k}"]`);
      if (document.activeElement !== inp) inp.value = String(v);
      q(this.root, `[data-dev-v="${k}"]`).textContent = text;
    };
    set('tws', tws, `${tws} nds${s.tws === null ? ' · course' : ''}`);
    set('twa', twa, `${twa}°${s.twa === null ? ' · course' : ''}`);
    set('swell', s.swell, `×${s.swell.toFixed(1).replace('.', ',')}`);
  }

  /** dernier état du bateau affiché (pour les réglages à la souris) */
  private view = { hdg: 0, twd: 0, twa: 0, tws: 0, wp: null as number | null, auto: true, lock: 'hdg' as 'hdg' | 'twa', boat: null as Boat | null };
  /** consigne en cours de réglage (cap vrai), null = aucune */
  private pending: number | null = null;

  /** Règle la nouvelle consigne (cap vrai) et prévient le jeu pour l'aperçu sur la carte. */
  setPending(h: number | null) {
    this.pending = h === null ? null : ((Math.round(h) % 360) + 360) % 360;
    this.h.preview(this.pending);
    this.drawPilot();
  }

  /** Décale la consigne en cours (ou le cap actuel) de `d` degrés. */
  nudge(d: number) {
    this.setPending((this.pending ?? this.view.hdg) + d);
  }

  commitPending() {
    if (this.pending === null) return;
    const h = this.pending;
    this.pending = null;
    this.h.preview(null);
    this.h.commit(h);
    this.drawPilot();
  }

  cancelPending() {
    if (this.pending === null) return;
    this.pending = null;
    this.h.preview(null);
    this.drawPilot();
  }

  get hasPending() {
    return this.pending !== null;
  }

  /** Cadran, règle, consigne et aperçu de la nouvelle consigne. */
  private drawPilot() {
    const r = this.root;
    const v = this.view;
    const pend = this.pending;
    const b0 = v.boat;
    setPilotDial(r, {
      hdg: v.hdg,
      twd: v.twd,
      twa: pend === null ? v.twa : norm180(v.twd - pend),
      tws: v.tws,
      spd: pend !== null && b0 ? boatSpeed(norm180(v.twd - pend), v.tws, b0.perf, b0.autoSail ? bestSail(norm180(v.twd - pend), v.tws) : targetSail(b0)) : (b0?.spd ?? 0),
      sailColor: SAIL_COLOR[b0 ? workingSail(b0) : 'foc'],
      best: (a) => bestSail(a, v.tws),
      colors: SAIL_COLOR,
      cons: v.auto ? null : v.hdg,
      pending: pend,
      wp: v.wp,
    });
    const deg = (x: number) => `${String(Math.round(((x % 360) + 360) % 360)).padStart(3, '0')}°`;
    const side = (twa: number) => `${Math.round(Math.abs(twa))}° ${twa < 0 ? 'bâb' : 'tri'}`;
    r.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === (v.auto ? 'auto' : 'hdg'))));
    // aperçu de la nouvelle consigne, juste au-dessus du bouton OK
    const box = q(r, '[data-pend]');
    box.hidden = pend === null;
    const ok = q<HTMLButtonElement>(r, '[data-pend-ok]');
    ok.disabled = pend === null;
    ok.classList.toggle('on', pend !== null);
    if (pend === null) q(r, '[data-pend-v]').textContent = 'OK';
    if (pend === null || !v.boat) return;
    const b = v.boat;
    const ntwa = norm180(v.twd - pend);
    const dh = norm180(pend - v.hdg);
    q(r, '[data-pend-v]').textContent = `OK ${deg(pend)}`;
    const sail = b.autoSail ? bestSail(ntwa, v.tws) : targetSail(b);
    const bsp = boatSpeed(ntwa, v.tws, b.perf, sail);
    const tgt = v.wp;
    const vmg = tgt === null ? null : bsp * Math.cos((norm180(pend - tgt) * Math.PI) / 180);
    q(r, '[data-pend-info]').innerHTML = `${dh >= 0 ? '+' : '−'}${Math.abs(Math.round(dh))}° · TWA <b>${side(ntwa)}</b> · <b>${kn(bsp)}</b> nds${vmg !== null ? ` · VMG <b>${kn(vmg)}</b>` : ''}`;
    const warn: string[] = [];
    const a = Math.abs(ntwa);
    if (a < 38) warn.push('Face au vent : le bateau s’arrête.');
    else if (Math.sign(ntwa) !== Math.sign(v.twa) && Math.abs(v.twa) > 3) {
      const pen = b.energy < 25 ? 36 : 24;
      warn.push(`${a < 90 && Math.abs(v.twa) < 90 ? 'Virement de bord' : 'Empannage'} : ${pen} min à −40 %.`);
    }
    const best = bestSail(ntwa, v.tws);
    if (best !== targetSail(b)) {
      const nm = SAILS.find((x) => x.id === best)!.name;
      warn.push(b.autoSail ? `La voile auto enverra le ${nm} (15 min au ralenti).` : `Le ${nm} serait meilleur à cet angle (voile verrouillée).`);
    }
    const w = q(r, '[data-pend-warn]');
    w.hidden = !warn.length;
    w.textContent = warn.join(' ');
  }
  private unread = 0;
  private xkey = '';

  private setUnread(n: number) {
    this.unread = n;
    const b = q(this.root, '[data-vhf-badge]');
    b.hidden = n === 0;
    b.textContent = n > 9 ? '9+' : String(n);
    q(this.root, '[data-vhf-btn]').classList.toggle('ping', n > 0);
  }

  setControls(speedId: string, paused: boolean, _is2d: boolean, immersive = false) {
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(!paused && b.dataset.speed === speedId)));
    q(this.root, '[data-pause]').setAttribute('aria-pressed', String(paused));
    q(this.root, '[data-view="immersive"]').setAttribute('aria-pressed', String(immersive));
    // le vent et la houle de test ne touchent que la vue immersive
    q(this.root, '[data-devsea]').hidden = !(this.dev && immersive);
    // les prévisions concernent la carte : on les range en vue immersive
    if (immersive && this.openPanel === 'fc') this.toggle(null);
    q(this.root, '[data-open="fc"]').hidden = immersive;
  }

  /** Curseur des prévisions : décalage en heures, lecture en cours, texte. */
  setForecast(hours: number, playing: boolean, label: string, sub: string) {
    const r = this.root;
    const range = q<HTMLInputElement>(r, '[data-fc-range]');
    if (document.activeElement !== range || playing) range.value = String(Math.round(hours));
    range.style.setProperty('--p', `${(hours / FC_MAX) * 100}%`);
    q(r, '[data-fc-label]').textContent = label;
    q(r, '[data-fc-sub]').textContent = sub;
    q(r, '[data-fc-now]').hidden = hours < 0.5;
    const play = q(r, '[data-fc-play]');
    play.innerHTML = playing ? ICON.pause : ICON_PLAY;
    play.setAttribute('aria-pressed', String(playing));
    r.querySelector('.fc')!.classList.toggle('on', hours >= 0.5);
    const badge = q(r, '[data-fc-badge]');
    badge.hidden = hours < 0.5;
    badge.textContent = `+${Math.round(hours)} h`;
  }

  private cpFollowing = false;
  private cpCount = 0;
  private bubN = 0;

  /** Barre ou Route : le cockpit laisse la place à la barre de route et à la frise du temps. */
  setMode(m: 'barre' | 'route') {
    const r = this.root;
    r.querySelectorAll<HTMLButtonElement>('[data-msw]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.msw === m)));
    q(r, '[data-routebar]').hidden = m !== 'route';
    r.querySelector<HTMLElement>('.cockpit')!.hidden = m === 'route';
    r.classList.toggle('route-mode', m === 'route');
    if (m !== 'route') this.showBubble(null);
    if (m === 'route' && this.openPanel === 'fc') this.toggle(null);
  }

  /** Barre de route : résumé, frise, bouton Lancer. */
  setRouteBar(d: RouteBar) {
    const r = this.root;
    this.cpFollowing = d.following;
    this.cpCount = d.count;
    const n = q(r, '[data-msw-n]');
    n.hidden = !d.count;
    n.textContent = String(d.count);
    const sum = q(r, '[data-rb-sum]');
    const html = d.inserting !== null
      ? `<b>Touche la mer pour insérer un point après le ${d.inserting + 1}</b><small>Ou touche un point pour annuler.</small>`
      : d.count
        ? `<b>${d.count}/5 points · ${esc(d.total)}</b><small>${esc(d.arrival)}${d.following ? ' · le pilote suit ta route' : ''}</small>`
        : `<b>Touche la mer pour poser ton premier point</b><small>Le pilote filera droit d’un point à l’autre. Face au vent, il serre le vent au plus près : place tes points pour tirer tes bords.</small>`;
    if (sum.innerHTML !== html) sum.innerHTML = html;
    const go = q<HTMLButtonElement>(r, '[data-rb-go]');
    go.disabled = !d.count;
    go.textContent = d.following ? 'Route lancée · arrêter' : 'Lancer la route';
    go.classList.toggle('on', d.following);
    q(r, '[data-rb-clear]').hidden = !d.count;
    q<HTMLInputElement>(r, '[data-ts-range]').max = String(d.hours);
    q(r, '[data-ts-ticks]').innerHTML = d.ticks.map((t) => `<span class="${t.day ? 'd' : ''}" style="left: ${(t.at * 100).toFixed(2)}%">${esc(t.label)}</span>`).join('');
    q(r, '[data-ts-marks]').innerHTML = d.marks.map((m, i) => (m > 1 ? '' : `<b style="left: ${(m * 100).toFixed(2)}%">${i + 1}</b>`)).join('');
  }

  /** Bulle d'un point (null = fermée). */
  showBubble(d: CpBubble | null) {
    const el = q(this.root, '[data-cpbub]');
    if (!d) {
      el.hidden = true;
      return;
    }
    this.bubN = d.n;
    el.hidden = false;
    q(el, '[data-cb-n]').textContent = `Point ${d.n + 1}`;
    q(el, '[data-cb-eta]').textContent = d.eta;
    q(el, '[data-cb-r]').innerHTML = `<span><b>${esc(d.dist)}</b> · cap ${String(d.hdg).padStart(3, '0')}°</span><span class="${d.upwind ? 'up' : ''}">${d.upwind ? 'Face au vent : le pilote tirera des bords' : esc(d.pace)}</span>`;
    const w = el.offsetWidth || 220;
    const h = el.offsetHeight || 110;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, d.x - w / 2));
    const y = d.y - h - 26 < 8 ? d.y + 26 : d.y - h - 26;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** Frise : position du curseur et étiquette (heure, vent au point fantôme). */
  setStrip(hours: number, span: number, label: string, playing: boolean) {
    const r = this.root;
    const ts = q<HTMLInputElement>(r, '[data-ts-range]');
    if (document.activeElement !== ts || playing) ts.value = String(hours);
    ts.style.setProperty('--p', `${(hours / span) * 100}%`);
    const l = q(r, '[data-ts-label]');
    if (l.innerHTML !== label) l.innerHTML = label;
    const play = q(r, '[data-ts-play]');
    play.innerHTML = playing ? ICON.pause : ICON_PLAY;
  }

  /** Fenêtre 3D ouverte ou réduite ; rectangle à l'écran pour le rendu. */
  setPip(open: boolean) {
    q(this.root, '[data-pip]').classList.toggle('open', open);
  }
  pipRect(): DOMRect | null {
    const f = q(this.root, '[data-pip-frame]');
    const r = f.getBoundingClientRect();
    return r.width > 10 && f.offsetParent !== null ? r : null;
  }

  /** Ligne d'état du pilote Auto (ce qu'il suit, prochain ordre). */
  setAutoInfo(text: string) {
    const el = q(this.root, '[data-auto-info]');
    if (el.innerHTML !== text) el.innerHTML = text;
  }

  onProbeClose: (() => void) | null = null;

  /** Carte de la sonde posée sur la carte, à côté du repère (x, y écran). */
  showProbe(x: number, y: number, d: { pos: string; wind: string; cur: string; wave: string; from: string; twa: string; time: string } | null) {
    const el = q(this.root, '[data-probe]');
    if (!d) {
      el.hidden = true;
      return;
    }
    if (el.hidden) {
      el.hidden = false;
      q(el, '[data-pr-close]').onclick = () => this.onProbeClose?.();
    }
    const set = (k: string, v: string) => {
      const n = q(el, `[data-pr-${k}]`);
      if (n.textContent !== v) n.textContent = v;
    };
    set('pos', d.pos);
    set('wind', d.wind);
    set('cur', d.cur);
    set('wave', d.wave);
    set('from', d.from);
    set('twa', d.twa);
    set('time', d.time);
    const W = window.innerWidth;
    const w = el.offsetWidth || 230;
    const h = el.offsetHeight || 170;
    // à gauche du repère s'il est dans la moitié droite (la télémétrie y est)
    const left = x > W / 2 || x + 22 + w > W - 8 ? Math.max(8, x - 22 - w) : x + 22;
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, y - h / 2));
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Infobulle du vent sous le pointeur. */
  showPick(x: number, y: number, text: string | null) {
    const el = q(this.root, '[data-pick]');
    if (!text) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y - 34)}px)`;
  }

  toast(text: string) {
    const el = q(this.root, '[data-toast]');
    el.textContent = text;
    el.style.opacity = '1';
    this.toastT = 3.2;
  }

  tick(dt: number) {
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) q(this.root, '[data-toast]').style.opacity = '0';
    }
  }

  say(who: Boat | null, text: string, kind: '' | 'sys' | 'mine' = '') {
    const feed = q(this.root, '[data-feed]');
    const el = document.createElement('div');
    el.className = 'msg-b' + (kind ? ' ' + kind : '');
    if (who) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = who.color;
      const sp = document.createElement('span');
      const b = document.createElement('strong');
      b.textContent = who.isPlayer ? 'Toi' : who.name;
      sp.append(b, document.createTextNode(` : ${text}`));
      el.append(dot, sp);
    } else {
      el.textContent = text;
    }
    feed.appendChild(el);
    while (feed.children.length > 30) feed.removeChild(feed.firstChild!);
    feed.scrollTop = feed.scrollHeight;
    if (kind !== 'mine' && q(this.root, '[data-vhf-panel]').hidden) this.setUnread(this.unread + 1);
  }

  clearChat() {
    q(this.root, '[data-feed]').textContent = '';
    this.lastOrder = null;
  }

  update(race: Race, day: number) {
    const r = this.root;
    const p = race.player;
    if (this.dev) this.showDevSea(p);
    const order = race.standings();
    const me = order.indexOf(p);
    q(r, '[data-pos]').textContent = `P${me + 1}`;
    q(r, '[data-of]').textContent = `/${order.length}`;
    q(r, '[data-race]').textContent = `${race.def.name}${race.def.klass ? ` · ${race.def.klass}` : ''} · ${race.def.from} → ${race.def.to}`;
    q(r, '[data-remain]').innerHTML = p.finished !== null ? `Arrivé à ${esc(race.def.to)}` : `<b>${fmtInt(toUnit(race.remaining(p)))}</b> ${unitLabel(false)} restants`;
    const nm = race.nextMark(p);
    const mk = q(r, '[data-mark]');
    mk.hidden = !nm || p.finished !== null;
    if (nm) mk.innerHTML = `Marque ${p.mark + 1}/${race.def.marks!.length} · <b>${esc(nm.name)}</b> · ${fmtDist(dist(p.pos, nm.pos), true)}`;
    q(r, '[data-board-title]').textContent = `Classement${race.def.klass ? ` · ${race.def.klass}` : ''} · ${raceClock(race.originUTC, race.t)} UTC`;

    // classement
    const board = q(r, '[data-board]');
    board.textContent = '';
    const leadRem = race.remaining(order[0]);
    order.forEach((b, i) => {
      const li = document.createElement('li');
      if (b.isPlayer) li.className = 'me';
      const status = b.finished !== null ? 'arrivé' : b.repair > 0 ? 'répare' : b.avarie ? 'avarie' : b.sleep > 0 ? 'dort' : b.sailTo !== null ? 'change de voile' : b.penalty > 0 ? 'manœuvre' : b.spd < 4 ? 'à la peine' : '';
      const gap = i === 0 ? '—' : b.finished !== null ? fmtDuration(b.finished - (order[0].finished ?? 0)) : `+${fmtDist(race.remaining(b) - leadRem, true)}`;
      const fe = b.fleetId ? IMOCA_RHUM_2026.find((f) => f.id === b.fleetId) : undefined;
      const who = fe ? `<span class="n"><b><span class="fl" aria-hidden="true">${FLAG[fe.nat] ?? ''}</span>${esc(fe.skipper)}</b><small>${esc(fe.boat)}</small></span>` : `<span class="n"><b>${esc(b.isPlayer ? 'Toi' : b.name)}</b>${b.isPlayer ? '<small>Sail Run · FRA 1</small>' : ''}</span>`;
      li.innerHTML = `<span class="p num">${i + 1}</span><span class="bar-c" style="background: ${b.color}"></span>${who}<span class="s">${status}</span><span class="g">${gap}</span>`;
      board.appendChild(li);
    });

    // dépassements
    const ids = order.map((b) => b.id);
    if (this.lastOrder && p.finished === null) {
      const prev = this.lastOrder.indexOf(p.id);
      if (me < prev) this.onPassed?.(order[me + 1], true);
      else if (me > prev) this.onPassed?.(order[me - 1], false);
    }
    this.lastOrder = ids;

    // barre
    q(r, '[data-bsp]').textContent = kn(p.spd);
    q(r, '[data-tws]').textContent = String(Math.round(p.tws));
    const wp = p.route[p.wp];
    const wpb = wp && p.finished === null ? bearing(p.pos, wp) : null;
    this.view = { hdg: p.hdg, twd: p.twd, twa: p.twa, tws: p.tws, wp: wpb, auto: p.auto, lock: p.lock, boat: p };
    r.querySelector<HTMLButtonElement>('[data-mode="auto"]')!.disabled = p.avarie === 'pilote';
    this.drawPilot();

    // voiles
    const best = bestSail(p.twa, p.tws);
    const tgt = targetSail(p);
    const chg = p.sailTo;
    for (const s of SAILS) {
      const b = q<HTMLButtonElement>(r, `[data-sail="${s.id}"]`);
      b.setAttribute('aria-pressed', String(tgt === s.id));
      b.classList.toggle('best', s.id === best);
      b.classList.toggle('busy', chg !== null && tgt === s.id);
      // pendant un changement, seules les deux voiles en jeu répondent (annuler / reprendre)
      b.disabled = p.finished !== null || (chg !== null && s.id !== p.sail && s.id !== chg);
      // vitesse estimée avec cette voile (au cap en cours de réglage s'il y en a un), et si le changement paie
      const atwa = this.pending === null ? p.twa : norm180(p.twd - this.pending);
      const sw = sailSwitch(p, s.id, atwa, p.tws);
      let sv = '';
      let tone = '';
      if (chg === null) {
        if (s.id === p.sail) {
          sv = 'à poste';
        } else if (sw.breakEven === null) {
          sv = `${sw.vTo < sw.vNow - 0.05 ? '−' : '±'}${kn(Math.abs(sw.vTo - sw.vNow))} · plus lent`;
          tone = 'bad';
        } else {
          const be = Math.round(sw.breakEven * 60);
          sv = `+${kn(sw.vTo - sw.vNow)} · rentable en ${be >= 60 ? fmtDuration(be / 60) : `${Math.max(1, be)} min`}`;
          tone = be <= 30 ? 'good' : be <= 120 ? 'mid' : 'bad';
        }
      }
      const sp = chg === null ? `${kn(sw.vTo)} nds` : s.id === tgt ? (p.sailBack ? 'retour…' : 'envoi…') : s.id === p.sail || s.id === chg ? (p.sailBack ? 'reprendre' : 'annuler') : '—';
      q(r, `[data-sp="${s.id}"]`).textContent = sp;
      const svEl = q(r, `[data-sv="${s.id}"]`);
      svEl.textContent = sv;
      svEl.className = `sv ${tone}`;
      b.title = chg === null && s.id !== p.sail ? `${s.name} : ${kn(sw.vTo)} nds contre ${kn(sw.vNow)} avec le ${SAILS.find((x) => x.id === p.sail)!.name}. Le changement coûte environ ${(sw.lossNm * 1.852).toFixed(1).replace('.', ',')} km.` : `${s.name} : ${s.hint}`;
    }
    r.querySelectorAll<HTMLButtonElement>('[data-autosail]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.autosail === '1') === p.autoSail)));
    const nowEl = q(r, '[data-sx-now]');
    nowEl.hidden = chg !== null;
    if (chg === null) {
      const cur = SAILS.find((x) => x.id === p.sail)!;
      const nowHtml = `<span class="sx-ic" style="--sc: ${SAIL_COLOR[p.sail]}"><svg viewBox="0 0 56 60" aria-hidden="true">${SAIL_ART[p.sail]}</svg></span><span class="sx-t"><small>À poste</small><b>${esc(cur.name)}</b><em>${pct(sailFactor(p.sail, p.twa, p.tws))} de la polaire${best !== p.sail ? ` · mieux : ${esc(SAILS.find((x) => x.id === best)!.name)}` : ''}</em></span><span class="sx-mode">${p.autoSail ? 'Voile auto' : 'Voile verrouillée'}</span>`;
      if (nowEl.innerHTML !== nowHtml) nowEl.innerHTML = nowHtml;
      nowEl.classList.toggle('warn', best !== p.sail);
    }
    this.drawSailChange(p);
    const xkey = `${Math.round(p.tws)}.${Math.round(p.twa)}.${this.pending === null ? '' : Math.round(norm180(p.twd - this.pending))}`;
    if (xkey !== this.xkey && this.polarOpen) {
      this.xkey = xkey;
      q(r, '[data-xover]').innerHTML = crossoverSvg((a) => bestSail(a, p.tws), SAIL_COLOR, p.twa, this.pending === null ? null : norm180(p.twd - this.pending));
    }

    // énergie : jauge circulaire autour d'une petite tête de skipper
    const e = Math.round(p.energy);
    const arc = q(r, '[data-en-arc]');
    arc.setAttribute('stroke-dasharray', `${e} 100`);
    const tone = p.sleep > 0 ? 'sleep' : e < 25 ? 'bad' : e < 45 ? 'mid' : 'ok';
    q(r, '[data-en-ring]').className = `skipper-g ${tone}`;
    q(r, '[data-sk-badge]').hidden = !(e < 35 && p.sleep <= 0 && p.finished === null);
    q(r, '[data-en-face]').innerHTML = FACE[tone];
    const st = q(r, '[data-en-state]');
    st.textContent = p.sleep > 0 ? `Dort · encore ${fmtDuration(p.sleep)} · ${e} %` : e < 25 ? `Épuisé · −12 % · ${e} %` : e < 45 ? `Fatigué · ${e} %` : `En forme · ${e} %`;
    st.className = `en-state ${tone}`;
    const sl = q<HTMLButtonElement>(r, '[data-sleep]');
    const slt = q(sl, 'span');
    if (p.sleep > 0) {
      sl.disabled = false;
      slt.textContent = 'Réveiller';
    } else if (p.repair > 0) {
      sl.disabled = true;
      slt.textContent = 'Répare…';
    } else {
      sl.disabled = p.finished !== null;
      slt.textContent = 'Sieste 2 h';
    }

    // horloge
    q(r, '[data-clock]').textContent = raceClock(race.originUTC, race.t);
    q(r, '[data-sky]').innerHTML = day >= 0.5 ? ICON.sun : ICON.moon;

    if (this.polarOpen) this.drawPolar(p);
    this.updateTele(race, order);
    this.updateAlert(race);
  }

  private etaH: number | null = null;
  /** Durée restante d'après le routage (h), null si la route n'atteint pas l'arrivée. */
  setEta(h: number | null) {
    this.etaH = h;
  }

  /** Télémétrie : les chiffres d'un vrai écran de navigation. */
  private updateTele(race: Race, order: Boat[]) {
    const r = this.root;
    const p = race.player;
    const set = (k: string, v: string) => {
      const el = r.querySelector(`[data-t="${k}"]`);
      if (el && el.textContent !== v) el.textContent = v;
    };
    const tgt = boatSpeed(p.twa, p.tws, p.perf, bestSail(p.twa, p.tws));
    const eff = tgt > 0.5 ? p.spd / tgt : 0;
    set('bsp', kn(p.spd));
    set('tgt', kn(tgt));
    set('eff', `${Math.round(eff * 100)} %`);
    const bar = r.querySelector<HTMLElement>('[data-t="effbar"]');
    if (bar) {
      bar.style.width = `${Math.min(100, eff * 100).toFixed(1)}%`;
      bar.className = eff >= 0.97 ? 'ok' : eff >= 0.85 ? 'mid' : 'bad';
    }
    set('tws', String(Math.round(p.tws)));
    set('twd', `${String(Math.round(p.twd) % 360).padStart(3, '0')}°`);
    set('twdc', cardinal(p.twd));
    set('twa', `${Math.round(Math.abs(p.twa))}°`);
    set('side', p.twa < 0 ? 'BÂB' : 'TRI');
    set('hdg', `${String(Math.round(p.hdg) % 360).padStart(3, '0')}°`);
    const target = race.nextMark(p)?.pos ?? (p.route[p.wp] && p.mark >= (race.def.marks?.length ?? 0) ? race.def.finish : race.def.finish);
    const brg = bearing(p.pos, target);
    const vmg = p.spd * Math.cos(((p.hdg - brg) * Math.PI) / 180);
    set('vmg', kn(vmg));
    const leader = order[0];
    if (leader === p) {
      set('gap', 'Leader');
      set('gapu', '');
    } else {
      set('gap', `+${fmtInt(toUnit(race.remaining(p) - race.remaining(leader)))}`);
      set('gapu', unitLabel(true));
    }
    // foils : en vol au reaching rapide, décollage autour de 12-16 nds
    const a = Math.abs(p.twa);
    const load = p.perf.imoca && a > 55 && a < 165 ? Math.max(0, Math.min(1, (p.spd - 11) / 9)) : 0;
    set('fstate', load >= 0.55 ? 'En vol' : load > 0.05 ? 'Décollage' : 'Archimédien');
    const fl = r.querySelector<HTMLElement>('[data-t="fload"]');
    if (fl) fl.style.width = `${Math.round(load * 100)}%`;
    q(r, '[data-t="foil"]').hidden = !p.perf.imoca;
    const nm = race.nextMark(p);
    set('mark', p.finished !== null ? 'Course terminée' : nm ? `${nm.short} · ${fmtDist(dist(p.pos, nm.pos), true)} · ${String(Math.round(brg)).padStart(3, '0')}°` : `Arrivée · ${fmtDist(dist(p.pos, race.def.finish), true)} · ${String(Math.round(brg)).padStart(3, '0')}°`);
    set('eta', p.finished !== null ? fmtDuration(p.finished) : this.etaH !== null ? `${raceClock(race.originUTC, race.t + this.etaH)} · dans ${fmtDuration(this.etaH)}` : 'aucun checkpoint');
    const w = race.wind;
    if (w instanceof GridWind) {
      const d = new Date(w.meta.t0);
      set('tele-src', '');
      q(r, '[data-tele-src]').textContent = `GFS ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}Z`;
    } else {
      q(r, '[data-tele-src]').textContent = 'Vent simulé';
    }
  }

  /**
   * Module de changement de voile : les 4 étapes, leur malus et la voile qui tire à chacune,
   * l'avancement, le temps restant, et Annuler / Reprendre. Mis à jour sans reconstruire le DOM.
   */
  private sailChgKey = '';
  private drawSailChange(p: Boat) {
    const r = this.root;
    const box = q(r, '[data-sx-chg]');
    const to = p.sailTo;
    box.hidden = to === null;
    box.closest('.sailc')?.classList.toggle('chg', to !== null);
    if (to === null) {
      this.sailChgKey = '';
      return;
    }
    const from = p.sail;
    const name = (id: SailId) => SAILS.find((x) => x.id === id)!.name;
    const key = `${from}.${to}.${p.sailBack}`;
    if (key !== this.sailChgKey) {
      this.sailChgKey = key;
      const art = (id: SailId) => `<svg viewBox="0 0 56 60" style="--sc: ${SAIL_COLOR[id]}">${SAIL_ART[id]}</svg>`;
      q(r, '[data-sx-from]').innerHTML = art(p.sailBack ? to : from);
      q(r, '[data-sx-to]').innerHTML = art(p.sailBack ? from : to);
      q(r, '[data-sx-kind]').textContent = p.sailBack ? 'Annulation · à l’envers' : 'Changement de voile';
      q(r, '[data-sx-title]').textContent = p.sailBack ? `Retour au ${name(from)}` : `${name(from)} → ${name(to)}`;
      q(r, '[data-sx-cancel]').textContent = p.sailBack ? 'Reprendre' : 'Annuler';
      box.classList.toggle('back', p.sailBack);
      r.querySelectorAll<HTMLElement>('[data-sx-step]').forEach((li) => {
        const st = SAIL_STEPS[Number(li.dataset.sxStep)];
        const w = st.works === 'to' ? to : from;
        li.style.setProperty('--sc', SAIL_COLOR[w]);
        q(li, '[data-sx-w]').textContent = name(w);
      });
    }
    const cur = sailStep(p);
    const prog = p.sailT / p.sailDur;
    r.querySelectorAll<HTMLElement>('[data-sx-step]').forEach((li) => {
      const i = Number(li.dataset.sxStep);
      const st = SAIL_STEPS[i];
      const start = i === 0 ? 0 : SAIL_STEPS[i - 1].end;
      const k = Math.min(1, Math.max(0, (prog - start) / (st.end - start)));
      li.className = i < cur ? 'done' : i === cur ? 'cur' : 'todo';
      q(li, '[data-sx-fill]').style.width = `${(k * 100).toFixed(1)}%`;
    });
    const st = SAIL_STEPS[cur];
    const stepEnd = (p.sailBack ? (cur === 0 ? 0 : SAIL_STEPS[cur - 1].end) : st.end) * p.sailDur;
    const stepLeft = Math.max(1, Math.round(Math.abs(stepEnd - p.sailT) * 60));
    const txt = p.sailBack ? st.undo : st.what;
    const what = `${txt[0].toUpperCase()}${txt.slice(1)}. Le ${name(st.works === 'to' ? to : from)} tire, vitesse ${pct(st.f)} · ${stepLeft} min.`;
    const whatEl = q(r, '[data-sx-what]');
    if (whatEl.textContent !== what) whatEl.textContent = what;
    q(r, '[data-sx-left]').textContent = `encore ${Math.max(1, Math.round(sailRemaining(p) * 60))} min`;
  }

  /** Polaire : vitesse selon l'angle au vent pour chaque voile, à la force de vent actuelle. */
  private drawPolar(p: Boat) {
    const tws = p.tws;
    const ws = workingSail(p);
    const a = Math.abs(p.twa);
    const key = `${Math.round(tws * 2)}.${Math.round(a)}.${ws}.${p.spd.toFixed(1)}.${sailStep(p)}.${p.penalty > 0}.${p.sleep > 0}.${p.energy < 25}.${p.avarie}.${p.repair > 0}`;
    if (key === this.lastPolarKey) return;
    this.lastPolarKey = key;
    const r = this.root;
    q(r, '[data-pol-title]').textContent = `Polaire · vent de ${Math.round(tws)} nds`;

    // échelle : arrondie aux 5 nœuds au-dessus de la meilleure vitesse
    const curves = SAILS.map((s) => {
      const pts: [number, number][] = [];
      for (let ang = 30; ang <= 180; ang += 4) pts.push([ang, boatSpeed(ang, tws, p.perf, s.id)]);
      return { s, pts };
    });
    const vmax = Math.max(5, ...curves.flatMap((c) => c.pts.map((x) => x[1])));
    const scale = Math.ceil(vmax / 5) * 5;
    const R = 140;
    const xy = (ang: number, v: number) => {
      const t = (ang * Math.PI) / 180;
      const rr = (v / scale) * R;
      return [rr * Math.sin(t), -rr * Math.cos(t)];
    };
    let svg = '';
    for (let v = 5; v <= scale; v += 5) {
      const rr = (v / scale) * R;
      svg += `<path d="M0,${-rr} A${rr},${rr} 0 0,1 0,${rr}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
      svg += `<text x="-4" y="${(-rr + 4).toFixed(1)}" text-anchor="end" class="pt">${v}</text>`;
    }
    for (const ang of [30, 60, 90, 120, 150]) {
      const [x, y] = xy(ang, scale);
      const [lx, ly] = xy(ang, scale * 1.07);
      svg += `<line x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.08)"/>`;
      svg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" class="pt">${ang}°</text>`;
    }
    svg += `<line x1="0" y1="${-R}" x2="0" y2="${R}" stroke="rgba(255,255,255,0.2)"/>`;
    svg += `<text x="4" y="-140" class="pt w">vent ↓</text>`;
    const best = bestSail(p.twa, tws);
    for (const c of curves) {
      const d = c.pts.map(([ang, v], i) => `${i ? 'L' : 'M'}${xy(ang, v)[0].toFixed(1)},${xy(ang, v)[1].toFixed(1)}`).join(' ');
      const isBest = c.s.id === best;
      svg += `<path d="${d}" fill="none" stroke="${SAIL_COLOR[c.s.id]}" stroke-width="${isBest ? 3.4 : 2}" stroke-linejoin="round" opacity="${isBest ? 1 : 0.7}"/>`;
    }
    // angle actuel, vitesse avec la meilleure voile et vitesse réelle
    const [rx, ry] = xy(a, scale);
    svg += `<line x1="0" y1="0" x2="${rx.toFixed(1)}" y2="${ry.toFixed(1)}" stroke="#fff" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    const vb = boatSpeed(a, tws, p.perf, best);
    const [bx, by] = xy(a, vb);
    svg += `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="5" fill="none" stroke="${SAIL_COLOR[best]}" stroke-width="2.5"/>`;
    const [px, py] = xy(a, p.spd);
    svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5" fill="#fff" stroke="#0b1e33" stroke-width="2"/>`;
    q(r, '[data-pol-svg]').innerHTML = svg;

    // pourquoi
    const fb = sailFactor(best, a, tws);
    const fc = sailFactor(ws, a, tws);
    const bestName = SAILS.find((s) => s.id === best)!.name;
    const curName = SAILS.find((s) => s.id === ws)!.name;
    const gain = Math.round((fb / fc - 1) * 100);
    q(r, '[data-pol-why]').innerHTML =
      `À <b>${Math.round(a)}°</b> du vent, la meilleure voile est le <b style="color: ${SAIL_COLOR[best]}">${esc(bestName)}</b> : ${esc(SAIL_WHY[best])}` +
      (best === ws ? ' <span class="ok">C’est celle que tu as.</span>' : gain >= 1 ? ` <span class="warn">Avec ton ${esc(curName)}, tu perds ${gain} %.</span>` : ` <span class="muted">Ton ${esc(curName)} fait presque aussi bien.</span>`);

    // décomposition de la vitesse
    const base = boatSpeed(a, tws, p.perf, ws) / Math.max(0.01, fc);
    const rows: string[] = [`<li><span>Ton bateau à ${Math.round(a)}° dans ${Math.round(tws)} nds</span><b>${kn(base)} nds</b></li>`, `<li><span><i style="background: ${SAIL_COLOR[ws]}"></i>Voile : ${esc(curName)}</span><b>${pct(fc)}</b></li>`];
    for (const f of speedFactors(p)) rows.push(`<li class="loss"><span>${esc(f.label)}</span><b>−${Math.round((1 - f.f) * 100)} %</b></li>`);
    rows.push(`<li class="tot"><span>Vitesse actuelle</span><b>${kn(p.spd)} nds</b></li>`);
    q(r, '[data-pol-break]').innerHTML = rows.join('');
  }

  private updateAlert(race: Race) {
    const p = race.player;
    const el = q(this.root, '[data-alert]');
    let msg: string | null = null;
    let danger = false;
    let action: AlertAction | null = null;
    let btn = '';
    const a = Math.abs(p.twa);
    const best = bestSail(p.twa, p.tws);
    const loss = 1 - sailFactor(p.sail, p.twa, p.tws) / sailFactor(best, p.twa, p.tws);
    if (p.finished !== null) {
      msg = null;
    } else if (p.avarie && p.repair <= 0) {
      msg = `Avarie : ${AVARIES[p.avarie].label.toLowerCase()}. Le bateau ralentit.`;
      danger = true;
      action = 'repair';
      btn = `Réparer · ${fmtDuration(REPAIR_HOURS / p.perf.repair)}`;
    } else if (p.repair > 0) {
      msg = `Réparation en cours · encore ${fmtDuration(p.repair)}`;
    } else if (a < 34 && !p.auto) {
      msg = 'Face au vent, le bateau n’avance plus.';
      danger = true;
      action = 'bear';
      btn = 'Abattre';
    } else if (!p.auto && !clearAhead(p.pos[0], p.pos[1], p.hdg, Math.max(p.spd, 8))) {
      msg = 'La côte est droit devant : change de cap !';
      danger = true;
    } else if (p.energy < 25 && p.sleep <= 0) {
      msg = 'Ton skipper est épuisé : −12 % de vitesse.';
      action = 'sleep';
      btn = 'Sieste 2 h';
    } else if (!p.autoSail && p.sailTo === null && loss > 0.04) {
      msg = `Mauvaise voile : le ${SAILS.find((s) => s.id === best)!.name} irait ${Math.round(loss * 100)} % plus vite.`;
      action = 'sail';
      btn = 'Voile auto';
    } else if (!p.auto && p.lock === 'hdg') {
      const fp = move(p.pos[0], p.pos[1], p.hdg, p.spd, 2);
      const w = race.wind.at(fp[0], fp[1], race.t + 2);
      const ftwa = Math.abs(norm180(windFrom(w[0], w[1]) - p.hdg));
      if (ftwa < 38 && a > 45) {
        msg = 'Le vent tourne dans 2 h : il faudra virer.';
      }
    }
    this.alertAction = action;
    if (!msg) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.classList.toggle('danger', danger);
    q(this.root, '[data-alert-msg]').textContent = msg;
    const b = q<HTMLButtonElement>(this.root, '[data-alert-btn]');
    b.hidden = !action;
    b.textContent = btn;
  }
}
