import { ACCENT_COLORS, CLOTHS, DEFAULT_SETUP, HULL_COLORS, NEUTRAL_TUNE, PATTERNS, styleOf, SKIPPERS, SLOTS, Setup, SlotId, TUNES, Tune, TuneId, estimatedHours, idealTune, likesOf, lookOf, partOf, perfDeltas, skipperOf } from '../data/garage';
import { GEN_LABEL } from '../data/fleet';
import { raceMix, raceWind, realEta } from '../sim/eta';
import { RaceDef, raceDistance } from '../data/races';
import { GarageView } from '../render/garageView';
import { ICON, esc, fmtDuration, q } from './dom';
import { fmtDist } from './units';

type Tab = SlotId | 'livree' | 'reglages';
type Step = 'bateau' | 'skipper';

const SETUP_KEY = 'sailgame.setup.v3';
export function loadSetup(fallback: Setup): Setup {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Setup;
      if (s.parts && s.skipper && s.livery && SLOTS.every((sl) => sl.parts.some((p) => p.id === s.parts[sl.id]))) return s;
    }
  } catch {
    /* rien */
  }
  return structuredClone(fallback);
}
function storeSetup(s: Setup) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
  } catch {
    /* rien */
  }
}

const clone = (s: Setup): Setup => ({ ...s, parts: { ...s.parts }, tune: { ...NEUTRAL_TUNE, ...(s.tune ?? {}) } });

/* ---------- illustrations des pièces (traits simples, couleur du texte) ---------- */
const ART: Record<string, string> = {
  // jeux de voiles : génois et grand-voile, plus ou moins creux
  'coque.polyvalent': '<path d="M34 42 L 34 6"/><path d="M34 8 C 44 18, 48 30, 50 40 L 34 40"/><path d="M30 10 C 22 20, 18 30, 16 40 L 30 40 Z"/><path d="M10 42 L 66 42"/>',
  'coque.brise': '<path d="M34 42 L 34 6"/><path d="M34 8 L 46 40 L 34 40"/><path d="M30 14 L 20 40 L 30 40 Z"/><path d="M10 42 L 66 42"/><path d="M58 12 L 70 12 M60 18 L 72 18 M56 24 L 68 24"/>',
  'coque.petittemps': '<path d="M34 42 L 34 6"/><path d="M34 8 C 50 16, 56 30, 54 40 L 34 40"/><path d="M30 8 C 14 18, 8 30, 10 40 L 30 40 Z"/><path d="M10 42 L 66 42"/>',
  // foils vus de face
  'foils.c': '<path d="M26 14 L 54 14 L 50 24 L 30 24 Z"/><path d="M40 24 L 40 44"/><path d="M28 18 C 14 18, 12 34, 22 40 M52 18 C 66 18, 68 34, 58 40"/>',
  'foils.grands': '<path d="M30 14 L 50 14 L 47 24 L 33 24 Z"/><path d="M40 24 L 40 44"/><path d="M32 18 L 8 18 L 6 40 L 18 42 M48 18 L 72 18 L 74 40 L 62 42"/>',
  'foils.compacts': '<path d="M26 14 L 54 14 L 50 24 L 30 24 Z"/><path d="M40 24 L 40 44"/><path d="M29 19 C 22 20, 20 28, 24 33 M51 19 C 58 20, 60 28, 56 33"/>',
  // centrage : coque de profil et masse
  'mat.neutre': '<path d="M6 30 C 20 36, 60 36, 74 26 L 74 22 L 6 22 Z"/><circle cx="40" cy="15" r="5"/><path d="M40 20 L 40 22"/>',
  'mat.avant': '<path d="M6 28 C 20 36, 60 38, 74 30 L 74 24 L 6 20 Z"/><circle cx="58" cy="13" r="5"/><path d="M58 18 L 58 22"/>',
  'mat.arriere': '<path d="M6 32 C 20 38, 60 36, 74 24 L 74 20 L 6 24 Z"/><circle cx="20" cy="15" r="5"/><path d="M20 20 L 20 23"/>',
};
const art = (key: string) => `<svg class="ill" viewBox="0 0 80 48" aria-hidden="true">${ART[key] ?? ''}</svg>`;

