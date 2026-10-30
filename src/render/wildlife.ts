/**
 * Animaux marins (vue immersive) : de temps en temps, une bande de dauphins vient jouer à l'étrave, ou une
 * baleine passe au loin, souffle à chaque remontée et sonde en montrant sa queue. Rare : quelques rencontres
 * par heure, jamais la nuit (on ne les verrait pas) ; les dauphins ne suivent pas un bateau trop rapide.
 *
 * Repère du bateau, comme la flottabilité : 1 = une longueur de coque (≈ 18 m), étrave vers -z, tribord vers +x.
 * Hauteurs comptées depuis la surface de l'eau au même point.
 */

import * as THREE from 'three';
import type { Spray } from './spray';

export type Kind = 'dolphins' | 'whale';

/** au-delà (nœuds), les dauphins ne suivent plus : ils décrochent */
export const DOLPHIN_MAX_KN = 22;
/** demi-hauteur du corps de la baleine */
export const WHALE_HALF = 0.07;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const frac = (x: number) => x - Math.floor(x);
/** bruit déterministe d'un entier, entre 0 et 1 */
const hash = (n: number) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);

/* ---------- quand ---------- */

export interface Encounter {
  kind: Kind;
  /** secondes depuis l'arrivée */
  t: number;
  /** instant du départ (secondes depuis l'arrivée) */
  end: number;
  pod: DolphinSpec[];
  whale: WhaleSpec | null;
}

/** Qui vient, et quand : une rencontre à la fois, séparées de plusieurs minutes de mer vide. */
export class Sightings {
  current: Encounter | null = null;
  private wait: number;

  constructor(private rand: () => number = Math.random) {
    // la première ne se fait pas trop attendre
    this.wait = 45 + 150 * rand();
  }

  /** Avance de `dt` secondes ; renvoie l'espèce qui arrive à cet instant, s'il y en a une. */
  step(dt: number, spd: number, day: number): Kind | null {
    const c = this.current;
    if (c) {
      c.t += dt;
      // trop vite (ou à l'arrêt) : les dauphins décrochent
      if (c.kind === 'dolphins' && (spd > DOLPHIN_MAX_KN || spd < 2)) c.end = Math.min(c.end, Math.max(c.t, 1) + 5);
      if (c.t >= c.end) {
        this.current = null;
        this.wait = 120 + Math.min(900, -300 * Math.log(1 - this.rand()));
      }
      return null;
    }
    if (day < 0.2) return null;
    this.wait -= dt;
    if (this.wait > 0) return null;
    const kind: Kind = spd >= 3 && spd <= DOLPHIN_MAX_KN && this.rand() < 0.6 ? 'dolphins' : 'whale';
    this.trigger(kind);
    return kind;
  }

  /** Fait venir une espèce tout de suite (mode test). */
  trigger(kind: Kind): void {
    if (kind === 'dolphins') {
      this.current = { kind, t: 0, end: 45 + 55 * this.rand(), pod: dolphinPod(this.rand), whale: null };
    } else {
      const whale = whaleSpec(this.rand);
      this.current = { kind, t: 0, end: whaleEnd(whale), pod: [], whale };
    }
  }
}

/** Arrivée en 6 s, départ en 5 s : 0 = au loin, 1 = là. */
export function presence(t: number, end: number, start = 0): number {
  return smooth(Math.min((t - start) / 6, (end - t) / 5));
}

/* ---------- dauphins ---------- */

export interface DolphinSpec {
  /** place à l'étrave */
  x0: number;
  z0: number;
  side: number;
  /** une respiration toutes les `period` secondes */
  period: number;
  phase: number;
  depth: number;
  leap: number;
  seed: number;
}

/** part du cycle passée hors de l'eau */
const LEAP = 0.2;
/** vitesse de nage prise pour l'assiette (longueurs / s) */
const SWIM = 0.45;

/** Une bande de 3 à 6 dauphins, répartis des deux bords, devant et le long de l'étrave. */
export function dolphinPod(rand: () => number): DolphinSpec[] {
  const n = 3 + Math.floor(rand() * 4);
  return Array.from({ length: n }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const z0 = -0.95 + 0.6 * rand();
    // devant l'étrave on peut passer près de l'axe ; le long de la coque, on garde de la place
    const x0 = side * ((z0 < -0.55 ? 0.07 : 0.14) + 0.16 * rand());
    return { x0, z0, side, period: 2.4 + 1.2 * rand(), phase: rand(), depth: 0.05 + 0.04 * rand(), leap: 0.045 + 0.02 * rand(), seed: Math.floor(rand() * 1000) };
  });
}

