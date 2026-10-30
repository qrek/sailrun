import { DEFAULT_SETUP, Setup } from './data/garage';
import { RaceDef, raceById } from './data/races';
import { Engine } from './render/engine';
import { GarageView } from './render/garageView';
import { WorldView } from './render/world';
import { ImmersiveView } from './render/immersive';
import { ChartView } from './render/chart';
import { distUnit } from './ui/units';
import { Boat, CP_RADIUS, MAX_CP, SAILS, SailId, bestSail, changeSail, checkpointHeading, projectBoat, startRepair, startSleep, targetSail, wakeUp } from './sim/boat';
import { LonLat, isLand, norm180, norm360, smooth } from './sim/geo';
import { Race, RaceEvent, clearRace, loadRace, saveRace, timeScaleOf } from './sim/race';

import { sunElevation } from './sim/sun';
import { SyntheticWind, windFrom } from './sim/wind';
import { GarageUI, loadSetup } from './ui/garageUI';
import { Hud, LayerId, ViewMode, cardinal } from './ui/hud';
import { renderMenu } from './ui/menu';
import { fmtDuration, raceClock } from './ui/dom';
import { showFinish } from './ui/overlays';
import { loadWindGrid, windGrid } from './sim/gfsWind';
import { MarineSeries, fetchMarine, marineAt } from './sim/marine';
import { bearing, dist } from './sim/geo';
import { fmtDist } from './ui/units';
import { enableModelDrop, preloadBoatModel } from './render/glbBoat';

type Screen = 'menu' | 'garage' | 'race';
const LAYERS_KEY = 'sailgame.layers.v1';
const PROJ_HOURS = 72;
/** ?dev dans l'adresse : accélération du temps pour tester. Sinon tout est en temps réel. */
const DEV = new URLSearchParams(location.search).has('dev');
const FC_MAX = 120;
/** angle au vent sous lequel le trajet est dessiné « bords » (le pilote serre à 42°) */
const CLOSE_SHOWN = 46;
const sailName = (id: SailId) => SAILS.find((s) => s.id === id)?.name ?? id;

function loadLayers(): Record<LayerId, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? 'null');
    if (v && typeof v.wind === 'boolean' && typeof v.clouds === 'boolean') return v;
  } catch {
    /* rien */
  }
  return { wind: true, clouds: true };
}

/** Orchestre les écrans, la boucle de jeu et la sauvegarde. */
export class Game {
  private engine: Engine;
  private world: WorldView;
  private garageView: GarageView;
  private immersive: ImmersiveView;
  private chart: ChartView;
  private immersiveOn = false;
  private ui: HTMLElement;
  private screen: Screen = 'menu';
  private race: Race | null = null;
  private hud: Hud | null = null;
  private garageUI: GarageUI | null = null;
  private paused = false;
  private finishShown = false;
  private menuWind = new SyntheticWind(30);
  private menuT = 0;
  private clock = 0;
  private last = performance.now();
  private uiClock = 0;
  private saveClock = 0;
  private day = 1;
  private layers = loadLayers();
  private fcOffset = 0;
  private fcPlay = false;
  private fcDirty = true;
  private projClock = 0;
  private pickAt: { x: number; y: number } | null = null;
  private pickHide = 0;
  private downAt: { x: number; y: number } | null = null;
  private probe: LonLat | null = null;
  /** consigne en cours de réglage dans le pilote (aperçu de trajectoire) */
  private pendingHdg: number | null = null;
  private probeMarine: MarineSeries | null | undefined = undefined;
  /** pose de checkpoints en cours, checkpoint sélectionné */
  private cpSel = -1;
  /** Barre (on navigue) ou Route (la carte sert à poser ses points) */
  private mode: 'barre' | 'route' = 'barre';
  /** le prochain point posé s'insère après celui-ci */
  private insertAfter: number | null = null;
  /** trajet simulé de la route : un point par demi-heure à partir de t0 */
  private cpPath: { pts: LonLat[]; dt: number; t0: number } | null = null;
  private cpEtas: (number | null)[] = [];
  /** fenêtre 3D en bas à droite */
  private pipOn = true;
  private pipClock = 0;
  private stripH = 48;
  private pipDt = 0;
  private cpClock = 0;