const SKIPPER_ICON: Record<string, string> = {
  regleur: '<path d="M10 30 A 14 14 0 0 1 38 30"/><path d="M24 30 L 32 19"/><circle cx="24" cy="30" r="2.5"/>',
  endurant: '<path d="M30 12 A 12 12 0 1 0 36 32 A 10 10 0 0 1 30 12 Z"/>',
  bricoleur: '<path d="M14 34 L 28 20"/><path d="M26 14 A 7 7 0 0 0 34 24 L 30 20 Z"/><circle cx="13" cy="35" r="3"/>',
};

/** Petites icônes du menu de gauche. */
const SLOT_ICON: Record<Tab, string> = {
  reglages: '<path d="M4 6 H28 M4 12 H28 M4 18 H28"/><circle cx="11" cy="6" r="2.6" class="f"/><circle cx="21" cy="12" r="2.6" class="f"/><circle cx="14" cy="18" r="2.6" class="f"/>',
  coque: '<path d="M14 22 L 14 2"/><path d="M14 4 C 20 10, 22 16, 23 20 L 14 20"/><path d="M11 6 C 7 12, 5 16, 4 20 L 11 20 Z"/>',
  foils: '<path d="M10 6 L 22 6"/><path d="M16 6 L 16 20"/><path d="M11 7 C 4 8, 4 16, 8 19 M21 7 C 28 8, 28 16, 24 19"/>',
  mat: '<path d="M3 15 C 9 19, 23 19, 29 13 L 29 11 L 3 11 Z"/><circle cx="16" cy="6" r="3"/>',
  livree: '<circle cx="16" cy="12" r="8"/><path d="M16 4 A 8 8 0 0 1 16 20 Z" class="f"/>',
};

/** Garage en deux étapes : le bateau, puis le skipper. Écran façon menu de jeu, habillage sport voile. */
export class GarageUI {
  private step: Step = 'bateau';
  private tab: Tab = 'reglages';
  /** zone idéale des réglages, calculée sur les prévisions (null tant qu'elles ne sont pas chargées) */
  private ideal: Tune | null = null;
  private setup: Setup;

  constructor(
    private root: HTMLElement,
    private def: RaceDef,
    initial: Setup,
    private view: GarageView,
    private onBack: () => void,
    private onStart: (s: Setup) => void,
  ) {
    this.setup = clone(initial);
    this.render();
  }

  private tabLabel(t: Tab): string {
    if (t === 'livree') return styleOf(this.setup).name;
    if (t === 'reglages') return this.fitLabel();
    return partOf(t, this.setup.parts[t]).name;
  }

  render() {
    const d = this.def;
    const isBoat = this.step === 'bateau';
    const st = styleOf(this.setup);
    const sk = skipperOf(this.setup.skipper);
    const tabs: Tab[] = ['reglages', 'coque', 'livree'];
    const label: Record<Tab, string> = { reglages: 'Réglages', coque: 'Voiles', foils: 'Foils', mat: 'Centrage', livree: 'Livrée' };
    this.root.innerHTML = `
      <div class="gx">
        <header class="gx-head">
          <button type="button" class="gx-back" data-back aria-label="${isBoat ? 'Retour aux courses' : 'Retour au bateau'}">${ICON.back}</button>
          <div class="gx-title">
            <span class="gx-eyebrow">Village départ · ${esc(d.from)}</span>
            <h2>${esc(d.name)}</h2>
            <div class="gx-chips">
              <span>${esc(d.from)} → ${esc(d.to)}</span>
              <span>${fmtDist(raceDistance(d))}</span>
              ${d.klass ? `<span class="hl">Classe ${esc(d.klass)}</span>` : `<span class="hl">${esc(d.profileLabel)}</span>`}
            </div>
          </div>
        </header>

        <ol class="gx-steps" aria-label="Étapes">
          <li class="${isBoat ? 'on' : 'done'}"><b>1</b>Bateau</li>
          <li class="${isBoat ? '' : 'on'}"><b>2</b>Préparation</li>
          <li><b>3</b>Départ</li>
        </ol>

        <nav class="gx-left" aria-label="${isBoat ? 'Équipements' : 'Skippers'}">
          ${
            isBoat
              ? `<div class="gx-slots" role="tablist">
              ${tabs
                .map(
                  (t) => `<button type="button" class="gx-slot" data-tab="${t}" aria-pressed="${t === this.tab}">
                <svg viewBox="0 0 32 24" aria-hidden="true">${SLOT_ICON[t]}</svg>
                <span><b>${label[t]}</b><small>${esc(this.tabLabel(t))}</small></span>
              </button>`,
                )
                .join('')}
            </div>
            <div class="gx-opts" data-opts></div>`
              : this.skipperHtml()
          }
        </nav>

        <aside class="gx-sheet" data-summary aria-label="Fiche technique"></aside>

        <div class="gx-plate" aria-hidden="true">
          <i style="background: ${st.color}"></i>
          <span class="n">${esc(st.name)}</span>
          <span class="num">${esc(st.number)}</span>
          <span class="sk">${isBoat ? `IMOCA 60 · ${GEN_LABEL.new}` : `Préparation · ${esc(sk.name)}`}</span>
        </div>

        <button type="button" class="gx-cta" data-next><span>${isBoat ? 'Préparation du skipper' : 'Prendre le départ'}</span></button>
        <span class="gx-hint">Glisse pour tourner autour du bateau</span>
      </div>`;
    q(this.root, '[data-back]').addEventListener('click', () => {
      if (isBoat) this.onBack();
      else this.go('bateau');
    });
    q(this.root, '[data-next]').addEventListener('click', () => {
      storeSetup(this.setup);
      if (isBoat) this.go('skipper');
      else this.onStart(clone(this.setup));
    });
    if (isBoat) this.bindBoat();
    else this.bindSkipper();
    this.renderSummary(null);
    this.applyLook();
    this.view.setFocus(isBoat ? (this.tab === 'coque' ? 'mat' : 'all') : 'skipper');
    this.layout();
  }