/**
 * Où est un dauphin à l'instant `t` : (x, z) dans le repère du bateau, `dy` au-dessus de l'eau (négatif : dessous),
 * `pitch` > 0 nez en l'air. `k` : présence (0 = encore loin, en profondeur ; 1 = à l'étrave).
 */
export function dolphinPose(d: DolphinSpec, t: number, k: number, flow: number): { x: number; z: number; dy: number; pitch: number } {
  const cyc = t / d.period + d.phase;
  const u = frac(cyc);
  // chaque respiration est différente : saut franc ou simple dos qui affleure
  const h = d.leap * (0.6 + 0.4 * hash(Math.floor(cyc) + d.seed));
  const jump = (hh: number) => (hh * Math.PI) / (LEAP * d.period);
  let dy: number;
  let vy: number;
  if (u < LEAP) {
    dy = h * Math.sin((Math.PI * u) / LEAP);
    vy = jump(h) * Math.cos((Math.PI * u) / LEAP);
  } else {
    const w = (u - LEAP) / (1 - LEAP);
    dy = -d.depth * Math.sin(Math.PI * w);
    const glide = ((-d.depth * Math.PI) / ((1 - LEAP) * d.period)) * Math.cos(Math.PI * w);
    // le corps pivote en douceur : il entre nez en avant à l'angle de son saut, nage à plat, puis se relève
    // pour le saut suivant
    const next = jump(d.leap * (0.6 + 0.4 * hash(Math.floor(cyc) + 1 + d.seed)));
    vy = w < 0.5 ? -jump(h) + (glide + jump(h)) * smooth(w / 0.3) : glide + (next - glide) * smooth((w - 0.7) / 0.3);
  }
  // ils flânent autour de leur place
  const x = d.x0 + 0.03 * Math.sin(t * 0.37 + d.seed);
  const z = d.z0 + 0.06 * Math.sin(t * 0.23 + d.seed * 1.7) - 0.03 * Math.max(0, dy) / Math.max(h, 1e-6);
  // arrivée et départ : de loin, par le travers arrière, en profondeur
  const e = smooth(k);
  const deep = smooth((k - 0.6) / 0.4);
  return {
    x: d.side * 1.8 + (x - d.side * 1.8) * e,
    z: 1.2 + (z - 1.2) * e,
    dy: -0.25 + (dy + 0.25) * deep,
    pitch: Math.atan2(vy * deep, SWIM + 0.3 * flow),
  };
}

/* ---------- baleine ---------- */

export interface WhaleSpec {
  /** où elle apparaît (repère du bateau) */
  x0: number;
  z0: number;
  heading: number;
  /** nombre de remontées avant de sonder */
  n: number;
  /** secondes entre deux remontées */
  gap: number;
}

const FIRST = 3;
const ROLL = 6;
const DIVE = 9;
/** une baleine à bosse croise à 6 ou 7 nœuds (même échelle accélérée que le bateau) */
const SWIM_WHALE = 0.2;
const TAIL = 0.42;

/**
 * Au large, sur l'avant : 20 à 28 longueurs (360 à 500 m). Elle fait à peu près route comme le bateau, plus
 * lentement : il la rattrape et la voit sonder vers le travers.
 */
export function whaleSpec(rand: () => number): WhaleSpec {
  const d = 20 + 8 * rand();
  const side = rand() < 0.5 ? -1 : 1;
  const b = ((38 + 22 * rand()) * Math.PI) / 180;
  return { x0: side * d * Math.sin(b), z0: -d * Math.cos(b), heading: (rand() - 0.5) * 0.8, n: 3 + Math.floor(rand() * 2), gap: 10 + 2 * rand() };
}

/** Instant du départ : après la dernière plongée. */
export function whaleEnd(w: WhaleSpec): number {
  return FIRST + w.n * w.gap + DIVE + 2;
}

/** Instants des souffles : peu après le début de chaque remontée, quand l'évent sort de l'eau. */
export function whaleBlows(w: WhaleSpec): number[] {
  return Array.from({ length: w.n }, (_, k) => FIRST + k * w.gap + ROLL * (0.2 / 1.1));
}

/**
 * Pose de la baleine : `s` avancée le long de son cap, `dy` hauteur du centre du corps au-dessus de l'eau,
 * `pitch` > 0 nez en l'air, `tail` hauteur du bout de la queue, `blowhole` hauteur de l'évent.
 * Elle roule le dos en arc de cercle à chaque remontée, puis sonde : l'arc se resserre et la queue sort.
 */
