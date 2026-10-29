import { DEFAULT_SETUP, Setup } from './data/garage';
import { RaceDef, raceById } from './data/races';
import { Engine } from './render/engine';
import { GarageView } from './render/garageView';
import { WorldView } from './render/world';
import { ImmersiveView } from './render/immersive';
import { Boat, SAILS, SailId, changeSail, projectBoat, startRepair, startSleep, wakeUp } from './sim/boat';
import { LonLat, norm180, norm360, smooth } from './sim/geo';
import { Race, RaceEvent, clearRace, loadRace, saveRace, timeScaleOf } from './sim/race';
import { bestHeading, decideEvery, nextTarget, planRoute } from './sim/router';
import { sunElevation } from './sim/sun';
import { SyntheticWind, WindSource, windFrom } from './sim/wind';
import { GarageUI, loadSetup } from './ui/garageUI';
import { Hud, LayerId, ViewMode, cardinal } from './ui/hud';
import { renderMenu } from './ui/menu';
import { raceClock } from './ui/dom';
import { showFinish, showIntro } from './ui/overlays';
import { loadWindGrid, windGrid } from './sim/gfsWind';
import { MarineSeries, fetchMarine, marineAt } from './sim/marine';
import { bearing, dist } from './sim/geo';
import { fmtDist } from './ui/units';