  /** Le bateau 3D suit la livrée et les réglages. */
  private applyLook() {
    const st = styleOf(this.setup);
    this.view.setLook({ ...lookOf(this.setup), color: st.color, accent: st.accent, pattern: st.pattern, sail: st.sail, name: st.name, number: st.number });
    this.view.applyTune({ ...NEUTRAL_TUNE, ...(this.setup.tune ?? {}) }, this.setup.parts.coque);
  }

  private go(step: Step) {
    this.step = step;
    this.render();
  }

  /** Indique à la vue 3D la zone libre où centrer le bateau. */
  layout() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const left = this.root.querySelector('.gx-left');
    const sheet = this.root.querySelector('.gx-sheet');
    if (!left || !sheet) return;
    const l = left.getBoundingClientRect();
    const r = sheet.getBoundingClientRect();
    if (W <= 760) {
      // téléphone : le bateau dans la moitié haute, au-dessus des panneaux
      this.view.setFrame(0, 60, W, Math.max(160, l.top - 60));
    } else {
      // le bateau entre le menu de gauche et la fiche technique
      const x0 = l.right;
      const x1 = r.left;
      this.view.setFrame(x0, 0, Math.max(200, x1 - x0), H);
    }
  }

  private choose(next: Setup, pulse = true) {
    this.setup = next;
    storeSetup(next);
    this.render();
    if (pulse) this.view.pulse();
  }

  /* ---------- étape 1 : le bateau ---------- */
  private bindBoat() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as Tab;
        this.render();
      }),
    );
    const box = q(this.root, '[data-opts]');
    const s = this.setup;
    if (this.tab === 'reglages') {
      this.renderTunes(box);
      return;
    }
    if (this.tab === 'livree') {
      const st = styleOf(s);
      const sw = (attr: string, list: string[], cur: string) =>
        `<div class="lv-sw">${list.map((c) => `<button type="button" class="lv-c" ${attr}="${c}" aria-pressed="${c.toLowerCase() === cur.toLowerCase()}" style="--c: ${c}" aria-label="${c}"></button>`).join('')}</div>`;
      const chips = (attr: string, list: { id: string; name: string }[], cur: string) =>
        `<div class="lv-chips">${list.map((x) => `<button type="button" ${attr}="${x.id}" aria-pressed="${x.id === cur}">${esc(x.name)}</button>`).join('')}</div>`;
      box.innerHTML = `
        <div class="lv">
          <div class="lv-row"><span class="lv-l">Coque</span>${sw('data-hc', HULL_COLORS, st.color)}</div>
          <div class="lv-row"><span class="lv-l">Motif</span>${chips('data-pat', PATTERNS, st.pattern)}</div>
          <div class="lv-row"><span class="lv-l">Filet et têtière</span>${sw('data-ac', ACCENT_COLORS, st.accent)}</div>
          <div class="lv-row"><span class="lv-l">Voiles</span>${chips('data-cl', CLOTHS, st.sail)}</div>
          <div class="lv-row two">
            <label><span class="lv-l">Nom du bateau</span><input type="text" maxlength="16" value="${esc(st.name)}" data-nm></label>
            <label><span class="lv-l">Numéro</span><input type="text" maxlength="7" value="${esc(st.number)}" data-no></label>
          </div>
          <p class="gx-note">Purement esthétique : aucun effet sur la vitesse. La couleur de coque est aussi ton étiquette sur la carte.</p>
        </div>`;
      const upd = (patch: Record<string, string>, rerender = true) => {
        this.setup = { ...clone(this.setup), style: { ...(this.setup.style ?? {}), ...patch } };
        storeSetup(this.setup);
        this.applyLook();
        if (rerender) this.render();
      };
      box.querySelectorAll<HTMLButtonElement>('[data-hc]').forEach((b) => b.addEventListener('click', () => upd({ color: b.dataset.hc! })));
      box.querySelectorAll<HTMLButtonElement>('[data-ac]').forEach((b) => b.addEventListener('click', () => upd({ accent: b.dataset.ac! })));
      box.querySelectorAll<HTMLButtonElement>('[data-pat]').forEach((b) => b.addEventListener('click', () => upd({ pattern: b.dataset.pat! })));
      box.querySelectorAll<HTMLButtonElement>('[data-cl]').forEach((b) => b.addEventListener('click', () => upd({ sail: b.dataset.cl! })));
      const nm = q<HTMLInputElement>(box, '[data-nm]');
      const no = q<HTMLInputElement>(box, '[data-no]');
      nm.addEventListener('change', () => upd({ name: nm.value.trim() || 'Sail Run' }));
      no.addEventListener('change', () => upd({ number: no.value.trim().toUpperCase() || 'FRA 1' }));
      return;
    }
    const slot = SLOTS.find((x) => x.id === this.tab)!;
    box.innerHTML = slot.parts
      .map((p) => {
        const selected = p.id === s.parts[slot.id];
        const t = clone(DEFAULT_SETUP);
        t.parts[slot.id] = p.id;
        const tags = this.deltaTags(t);
        return `
          <button type="button" class="gx-opt" data-opt="${p.id}" aria-pressed="${selected}">
            ${art(`${slot.id}.${p.id}`)}
            <span class="txt">
              <span class="top"><span class="n">${esc(p.name)}</span>${selected ? '<span class="badge">Monté</span>' : ''}</span>
              <span class="d">${esc(p.desc)}</span>
              ${tags}
            </span>
          </button>`;
      })
      .join('');
    box.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((b) => {
      const next = () => {
        const t = clone(s);
        t.parts[slot.id] = b.dataset.opt!;
        return t;
      };
      b.addEventListener('click', () => this.choose(next()));
      b.addEventListener('mouseenter', () => this.renderSummary(next()));
      b.addEventListener('mouseleave', () => this.renderSummary(null));
      b.addEventListener('focus', () => this.renderSummary(next()));
      b.addEventListener('blur', () => this.renderSummary(null));
    });
  }

  /* ---------- réglages fins, façon écran de setup ---------- */
  private tuneOf(id: TuneId) {
    return this.setup.tune?.[id] ?? 0;
  }

  /** Adéquation des réglages à la météo (0 à 100 %), null sans prévisions. */
  private fit(): number | null {
    if (!this.ideal) return null;
    let d = 0;
    for (const t of TUNES) d += Math.abs(this.tuneOf(t.id) - this.ideal[t.id]);
    return Math.max(0, Math.round(100 - (d / TUNES.length) * 60));
  }

  private fitLabel(): string {
    const f = this.fit();
    return f === null ? 'Zone idéale en calcul' : `Adéquation ${f} %`;
  }

  private renderTunes(box: HTMLElement) {
    const id = this.ideal;
    const pos = (x: number) => ((x + 1) / 2) * 100;
    box.innerHTML = `
      <p class="gx-note">${id ? 'La bande claire montre la zone idéale pour la météo GFS de cette course.' : 'Chargement des prévisions : la zone idéale apparaîtra dans un instant.'} Chaque cran vaut quelques minutes sur la traversée.</p>
      <div class="tn">
        ${TUNES.map((t) => {
          const v = this.tuneOf(t.id);
          const ideal = id ? `<i class="tn-ideal" style="left: ${Math.max(0, pos(id[t.id]) - 11).toFixed(1)}%; width: ${(Math.min(100, pos(id[t.id]) + 11) - Math.max(0, pos(id[t.id]) - 11)).toFixed(1)}%"></i>` : '';
          return `
          <div class="tn-row" data-tn="${t.id}">
            <div class="tn-top"><b>${esc(t.label)}</b><span class="tn-val" data-tnv>${fmtClick(v)}</span></div>
            <div class="tn-track">
              ${ideal}
              <div class="tn-ticks">${Array.from({ length: 21 }, (_, i) => `<span class="${i === 10 ? 'z' : i % 5 === 0 ? 'M' : ''}"></span>`).join('')}</div>
              <input type="range" min="-10" max="10" step="1" value="${Math.round(v * 10)}" aria-label="${esc(t.label)}">
            </div>
            <div class="tn-ends"><span>${esc(t.min)}</span><span>${esc(t.max)}</span></div>
            <p class="tn-help">${esc(t.help)}</p>
          </div>`;
        }).join('')}
        <button type="button" class="tn-reset" data-tn-reset>Revenir au réglage de série</button>
      </div>`;
    box.querySelectorAll<HTMLElement>('[data-tn]').forEach((row) => {
      const tid = row.dataset.tn as TuneId;
      const input = row.querySelector('input')!;
      input.addEventListener('input', () => {
        const v = Number(input.value) / 10;
        this.setup.tune = { ...NEUTRAL_TUNE, ...(this.setup.tune ?? {}), [tid]: v };
        storeSetup(this.setup);
        row.querySelector('[data-tnv]')!.textContent = fmtClick(v);
        const slot = this.root.querySelector('[data-tab="reglages"] small');
        if (slot) slot.textContent = this.fitLabel();
        this.applyLook();
        this.view.pulse();
        this.renderSummary(null);
      });
    });
    q(box, '[data-tn-reset]').addEventListener('click', () => this.choose({ ...clone(this.setup), tune: { ...NEUTRAL_TUNE } }, false));
  }

  /** Prévisions chargées : calcule la zone idéale puis le temps estimé. */
  fillEta(p: Setup = this.setup) {
    const wind = raceWind(this.def);
    if (wind && !this.ideal) {
      this.ideal = idealTune(raceMix(this.def, wind));
      if (this.step === 'bateau' && this.tab === 'reglages') this.render();
    }
    this.fillEtaOnly(p);
  }

  /** Gains et pertes de la pièce, par domaine, par rapport à la configuration de série. */
  private deltaTags(t: Setup): string {
    const ds = perfDeltas(t).filter((d) => Math.abs(d.v) >= 0.05);
    if (!ds.length) return '<span class="tags"><span class="fx">Configuration de série</span></span>';
    return `<span class="tags">${ds.map((d) => `<span class="${d.v > 0 ? 'up' : 'down'}">${esc(d.label)} ${d.v > 0 ? '+' : '−'}${Math.abs(d.v).toFixed(1).replace('.', ',')} %</span>`).join('')}</span>`;
  }

  /* ---------- étape 2 : le skipper ---------- */
  private skipperHtml(): string {
    const s = this.setup;
    return `
      <p class="gx-note">Ta préparation avant le départ : un seul axe de travail, à choisir selon la course qui t’attend.</p>
      <div class="gx-opts gx-skippers">
        ${SKIPPERS.map((k) => {
          const sel = k.id === s.skipper;
          return `
            <button type="button" class="gx-opt gx-sk" data-sk="${k.id}" aria-pressed="${sel}">
              <svg class="avatar" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="23"/>${SKIPPER_ICON[k.id] ?? ''}</svg>
              <span class="txt">
                <span class="top"><span class="n">${esc(k.name)}</span><span class="role">${esc(k.role)}</span>${sel ? '<span class="badge">Choisi</span>' : ''}</span>
                <span class="d">${esc(k.desc)}</span>
                <span class="tags">${k.effects.map((e) => `<span class="fx">${esc(e)}</span>`).join('')}</span>
              </span>
            </button>`;
        }).join('')}
      </div>`;
  }

  private bindSkipper() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-sk]').forEach((b) => {
      const next = () => ({ ...clone(this.setup), skipper: b.dataset.sk! });
      b.addEventListener('click', () => this.choose(next(), false));
      b.addEventListener('mouseenter', () => this.renderSummary(next()));
      b.addEventListener('mouseleave', () => this.renderSummary(null));
    });
  }

  /* ---------- résumé : écarts par domaine et temps estimé sur la vraie météo ---------- */
  private etaTimer = 0;

  private renderSummary(preview: Setup | null) {
    const box = q(this.root, '[data-summary]');
    const p = preview ?? this.setup;
    const ds = perfDeltas(p);
    const sk = skipperOf(p.skipper);
    const max = 2;
    const rows = ds
      .map((d) => {
        const w = (Math.min(max, Math.abs(d.v)) / max) * 50;
        const v = Math.abs(d.v) < 0.05 ? '0,0' : `${d.v > 0 ? '+' : '−'}${Math.abs(d.v).toFixed(1).replace('.', ',')}`;
        return `
        <div class="stat dlt">
          <div class="row"><span>${esc(d.label)}</span><b class="${d.v > 0.04 ? 'up' : d.v < -0.04 ? 'down' : ''}">${v} %</b></div>
          <div class="bar mid"><i class="${d.v >= 0 ? 'gain' : 'loss'}" style="${d.v >= 0 ? 'left: 50%' : `left: ${50 - w}%`}; width: ${w}%"></i></div>
        </div>`;
      })
      .join('');
    const est = this.def.realWind ? null : estimatedHours(p, this.def);
    const fit = this.fit();
    const fitHtml = this.def.realWind
      ? `<div class="gx-fitg"><span class="gx-eyebrow">Adéquation météo</span><b>${fit === null ? '—' : `${fit} %`}</b><span class="fg-bar"><i style="width: ${fit ?? 0}%" class="${fit === null ? '' : fit >= 85 ? 'ok' : fit >= 65 ? 'mid' : 'bad'}"></i></span></div>`
      : '';
    box.innerHTML = `
      ${fitHtml}
      <span class="gx-eyebrow">Analyse · écart à la série</span>
      <div class="gx-stats">${rows}</div>
      <div class="gx-fit">
        <span class="gx-eyebrow">${this.def.realWind ? 'Simulation sur la météo GFS' : 'Pour cette course'}</span>
        <span class="l">Aime ${esc(likesOf(p))}${this.step === 'skipper' ? ` · ${esc(sk.name)}` : ''}</span>
        <span class="eta" data-eta>${est !== null ? `<small>Temps estimé</small><b>${fmtDuration(est)}</b>` : this.def.realWind ? '<small>Calcul du temps estimé…</small>' : ''}</span>
      </div>`;
    if (this.def.realWind) {
      window.clearTimeout(this.etaTimer);
      this.etaTimer = window.setTimeout(() => this.fillEta(p), preview ? 220 : 120);
    }
  }

  /** Temps de course simulé sur les vraies prévisions, et gain par rapport à la série. */
  private fillEtaOnly(p: Setup = this.setup) {
    const el = this.root.querySelector('[data-eta]');
    if (!el) return;
    const wind = raceWind(this.def);
    if (!wind) {
      el.innerHTML = '<small>Prévisions GFS en cours de chargement…</small>';
      return;
    }
    const { h, delta } = realEta(this.def, p, wind);
    const m = Math.round(delta * 60);
    const run = new Date(wind.meta.t0);
    const dstr = `${String(run.getUTCDate()).padStart(2, '0')}/${String(run.getUTCMonth() + 1).padStart(2, '0')} ${String(run.getUTCHours()).padStart(2, '0')}h UTC`;
    const gain = m === 0 ? 'identique à la série' : `${m < 0 ? '−' : '+'}${Math.abs(m) >= 60 ? fmtDuration(Math.abs(m) / 60) : `${Math.abs(m)} min`} vs série`;
    el.innerHTML = `<small>Temps estimé</small><b>${fmtDuration(h)}</b><em class="${m < 0 ? 'up' : m > 0 ? 'down' : ''}">${gain}</em><small class="src">GFS ${dstr}${wind.meta.source === 'snapshot' ? ' · hors ligne' : ''}</small>`;
  }
}

/** Valeur d'un curseur en crans, façon setup : « 0 », « +3 », « −6 ». */
function fmtClick(v: number): string {
  const n = Math.round(v * 10);
  return n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
}