export function whalePose(w: WhaleSpec, t: number): { s: number; dy: number; pitch: number; tail: number; blowhole: number } {
  let dy = -0.5;
  let th = 0;
  let arc = 0;
  const dive = FIRST + w.n * w.gap;
  const k = Math.floor((t - FIRST) / w.gap);
  if (t >= dive && t < dive + DIVE) {
    const R = 0.45;
    th = -0.4 + (1.9 * (t - dive)) / DIVE;
    dy = -0.02 - R * (1 - Math.cos(th));
    arc = R * Math.sin(th);
  } else if (t >= FIRST && k < w.n && t - FIRST - k * w.gap < ROLL) {
    const R = 1;
    th = -0.55 + (1.1 * (t - FIRST - k * w.gap)) / ROLL;
    dy = -0.03 - R * (1 - Math.cos(th));
    arc = R * Math.sin(th);
  }
  const pitch = -th;
  return {
    s: SWIM_WHALE * t + arc,
    dy,
    pitch,
    tail: dy - TAIL * Math.sin(pitch),
    blowhole: dy + 0.06 * Math.cos(pitch) + 0.3 * Math.sin(pitch),
  };
}

/* ---------- modèles ---------- */

/** Corps tourné autour de son axe : `profile` (0 = queue, 1 = museau) → rayon ; museau vers -z. */
function lathe(profile: [number, number][], len: number, flat: number, seg: number, color: (s: number, up: number, side: number) => THREE.Color) {
  const pts = profile.map(([s, r]) => new THREE.Vector2(r * len, (s - 0.5) * len));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(-Math.PI / 2);
  g.scale(1, flat, 1);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = 0.5 - pos.getZ(i) / len;
    const r = Math.max(1e-6, Math.hypot(pos.getX(i), pos.getY(i) / flat));
    color(s, pos.getY(i) / flat / r, Math.abs(pos.getX(i)) / r).toArray(col, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Aileron ou nageoire plate : contour (x vers l'arrière, y vers le haut), épaisseur `t`, tourné pour que x → +z. */
function fin(outline: [number, number][], t: number) {
  const sh = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -t / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

const DOLPHIN_LEN = 0.13;
// couleurs en espace linéaire (bien plus sombres qu'elles n'en ont l'air) : dos ardoise, ventre gris clair
const BACK = new THREE.Color(0.03, 0.04, 0.055);
const BELLY = new THREE.Color(0.4, 0.42, 0.43);
const FLANK = new THREE.Color(0.36, 0.27, 0.13);

/** Dauphin commun (le plus fréquent en Atlantique) : dos gris-bleu, ventre clair, sablier ocre sur le flanc. */
function dolphinMesh(mats: { body: THREE.Material; fin: THREE.Material }) {
  const L = DOLPHIN_LEN;
  const body = lathe(
    [[0, 0.012], [0.1, 0.03], [0.25, 0.065], [0.45, 0.1], [0.62, 0.098], [0.75, 0.085], [0.84, 0.07], [0.88, 0.05], [0.9, 0.028], [0.98, 0.016], [1, 0]],
    L,
    1.05,
    14,
    (s, up, side) => {
      const c = BELLY.clone().lerp(BACK, smooth((up + 0.35) / 0.7));
      // le sablier : une tache claire et chaude sur l'avant du flanc
      const patch = smooth((s - 0.45) / 0.15) * smooth((0.86 - s) / 0.12) * clamp01(1 - Math.abs(up + 0.05) * 2.4) * side;
      return c.lerp(FLANK, 0.55 * patch);
    },
  );
  const g = new THREE.Group();
  g.add(new THREE.Mesh(body, mats.body));
  const dorsal = new THREE.Mesh(fin([[-0.05, 0], [0.01, 0.06], [0.07, 0.115], [0.065, 0.09], [0.055, 0.045], [0.09, 0]], 0.012), mats.fin);
  dorsal.scale.setScalar(L);
  dorsal.position.set(0, 0.085 * L, 0.02 * L);
  g.add(dorsal);
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 4), mats.fin);
    p.scale.set(0.07 * L, 0.008 * L, 0.03 * L);
    p.position.set(sx * 0.1 * L, -0.05 * L, -0.15 * L);
    p.rotation.set(0.3, sx * 0.5, sx * -0.5);
    g.add(p);
  }
  // nageoire caudale, battue autour du pédoncule
  const tail = new THREE.Group();
  tail.position.set(0, 0, 0.38 * L);
  const fluke = new THREE.Mesh(fin([[0, 0], [0.08, 0.1], [0.13, 0.11], [0.1, 0.04], [0.12, 0], [0.1, -0.04], [0.13, -0.11], [0.08, -0.1]], 0.01), mats.fin);
  fluke.scale.setScalar(L);
  fluke.rotation.z = Math.PI / 2; // à plat
  tail.add(fluke);
  g.add(tail);
  return { g, tail };
}

const WHALE_LEN = 0.8;

/** Baleine à bosse : longue, sombre, de grandes nageoires pectorales, une queue large au revers blanc. */
function whaleMesh(mats: { body: THREE.Material; fin: THREE.Material; fluke: THREE.Material }) {
  const L = WHALE_LEN;
  const body = lathe(
    [[0, 0.016], [0.1, 0.035], [0.3, 0.085], [0.5, 0.112], [0.65, 0.12], [0.8, 0.105], [0.92, 0.07], [0.97, 0.042], [1, 0]],
    L,
    0.75,
    16,
    (_s, up) => new THREE.Color(0.2, 0.21, 0.22).lerp(new THREE.Color(0.018, 0.02, 0.024), smooth((up + 0.5) / 0.6)),
  );
  const g = new THREE.Group();
  g.add(new THREE.Mesh(body, mats.body));
  const hump = new THREE.Mesh(fin([[-0.04, 0], [0.01, 0.03], [0.05, 0.035], [0.06, 0]], 0.02), mats.fin);
  hump.scale.setScalar(L);
  hump.position.set(0, 0.07, 0.16 * L);
  g.add(hump);
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 5), mats.fin);
    p.scale.set(0.16 * L, 0.012 * L, 0.035 * L);
    p.position.set(sx * 0.15 * L, -0.04, -0.2 * L);
    p.rotation.set(0.2, sx * 0.7, sx * -0.35);
    g.add(p);
  }
  const fg = fin([[0, 0], [0.09, 0.17], [0.13, 0.17], [0.1, 0.02], [0.12, 0], [0.1, -0.02], [0.13, -0.17], [0.09, -0.17]], 0.02);
  // dessus noir, revers blanc (la face +x de la nageoire, une fois couchée, regarde vers le haut)
  const nrm = fg.getAttribute('normal');
  const fc = new Float32Array(nrm.count * 3);
  for (let i = 0; i < nrm.count; i++) (nrm.getX(i) < -0.5 ? new THREE.Color(0.62, 0.63, 0.63) : new THREE.Color(0.02, 0.022, 0.026)).toArray(fc, i * 3);
  fg.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  const fluke = new THREE.Mesh(fg, mats.fluke);
  fluke.scale.setScalar(L);
  fluke.rotation.z = Math.PI / 2;
  fluke.position.set(0, 0, TAIL - 0.02);
  g.add(fluke);
  return g;
}