type Screen = 'menu' | 'garage' | 'race';
const INTRO_KEY = 'sailgame.intro.v2';
const LAYERS_KEY = 'sailgame.layers.v1';
const PROJ_HOURS = 72;
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
  private lastWall = Date.now();
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

  constructor(app: HTMLElement) {
    this.ui = app.querySelector('#ui')!;
    const labels = app.querySelector<HTMLElement>('#labels')!;
    this.engine = new Engine(app.querySelector('#stage')!);
    this.world = new WorldView(this.engine, labels);
    this.garageView = new GarageView(this.engine);
    this.immersive = new ImmersiveView(this.engine, app);
    window.addEventListener('resize', () => this.garageUI?.layout());
    window.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.race) saveRace(this.race);
    });
    window.addEventListener('pagehide', () => {
      if (this.race) saveRace(this.race);
    });
    this.bindPick();
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
    this.enterRace();
    let seen = false;
    try {
      seen = localStorage.getItem(INTRO_KEY) === '1';
    } catch {
      /* rien */
    }
    if (!seen) {
      this.paused = true;
      showIntro(this.ui, def.name, () => {
        try {
          localStorage.setItem(INTRO_KEY, '1');
        } catch {
          /* rien */
        }
        this.paused = false;
        this.departure(def);
      });
    } else {
      this.departure(def);
    }
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
    if (saved.speed === 'live') {
      const hours = Math.min(24 * 30, (Date.now() - saved.savedAt) / 3600000);
      if (hours > 0.05) {
        this.race.step(hours, (e) => this.onRaceEvent(e, true));
        this.hud?.say(null, `Pendant ton absence : ${hours < 1 ? Math.round(hours * 60) + ' min' : hours.toFixed(1).replace('.', ',') + ' h'} de course.`, 'sys');
      }
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
    this.engine.input = this.world.input();
    this.world.setLayerVisible(true);
    this.world.setLabelsVisible(true);
    this.world.setBoats(race.boats);
    this.world.setFinish(race.def.finish, race.def.finishR, `ARRIVÉE · ${race.def.to.toUpperCase()}`);
    this.world.setMarks(race.def.marks ?? [], race.player.mark);
    this.world.view('reset');
    this.world.snapCamera();
    this.fcOffset = 0;
    this.fcPlay = false;
    this.fcDirty = true;
    this.projClock = 0;
    this.world.windLayer = this.layers.wind;
    this.world.setCloudsVisible(this.layers.clouds);
    this.hud = new Hud(this.ui, {
      steer: (d) => this.steer(d),
      preview: (h) => {
        this.pendingHdg = h;
        this.projClock = Math.min(this.projClock, 0.05);
      },
      commit: (h) => {
        const p = race.player;
        if (p.finished !== null) return;
        this.wake();
        const twaMode = !p.auto && p.lock === 'twa';
        this.setAuto(false, true);
        if (twaMode) {
          p.lock = 'twa';
          p.lockTwa = norm180(p.twd - h);
        } else {
          p.lock = 'hdg';
        }
        p.hdg = norm360(h);
        this.projClock = 0;
        this.hud?.toast(twaMode ? `Consigne : ${Math.round(Math.abs(p.lockTwa))}° du vent ${p.lockTwa < 0 ? 'bâbord' : 'tribord'}` : `Consigne : cap ${String(Math.round(p.hdg)).padStart(3, '0')}°`);
      },
      setAuto: (on) => this.setAuto(on),
      sleep: () => {
        if (race.player.sleep > 0) return this.wake();
        if (startSleep(race.player)) this.hud?.toast('Sieste de 2 h : le bateau garde sa barre, mais personne ne touche aux voiles.');
      },
      repair: () => {
        if (startRepair(race.player)) this.hud?.toast('Réparation lancée. Le bateau avance moins vite pendant ce temps.');
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
          this.hud?.toast(`Le ${sailName(id)} est déjà envoyé.`);
          return;
        }
        this.wake();
        if (p.autoSail) p.autoSail = false;
        if (changeSail(p, id)) this.hud?.toast(`Envoi du ${sailName(id)} : 15 min au ralenti. Voile auto coupée.`);
        this.projClock = 0;
      },
      autoSail: (on) => {
        const p = race.player;
        p.autoSail = on;
        p.sailLag = 0;
        this.hud?.toast(on ? 'Voile auto : la meilleure voile est envoyée dès que le vent change.' : 'Tu choisis tes voiles toi-même.');
      },
      lock: (m) => {
        const p = race.player;
        this.wake();
        this.setAuto(false, true);
        p.lock = m;
        p.lockTwa = p.twa;
        this.projClock = 0;
        this.hud?.toast(m === 'twa' ? `Barre à ${Math.round(Math.abs(p.twa))}° du vent : le cap suit les bascules.` : `Barre au cap ${Math.round(p.hdg)}° : le bateau ne bouge plus de cap.`);
      },
      forecast: (h) => {
        this.fcOffset = Math.max(0, Math.min(FC_MAX, h));
        this.fcPlay = false;
        this.fcDirty = true;
      },
      units: () => {
        this.hud?.update(race, this.day);
      },
      forecastPlay: () => {
        this.fcPlay = !this.fcPlay;
        if (this.fcPlay && this.fcOffset >= FC_MAX - 1) this.fcOffset = 0;
        this.fcDirty = true;
      },
      layer: (id, on) => {
        this.layers[id] = on;
        if (id === 'wind') this.world.windLayer = on;
        else this.world.setCloudsVisible(on);
        try {
          localStorage.setItem(LAYERS_KEY, JSON.stringify(this.layers));
        } catch {
          /* rien */
        }
      },
      speed: (id) => {
        race.speed = id;
        this.paused = false;
        this.lastWall = Date.now();
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
    this.lastWall = Date.now();
    this.syncControls();
    this.hud.update(race, this.day);
  }

  private syncControls() {
    if (this.race && this.hud) this.hud.setControls(this.race.speed, this.paused, this.world.is2d, this.immersiveOn);
  }

  /** Carte (2D / 3D) ou vue immersive au ras de l'eau. */
  private setView(m: ViewMode): void {
    if (m === 'immersive') {
      if (this.immersiveOn) {
        this.setView('3d');
        return;
      }
      this.immersiveOn = true;
      this.immersive.reset();
      this.immersive.setActive(true);
      this.engine.input = this.immersive.input();
      this.world.setLayerVisible(false);
      this.hud?.showPick(0, 0, null);
    } else if (m === 'reset' && this.immersiveOn) {
      this.immersive.reset();
    } else {
      if (this.immersiveOn) {
        this.immersiveOn = false;
        this.immersive.setActive(false);
        this.engine.input = this.world.input();
        this.world.setLayerVisible(true);
        this.world.snapCamera();
      }
      this.world.view(m);
    }
    this.syncControls();
  }

  /* ---------- commandes ---------- */
  private steer(delta: number) {
    const race = this.race;
    if (!race || race.player.finished !== null) return;
    const p = race.player;
    this.wake();
    if (p.auto) this.setAuto(false);
    if (p.lock === 'twa') {
      p.lockTwa = norm180(p.lockTwa - delta);
      p.hdg = norm360(p.twd - p.lockTwa);
    } else {
      p.hdg = norm360(p.hdg + delta);
    }
    this.projClock = Math.min(this.projClock, 0.15);
  }

  /** Toucher la barre ou les voiles réveille le skipper. */
  private wake() {
    const p = this.race?.player;
    if (p && wakeUp(p)) this.hud?.toast(`Tu as réveillé ton skipper (énergie ${Math.round(p.energy)} %).`);
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
    if (!quiet) this.hud?.toast(on ? 'Pilote auto : il suit la route conseillée' : 'Tu as la barre');
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
    } else if (e.key === ' ' && e.target === document.body) {
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
      this.world.setMarks(this.race?.def.marks ?? [], boat.mark);
      if (m && !quiet) {
        hud.say(null, `Marque passée : ${m.name}.`, 'sys');
        hud.toast(`${m.name} passé${boat.mark === this.race?.def.marks?.length ? ' — cap sur la ligne d’arrivée !' : ''}`);
      }
      return;
    }
    if (quiet) return;
    if (ev === 'tack') hud.toast('Virement de bord : le bateau ralentit un moment');
    else if (ev === 'gybe') hud.toast('Empannage : le bateau ralentit un moment');
    else if (ev === 'avarie') hud.toast('Aïe ! Quelque chose a cassé à bord.');
    else if (ev === 'repaired') hud.toast('Réparation terminée, le bateau repart à pleine vitesse.');
    else if (ev === 'woke') hud.toast('Ton skipper est réveillé et en forme.');
    else if (ev === 'land') hud.toast('Le bateau touche la côte : change de cap !');
    else if (ev === 'sail') hud.toast(`Voile auto : envoi du ${sailName(boat.sail)}.`);
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
    if (!this.paused && !race.allFinished) {
      const ts = timeScaleOf(race.speed);
      // en temps réel on suit l'horloge murale, même si l'onglet a dormi
      const hours = race.speed === 'live' ? (wall - this.lastWall) / 3600000 : dt * ts.hoursPerSecond;
      race.step(hours, (e) => this.onRaceEvent(e));
    }
    this.lastWall = wall;

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

    const sun = sunElevation(p.pos[0], p.pos[1], race.def.startUTC + race.t * 3600000);
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
      this.projClock = 1;
      if (p.finished === null) {
        let src = p;
        if (this.pendingHdg !== null) {
          // aperçu : le bateau avec la nouvelle consigne, sans la valider
          const twaMode = !p.auto && p.lock === 'twa';
          src = { ...p, auto: false, lock: twaMode ? 'twa' : 'hdg', hdg: this.pendingHdg, lockTwa: norm180(p.twd - this.pendingHdg) };
        }
        const pr = projectBoat(src, race.t, race.wind, PROJ_HOURS, race.def.finish, race.def.finishR, this.projSteer(src, race.wind), race.def.marks);
        this.world.setProjection(pr.pts, pr.dt);
      } else {
        this.world.setProjection([], 0.5);
      }
      this.fcDirty = true;
    }

    this.routeClock -= dt;
    if (this.routeClock <= 0) {
      this.routeClock = 1.5;
      const rt = p.finished === null ? planRoute(p, race.t, race.wind, race.def.finish, race.def.finishR, 420, race.def.marks) : [];
      this.world.setRoute(rt);
      const end = rt[rt.length - 1];
      this.hud?.setEta(end && dist(end, race.def.finish) < race.def.finishR + 1 ? rt.length - 1 : null);
    }
    this.uiClock -= dt;
    if (this.uiClock <= 0) {
      this.uiClock = 0.25;
      this.hud?.update(race, this.day);
      this.updatePick(windT);
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
      const hours = ((race.def.startUTC + race.t * 3600000) / 3600000) % 24;
      const hourAngle = (hours + p.pos[0] / 15 - 12) * 15;
      this.immersive.frame(dt, p, race.boats, this.day, ((180 + hourAngle - p.hdg) * Math.PI) / 180);
    } else {
      this.world.frame({ dt, time: this.clock, wind: race.wind, windT, focus: p.pos, day: this.day });
    }
  }

  /** Le pilote de la projection décide comme celui de la course, sans aléas. */
  private projSteer(p: Boat, wind: WindSource) {
    if (!p.auto) return undefined;
    let decide = 0;
    return (b: Boat, t: number) => {
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
      this.world.setGhost(0, '');
      this.hud?.setForecast(0, this.fcPlay, 'Prévisions', 'Glisse pour voir le vent des 5 prochains jours');
      return;
    }
    const t = race.t + h;
    const label = `+${Math.round(h)} h · ${raceClock(race.def.startUTC, t)}`;
    let sub: string;
    if (race.player.finished === null && h <= PROJ_HOURS) {
      this.world.setGhost(h, `+${Math.round(h)} h`);
      const pr = this.world.ghostPos();
      if (pr) {
        const w = race.wind.at(pr[0], pr[1], t);
        sub = `Là où tu seras (rond jaune) : ${Math.round(Math.hypot(w[0], w[1]))} nds de ${cardinal(windFrom(w[0], w[1]))}`;
      } else {
        sub = 'Le rond jaune montre où tu seras';
      }
    } else {
      this.world.setGhost(0, '');
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
    this.world.setProbe(ll);
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
    const sp = this.probe && !this.immersiveOn ? this.world.probeScreen() : null;
    if (!this.probe || !sp) return hud.showProbe(0, 0, null);
    const [lon, lat] = this.probe;
    const w = race.wind.at(lon, lat, windT);
    const tws = Math.hypot(w[0], w[1]);
    const twd = windFrom(w[0], w[1]);
    const utc = race.def.startUTC + windT * 3600000;
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
      time: this.fcOffset >= 0.5 ? `Prévision à ${raceClock(race.def.startUTC, windT)} UTC` : `Maintenant · ${raceClock(race.def.startUTC, windT)} UTC`,
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
    const ll = this.world.pick(this.pickAt.x, this.pickAt.y);
    if (!ll) {
      hud.showPick(0, 0, null);
      return;
    }
    const w = race.wind.at(ll[0], ll[1], windT);
    const dir = windFrom(w[0], w[1]);
    hud.showPick(this.pickAt.x, this.pickAt.y, `${Math.round(Math.hypot(w[0], w[1]))} nds · de ${cardinal(dir)} (${Math.round(dir)}°)`);
  }
}