  constructor(app: HTMLElement) {
    this.ui = app.querySelector('#ui')!;
    const labels = app.querySelector<HTMLElement>('#labels')!;
    this.engine = new Engine(app.querySelector('#stage')!);
    this.world = new WorldView(this.engine, labels);
    this.garageView = new GarageView(this.engine);
    if (DEV) (window as unknown as { __garage: GarageView }).__garage = this.garageView;
    this.immersive = new ImmersiveView(this.engine, app);
    this.chart = new ChartView(app);
    this.chart.setUnit(distUnit());
    this.chart.on('click', (ll) => {
      if (!ll || this.screen !== 'race' || this.immersiveOn) return;
      if (this.mode === 'route') {
        // une bulle ouverte se ferme d'abord ; sinon chaque toucher pose un point
        if (this.cpSel >= 0) {
          this.cpSel = -1;
          this.refreshCheckpoints();
        } else this.addCheckpoint(ll);
      } else this.setProbe(ll);
    });
    this.chart.on('mousemove', (_ll, x, y) => {
      this.pickAt = { x, y };
      this.pickHide = 0;
      if (this.race) this.updatePick(this.race.t + this.fcOffset);
    });
    this.chart.on('mouseout', () => {
      this.pickAt = null;
      this.hud?.showPick(0, 0, null);
    });
    window.addEventListener('resize', () => this.garageUI?.layout());
    window.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.race) saveRace(this.race);
      else if (!document.hidden) this.refreshWind();
    });
    window.addEventListener('pagehide', () => {
      if (this.race) saveRace(this.race);
    });
    this.bindPick();
    void preloadBoatModel();
    enableModelDrop((ok, name) => toast(ok ? `Modèle « ${name} » chargé : il remplace le bateau jusqu’au rechargement de la page.` : `« ${name} » n’a pas pu être lu (voir la console).`));
    void loadWindGrid().then(() => {
      if (this.screen === 'menu') this.renderMenuUI();
    });
    // onglet ouvert pendant des jours : on va chercher chaque nouveau run GFS
    setInterval(() => this.refreshWind(), 10 * 60000);
    this.showMenu();
    requestAnimationFrame((t) => this.loop(t));
  }

  /** Recharge les prévisions si elles ont plus de 3 h ; la course en cours passe dessus tout de suite. */
  private refreshWind() {
    const before = windGrid();
    void loadWindGrid().then((g) => {
      if (!g) return;
      if (g !== before && this.screen === 'menu') this.renderMenuUI();
      if (g !== before) this.garageUI?.fillEta();
      if (this.race?.setWindGrid(g)) {
        this.fcDirty = true;
        this.hud?.say(null, 'Météo : nouvelles prévisions GFS, la course navigue dessus.', 'sys');
      }
    });
  }

  /* ---------- écrans ---------- */
  showMenu() {
    if (this.race && this.race.player.finished === null) saveRace(this.race);
    this.immersiveOn = false;
    this.immersive.setActive(false);
    this.screen = 'menu';
    this.syncPipStage();
    this.chart.setVisible(false);
    this.chart.setProbe(null);
    this.world.setLayerVisible(true);
    this.race = null;
    this.hud = null;
    this.garageUI = null;
    this.world.setBoats([]);
    this.world.setFinish(null, 0, '');
    this.world.setMarks([], 0);
    this.probe = null;
    this.pendingHdg = null;
    this.world.setProbe(null);
    this.world.setRoute([]);
    this.world.setProjection([], 0.5);
    this.world.setGhost(0, '');
    this.world.windLayer = false;
    this.world.setCloudsVisible(true);
    this.world.setLabelsVisible(false);
    this.world.tPitch = 0.86;
    this.world.tDist = 26;
    this.world.snapCamera();
    this.engine.input = null;
    this.renderMenuUI();
  }

  private renderMenuUI() {
    renderMenu(this.ui, loadRace(), {
      pick: (def) => this.showGarage(def),
      resume: () => this.resume(),
    });
  }

  showGarage(def: RaceDef) {
    this.screen = 'garage';
    this.syncPipStage();
    this.chart.setVisible(false);
    this.world.setLayerVisible(false);
    this.engine.input = this.garageView.input();
    this.garageView.setRace(def.name);
    this.garageUI = new GarageUI(this.ui, def, loadSetup(DEFAULT_SETUP), this.garageView, () => this.showMenu(), (s) => this.startRace(def, s));
    if (def.realWind) void loadWindGrid().then(() => this.garageUI?.fillEta());
  }

  private startRace(def: RaceDef, setup: Setup, waited = false) {
    if (def.realWind && !windGrid() && !waited) {
      void loadWindGrid().then(() => this.startRace(def, setup, true));
      return;
    }
    clearRace();
    this.race = new Race(def, setup);
    // course déjà partie (on arrive en retard) : les concurrents ont avancé, toi tu pars de la ligne maintenant
    const late = this.race.realT();
    if (late > 0.05 && !DEV) {
      this.race.player.live = true;
      this.race.step(late, () => {});
      this.race.player.live = false;
    }
    this.enterRace();
    if (late <= 0) this.hud?.say(null, `Direction de course : départ ${def.fleet ? 'à l’heure officielle' : 'dans un instant'}. Règle ton cap et ta voile.`, 'sys');
    else this.departure(def);
    saveRace(this.race);
  }

  private departure(def: RaceDef) {
    const r = this.race;
    if (def.fleet && r) {
      this.hud?.say(null, `Direction de course : départ donné à ${def.from} ! ${r.boats.length} ${def.klass ?? ''} en route pour ${def.to}.`, 'sys');
      this.hud?.say(null, r.realWind ? 'Météo : prévisions GFS réelles, mises à jour toutes les 3 h.' : 'Météo : prévisions indisponibles, vent simulé.', 'sys');
      const m = r.nextMark(r.player);
      if (m) this.hud?.say(null, `Première marque : ${m.name}, à laisser à bâbord.`, 'sys');
    } else {
      this.hud?.say(null, `Départ donné ! Cap sur ${def.to}.`, 'sys');
    }
    this.hud?.toast('Règle ton cap, ou pose des checkpoints.');
  }

  private resume(waited = false) {
    const saved = loadRace();
    if (!saved) return this.showMenu();
    if (raceById(saved.raceId).realWind && !windGrid() && !waited) {
      void loadWindGrid().then(() => this.resume(true));
      return;
    }
    this.race = Race.restore(saved);
    this.enterRace();
    // temps réel : la course a continué pendant ton absence
    const hours = Math.min(24 * 30, this.race.realT() - this.race.t);
    if (hours > 0.05 && !DEV) {
      this.race.step(hours, (e) => this.onRaceEvent(e, true));
      this.hud?.say(null, `Pendant ton absence : ${hours < 1 ? Math.round(hours * 60) + ' min' : hours < 48 ? hours.toFixed(1).replace('.', ',') + ' h' : Math.round(hours / 24) + ' jours'} de course.`, 'sys');
    } else {
      this.hud?.say(null, 'Course reprise.', 'sys');
    }
  }

  private enterRace() {
    const race = this.race!;
    this.screen = 'race';
    this.paused = false;
    // nouvelle interface : les réglages de test repartent du vent de la course
    Object.assign(this.immersive.test, { tws: null, twa: null, swell: 1 });
    this.finishShown = race.player.finished !== null;
    this.garageUI = null;
    this.immersiveOn = false;
    this.immersive.setActive(false);
    this.engine.input = null;
    this.world.setLayerVisible(false);
    this.world.setLabelsVisible(false);
    this.chart.setVisible(true);
    this.chart.setBoats(race.boats);
    this.chart.setFinish(race.def.finish, `ARRIVÉE · ${race.def.to.toUpperCase()}`);
    this.chart.setMarks(race.def.marks ?? [], race.player.mark);
    this.fcOffset = 0;
    this.fcPlay = false;
    this.fcDirty = true;
    this.projClock = 0;
    this.chart.windLayer = this.layers.wind;
    // deux modes seulement : cap fixe ou Auto
    if (race.player.lock === 'twa') race.player.lock = 'hdg';
    if (race.player.auto && !race.player.checkpoints?.length) race.player.auto = false;
    this.cpSel = -1;
    this.insertAfter = null;
    this.chart.onCpMove = (i, ll) => {
      const cps = race.player.checkpoints;
      if (!cps?.[i]) return;
      if (isLand(ll[0], ll[1])) {
        this.hud?.toast('Pose le point sur l’eau');
        this.refreshCheckpoints();
        return;
      }
      cps[i] = ll;
      this.cpChanged();
    };
    this.chart.onCpTap = (i) => {
      if (this.mode !== 'route') this.setMode('route');
      this.insertAfter = null;
      this.cpSel = this.cpSel === i ? -1 : i;
      this.refreshCheckpoints();
    };
    this.chart.onRingDrag = (h) => this.hud?.setPending(h);
    this.chart.onRingOk = () => this.hud?.commitPending();
    this.chart.onRingCancel = () => this.hud?.cancelPending();
    this.hud = new Hud(this.ui, {
      steer: (d) => this.steer(d),
      map3d: (on) => this.chart.set3d(on),
      preview: (h) => {
        this.pendingHdg = h;
        this.projClock = Math.min(this.projClock, 0.05);
        this.syncRing();
      },
      commit: (h) => {
        const p = race.player;
        if (p.finished !== null) return;
        this.wake();
        const wasAuto = p.auto;
        this.setAuto(false, true);
        p.lock = 'hdg';
        p.hdg = norm360(h);
        this.projClock = 0;
        this.syncRing();
        this.hud?.toast(`Cap ${String(Math.round(p.hdg)).padStart(3, '0')}° verrouillé${wasAuto ? ' · Auto coupé' : ''}`);
      },
      setAuto: (on) => this.setAuto(on),
      sleep: () => {
        if (race.player.sleep > 0) return this.wake();
        if (startSleep(race.player)) this.hud?.toast('Sieste de 2 h');
        else if (race.player.sailTo !== null) this.hud?.toast('Pas de sieste pendant un changement de voile');
      },
      repair: () => {
        if (startRepair(race.player)) this.hud?.toast('Réparation lancée');
      },
      bearAway: () => {
        const p = race.player;
        const side = p.twa >= 0 ? 1 : -1;
        this.setAuto(false, true);
        p.lockTwa = side * 50;
        p.hdg = norm360(p.twd - side * 50);
        this.projClock = 0;
      },
      sail: (id) => {
        const p = race.player;
        const r = changeSail(p, id);
        if (!r) {
          if (p.sailTo === null) this.hud?.toast(`${sailName(id)} déjà à poste`);
          else if (id === targetSail(p)) this.hud?.toast(p.sailBack ? `Retour au ${sailName(id)} déjà en cours` : `Envoi du ${sailName(id)} déjà en cours`);
          else this.hud?.toast('Termine ou annule d’abord le changement en cours');
          return;
        }
        this.wake();
        if (p.autoSail) p.autoSail = false;
        if (r === 'start') this.hud?.toast(`Envoi du ${sailName(id)} · ${Math.round(p.sailDur * 60)} min`);
        else if (r === 'cancel') this.hud?.toast(`Annulation : on garde le ${sailName(id)}`);
        else this.hud?.toast(`Reprise de l’envoi du ${sailName(id)}`);
        this.projClock = 0;
      },
      autoSail: (on) => {
        const p = race.player;
        p.autoSail = on;
        p.sailLag = 0;
        this.hud?.toast(on ? 'Voile auto' : 'Voile verrouillée');
      },
      lock: (m) => {
        const p = race.player;
        this.wake();
        this.setAuto(false, true);
        p.lock = m;
        p.lockTwa = p.twa;
        this.projClock = 0;
        this.hud?.toast(`Cap fixe ${String(Math.round(p.hdg)).padStart(3, '0')}°`);
      },
      forecast: (h) => {
        this.fcOffset = Math.max(0, Math.min(FC_MAX, h));
        this.fcPlay = false;
        this.fcDirty = true;
      },
      units: (u) => {
        this.chart.setUnit(u);
        this.hud?.update(race, this.day);
      },
      forecastPlay: () => {
        this.fcPlay = !this.fcPlay;
        if (this.fcPlay && this.fcOffset >= FC_MAX - 1) this.fcOffset = 0;
        this.fcDirty = true;
      },
      layer: (id, on) => {
        this.layers[id] = on;
        if (id === 'wind') this.chart.windLayer = on;
        try {
          localStorage.setItem(LAYERS_KEY, JSON.stringify(this.layers));
        } catch {
          /* rien */
        }
      },
      setMode: (m) => this.setMode(m),
      cpDelete: (i) => {
        race.player.checkpoints?.splice(i, 1);
        this.cpSel = -1;
        this.insertAfter = null;
        this.cpChanged();
      },
      cpInsertAfter: (i) => {
        this.insertAfter = i;
        this.cpSel = -1;
        this.refreshCheckpoints();
      },
      cpClear: () => {
        race.player.checkpoints = [];
        this.cpSel = -1;
        this.insertAfter = null;
        this.cpChanged();
      },
      scrub: (h) => {
        this.fcOffset = Math.max(0, Math.min(this.stripH, h));
        this.fcPlay = false;
        this.fcDirty = true;
      },
      pip: (open) => this.setPip(open),
      pipFull: () => this.setView('immersive'),
      speed: (id) => {
        race.speed = id;
        this.paused = false;
        this.syncControls();
        saveRace(race);
      },
      pause: () => {
        this.paused = !this.paused;
        this.syncControls();
      },
      devSea: (o) => Object.assign(this.immersive.test, o),
      view: (m) => this.setView(m),
      menu: () => this.showMenu(),
      say: (text) => {
        this.hud?.say(race.player, text, 'mine');
        if (!race.chatty) return;
        const { boat, text: reply } = race.quip('reply');
        window.setTimeout(() => this.hud?.say(boat, reply), 900 + Math.random() * 1500);
      },
    }, this.layers);
    this.hud.onProbeClose = () => this.setProbe(null);
    this.hud.onPassed = (who, byMe) => {
      if (byMe) {
        this.hud?.say(null, `Tu as doublé ${who.name} !`, 'sys');
        if (race.chatty && Math.random() < 0.5) {
          const reply = race.quip('passed').text;
          window.setTimeout(() => this.hud?.say(who, reply), 1200);
        }
      } else {
        this.hud?.say(null, `${who.name} t’a doublé.`, 'sys');
      }
    };
    this.hud.setDev(DEV);
    this.syncControls();
    this.hud.update(race, this.day);
    this.mode = 'barre';
    this.hud.setMode('barre');
    let pip = !this.engine.small;
    try {
      const v = localStorage.getItem('sailgame.pip');
      if (v !== null) pip = v === '1';
    } catch {
      /* rien */
    }
    this.pipOn = pip;
    this.hud.setPip(pip);
    this.refreshCheckpoints();
    this.syncRing();
  }

  private syncControls() {
    if (this.race && this.hud) this.hud.setControls(this.race.speed, this.paused, true, this.immersiveOn);
  }

  /** Carte (2D / 3D) ou vue immersive au ras de l'eau. */
  private setView(m: ViewMode): void {
    const p = this.race?.player;
    if (m === 'immersive') {
      if (this.immersiveOn) return this.setView('3d');
      this.immersiveOn = true;
      this.immersive.reset();
      this.immersive.setActive(true);
      this.engine.input = this.immersive.input();
      this.chart.setVisible(false);
      this.hud?.showPick(0, 0, null);
      this.hud?.showProbe(0, 0, null);
    } else if (m === 'reset' && this.immersiveOn) {
      this.immersive.reset();
    } else {
      if (this.immersiveOn) {
        this.immersiveOn = false;
        this.immersive.setActive(false);
        this.engine.input = null;
        this.chart.setVisible(true);
      }
      if (m === 'reset' && p) this.chart.recenter(p.pos, 7);
    }
    this.syncControls();
    this.syncPipStage();
  }

  /* ---------- cercle de cap, état du pilote ---------- */
  private syncRing() {
    const p = this.race?.player;
    if (!p || p.finished !== null || this.immersiveOn || this.mode === 'route') return this.chart.setRing(null);
    const change = p.sailTo === null ? null : { from: p.sail, to: p.sailTo, p: p.sailT / p.sailDur, back: p.sailBack };
    this.chart.setRing({ pos: p.pos, hdg: p.hdg, twd: p.twd, tws: p.tws, pending: this.pendingHdg, sail: p.sail, change });
  }

  private updateAutoInfo() {
    const race = this.race;
    const p = race?.player;
    if (!race || !p || !this.hud) return;
    const c = p.checkpoints?.[0];
    const txt = p.auto && c
      ? `<b>Suit ta route</b> · point 1/${p.checkpoints!.length} à ${fmtDist(dist(p.pos, c), true)}`
      : `<b>Cap fixe</b> · le bateau garde ${String(Math.round(p.hdg)).padStart(3, '0')}°${c ? '' : ' · trace ta route dans l’onglet Route'}`;
    this.hud.setAutoInfo(txt);
  }

  /* ---------- checkpoints ---------- */
  /** Heure locale d'un instant de course : « 14:30 », précédé du jour s'il n'est pas aujourd'hui. */
  private localHM(t: number): string {
    const race = this.race!;
    const d = new Date(race.originUTC + t * 3600000);
    const now = new Date(race.originUTC + race.t * 3600000);
    const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString('fr-FR', { weekday: 'short' })} ${hm}`;
  }

  /** Barre : on navigue (cadran, voiles). Route : la carte sert à poser ses points, la frise montre le temps. */
  private setMode(m: 'barre' | 'route') {
    this.mode = m;
    this.chart.setPlacing(m === 'route');
    this.hud?.setMode(m);
    this.insertAfter = null;
    this.cpSel = -1;
    if (m === 'barre') {
      this.fcOffset = 0;
      this.fcPlay = false;
      this.fcDirty = true;
    }
    if (this.immersiveOn && m === 'route') this.setView('3d');
    this.syncRing();
    this.refreshCheckpoints();
  }

  /** Toucher sur la mer en mode Route : nouveau point en fin de route (ou inséré après le point choisi). */
  private addCheckpoint(ll: LonLat) {
    const p = this.race?.player;
    if (!p) return;
    if (isLand(ll[0], ll[1])) {
      this.hud?.toast('Pose le point sur l’eau');
      return;
    }
    const cps = (p.checkpoints ??= []);
    if (cps.length >= MAX_CP) {
      this.hud?.toast(`${MAX_CP} points au maximum : déplace ou supprime un point`);
      return;
    }
    if (this.insertAfter !== null) {
      cps.splice(this.insertAfter + 1, 0, ll);
      this.insertAfter = null;
    } else cps.push(ll);
    this.cpChanged();
  }

  private cpChanged() {
    const p = this.race?.player;
    if (p && p.auto && !p.checkpoints?.length) this.setAuto(false, true);
    if (p?.auto && p.checkpoints?.[0]) p.hdg = checkpointHeading(p.pos, p.checkpoints[0], p.twd);
    this.projClock = 0;
    this.refreshCheckpoints();
  }

  /** Position sur le trajet simulé de la route à l'heure t (null hors du trajet). */
  private pathAt(t: number): LonLat | null {
    const pp = this.cpPath;
    if (!pp) return null;
    const i = (t - pp.t0) / pp.dt;
    if (i < 0 || i > pp.pts.length - 1) return null;
    const a = pp.pts[Math.floor(i)];
    const b = pp.pts[Math.min(pp.pts.length - 1, Math.floor(i) + 1)];
    const k = i - Math.floor(i);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }

  /**
   * Route : on simule le pilote qui suit les points sur les prévisions, pour l'heure d'arrivée à chaque
   * point et le trajet coloré selon la voile. Puis repères, bulle et barre de route.
   */
  private refreshCheckpoints() {
    const race = this.race;
    if (!race || !this.hud) return;
    const p = race.player;
    const cps = p.checkpoints ?? [];
    const etas: (number | null)[] = cps.map(() => null);
    this.cpPath = null;
    const segs: { coords: LonLat[]; k: string }[] = [];
    if (cps.length && p.finished === null) {
      const sim: Boat = { ...p, auto: true, checkpoints: cps.slice() };
      let k = 0;
      let done = Infinity;
      const steer = this.projSteer(sim)!;
      const pr = projectBoat(sim, race.t, race.wind, FC_MAX, race.def.finish, race.def.finishR, (b, t) => {
        while (k < cps.length && dist(b.pos, cps[k]) < CP_RADIUS) {
          etas[k++] = t;
          if (k === cps.length) done = t;
        }
        steer(b);
      }, race.def.marks);
      // le trajet s'arrête au dernier point atteint
      const n = Math.min(pr.pts.length, Number.isFinite(done) ? Math.ceil((done - race.t) / pr.dt) + 1 : pr.pts.length);
      const pts = pr.pts.slice(0, n);
      this.cpPath = { pts, dt: pr.dt, t0: race.t };
      // segments colorés : voile portée, ou « up » quand on serre le vent (bords)
      for (let i = 0; i + 1 < pts.length; i++) {
        const t = race.t + i * pr.dt;
        const w = race.wind.at(pts[i][0], pts[i][1], t);
        const twa = norm180(windFrom(w[0], w[1]) - bearing(pts[i], pts[i + 1]));
        const kind = Math.abs(twa) < CLOSE_SHOWN ? 'up' : bestSail(twa, Math.hypot(w[0], w[1]));
        const last = segs[segs.length - 1];
        if (last && last.k === kind) last.coords.push(pts[i + 1]);
        else segs.push({ coords: [pts[i], pts[i + 1]], k: kind });
      }
    }
    this.cpEtas = etas;
    this.chart.setRoutePath(segs);
    const lastEta = etas[etas.length - 1];
    let total = 0;
    let from = p.pos;
    for (const c of cps) {
      total += dist(from, c);
      from = c;
    }
    this.chart.setCheckpoints(p.finished === null ? p.pos : null, cps.map((c, i) => ({ pos: c, eta: etas[i] === null ? '' : this.localHM(etas[i]!), sel: i === this.cpSel })));
    this.hud.setEta(lastEta !== null && lastEta !== undefined ? lastEta - race.t : null);
    // frise : on zoome sur la durée de la route (au moins 12 h, au plus les 5 jours de prévisions)
    const H = lastEta !== null && lastEta !== undefined ? Math.min(FC_MAX, Math.max(12, Math.ceil((lastEta - race.t) * 1.25 + 2))) : 48;
    this.stripH = H;
    const every = H <= 24 ? 3 : H <= 72 ? 6 : 12;
    const ticks: { at: number; label: string; day: boolean }[] = [];
    const now = new Date(race.originUTC + race.t * 3600000);
    const first = new Date(now);
    first.setMinutes(0, 0, 0);
    for (let k = 1; k <= H + 1; k++) {
      const d = new Date(first.getTime() + k * 3600000);
      const h = (d.getTime() - now.getTime()) / 3600000;
      if (h > H) break;
      if (d.getHours() === 0) ticks.push({ at: h / H, label: d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }), day: true });
      else if (d.getHours() % every === 0) ticks.push({ at: h / H, label: `${d.getHours()}h`, day: false });
    }
    this.hud.setRouteBar({
      count: cps.length,
      total: fmtDist(total, true),
      arrival: lastEta === null || lastEta === undefined ? 'arrivée au-delà de 5 jours' : `arrivée au point ${cps.length} ${this.localHM(lastEta)} · dans ${fmtDuration(lastEta - race.t)}`,
      following: p.auto && cps.length > 0,
      marks: etas.map((e) => (e === null ? 2 : (e - race.t) / H)),
      ticks,
      hours: H,
      inserting: this.insertAfter,
    });
    this.updateBubble();
    this.fcDirty = true;
  }

  /** Bulle du point sélectionné, collée à son repère sur la carte. */
  private updateBubble() {
    const race = this.race;
    if (!race || !this.hud) return;
    const p = race.player;
    const cps = p.checkpoints ?? [];
    const i = this.cpSel;
    if (this.mode !== 'route' || i < 0 || !cps[i]) return this.hud.showBubble(null);
    const sc = this.chart.screenOf(cps[i]);
    if (!sc) return this.hud.showBubble(null);
    const from = i ? cps[i - 1] : p.pos;
    const hdg = bearing(from, cps[i]);
    const tFrom = i ? (this.cpEtas[i - 1] ?? race.t) : race.t;
    const w = race.wind.at(from[0], from[1], tFrom);
    const twa = Math.abs(norm180(windFrom(w[0], w[1]) - hdg));
    const pace = twa < 60 ? 'au près' : twa < 110 ? 'vent de travers' : twa < 150 ? 'au largue' : 'vent arrière';
    const eta = this.cpEtas[i];
    this.hud.showBubble({
      n: i,
      x: sc[0],
      y: sc[1],
      eta: eta === null || eta === undefined ? 'au-delà de 5 j' : `${this.localHM(eta)} · dans ${fmtDuration(eta - race.t)}`,
      dist: fmtDist(dist(from, cps[i]), true),
      hdg: Math.round(hdg),
      pace: `${pace} · ${sailName(bestSail(twa, Math.hypot(w[0], w[1])))}`,
      upwind: twa < 42,
    });
  }

  /* ---------- fenêtre 3D ---------- */
  private setPip(open: boolean) {
    this.pipOn = open;
    try {
      localStorage.setItem('sailgame.pip', open ? '1' : '0');
    } catch {
      /* rien */
    }
    this.hud?.setPip(open);
    this.syncPipStage();
  }

  /** Le canvas 3D passe au-dessus de la carte, découpé à la taille de la fenêtre. */
  private syncPipStage() {
    const st = this.engine.canvas.parentElement!;
    const rect = this.pipOn && this.screen === 'race' && !this.immersiveOn ? this.hud?.pipRect() : null;
    st.classList.toggle('pip', !!rect);
    if (!rect) {
      st.style.clipPath = '';
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    st.style.clipPath = `inset(${rect.top}px ${W - rect.right}px ${H - rect.bottom}px ${rect.left}px round 14px)`;
  }

  /* ---------- commandes ---------- */
  private steer(delta: number) {
    const race = this.race;
    if (!race || race.player.finished !== null) return;
    const p = race.player;
    this.wake();
    if (p.auto) this.setAuto(false);
    p.hdg = norm360(p.hdg + delta);
    this.projClock = Math.min(this.projClock, 0.15);
  }

  /** Toucher la barre ou les voiles réveille le skipper. */
  private wake() {
    const p = this.race?.player;
    if (p && wakeUp(p)) this.hud?.toast(`Skipper réveillé · ${Math.round(p.energy)} %`);
  }

  private setAuto(on: boolean, quiet = false) {
    const p = this.race?.player;
    if (!p) return;
    if (on && p.avarie === 'pilote') {
      this.hud?.toast('Le pilote auto est en panne : répare-le d’abord.');
      return;
    }
    if (on && !p.checkpoints?.length) return;
    if (p.auto === on) return;
    p.auto = on;
    // le bateau se tourne tout de suite vers le premier point (même avant le départ)
    if (on && p.checkpoints?.[0]) p.hdg = checkpointHeading(p.pos, p.checkpoints[0], p.twd);
    window.setTimeout(() => this.refreshCheckpoints(), 0);
    p.decide = 0;
    this.projClock = 0;
    if (!quiet) this.hud?.toast(on ? 'Cap sur le checkpoint 1' : 'Cap fixe');
    this.syncRing();
  }

  private onKey(e: KeyboardEvent) {
    if (this.screen !== 'race' || !this.race) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.hud?.nudge(e.key === 'ArrowLeft' ? (e.shiftKey ? -10 : -2) : e.shiftKey ? 10 : 2);
      e.preventDefault();
    } else if (e.key === 'Enter' && this.hud?.hasPending) {
      this.hud.commitPending();
      e.preventDefault();
    } else if (e.key === 'Escape' && this.hud?.hasPending) {
      this.hud.cancelPending();
    } else if (e.key === 'Escape' && this.probe) {
      this.setProbe(null);
    } else if (e.key === 'i' || e.key === 'I') {
      this.setView('immersive');
    } else if (DEV && e.key === ' ' && e.target === document.body) {
      this.paused = !this.paused;
      this.syncControls();
      e.preventDefault();
    }
  }

  /* ---------- événements de course ---------- */
  private onRaceEvent(e: RaceEvent, quiet = false) {
    const hud = this.hud;
    if (!hud) return;
    if (e.type === 'chat') {
      if (!quiet) hud.say(e.boat, e.text);
      return;
    }
    if (e.type === 'sys') {
      hud.say(null, e.text, 'sys');
      return;
    }
    const { boat, ev } = e;
    if (!boat.isPlayer) {
      if (ev === 'finish' && !quiet) hud.say(null, `${boat.name} a franchi la ligne d’arrivée !`, 'sys');
      return;
    }
    if (ev === 'mark') {
      const m = this.race?.def.marks?.[boat.mark - 1];
      this.chart.setMarks(this.race?.def.marks ?? [], boat.mark);
      if (m && !quiet) {
        hud.say(null, `Marque passée : ${m.name}.`, 'sys');
        hud.toast(`${m.name} passé`);
      }
      return;
    }
    if (quiet) return;
    if (ev === 'tack') hud.toast('Virement de bord');
    else if (ev === 'gybe') hud.toast('Empannage');
    else if (ev === 'avarie') hud.toast('Avarie à bord !');
    else if (ev === 'repaired') hud.toast('Réparation terminée');
    else if (ev === 'woke') hud.toast('Skipper réveillé');
    else if (ev === 'land') hud.toast('Côte en vue : change de cap !');
    else if (ev === 'sail') hud.toast(`Voile auto : envoi du ${sailName(boat.sailTo ?? boat.sail)}`);
    else if (ev === 'sailset') hud.toast(`${sailName(boat.sail)} à poste`);
    else if (ev === 'sailkept') hud.toast(`Changement annulé : ${sailName(boat.sail)} gardé`);
  }

  /* ---------- boucle ---------- */
  private loop(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    if (this.screen === 'garage') {
      this.garageView.frame(dt);
    } else if (this.screen === 'race' && this.race) {
      this.raceFrame(dt);
    } else {
      this.menuT += dt * 0.6;
      const focus: LonLat = [-33 + 9 * Math.sin(this.clock / 40), 33 + 4 * Math.sin(this.clock / 55)];
      this.world.yaw = Math.sin(this.clock / 60) * 0.5;
      this.world.frame({ dt, time: this.clock, wind: this.menuWind, windT: this.menuT, focus, day: 1 });
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  private raceFrame(dt: number) {
    const race = this.race!;
    const p = race.player;
    const wall = Date.now();
    if (!race.allFinished) {
      if (DEV && race.speed !== 'live') {
        if (!this.paused) race.step(dt * timeScaleOf(race.speed).hoursPerSecond, (e) => this.onRaceEvent(e));
      } else {
        // temps réel : la course suit l'horloge, même si l'onglet a dormi
        const target = race.realT(wall);
        if (target > race.t) race.step(Math.min(target - race.t, 24 * 30), (e) => this.onRaceEvent(e));
      }
    }
    const pre = race.realT(wall);
    this.hud?.setPrestart(pre < 0 && !DEV ? -pre * 3600000 : null);
    if (p.finished !== null && !this.finishShown) {
      this.finishShown = true;
      clearRace();
      showFinish(
        this.ui,
        race,
        () => this.showMenu(),
        () => this.hud?.toast('Les autres bateaux terminent leur course.'),
      );
    }

    const sun = sunElevation(p.pos[0], p.pos[1], race.originUTC + race.t * 3600000);
    this.day = smooth(-7, 6, sun);

    // prévisions : décalage dans le temps de la carte (vent, nuages, bateau fantôme)
    if (this.fcPlay) {
      const end = this.mode === 'route' ? this.stripH : FC_MAX;
      this.fcOffset += dt * (end / 12);
      if (this.fcOffset >= end) {
        this.fcOffset = end;
        this.fcPlay = false;
      }
      this.fcDirty = true;
    }
    const windT = race.t + this.fcOffset;

    this.projClock -= dt;
    if (this.projClock <= 0) {
      this.projClock = this.pendingHdg !== null ? 0.4 : 3;
      if (p.finished === null && this.mode !== 'route') {
        let src = p;
        if (this.pendingHdg !== null) {
          // aperçu : le bateau avec la nouvelle consigne, sans la valider
          src = { ...p, auto: false, lock: 'hdg', hdg: this.pendingHdg, lockTwa: norm180(p.twd - this.pendingHdg) };
        }
        const pr = projectBoat(src, race.t, race.wind, PROJ_HOURS, race.def.finish, race.def.finishR, this.projSteer(src), race.def.marks);
        this.chart.setProjection(pr.pts, pr.dt);
      } else {
        this.chart.setProjection([], 0.5);
      }
      this.fcDirty = true;
    }

    this.uiClock -= dt;
    if (this.uiClock <= 0) {
      this.uiClock = 0.25;
      this.hud?.update(race, this.day);
      this.chart.updateBoats();
      this.updatePick(windT);
      this.syncRing();
      this.updateAutoInfo();
    }
    this.cpClock -= dt;
    if (this.cpClock <= 0) {
      this.cpClock = 10;
      this.refreshCheckpoints();
    }
    if (this.probe) {
      this.updateProbe(windT);
    }
    if (this.fcDirty) {
      this.fcDirty = false;
      this.updateForecastUI(race);
    }
    this.hud?.tick(dt);
    this.saveClock -= dt;
    if (this.saveClock <= 0) {
      this.saveClock = 3;
      if (p.finished === null) saveRace(race);
    }
    if (this.immersiveOn) {
      // soleil : angle horaire à la position du bateau, ramené au cap
      const hours = ((race.originUTC + race.t * 3600000) / 3600000) % 24;
      const hourAngle = (hours + p.pos[0] / 15 - 12) * 15;
      this.immersive.frame(dt, p, race.boats, this.day, ((180 + hourAngle - p.hdg) * Math.PI) / 180);
    } else {
      this.chart.frame({ wind: race.wind, windT, focus: p.pos }, dt);
      if (this.cpSel >= 0 && this.mode === 'route') this.updateBubble();
      // fenêtre 3D : rendu réduit, une quinzaine d'images par seconde
      this.pipDt += dt;
      this.pipClock -= dt;
      if (this.pipOn && this.pipClock <= 0) {
        this.pipClock = this.engine.small ? 1 / 12 : 1 / 20;
        this.syncPipStage();
        const rc = this.hud?.pipRect();
        if (rc) {
          const hours = ((race.originUTC + race.t * 3600000) / 3600000) % 24;
          const hourAngle = (hours + p.pos[0] / 15 - 12) * 15;
          this.immersive.frame(this.pipDt, p, race.boats, this.day, ((180 + hourAngle - p.hdg) * Math.PI) / 180, { x: rc.left, y: rc.top, w: rc.width, h: rc.height });
        }
        this.pipDt = 0;
      }
    }
  }

  /** La projection suit les checkpoints comme le pilote de la course. */
  private projSteer(p: Boat) {
    if (!p.auto || !p.checkpoints?.length) return undefined;
    const cps = p.checkpoints.slice();
    return (b: Boat) => {
      while (cps.length && dist(b.pos, cps[0]) < CP_RADIUS) cps.shift();
      if (cps.length) b.hdg = checkpointHeading(b.pos, cps[0], b.twd);
    };
  }

  private updateForecastUI(race: Race) {
    const h = this.fcOffset;
    if (this.mode === 'route') {
      // frise de la route : heure, et vent là où sera le bateau fantôme sur ta route
      const t = race.t + h;
      const g = h >= 0.25 ? this.pathAt(t) : null;
      this.chart.setGhostPos(g);
      const when = h < 0.25 ? 'Maintenant' : `${this.localHM(t)} <small>+${h < 10 ? h.toFixed(1).replace('.', ',') : Math.round(h)} h</small>`;
      let wind = '';
      if (g) {
        const w = race.wind.at(g[0], g[1], t);
        wind = `<em>ton bateau : ${Math.round(Math.hypot(w[0], w[1]))} nds de ${cardinal(windFrom(w[0], w[1]))}</em>`;
      } else if (h >= 0.25 && this.cpPath) wind = '<em>route terminée</em>';
      this.hud?.setStrip(h, this.stripH, `<b>${when}</b>${wind}`, this.fcPlay);
      return;
    }
    if (h < 0.5) {
      this.chart.setGhost(0);
      this.hud?.setForecast(0, this.fcPlay, 'Prévisions', 'Glisse pour voir le vent des 5 prochains jours');
      return;
    }
    const t = race.t + h;
    const label = `+${Math.round(h)} h · ${raceClock(race.originUTC, t)}`;
    let sub: string;
    if (race.player.finished === null && h <= PROJ_HOURS) {
      this.chart.setGhost(h);
      const pr = this.chart.ghostPos(h);
      if (pr) {
        const w = race.wind.at(pr[0], pr[1], t);
        sub = `Là où tu seras (rond jaune) : ${Math.round(Math.hypot(w[0], w[1]))} nds de ${cardinal(windFrom(w[0], w[1]))}`;
      } else {
        sub = 'Le rond jaune montre où tu seras';
      }
    } else {
      this.chart.setGhost(0);
      sub = `Au-delà de ${PROJ_HOURS} h, on ne montre que le vent`;
    }
    this.hud?.setForecast(h, this.fcPlay, label, sub);
  }

  /* ---------- vent sous le pointeur ---------- */
  private bindPick() {
    const c = this.engine.canvas;
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || e.buttons) {
        if (this.pickAt && e.pointerType === 'mouse') this.pickAt = null;
        return;
      }
      this.pickAt = { x: e.clientX, y: e.clientY };
      this.pickHide = 0;
      if (this.race) this.updatePick(this.race.t + this.fcOffset);
    });
    c.addEventListener('pointerleave', () => {
      this.pickAt = null;
      this.hud?.showPick(0, 0, null);
    });
    c.addEventListener('pointerdown', (e) => {
      this.downAt = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'mouse') this.hud?.showPick(0, 0, null);
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.downAt;
      this.downAt = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || this.screen !== 'race' || this.immersiveOn) return;
      // clic ou toucher bref : on pose la sonde (vent, courant, houle à ce point précis)
      const ll = this.world.pick(e.clientX, e.clientY);
      if (ll) this.setProbe(ll);
    });
  }

  private setProbe(ll: LonLat | null) {
    this.probe = ll;
    this.probeMarine = undefined;
    this.chart.setProbe(ll);
    if (!ll) {
      this.hud?.showProbe(0, 0, null);
      return;
    }
    const mine = ll;
    void fetchMarine(ll[0], ll[1]).then((m) => {
      if (this.probe === mine) this.probeMarine = m;
    });
    if (this.race) this.updateProbe(this.race.t + this.fcOffset);
  }

  /** Carte de la sonde, à l'heure des prévisions affichées. */
  private updateProbe(windT: number) {
    const race = this.race;
    const hud = this.hud;
    if (!race || !hud) return;
    const sp = this.probe && !this.immersiveOn ? this.chart.probeScreen() : null;
    if (!this.probe || !sp) return hud.showProbe(0, 0, null);
    const [lon, lat] = this.probe;
    const w = race.wind.at(lon, lat, windT);
    const tws = Math.hypot(w[0], w[1]);
    const twd = windFrom(w[0], w[1]);
    const utc = race.originUTC + windT * 3600000;
    const deg = (v: number) => `${String(Math.round(((v % 360) + 360) % 360)).padStart(3, '0')}°`;
    const dm = (v: number, pos: string, neg: string) => {
      const tm = Math.round(Math.abs(v) * 60);
      return `${Math.floor(tm / 60)}°${String(tm % 60).padStart(2, '0')}′${v >= 0 ? pos : neg}`;
    };
    let cur = 'chargement…';
    let wave = 'chargement…';
    if (this.probeMarine === null) {
      cur = wave = 'indisponible';
    } else if (this.probeMarine) {
      const m = marineAt(this.probeMarine, utc);
      if (!m) {
        cur = wave = 'hors prévisions';
      } else {
        cur = Number.isNaN(m.cur) ? '—' : `${m.cur.toFixed(1).replace('.', ',')} nd vers ${cardinal(m.curDir)} (${deg(m.curDir)})`;
        wave = Number.isNaN(m.wave) ? '—' : `${m.wave.toFixed(1).replace('.', ',')} m de ${cardinal(m.waveDir)}`;
      }
    }
    const p = race.player;
    const brg = bearing(p.pos, this.probe);
    const twaThere = norm180(twd - brg);
    hud.showProbe(sp[0], sp[1], {
      pos: `${dm(lat, 'N', 'S')} ${dm(lon, 'E', 'O')}`,
      wind: `${Math.round(tws)} nds de ${cardinal(twd)} (${deg(twd)})`,
      cur,
      wave,
      from: `${fmtDist(dist(p.pos, this.probe), true)} · cap ${deg(brg)}`,
      twa: `${Math.round(Math.abs(twaThere))}° ${twaThere < 0 ? 'bâbord' : 'tribord'} en y allant`,
      time: this.fcOffset >= 0.5 ? `Prévision à ${raceClock(race.originUTC, windT)} UTC` : `Maintenant · ${raceClock(race.originUTC, windT)} UTC`,
    });
  }

  private updatePick(windT: number) {
    const hud = this.hud;
    const race = this.race;
    if (!hud || !race) return;
    if (this.immersiveOn) return hud.showPick(0, 0, null);
    if (!this.pickAt || (this.pickHide && performance.now() > this.pickHide)) {
      this.pickAt = this.pickHide ? null : this.pickAt;
      this.pickHide = 0;
      hud.showPick(0, 0, null);
      return;
    }
    const ll = this.chart.pick(this.pickAt.x, this.pickAt.y);
    if (!ll) {
      hud.showPick(0, 0, null);
      return;
    }
    const w = race.wind.at(ll[0], ll[1], windT);
    const dir = windFrom(w[0], w[1]);
    hud.showPick(this.pickAt.x, this.pickAt.y, `${Math.round(Math.hypot(w[0], w[1]))} nds · de ${cardinal(dir)} (${Math.round(dir)}°)`);
  }
}

/** Petit message éphémère en bas de l'écran. */
function toast(text: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  window.setTimeout(() => el.classList.add('out'), 4200);
  window.setTimeout(() => el.remove(), 4800);
}