/* ---------- dans la vue ---------- */

export interface WildlifeInput {
  /** vitesse du bateau (nœuds) et de l'eau qui défile le long de la coque (longueurs / s) */
  spd: number;
  flow: number;
  day: number;
  /** hauteur de l'eau sous un point (repère du bateau) */
  water: (x: number, z: number) => number;
  spray: Spray;
}

export class Wildlife {
  readonly group = new THREE.Group();
  readonly sightings: Sightings;
  private dolphins: { g: THREE.Group; tail: THREE.Group; out: boolean }[] = [];
  private whale: THREE.Group;
  /** la baleine dérive vers l'arrière à mesure que le bateau avance */
  private drift = 0;
  private blown = 0;
  private fluked = false;
  private materials: THREE.Material[] = [];

  constructor(rand: () => number = Math.random) {
    this.sightings = new Sightings(rand);
    // peau mouillée : un peu de brillant, mais pas un miroir du ciel
    const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, envMapIntensity: 0.5 });
    const finMat = new THREE.MeshStandardMaterial({ color: BACK, roughness: 0.42, envMapIntensity: 0.5 });
    const wBody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, envMapIntensity: 0.5 });
    const wFin = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.02, 0.022, 0.026), roughness: 0.55, envMapIntensity: 0.5 });
    // le revers des nageoires de la baleine à bosse est blanc
    const wFluke = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, envMapIntensity: 0.5 });
    this.materials.push(body, finMat, wBody, wFin, wFluke);
    for (let i = 0; i < 6; i++) {
      const d = dolphinMesh({ body, fin: finMat });
      d.g.rotation.order = 'YXZ';
      this.group.add(d.g);
      this.dolphins.push({ g: d.g, tail: d.tail, out: false });
    }
    this.whale = whaleMesh({ body: wBody, fin: wFin, fluke: wFluke });
    this.whale.rotation.order = 'YXZ';
    this.group.add(this.whale);
    // visibles aussi par transparence sous la surface, et depuis la caméra sous l'eau
    this.group.traverse((o) => o.layers.enable(1));
    this.group.visible = false;
  }

  /** Fait venir des dauphins ou une baleine tout de suite (mode test). */
  trigger(kind: Kind): void {
    this.sightings.trigger(kind);
    this.reset();
  }

  private reset() {
    this.drift = 0;
    this.blown = 0;
    this.fluked = false;
    for (const d of this.dolphins) d.out = false;
  }

  step(dt: number, time: number, k: WildlifeInput): void {
    if (this.sightings.step(dt, k.spd, k.day)) this.reset();
    const c = this.sightings.current;
    this.group.visible = !!c;
    if (!c) return;
    const showDolphins = c.kind === 'dolphins';
    this.dolphins.forEach((d, i) => (d.g.visible = showDolphins && i < c.pod.length));
    this.whale.visible = c.kind === 'whale';
    if (showDolphins) this.stepDolphins(c, time, k);
    else this.stepWhale(c, dt, k);
  }

  private stepDolphins(c: Encounter, time: number, k: WildlifeInput) {
    const here = presence(c.t, c.end);
    c.pod.forEach((spec, i) => {
      const d = this.dolphins[i];
      const p = dolphinPose(spec, c.t, here, k.flow);
      const surf = k.water(p.x, p.z);
      // cap : le long de sa vitesse par rapport à l'eau, qui défile vers l'arrière
      const q = dolphinPose(spec, c.t + 0.1, presence(c.t + 0.1, c.end), k.flow);
      const yaw = Math.atan2(-(q.x - p.x) / 0.1, -((q.z - p.z) / 0.1 - Math.max(k.flow, 0.3)));
      d.g.position.set(p.x, surf + p.dy, p.z);
      d.g.rotation.set(p.pitch, yaw, 0.15 * Math.sin(c.t * 0.7 + spec.seed));
      d.tail.rotation.x = 0.35 * Math.sin(time * 2 * Math.PI * 2.2 + spec.seed);
      // éclaboussure à la sortie de l'eau et en y rentrant
      const out = p.dy > 0;
      if (out !== d.out && here > 0.8) k.spray.puff(p.x, surf + 0.005, p.z, { n: out ? 10 : 16, up: 0.25, spread: 0.12, size: 0.02, life: 0.6, mist: 0.2 });
      d.out = out;
    });
  }

  private stepWhale(c: Encounter, dt: number, k: WildlifeInput) {
    const w = c.whale!;
    this.drift += k.flow * dt;
    const p = whalePose(w, c.t);
    const x = w.x0 - Math.sin(w.heading) * p.s;
    const z = w.z0 + this.drift - Math.cos(w.heading) * p.s;
    const surf = k.water(x, z);
    this.whale.position.set(x, surf + p.dy, z);
    this.whale.rotation.set(p.pitch, w.heading, 0);
    // souffle : une colonne de brume de quelques mètres, que le vent couche
    const blows = whaleBlows(w);
    if (this.blown < blows.length && c.t >= blows[this.blown]) {
      this.blown++;
      const head = new THREE.Vector3(0, 0.06, -0.3).applyEuler(this.whale.rotation).add(this.whale.position);
      k.spray.puff(head.x, head.y, head.z, { n: 120, up: 1, spread: 0.06, size: 0.3, life: 3, mist: 0.9, alpha: 0.5 });
    }
    // la queue retombe dans l'eau en sondant
    if (!this.fluked && p.tail > 0.05 && p.pitch < -1.2) {
      this.fluked = true;
      const tail = new THREE.Vector3(0, 0, TAIL).applyEuler(this.whale.rotation).add(this.whale.position);
      k.spray.puff(tail.x, surf + 0.01, tail.z, { n: 40, up: 0.35, spread: 0.2, size: 0.06, life: 1.4, mist: 0.4 });
    }
  }

  dispose(): void {
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const m of this.materials) m.dispose();
  }
}
