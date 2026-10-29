import { DEFAULT_SETUP, Setup } from './data/garage';
import { RaceDef, raceById } from './data/races';
import { Engine } from './render/engine';
import { GarageView } from './render/garageView';
import { WorldView } from './render/world';
import { ImmersiveView } from './render/immersive';
import { ChartView } from './render/chart';
import { distUnit } from './ui/units';
import { Boat, Order, SAILS, SailId, activeOrder, bestSail, changeSail, projectBoat, startRepair, startSleep, wakeUp } from './sim/boat';
import { isoRoute, remainingFrom } from './sim/isochrone';
import { LonLat, norm180, norm360, smooth } from './sim/geo';
import { Race, RaceEvent, clearRace, loadRace, saveRace, timeScaleOf } from './sim/race';
import { bestHeading, decideEvery, nextTarget, planRoute } from './sim/router';
import { sunElevation } from './sim/sun';
import { SyntheticWind, WindSource, windFrom } from './sim/wind';
import { GarageUI, loadSetup } from './ui/garageUI';
import { Hud, LayerId, RouteRow, ViewMode, cardinal } from './ui/hud';
import { renderMenu } from './ui/menu';
import { raceClock } from './ui/dom';
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
  private routeClock = 0;
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
  /** programme de routage affiché (ordres modifiables) et sa fin (h de course) */
  private planOrders: (Order & { sail: SailId; twa: number })[] = [];
  private planEnd = 0;
  private planSum = '';
  private planSel = -1;
  private planPath: { pts: LonLat[]; dt: number; t0: number } | null = null;
  private planBusy = false;
  private planClock = 0;

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
      if (ll && this.screen === 'race' && !this.immersiveOn) this.setProbe(ll);
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
    this.showMenu();
    requestAnimationFrame((t) => this.loop(t));
  }

  /* ---------- écrans ---------- */
  showMenu() {
    if (this.race && this.race.player.finished === null) saveRace(this.race);
    this.immersiveOn = false;
    this.immersive.setActive(false);
    this.screen = 'menu';
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
    this.hud?.toast('Le pilote suit la route conseillée. Prends la barre quand tu veux.');
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
    this.planOrders = (race.player.program ?? []).map((o) => ({ ...o, sail: race.player.sail, twa: 0 }));
    this.planEnd = race.player.programEnd ?? 0;
    this.planSum = this.planOrders.length ? 'Programme repris de ta dernière session.' : '';
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
        if (p.sail === id) {
          this.hud?.toast(`${sailName(id)} déjà à poste`);
          return;
        }
        this.wake();
        if (p.autoSail) p.autoSail = false;
        if (changeSail(p, id)) this.hud?.toast(`Envoi du ${sailName(id)} · 15 min`);
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
      route: (hours) => void this.computeRoute(hours),
      routeFollow: (on) => {
        const p = race.player;
        if (on) {
          if (!this.planOrders.length) return;
          this.applyProgram();
          this.setAuto(true, true);
          this.hud?.toast('Auto : suit ton programme');
        } else {
          p.program = undefined;
          p.programEnd = undefined;
          this.hud?.toast('Programme mis de côté');
        }
        this.projClock = 0;
        this.refreshPlan();
      },
      routeShift: (i, min) => {
        const o = this.planOrders[i];
        if (!o) return;
        o.t = Math.max(race.t, o.t + min / 60);
        this.planOrders.sort((a, b) => a.t - b.t);
        this.planEnd = Math.max(this.planEnd, o.t + 1);
        this.planChanged();
      },
      routeDelete: (i) => {
        this.planOrders.splice(i, 1);
        this.planSel = -1;
        this.planChanged();
      },
      routeAdd: (hhmm, hdg) => {
        const t = this.nextLocal(hhmm);
        const twa = norm180(race.player.twd - hdg);
        this.planOrders.push({ t, hdg, sail: bestSail(twa, race.player.tws), twa });
        this.planOrders.sort((a, b) => a.t - b.t);
        this.planEnd = Math.max(this.planEnd, t + 6);
        if (!this.planSum) this.planSum = 'Programme manuel.';
        this.planChanged();
      },
      routeFocus: (i) => {
        this.planSel = i;
        const o = this.planOrders[i];
        if (o) {
          const pos = this.planPosAt(o.t);
          if (pos) this.chart.focusPlan(pos);
        }
        this.refreshPlan(false);
      },
      routeClear: () => {
        this.planOrders = [];
        this.planEnd = 0;
        this.planSum = '';
        race.player.program = undefined;
        race.player.programEnd = undefined;
        this.refreshPlan();
        this.projClock = 0;
      },
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
    this.routeClock = 0;
    this.hud.setDev(DEV);
    this.syncControls();
    this.hud.update(race, this.day);
    this.refreshPlan();
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
  }

  /* ---------- cercle de cap, état du pilote ---------- */
  private syncRing() {
    const p = this.race?.player;
    if (!p || p.finished !== null || this.immersiveOn) return this.chart.setRing(null);
    this.chart.setRing({ pos: p.pos, hdg: p.hdg, twd: p.twd, tws: p.tws, pending: this.pendingHdg, sail: p.sail });
  }

  private updateAutoInfo() {
    const race = this.race;
    const p = race?.player;
    if (!race || !p || !this.hud) return;
    let txt: string;
    if (!p.auto) {
      txt = `<b>Cap fixe</b> · le bateau garde ${String(Math.round(p.hdg)).padStart(3, '0')}°`;
    } else if (activeOrder(p, race.t)) {
      const next = (p.program ?? []).find((o) => o.t > race.t + 1e-6);
      txt = next ? `<b>Auto · programme</b> · ${this.localHM(next.t)} → ${String(Math.round(next.hdg)).padStart(3, '0')}°` : `<b>Auto · programme</b> · jusqu’à ${this.localHM(p.programEnd ?? race.t)}`;
    } else {
      const m = race.nextMark(p);
      txt = `<b>Auto</b> · route conseillée${m ? ` vers ${m.name}` : ''}`;
    }
    this.hud.setAutoInfo(txt);
  }

  /* ---------- routage ---------- */
  /** Heure locale d'un instant de course : « 14:30 », précédé du jour s'il n'est pas aujourd'hui. */
  private localHM(t: number): string {
    const race = this.race!;
    const d = new Date(race.originUTC + t * 3600000);
    const now = new Date(race.originUTC + race.t * 3600000);
    const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString('fr-FR', { weekday: 'short' })} ${hm}`;
  }

  /** Prochaine occurrence d'une heure locale « hh:mm », en heures de course. */
  private nextLocal(hhmm: string): number {
    const race = this.race!;
    const nowMs = race.originUTC + race.t * 3600000;
    const [hh, mm] = hhmm.split(':').map(Number);
    const d = new Date(nowMs);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return (d.getTime() - race.originUTC) / 3600000;
  }

  private async computeRoute(hours: number) {
    const race = this.race;
    if (!race || this.planBusy) return;
    const p = race.player;
    if (p.finished !== null) return;
    this.planBusy = true;
    this.hud?.setRouteBusy(0);
    try {
      const course = { marks: race.def.marks ?? [], finish: race.def.finish, finishR: race.def.finishR };
      const plan = await isoRoute(p.pos, race.t, hours, race.wind, p.perf, p.mark, course, p.hdg, (k) => this.hud?.setRouteBusy(k));
      if (this.race !== race) return;
      this.planOrders = plan.orders.map((o) => ({ t: o.t, hdg: o.hdg, sail: o.sail, twa: o.twa }));
      this.planEnd = plan.t0 + plan.hours;
      const gained = plan.remain0 - plan.remain1;
      void gained;
      this.planSum = `Calculé à ${this.localHM(race.t)} sur le vent ${race.realWind ? 'GFS (NOAA)' : 'simulé'}, pour ${Math.round(plan.hours)} h de route.`;
      this.planSel = -1;
      // déjà en Auto avec un programme : on le remplace directement
      if (p.auto && p.program?.length) this.applyProgram();
      this.refreshPlan();
    } finally {
      this.planBusy = false;
      this.hud?.setRouteBusy(null);
    }
  }

  /** Le programme affiché devient celui du pilote. */
  private applyProgram() {
    const p = this.race!.player;
    p.program = this.planOrders.map((o) => ({ t: o.t, hdg: o.hdg }));
    p.programEnd = this.planEnd;
    p.decide = 0;
  }

  private planChanged() {
    const p = this.race?.player;
    if (p?.program) this.applyProgram();
    this.projClock = 0;
    this.refreshPlan();
  }

  /** Position prévue sur la route du routage à l'heure t. */
  private planPosAt(t: number): LonLat | null {
    const pp = this.planPath;
    if (!pp || !pp.pts.length) return null;
    return pp.pts[Math.max(0, Math.min(pp.pts.length - 1, Math.round((t - pp.t0) / pp.dt)))];
  }

  /**
   * Redessine le routage : trajectoire simulée en suivant les ordres (ce que fera vraiment le pilote),
   * chiffres clés comparés au cap actuel, frise et étapes en clair.
   */
  private refreshPlan(redraw = true) {
    const race = this.race;
    if (!race || !this.hud) return;
    const p = race.player;
    if (!this.planOrders.length) {
      this.planPath = null;
      this.chart.setPlan([]);
      this.hud.setRoute(null);
      return;
    }
    this.chart.setRoute([]);
    const course = { marks: race.def.marks ?? [], finish: race.def.finish, finishR: race.def.finishR };
    const H = Math.max(1, Math.min(72, this.planEnd - race.t));
    const sim: Boat = { ...p, auto: true, program: this.planOrders.map((o) => ({ t: o.t, hdg: o.hdg })), programEnd: this.planEnd };
    const pr = projectBoat(sim, race.t, race.wind, H, race.def.finish, race.def.finishR, this.projSteer(sim, race.wind), race.def.marks);
    this.planPath = { pts: pr.pts, dt: pr.dt, t0: race.t };
    // même durée en gardant le cap actuel, pour comparer
    const keep = projectBoat({ ...p, auto: false, lock: 'hdg', program: undefined }, race.t, race.wind, H, race.def.finish, race.def.finishR, undefined, race.def.marks);
    const end = pr.pts[pr.pts.length - 1];
    const remPlan = remainingFrom(end, pr.mark, course);
    const remKeep = remainingFrom(keep.pts[keep.pts.length - 1], keep.mark, course);
    const rem0 = race.remaining(p);
    let sailed = 0;
    for (let k = 1; k < pr.pts.length; k++) sailed += dist(pr.pts[k - 1], pr.pts[k]);
    const diff = remKeep - remPlan;

    // étapes : type de manœuvre d'après le vent sur la route simulée
    const nextIdx = this.planOrders.findIndex((o) => o.t > race.t + 1e-6);
    let prevTwa = p.twa;
    let prevSail: SailId = p.sail;
    const pace = (a: number) => (a < 60 ? 'au près' : a < 110 ? 'vent de travers' : a < 150 ? 'au largue' : 'vent arrière');
    const rows: RouteRow[] = this.planOrders.map((o, i) => {
      const pos = this.planPosAt(o.t) ?? p.pos;
      const w = race.wind.at(pos[0], pos[1], o.t);
      const tws = Math.hypot(w[0], w[1]);
      const twa = norm180(windFrom(w[0], w[1]) - o.hdg);
      const sail = bestSail(twa, tws);
      let kind: RouteRow['kind'] = 'turn';
      if (i === 0 && o.t <= race.t + 0.6) kind = 'start';
      else if (Math.sign(twa) !== Math.sign(prevTwa) && Math.abs(prevTwa) > 3) kind = Math.abs(twa) > 90 && Math.abs(prevTwa) > 90 ? 'gybe' : Math.abs(twa) < 90 && Math.abs(prevTwa) < 90 ? 'tack' : Math.abs(twa) > 90 ? 'gybe' : 'tack';
      else if (sail !== prevSail && Math.abs(norm180(o.hdg - (this.planOrders[i - 1]?.hdg ?? o.hdg))) < 20) kind = 'sail';
      prevTwa = twa;
      prevSail = sail;
      return {
        when: o.t <= race.t + 0.05 ? 'Maintenant' : this.localHM(o.t),
        hdg: Math.round(o.hdg),
        sail: sailName(sail),
        twa: `${Math.round(Math.abs(twa))}°`,
        pace: pace(Math.abs(twa)),
        past: o.t <= race.t && i !== nextIdx - 1,
        next: i === nextIdx,
        kind,
        at: (o.t - race.t) / H,
      };
    });

    if (redraw) {
      const tickEvery = H <= 12 ? 3 : 6;
      const pts = pr.pts.map((pos, k) => {
        const h = k * pr.dt;
        return { pos, order: false, label: k > 0 && h % tickEvery === 0 ? `+${h} h · ${this.localHM(race.t + h)}` : '' };
      });
      const KIND: Record<string, string> = { start: 'Départ', tack: 'Virement', gybe: 'Empannage', turn: 'Cap', sail: 'Voile' };
      rows.forEach((r, i) => {
        const o = this.planOrders[i];
        const pos = this.planPosAt(o.t);
        if (pos && o.t >= race.t - 0.01) pts.push({ pos, order: true, label: `${KIND[r.kind]} ${r.when === 'Maintenant' ? '' : r.when + ' '}· ${String(r.hdg).padStart(3, '0')}°` });
      });
      this.chart.setPlan(pts);
    }
    const ticks: { at: number; label: string }[] = [];
    const step = H <= 12 ? 3 : H <= 24 ? 6 : 12;
    for (let h = 0; h <= H + 1e-6; h += step) ticks.push({ at: h / H, label: h === 0 ? 'Maint.' : this.localHM(race.t + h) });
    const target = race.nextMark(p)?.name ?? race.def.to;
    this.hud.setRoute({
      hours: H,
      sailed: fmtDist(sailed, true),
      gained: fmtDist(Math.max(0, rem0 - remPlan), true),
      target,
      vsCap: Math.abs(diff) < 1 ? { text: '=', good: false } : { text: `${diff > 0 ? '+' : '−'}${fmtDist(Math.abs(diff), true)}`, good: diff > 0 },
      ticks,
      rows,
      following: !!p.program?.length && p.auto,
      source: this.planSum,
      defaultTime: this.defaultOrderTime(),
      sel: this.planSel,
    });
  }

  private defaultOrderTime(): string {
    const race = this.race!;
    const d = new Date(race.originUTC + race.t * 3600000 + 3600000);
    d.setMinutes(0, 0, 0);
    return `${String(d.getHours()).padStart(2, '0')}:00`;
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
    if (p.auto === on) return;
    p.auto = on;
    p.decide = 0;
    this.routeClock = 0;
    this.projClock = 0;
    if (!quiet) this.hud?.toast(on ? (activeOrder(p, this.race!.t) ? 'Auto : suit ton programme' : 'Auto : route conseillée') : 'Cap fixe');
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
    else if (ev === 'sail') hud.toast(`Voile auto : ${sailName(boat.sail)}`);
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
      this.fcOffset += dt * 10;
      if (this.fcOffset >= FC_MAX) {
        this.fcOffset = FC_MAX;
        this.fcPlay = false;
      }
      this.fcDirty = true;
    }
    const windT = race.t + this.fcOffset;

    this.projClock -= dt;
    if (this.projClock <= 0) {
      this.projClock = this.pendingHdg !== null ? 0.4 : 3;
      if (p.finished === null) {
        let src = p;
        if (this.pendingHdg !== null) {
          // aperçu : le bateau avec la nouvelle consigne, sans la valider
          src = { ...p, auto: false, lock: 'hdg', hdg: this.pendingHdg, lockTwa: norm180(p.twd - this.pendingHdg) };
        }
        const pr = projectBoat(src, race.t, race.wind, PROJ_HOURS, race.def.finish, race.def.finishR, this.projSteer(src, race.wind), race.def.marks);
        this.chart.setProjection(pr.pts, pr.dt);
      } else {
        this.chart.setProjection([], 0.5);
      }
      this.fcDirty = true;
    }

    this.routeClock -= dt;
    if (this.routeClock <= 0) {
      // route conseillée jusqu'à l'arrivée : lourde, et le vent change lentement : une fois par minute
      this.routeClock = 60;
      const rt = p.finished === null ? planRoute(p, race.t, race.wind, race.def.finish, race.def.finishR, 420, race.def.marks) : [];
      this.chart.setRoute(this.planOrders.length ? [] : rt);
      const end = rt[rt.length - 1];
      this.hud?.setEta(end && dist(end, race.def.finish) < race.def.finishR + 1 ? rt.length - 1 : null);
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
    this.planClock -= dt;
    if (this.planClock <= 0) {
      this.planClock = 30;
      if (this.planOrders.length) this.refreshPlan();
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
    }
  }

  /** Le pilote de la projection décide comme celui de la course, sans aléas. */
  private projSteer(p: Boat, wind: WindSource) {
    if (!p.auto) return undefined;
    let decide = 0;
    return (b: Boat, t: number) => {
      const o = activeOrder(b, t);
      if (o) {
        b.hdg = o.hdg;
        return;
      }
      decide -= 0.1;
      if (decide <= 0) {
        b.hdg = bestHeading(b.pos, t, nextTarget(b), b.perf, wind);
        decide = decideEvery(b);
      }
    };
  }

  private updateForecastUI(race: Race) {
    const h = this.fcOffset;
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
