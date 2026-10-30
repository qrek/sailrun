import * as THREE from 'three';
import type { SailId } from '../sim/boat';
import { SailChangeState, sailShow } from './sailAnim';

/**
 * IMOCA 60 stylisé mais fidèle : coque lissée par sections (bouchains, étrave droite ou ronde),
 * roof, cockpit, quille pendulaire, safrans, foils profilés, mât aile avec gréement, voiles creusées.
 * Unité : 1 = longueur de coque. L'avant pointe vers -Z, le pont vers +Y, la flottaison est à y = 0.
 */
export interface BoatLook {
  hull: string; // classique | ronde | legere
  foils: string; // derives | c | grands
  mast: string; // classique | aile | grand
  color: string;
  name?: string; // inscrit sur la coque et la grand-voile
  number?: string; // numéro de voile
  /** couleur secondaire (filet, têtière) */
  accent?: string;
  /** motif de la coque */
  pattern?: 'vague' | 'bande' | 'degrade' | 'uni' | 'eclair';
  /** couleur des voiles */
  sail?: 'carbone' | 'gris' | 'blanc';
}

export interface BoatRig {
  root: THREE.Group;
  heel: THREE.Group;
  main: THREE.Group;
  jib: THREE.Group;
  materials: THREE.Material[];
  /** matériaux de chaque équipement, pour la surbrillance au garage */
  parts: Record<'coque' | 'foils' | 'mat', THREE.MeshStandardMaterial[]>;
  /** mât, gréement et voiles, articulés au pied de mât (quête) */
  spar: THREE.Group;
  /** foils (incidence) */
  foilParts: THREE.Object3D[];
  /** géométries partagées avec un modèle importé : ne pas les libérer */
  shared?: boolean;
  /** voiles d'avant du modèle codé (foc, code 0, spi) ; un modèle importé n'a que son `jib` */
  headsails?: Record<SailId, Headsail>;
}

/** Une voile d'avant : la voile elle-même, son boudin roulé le long du câble, et le boudin couché sur le pont. */
export interface Headsail {
  /** pivot au point d'amure ; le bordé tourne autour du guindant */
  pivot: THREE.Group;
  /** direction du guindant (amure → têtière) dans le repère du pivot */
  axis: THREE.Vector3;
  /** longueur du guindant */
  len: number;
  cloth: THREE.Mesh;
  furled: THREE.Mesh;
  deck: THREE.Mesh;
  tackZ: number;
  /** angle de bordé (radians) selon l'angle au vent et l'ouverture de la bôme */
  trim: (a: number, boom: number) => number;
  /** déroule la voile (0 → 1) ; `flap` > 0 : elle fasseye */
  setOpen: (open: number, flap: number, time: number) => void;
}

/** Constructeur alternatif (modèle GLB importé) ; renvoie null pour garder le modèle codé. */
type CustomBuilder = (look: BoatLook, hero: boolean) => BoatRig | null;
let custom: CustomBuilder | null = null;
let customVersion = 0;
export function setCustomBoat(f: CustomBuilder | null) {
  custom = f;
  customVersion++;
}
/** Change quand un modèle importé est chargé : les vues reconstruisent leurs bateaux. */
export const boatModelVersion = () => customVersion;

const MAST_H: Record<string, number> = { classique: 1.06, aile: 1.16, grand: 1.28 };

/* ---------- textures générées ---------- */
const texCache = new Map<string, THREE.CanvasTexture>();

const isLight = (color: string) => {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(hsl);
  return hsl.l > 0.78;
};

/**
 * Coque façon IMOCA moderne : blanc cassé, grande vague aux couleurs du bateau, œuvres vives sombres.
 * `starboard` : tribord, l'avant est à droite de la texture (u = 1) mais le texte reste lisible.
 */
export function hullTexture(color: string, name: string, starboard: boolean, pattern = 'vague', accent2 = '#FFFFFF'): THREE.CanvasTexture {
  const key = `hull:${color}:${name}:${starboard}:${pattern}:${accent2}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d')!;
  // u = longueur (0 = étrave, 1 = tableau arrière), v = hauteur (0 = sous la coque, 1 = liston).
  // Haut du canevas = liston ; la flottaison tombe vers y ≈ 115 : tout ce qui se voit est dans la bande 0–115.
  const WL = 114;
  const light = isLight(color);
  const ink = light ? '#1B2530' : '#FFFFFF';
  g.fillStyle = pattern === 'bande' || pattern === 'eclair' ? (light ? '#1B2530' : '#EEF1F3') : color;
  g.fillRect(0, 0, 1024, 256);
  g.save();
  if (starboard) {
    g.translate(1024, 0);
    g.scale(-1, 1);
  }
  g.fillStyle = color;
  g.strokeStyle = accent2;
  if (pattern === 'bande') {
    // large bande de couleur à mi-franc-bord, filet en dessous
    g.fillRect(0, 22, 1024, 56);
    g.fillStyle = accent2;
    g.fillRect(0, 82, 1024, 7);
  } else if (pattern === 'degrade') {
    // la couleur file de l'étrave vers l'arrière et s'éteint dans le blanc
    const grd = g.createLinearGradient(0, 0, 1024, 0);
    grd.addColorStop(0, light ? '#1B2530' : '#F4F6F8');
    grd.addColorStop(0.18, light ? '#1B2530' : '#F4F6F8');
    grd.addColorStop(0.62, 'rgba(244,246,248,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, WL);
    g.fillStyle = accent2;
    g.fillRect(0, WL - 14, 1024, 5);
  } else if (pattern === 'eclair') {
    g.beginPath();
    g.moveTo(0, 104);
    g.lineTo(0, 64);
    g.lineTo(400, 30);
    g.lineTo(350, 62);
    g.lineTo(1024, 8);
    g.lineTo(1024, 52);
    g.lineTo(580, 84);
    g.lineTo(630, 54);
    g.closePath();
    g.fill();
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(0, 56);
    g.lineTo(410, 22);
    g.stroke();
  } else if (pattern === 'vague') {
    // coque pleine couleur, grand coup de pinceau clair de l'étrave basse vers l'arrière haut
    g.lineCap = 'round';
    g.lineWidth = 16;
    g.beginPath();
    g.moveTo(-20, 98);
    g.bezierCurveTo(260, 96, 520, 40, 1044, 22);
    g.stroke();
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(-20, 80);
    g.bezierCurveTo(260, 78, 520, 24, 1044, 6);
    g.stroke();
  }
  // liston : filet clair sous le pont
  g.fillStyle = accent2;
  g.fillRect(0, 0, 1024, 4);
  // flottaison et œuvres vives
  g.fillStyle = '#12161B';
  g.fillRect(0, WL + 4, 1024, 256 - WL - 4);
  g.fillStyle = accent2;
  g.fillRect(0, WL, 1024, 4);
  g.restore();
  // nom sur l'avant, en grand dans le franc-bord
  g.font = 'italic 800 70px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.fillStyle = pattern === 'bande' ? ink : pattern === 'eclair' ? (light ? '#FFFFFF' : '#1B2530') : pattern === 'degrade' ? (light ? '#FFFFFF' : color) : ink;
  g.textBaseline = 'middle';
  g.textAlign = starboard ? 'right' : 'left';
  g.fillText(name.toUpperCase(), starboard ? 1024 - 70 : 70, pattern === 'bande' ? 50 : 56);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

export const SAIL_CLOTH: Record<string, [string, string]> = { carbone: ['#22262C', '#16191E'], gris: ['#7a828b', '#5f666e'], blanc: ['#eef0ec', '#d9ddd8'] };
let clothNow: [string, string] = SAIL_CLOTH.carbone;

/** Membrane carbone : fond anthracite, coutures, lattes. */
function carbonBase(g: CanvasRenderingContext2D, w: number, h: number) {
  const grd = g.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, clothNow[0]);
  grd.addColorStop(1, clothNow[1]);
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 2;
  for (let i = -12; i < 40; i++) {
    g.beginPath();
    g.moveTo(0, h - i * 50);
    g.quadraticCurveTo(w * 0.45, h - 110 - i * 50, w, h - i * 62);
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.035)';
  for (let i = 0; i < 30; i++) {
    g.beginPath();
    g.moveTo(i * (w / 18), h);
    g.lineTo(w * 0.1 + i * (w / 50), 0);
    g.stroke();
  }
}

/** Grand-voile : carbone noir, nom en grand à la verticale, tête aux couleurs du bateau. */
export function sailTexture(color: string, name: string, number: string, cloth = 'carbone'): THREE.CanvasTexture {
  const key = `sail:${color}:${name}:${number}:${cloth}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 1024;
  const g = c.getContext('2d')!;
  // u = distance au mât rapportée à la corde maxi, v = hauteur (0 = bordure, 1 = têtière)
  clothNow = SAIL_CLOTH[cloth] ?? SAIL_CLOTH.carbone;
  carbonBase(g, 512, 1024);
  // tête de voile aux couleurs du bateau
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(512, 0);
  g.lineTo(512, 140);
  g.lineTo(0, 210);
  g.closePath();
  g.fill();
  // lattes
  g.strokeStyle = 'rgba(210,220,230,0.35)';
  g.lineWidth = 4;
  for (let k = 1; k <= 6; k++) {
    const y = 1024 - (k * 1024) / 7.2;
    g.beginPath();
    g.moveTo(8, y + 4);
    g.lineTo(510, y - 8);
    g.stroke();
  }
  // nom à la verticale le long du guindant, lu de bas en haut
  g.save();
  g.translate(120, 640);
  g.rotate(-Math.PI / 2);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = cloth === 'blanc' ? color : '#FFFFFF';
  let size = 150;
  g.font = `800 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const label = name.toUpperCase();
  while (g.measureText(label).width > 560 && size > 60) {
    size -= 6;
    g.font = `800 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  }
  g.fillText(label, 0, 0);
  g.restore();
  // numéro de voile
  g.fillStyle = color;
  g.font = '800 60px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'left';
  g.fillText(number, 210, 900);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Voile d'avant : carbone noir, bas de voile aux couleurs du bateau. */
export function jibTexture(color: string, cloth = 'carbone'): THREE.CanvasTexture {
  const key = `jib:${color}:${cloth}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  clothNow = SAIL_CLOTH[cloth] ?? SAIL_CLOTH.carbone;
  carbonBase(g, 256, 512);
  g.fillStyle = isLight(color) ? '#DCE3E8' : color;
  g.beginPath();
  g.moveTo(0, 512);
  g.lineTo(0, 440);
  g.quadraticCurveTo(140, 400, 256, 380);
  g.lineTo(256, 512);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(0, 428);
  g.quadraticCurveTo(140, 388, 256, 368);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Code 0 : membrane plus claire que le foc, guindant aux couleurs du bateau, grand « 0 » près de l'écoute. */
export function code0Texture(color: string, cloth = 'carbone'): THREE.CanvasTexture {
  const key = `code0:${color}:${cloth}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  clothNow = SAIL_CLOTH[cloth] ?? SAIL_CLOTH.carbone;
  carbonBase(g, 256, 512);
  // voile légère : la membrane est plus fine, donc plus claire
  g.fillStyle = cloth === 'blanc' ? 'rgba(200,214,226,0.25)' : 'rgba(255,255,255,0.13)';
  g.fillRect(0, 0, 256, 512);
  // u = 0 au guindant (à gauche), v = 0 à la bordure (en bas)
  g.fillStyle = isLight(color) ? '#DCE3E8' : color;
  g.fillRect(0, 0, 30, 512);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(36, 0);
  g.lineTo(36, 512);
  g.stroke();
  g.fillStyle = cloth === 'blanc' ? 'rgba(30,40,50,0.22)' : 'rgba(255,255,255,0.22)';
  g.font = '800 150px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center';
  g.fillText('0', 150, 470);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Spi : grande voile légère aux couleurs du bateau, panneaux en éventail depuis le point d'amure, têtière claire. */
export function spiTexture(color: string, accent = '#FFFFFF'): THREE.CanvasTexture {
  const base = isLight(color) ? (accent && !isLight(accent) ? accent : '#2563c9') : color;
  const key = `spi:${base}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 512, 256, 0);
  grd.addColorStop(0, base);
  grd.addColorStop(1, `#${new THREE.Color(base).lerp(new THREE.Color('#ffffff'), 0.22).getHexString()}`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 512);
  // panneaux en éventail, un sur deux un peu plus sombre
  for (let k = 0; k < 10; k++) {
    if (k % 2) continue;
    const a0 = (k / 10) * (Math.PI / 2);
    const a1 = ((k + 1) / 10) * (Math.PI / 2);
    g.fillStyle = 'rgba(0,0,0,0.09)';
    g.beginPath();
    g.moveTo(0, 512);
    g.lineTo(Math.cos(a0) * 900, 512 - Math.sin(a0) * 900);
    g.lineTo(Math.cos(a1) * 900, 512 - Math.sin(a1) * 900);
    g.closePath();
    g.fill();
  }
  // têtière claire et bande de bordure
  g.fillStyle = '#F4F6F8';
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(256, 0);
  g.lineTo(256, 40);
  g.quadraticCurveTo(120, 110, 0, 96);
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(0, 488, 256, 10);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Copie miroir horizontale d'une texture de canvas (pour l'autre bord). */
export function mirrored(t: THREE.CanvasTexture): THREE.CanvasTexture {
  const key = `mirror:${t.uuid}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const src = t.image as HTMLCanvasElement;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d')!;
  g.translate(c.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  const m = new THREE.CanvasTexture(c);
  m.colorSpace = THREE.SRGBColorSpace;
  m.anisotropy = 4;
  texCache.set(key, m);
  return m;
}

/* ---------- coque lissée par sections ---------- */
interface Station {
  z: number; // position longitudinale (-0.5 étrave → +0.5 tableau)
  b: number; // demi-largeur au livet
  d: number; // hauteur du pont au livet
  k: number; // tirant d'eau de la coque
  c: number; // hauteur du bouchain (0 = pas de bouchain)
}

function stations(kind: string, N = 28): Station[] {
  const out: Station[] = [];
  const beamMax = kind === 'legere' ? 0.142 : kind === 'ronde' ? 0.165 : 0.158;
  for (let i = 0; i <= N; i++) {
    const t = i / N; // 0 étrave → 1 tableau
    let b: number;
    if (kind === 'ronde') {
      // étrave « scow » : avant large et arrondi
      b = beamMax * (0.46 + 0.54 * Math.sin(Math.min(1, t / 0.7) * Math.PI * 0.5));
      if (t < 0.06) b *= 0.55 + (0.45 * t) / 0.06;
    } else {
      b = beamMax * Math.pow(Math.sin(Math.min(1, t / 0.72) * Math.PI * 0.5), kind === 'legere' ? 0.8 : 0.72);
      b = Math.max(b, 0.004);
    }
    if (t > 0.72) b = beamMax * (1 - 0.06 * ((t - 0.72) / 0.28));
    const d = 0.078 + 0.034 * Math.pow(1 - t, 2.2); // tonture : avant plus haut
    const k = 0.052 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.62) * (1 - 0.55 * t) + 0.004;
    const c = t < 0.35 ? 0 : Math.min(1, (t - 0.35) / 0.25);
    out.push({ z: -0.5 + t, b, d, k, c });
  }
  return out;
}

/** Demi-section : du fond (axe) au livet. Retourne [x, y] pour s ∈ [0, 1]. */
function section(st: Station, s: number): [number, number] {
  // fond arrondi, bouchain marqué à l'arrière, flanc légèrement évasé
  const chineY = 0.012;
  const chineX = st.b * (0.78 + 0.1 * st.c);
  if (s < 0.55) {
    const u = s / 0.55;
    const round = Math.sin((u * Math.PI) / 2);
    const x = chineX * (st.c * u + (1 - st.c) * round);
    const yFlat = -st.k * (1 - u * u);
    const yRound = -st.k * Math.cos((u * Math.PI) / 2);
    const y = st.c * yFlat + (1 - st.c) * yRound + chineY * u * u;
    return [x, y];
  }
  const u = (s - 0.55) / 0.45;
  const x = chineX + (st.b - chineX) * Math.sin((u * Math.PI) / 2);
  const y = chineY + (st.d - chineY) * u;
  return [x, y];
}

function buildHull(kind: string, port: THREE.Material, starboard: THREE.Material, hero = false): THREE.Mesh {
  const st = stations(kind, hero ? 64 : 28);
  const M = hero ? 26 : 14; // points par demi-section
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let side = -1; side <= 1; side += 2) {
    const base = pos.length / 3;
    for (let i = 0; i < st.length; i++) {
      for (let j = 0; j <= M; j++) {
        const [x, y] = section(st[i], j / M);
        pos.push(side * x, y, st[i].z);
        const u = i / (st.length - 1);
        uv.push(side > 0 ? 1 - u : u, j / M);
      }
    }
    for (let i = 0; i < st.length - 1; i++) {
      for (let j = 0; j < M; j++) {
        const a = base + i * (M + 1) + j;
        const b = a + M + 1;
        if (side > 0) idx.push(a, a + 1, b, b, a + 1, b + 1);
        else idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const half = idx.length / 2;
  g.addGroup(0, half, 0);
  g.addGroup(half, half, 1);
  return new THREE.Mesh(g, [port, starboard]);
}

/** Pont bombé qui ferme la coque. */
function buildDeck(kind: string, mat: THREE.Material, hero = false): THREE.Mesh {
  const st = stations(kind, hero ? 64 : 28);
  const M = hero ? 16 : 10;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < st.length; i++) {
    for (let j = 0; j <= M; j++) {
      const s = j / M; // -1..1 en travers
      const xx = (s * 2 - 1) * st[i].b * 0.995;
      const camber = 0.012 * (1 - (s * 2 - 1) ** 2) * Math.min(1, st[i].b / 0.08);
      pos.push(xx, st[i].d + camber, st[i].z);
      uv.push(xx * 6, st[i].z * 6);
    }
  }
  for (let i = 0; i < st.length - 1; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * (M + 1) + j;
      const b = a + M + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // tableau arrière
  const last = st[st.length - 1];
  const tb = pos.length / 3;
  const P = 14;
  for (let j = 0; j <= P; j++) {
    const [x, y] = section(last, j / P);
    pos.push(-x, y, last.z, x, y, last.z);
    uv.push(-x * 6, y * 6, x * 6, y * 6);
  }
  for (let j = 0; j < P; j++) {
    const a = tb + j * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/* ---------- détails « héros » (garage et vue immersive) ---------- */

/** Pont antidérapant : grain fin gris, sert aussi de relief. */
function nonSkidTexture(): THREE.CanvasTexture {
  const hit = texCache.get('nonskid');
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#7a7a7a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 14000; i++) {
    const v = 90 + Math.floor(Math.random() * 90);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  texCache.set('nonskid', t);
  return t;
}

/** Tissu de carbone : petit damier sergé, pour les pièces vues de près. */
function carbonTexture(): THREE.CanvasTexture {
  const hit = texCache.get('carbon');
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const on = (x + y) % 2 === 0;
      const grd = on ? g.createLinearGradient(x * 8, 0, x * 8 + 8, 0) : g.createLinearGradient(0, y * 8, 0, y * 8 + 8);
      grd.addColorStop(0, '#1a1f26');
      grd.addColorStop(0.5, '#3a434f');
      grd.addColorStop(1, '#1a1f26');
      g.fillStyle = grd;
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set('carbon', t);
  return t;
}

/** Tige (câble, tube) entre deux points. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, seg = 6): THREE.Mesh {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1, true);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

/** Profil d'aile symétrique (NACA 00xx) pour quille, safrans, foils. */
function airfoilShape(chord: number, thick: number): THREE.Shape {
  const sh = new THREE.Shape();
  const N = 16;
  const pts: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const x = (1 - Math.cos((i / N) * Math.PI)) / 2;
    const yt = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    pts.push([x, yt]);
  }
  sh.moveTo(-chord / 2, 0);
  for (const [x, y] of pts) sh.lineTo(x * chord - chord / 2, y * chord);
  for (let i = pts.length - 1; i >= 0; i--) sh.lineTo(pts[i][0] * chord - chord / 2, -pts[i][1] * chord);
  return sh;
}

/** Lame profilée verticale (quille, safran) : corde selon z, épaisseur selon x, de y0 à y1. */
function blade(chord: number, thick: number, y0: number, y1: number, mat: THREE.Material, taper = 0.8): THREE.Mesh {
  const g = new THREE.ExtrudeGeometry(airfoilShape(chord, thick), { depth: y1 - y0, bevelEnabled: false, steps: 1, curveSegments: 4 });
  // l'extrusion part selon +z : on la couche à la verticale, corde le long de z
  g.rotateX(Math.PI / 2);
  g.rotateY(-Math.PI / 2); // bord d'attaque vers l'avant (-z)
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < p.count; k++) {
    // effilement vers le bas
    const t = (p.getY(k) - 0) / -(y1 - y0);
    const f = 1 - (1 - taper) * Math.max(0, Math.min(1, t));
    p.setXYZ(k, p.getX(k) * f, p.getY(k), p.getZ(k) * f);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.position.y = y1;
  return m;
}

/** Winch : embase, tambour, poupée. */
function winchGeo(r: number): THREE.LatheGeometry {
  const pts = [
    [0, 0],
    [r * 1.25, 0],
    [r * 1.25, r * 0.25],
    [r * 0.95, r * 0.35],
    [r * 0.85, r * 1.1],
    [r * 1.0, r * 1.25],
    [r * 0.7, r * 1.45],
    [r * 0.55, r * 1.75],
    [0, r * 1.8],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 18);
}

/** Liston, chandeliers, filières, balcons, winchs, colonne de moulin, rail d'écoute, capot. */
function addDeckGear(parent: THREE.Object3D, kind: string, steel: THREE.Material, alu: THREE.Material, carbon: THREE.Material, deck: THREE.Material, glass: THREE.Material) {
  const st = stations(kind, 64);
  const at = (z: number) => {
    const t = Math.min(1, Math.max(0, z + 0.5)) * (st.length - 1);
    const i = Math.min(st.length - 2, Math.floor(t));
    const f = t - i;
    return { b: st[i].b + (st[i + 1].b - st[i].b) * f, d: st[i].d + (st[i + 1].d - st[i].d) * f };
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // liston le long du livet
  for (const sx of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let z = -0.485; z <= 0.5; z += 0.02) {
      const s = at(z);
      pts.push(V(sx * s.b * 0.985, s.d + 0.003, z));
    }
    parent.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.0028, 6), carbon));
  }
  // chandeliers et deux rangs de filières (en textile : fins et sombres)
  const posts: number[] = [-0.36, -0.24, -0.12, 0.0, 0.12, 0.24, 0.36];
  const H1 = 0.022;
  const H2 = 0.04;
  for (const sx of [-1, 1]) {
    const tops: THREE.Vector3[] = [];
    const mids: THREE.Vector3[] = [];
    for (const z of posts) {
      const s = at(z);
      const base = V(sx * s.b * 0.93, s.d, z);
      const top = V(sx * s.b * 0.96, s.d + H2, z);
      parent.add(rod(base, top, 0.0014, steel, 5));
      tops.push(top);
      mids.push(V(sx * s.b * 0.95, s.d + H1, z));
    }
    // balcons avant et arrière : arceaux tubulaires
    const fz = -0.43;
    const fs = at(fz);
    const bowRail = [V(sx * fs.b * 0.8, fs.d + H2, fz), V(sx * 0.012, fs.d + H2 + 0.004, -0.475), V(0, fs.d + H2 + 0.004, -0.482)];
    parent.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bowRail), 10, 0.0016, 5), steel));
    parent.add(rod(V(sx * fs.b * 0.78, fs.d, fz), bowRail[0], 0.0016, steel, 5));
    const az = 0.47;
    const as = at(az);
    const sternRail = [V(sx * as.b * 0.95, as.d + H2, az - 0.03), V(sx * as.b * 0.9, as.d + H2, az + 0.02)];
    parent.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sternRail), 6, 0.0016, 5), steel));
    parent.add(rod(V(sx * as.b * 0.9, as.d, az + 0.02), sternRail[1], 0.0016, steel, 5));
    tops.unshift(bowRail[0]);
    tops.push(sternRail[0]);
    for (const row of [tops, mids]) {
      for (let k = 0; k < row.length - 1; k++) parent.add(rod(row[k], row[k + 1], 0.0008, alu, 4));
    }
  }
  // winchs : piano, cockpit, colonne de moulin
  const wg = winchGeo(0.0105);
  const winch = (x: number, z: number, y: number) => {
    const w = new THREE.Mesh(wg, steel);
    w.position.set(x, y, z);
    parent.add(w);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.004, 10), alu);
    cap.position.set(x, y + 0.02, z);
    parent.add(cap);
  };
  for (const sx of [-1, 1]) {
    winch(sx * 0.098, 0.2, 0.097);
    winch(sx * 0.098, 0.3, 0.096);
    winch(sx * 0.055, 0.135, 0.13);
    winch(sx * 0.03, -0.035, 0.1);
  }
  // colonne de moulin à café au milieu du cockpit
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.045, 12), alu);
  pedestal.position.set(0, 0.105, 0.24);
  parent.add(pedestal);
  for (const sx of [-1, 1]) {
    parent.add(rod(V(0, 0.126, 0.24), V(sx * 0.022, 0.13, 0.24), 0.0015, steel, 5));
    parent.add(rod(V(sx * 0.022, 0.13, 0.24), V(sx * 0.022, 0.142, 0.24), 0.002, alu, 6));
  }
  // rail d'écoute de grand-voile en travers du cockpit, avec son chariot
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.004, 0.008), alu);
  rail.position.set(0, 0.092, 0.37);
  parent.add(rail);
  const car = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.008, 0.012), steel);
  car.position.set(0, 0.096, 0.37);
  parent.add(car);
  // capot de pont avant et hublots de roof
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.005, 0.05), glass);
  hatch.position.set(0, at(-0.28).d + 0.013, -0.28);
  parent.add(hatch);
  const hatchFrame = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.006, 0.056), deck);
  hatchFrame.position.set(0, at(-0.28).d + 0.009, -0.28);
  parent.add(hatchFrame);
  // hydrogénérateurs sur le tableau arrière
  for (const sx of [-1, 1]) {
    parent.add(rod(V(sx * 0.11, 0.085, 0.5), V(sx * 0.115, -0.02, 0.56), 0.003, alu, 6));
    const prop = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.02, 8), alu);
    prop.rotation.x = Math.PI / 2;
    prop.position.set(sx * 0.115, -0.022, 0.565);
    parent.add(prop);
  }
}

/* ---------- voiles creusées ---------- */
interface SailSpec {
  luff: (v: number) => THREE.Vector3;
  chord: (v: number) => number;
  draft: number;
  roach: number;
  twist: number;
  NU: number;
  NV: number;
  proportional: boolean;
  /** forme du guindant une fois la voile déroulée (voiles volantes : il se creuse) */
  bow?: (v: number) => THREE.Vector3;
}

/**
 * Sommets d'une voile creusée. `open` < 1 : la voile est en partie roulée sur son guindant
 * (la corde raccourcit, le point d'écoute revient vers le câble) ; `flap` : elle fasseye.
 */
function sailVerts(sp: SailSpec, pos: Float32Array, open = 1, flap = 0, phase = 0) {
  const { NU, NV } = sp;
  const p0 = new THREE.Vector3();
  let n = 0;
  for (let j = 0; j <= NV; j++) {
    const v = j / NV;
    p0.copy(sp.luff(v));
    if (sp.bow) p0.addScaledVector(sp.bow(v), open);
    const full = sp.chord(v) * (1 + sp.roach * Math.sin(v * Math.PI));
    const ch = full * open;
    // vrillage : le haut de la voile s'ouvre (la corde tourne autour du guindant)
    const tw = sp.twist * v;
    const cx = Math.sin(tw);
    const cz = Math.cos(tw);
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      // creux maximal vers 40 % de la corde, côté +x (trimBoat le passe sous le vent)
      let camber = sp.draft * ch * 4 * u * (1 - u) * (1 - 0.35 * u);
      if (flap) camber += flap * full * 0.045 * Math.sin(u * Math.PI) * Math.sin(u * 11 + v * 7 - phase * 9);
      pos[n++] = p0.x + camber * cz + u * ch * cx;
      pos[n++] = p0.y;
      pos[n++] = p0.z + u * ch * cz - camber * cx;
    }
  }
}

function sailGeometry(sp: SailSpec): THREE.BufferGeometry {
  const { NU, NV } = sp;
  let chMax = 0;
  for (let j = 0; j <= NV; j++) chMax = Math.max(chMax, sp.chord(j / NV) * (1 + sp.roach * Math.sin((j / NV) * Math.PI)));
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= NV; j++) {
    const v = j / NV;
    const ch = sp.chord(v) * (1 + sp.roach * Math.sin(v * Math.PI));
    for (let i = 0; i <= NU; i++) uv.push(sp.proportional ? ((i / NU) * ch) / chMax : i / NU, v);
  }
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i;
      const b = a + NU + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const pos = new Float32Array((NU + 1) * (NV + 1) * 3);
  sailVerts(sp, pos);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function sailMesh(luff: (v: number) => THREE.Vector3, chord: (v: number) => number, draft: number, mat: THREE.Material, roach = 0, back?: THREE.Material, proportional = false, hero = false, twist = 0): THREE.Object3D {
  const g = sailGeometry({ luff, chord, draft, roach, twist, NU: hero ? 22 : 10, NV: hero ? 40 : 16, proportional });
  if (!back) return new THREE.Mesh(g, mat);
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(g, mat), new THREE.Mesh(g, back));
  return grp;
}

/** Le boudin couché sur le pont sort de l'écoutille avant, ici. */
const DECK_FROM = -0.34;
const DECK_LEN = 0.24;
const DECK_Y = 0.124; // le pont avant est à ~0,112 sur l'axe, plus le rayon du boudin

/** Voile d'avant volante : guindant de l'amure à la têtière, boudins pour les manœuvres. */
function headsail(o: {
  tack: THREE.Vector3;
  head: THREE.Vector3;
  chord: (v: number) => number;
  draft: number;
  roach?: number;
  twist: number;
  bow?: (v: number) => THREE.Vector3;
  mat: THREE.Material;
  roll: THREE.Material;
  trim: Headsail['trim'];
  hero: boolean;
}): Headsail {
  const pivot = new THREE.Group();
  pivot.position.copy(o.tack);
  const d = o.head.clone().sub(o.tack);
  const len = d.length();
  const axis = d.clone().normalize();
  const sp: SailSpec = { luff: (v) => d.clone().multiplyScalar(v), chord: o.chord, draft: o.draft, roach: o.roach ?? 0, twist: o.hero ? o.twist : 0, NU: o.hero ? 22 : 10, NV: o.hero ? 40 : 16, proportional: false, bow: o.bow };
  const geo = sailGeometry(sp);
  const cloth = new THREE.Mesh(geo, o.mat);
  pivot.add(cloth);
  // boudin roulé autour du câble : un cylindre de hauteur 1 posé sur l'amure, étiré le long du guindant
  const k = o.hero ? 1 : 1.4;
  const fg = new THREE.CylinderGeometry(0.0035 * k, 0.0075 * k, 1, o.hero ? 10 : 6);
  fg.translate(0, 0.5, 0);
  const furled = new THREE.Mesh(fg, o.roll);
  furled.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  furled.visible = false;
  pivot.add(furled);
  // boudin couché sur le pont : son avant au point d'amure, il s'étire vers l'arrière
  const dg = new THREE.CylinderGeometry(0.011 * k, 0.011 * k, 1, o.hero ? 10 : 6);
  dg.rotateX(Math.PI / 2);
  dg.translate(0, 0, 0.5);
  const deck = new THREE.Mesh(dg, o.roll);
  deck.position.set(0, DECK_Y, o.tack.z);
  deck.visible = false;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  let open = 1;
  let flapping = false;
  const setOpen = (k: number, flap: number, time: number) => {
    if (k === open && !flap && !flapping) return;
    open = k;
    flapping = flap > 0;
    sailVerts(sp, pos.array as Float32Array, Math.max(0.002, k), flap, time);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  };
  return { pivot, axis, len, cloth, furled, deck, tackZ: o.tack.z, trim: o.trim, setOpen };
}

function foilMesh(points: [number, number, number][], thick: number, chordLen: number, mat: THREE.Material): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, thick, chordLen, 0, Math.PI * 2, false, 0);
  const g = new THREE.ExtrudeGeometry(shape, { steps: 64, bevelEnabled: false, extrudePath: curve, curveSegments: 14 });
  return new THREE.Mesh(g, mat);
}

function lineSegs(pts: number[], mat: THREE.LineBasicMaterial): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, mat);
}

export function buildBoat(look: BoatLook, hero = false, allowCustom = hero): BoatRig {
  if (allowCustom && custom) {
    const r = custom(look, hero);
    if (r) return r;
  }
  const root = new THREE.Group();
  const heel = new THREE.Group();
  root.add(heel);
  const name = look.name ?? 'SAIL RUN';
  const number = look.number ?? 'FRA 60';

  const hullMat = new THREE.MeshPhysicalMaterial({ map: hullTexture(look.color, name, false, look.pattern, look.accent), roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 });
  const hullMatSb = new THREE.MeshPhysicalMaterial({ map: hullTexture(look.color, name, true, look.pattern, look.accent), roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 });
  const deckMat = hero
    ? new THREE.MeshStandardMaterial({ color: 0x59626d, roughness: 0.92, map: nonSkidTexture(), bumpMap: nonSkidTexture(), bumpScale: 0.6 })
    : new THREE.MeshStandardMaterial({ color: 0x4a535e, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.5 });
  const carbon = hero
    ? new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: carbonTexture(), roughness: 0.35, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08 })
    : new THREE.MeshStandardMaterial({ color: 0x1b2129, roughness: 0.38, metalness: 0.2 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9d1d9, roughness: 0.22, metalness: 1 });
  const blackAlu = new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.3, metalness: 0.8 });
  const cable = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.45, metalness: 0.3 });
  const foilMat = carbon.clone();
  const mastMat = carbon.clone();
  const darkGlass = new THREE.MeshPhysicalMaterial({ color: 0x0b1118, roughness: 0.08, metalness: 0.3, clearcoat: 1 });
  const sailTex = sailTexture(look.accent && look.accent !== '#FFFFFF' ? look.accent : look.color, name, number, look.sail);
  const sailMat = new THREE.MeshStandardMaterial({ map: sailTex, roughness: 0.55, side: THREE.FrontSide });
  const sailBack = new THREE.MeshStandardMaterial({ map: mirrored(sailTex), roughness: 0.55, side: THREE.BackSide });
  const jibMat = new THREE.MeshStandardMaterial({ map: jibTexture(look.color, look.sail), roughness: 0.6, side: THREE.DoubleSide });
  const rigMat = new THREE.LineBasicMaterial({ color: 0x2b3440, transparent: true, opacity: 0.85 });
  const accent = new THREE.MeshStandardMaterial({ color: look.color, roughness: 0.4 });
  const materials: THREE.Material[] = [foilMat, mastMat, hullMat, hullMatSb, sailBack, roofMat, deckMat, carbon, darkGlass, sailMat, jibMat, rigMat, accent, steel, blackAlu, cable];

  heel.add(buildHull(look.hull, hullMat, hullMatSb, hero));
  const deck = buildDeck(look.hull, deckMat, hero);
  heel.add(deck);

  // roof avec vitrages
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-0.16, 0);
  roofShape.lineTo(0.1, 0);
  roofShape.lineTo(0.1, 0.03);
  roofShape.quadraticCurveTo(-0.02, 0.05, -0.16, 0.012);
  roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 0.13, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 });
  roofGeo.translate(0, 0, -0.065);
  roofGeo.rotateY(Math.PI / 2);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(0, 0.084, 0.04);
  heel.add(roof);
  const windows = new THREE.Mesh(new THREE.BoxGeometry(0.138, 0.012, 0.2), darkGlass);
  windows.position.set(0, 0.109, 0.03);
  windows.rotation.x = -0.12;
  heel.add(windows);

  // cockpit : creux sombre + hiloires
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.006, 0.17), carbon);
  cockpit.position.set(0, 0.08, 0.27);
  heel.add(cockpit);
  for (const sx of [-1, 1]) {
    const coaming = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.2), deckMat);
    coaming.position.set(sx * 0.09, 0.089, 0.27);
    heel.add(coaming);
  }
  // portique arrière avec panneaux solaires
  const arch = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.006, 0.04), darkGlass);
  arch.position.set(0, 0.145, 0.43);
  heel.add(arch);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 6), carbon);
    leg.position.set(sx * 0.12, 0.11, 0.43);
    heel.add(leg);
  }

  // beaupré
  const sprit = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.16, 8), carbon);
  sprit.rotation.x = Math.PI / 2;
  sprit.position.set(0, 0.105, -0.56);
  heel.add(sprit);

  // quille pendulaire et bulbe
  if (hero) {
    const fin = blade(0.075, 0.12, -0.44, -0.02, carbon, 0.75);
    fin.position.z = -0.02;
    heel.add(fin);
  } else {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.42, 0.06), carbon);
    fin.position.set(0, -0.23, -0.02);
    heel.add(fin);
  }
  const bulbPts: THREE.Vector2[] = [];
  const BN = hero ? 28 : 12;
  for (let i = 0; i <= BN; i++) {
    const t = i / BN;
    bulbPts.push(new THREE.Vector2(0.03 * Math.sin(Math.PI * Math.pow(t, 0.8)), (t - 0.5) * (hero ? 0.24 : 0.2)));
  }
  const bulb = new THREE.Mesh(new THREE.LatheGeometry(bulbPts, hero ? 32 : 16), hero ? blackAlu : carbon);
  bulb.rotation.x = Math.PI / 2;
  bulb.position.set(0, -0.44, 0.0);
  heel.add(bulb);

  // safrans jumeaux
  for (const sx of [-0.1, 0.1]) {
    if (hero) {
      const rud = blade(0.055, 0.1, -0.19, 0.03, carbon, 0.7);
      rud.position.x = sx;
      rud.position.z = 0.47;
      rud.rotation.x = 0.12;
      rud.rotation.z = sx > 0 ? -0.1 : 0.1;
      heel.add(rud);
    } else {
      const rud = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.2, 0.05), carbon);
      rud.position.set(sx, -0.08, 0.47);
      heel.add(rud);
    }
  }

  // appendices
  const f0 = heel.children.length;
  for (const side of [-1, 1]) {
    if (look.foils === 'derives') {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.26, 0.045), foilMat);
      board.position.set(side * 0.12, -0.13, -0.1);
      board.rotation.z = side * 0.08;
      heel.add(board);
    } else if (look.foils === 'c') {
      heel.add(foilMesh([[side * 0.14, 0.04, -0.1], [side * 0.22, 0.02, -0.1], [side * 0.28, -0.06, -0.1], [side * 0.27, -0.16, -0.1], [side * 0.19, -0.23, -0.1]], 0.006, 0.026, foilMat));
    } else {
      heel.add(foilMesh([[side * 0.15, 0.04, -0.12], [side * 0.3, 0.035, -0.12], [side * 0.42, -0.02, -0.12], [side * 0.45, -0.18, -0.12], [side * 0.43, -0.3, -0.12], [side * 0.26, -0.33, -0.12]], 0.007, 0.032, foilMat));
    }
  }

  const foilParts = heel.children.slice(f0);
  if (hero) addDeckGear(heel, look.hull, steel, blackAlu, carbon, deckMat, darkGlass);

  // mât
  const s0 = heel.children.length;
  const mh = MAST_H[look.mast] ?? 1.16;
  const wing = look.mast !== 'classique';
  const mastShape = new THREE.Shape();
  mastShape.absellipse(0, 0, wing ? 0.008 : 0.007, wing ? 0.02 : 0.009, 0, Math.PI * 2, false, 0);
  const mastGeo = new THREE.ExtrudeGeometry(mastShape, { depth: mh, bevelEnabled: false, curveSegments: hero ? 24 : 10 });
  mastGeo.rotateX(-Math.PI / 2);
  const mast = new THREE.Mesh(mastGeo, mastMat);
  const mastZ = -0.08;
  mast.position.set(0, 0.085, mastZ);
  heel.add(mast);
  const mastTop = 0.085 + mh;
  if (hero) {
    // tête de mât : potence, girouette-anémomètre
    const crane = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.006, 0.05), carbon);
    crane.position.set(0, mastTop + 0.002, mastZ - 0.02);
    heel.add(crane);
    heel.add(rod(new THREE.Vector3(0, mastTop, mastZ), new THREE.Vector3(0, mastTop + 0.05, mastZ - 0.01), 0.0015, blackAlu));
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.012, 0.028), blackAlu);
    vane.position.set(0, mastTop + 0.052, mastZ + 0.002);
    heel.add(vane);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const cup = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), blackAlu);
      cup.position.set(Math.cos(a) * 0.012, mastTop + 0.06, mastZ - 0.01 + Math.sin(a) * 0.012);
      heel.add(cup);
    }
    // rail de grand-voile le long du mât
    const track = new THREE.Mesh(new THREE.BoxGeometry(0.004, mh * 0.95, 0.004), blackAlu);
    track.position.set(0, 0.085 + mh * 0.5, mastZ + (wing ? 0.02 : 0.009));
    heel.add(track);
  }

  // barres de flèche (déflecteurs) et haubans
  const rig: number[] = [];
  const spreaders = [0.42, 0.72];
  for (const f of spreaders) {
    const y = 0.07 + mh * f;
    const span = 0.17 * (1 - f * 0.45);
    const sp = new THREE.Mesh(new THREE.BoxGeometry(span * 2, 0.006, 0.014), mastMat);
    sp.position.set(0, y, mastZ + 0.01);
    heel.add(sp);
  }
  for (const sx of [-1, 1]) {
    const y1 = 0.07 + mh * spreaders[0];
    const y2 = 0.07 + mh * spreaders[1];
    const s1 = 0.17 * (1 - spreaders[0] * 0.45);
    const s2 = 0.17 * (1 - spreaders[1] * 0.45);
    rig.push(sx * 0.15, 0.072, mastZ + 0.02, sx * s1, y1, mastZ + 0.01);
    rig.push(sx * s1, y1, mastZ + 0.01, sx * s2, y2, mastZ + 0.01);
    rig.push(sx * s2, y2, mastZ + 0.01, 0, mastTop - 0.03, mastZ);
    // bastaques
    rig.push(sx * 0.14, 0.07, 0.42, 0, mastTop - 0.08, mastZ + 0.01);
  }
  // étai et étai de trinquette
  rig.push(0, mastTop - 0.02, mastZ - 0.01, 0, 0.09, -0.62);
  rig.push(0, 0.07 + mh * 0.8, mastZ - 0.01, 0, 0.116, -0.49);
  if (hero) {
    for (let k = 0; k < rig.length; k += 6) {
      heel.add(rod(new THREE.Vector3(rig[k], rig[k + 1], rig[k + 2]), new THREE.Vector3(rig[k + 3], rig[k + 4], rig[k + 5]), 0.0016, cable));
    }
  } else {
    heel.add(lineSegs(rig, rigMat));
  }

  // grand-voile : guindant sur le mât, rond de chute, lattes
  const main = new THREE.Group();
  main.position.set(0, 0, mastZ + 0.02);
  heel.add(main);
  const mainFoot = 0.11;
  const mainHead = mastTop - 0.03;
  const mainChord = (v: number) => 0.5 * (1 - v) + 0.09 * v;
  const mainLuff = (v: number) => new THREE.Vector3(0, mainFoot + (mainHead - mainFoot) * v, 0);
  main.add(sailMesh(mainLuff, mainChord, 0.11, sailMat, 0.18, sailBack, true, hero, hero ? 0.22 : 0));
  if (hero) {
    // lattes : de petits tubes qui suivent le creux et le vrillage de la voile
    for (const v of [0.14, 0.3, 0.46, 0.62, 0.78, 0.92]) {
      const p0 = mainLuff(v);
      const ch = mainChord(v) * (1 + 0.18 * Math.sin(v * Math.PI));
      const tw = 0.22 * v;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const u = 0.04 + (i / 10) * 0.94;
        const camber = 0.11 * ch * 4 * u * (1 - u) * (1 - 0.35 * u) + 0.0025;
        pts.push(new THREE.Vector3(p0.x + camber * Math.cos(tw) + u * ch * Math.sin(tw), p0.y, p0.z + u * ch * Math.cos(tw) - camber * Math.sin(tw)));
      }
      main.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0022, 5), carbon));
    }
  }
  if (hero) {
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.009, 0.5, 14), carbon);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, mainFoot - 0.012, 0.25);
    main.add(boom);
    // hale-bas
    main.add(rod(new THREE.Vector3(0, mainFoot - 0.012, 0.09), new THREE.Vector3(0, 0.1, 0.012), 0.003, carbon));
  } else {
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.5), carbon);
    boom.position.set(0, mainFoot - 0.01, 0.25);
    main.add(boom);
  }

  // voiles d'avant : le foc à l'étrave, plat ; le code 0 et le spi au bout du bout-dehors, en tête de mât
  const cloth = SAIL_CLOTH[look.sail ?? 'carbone'] ?? SAIL_CLOTH.carbone;
  const code0Mat = new THREE.MeshStandardMaterial({ map: code0Texture(look.color, look.sail), roughness: 0.55, side: THREE.DoubleSide });
  const spiMat = new THREE.MeshStandardMaterial({ map: spiTexture(look.color, look.accent), roughness: 0.7, side: THREE.DoubleSide });
  const rollMat = new THREE.MeshStandardMaterial({ color: cloth[0], roughness: 0.7 });
  const rollSpi = new THREE.MeshStandardMaterial({ color: new THREE.Color(isLight(look.color) ? '#2563c9' : look.color).multiplyScalar(0.8), roughness: 0.75 });
  materials.push(code0Mat, spiMat, rollMat, rollSpi);
  const spritTip = new THREE.Vector3(0, 0.106, -0.635);
  const top = new THREE.Vector3(0, mastTop - 0.025, mastZ - 0.012);
  const headsails: Record<SailId, Headsail> = {
    foc: headsail({
      tack: new THREE.Vector3(0, 0.116, -0.49),
      head: new THREE.Vector3(0, 0.07 + mh * 0.8, mastZ - 0.012),
      chord: (v) => 0.38 * (1 - v) + 0.02 * v,
      draft: 0.08,
      twist: 0.2,
      mat: jibMat,
      roll: rollMat,
      trim: (_a, boom) => boom * 0.45,
      hero,
    }),
    code0: headsail({
      tack: spritTip,
      head: top,
      chord: (v) => 0.5 * (1 - v) + 0.03 * v,
      draft: 0.12,
      roach: 0.24,
      twist: 0.28,
      // le guindant d'une voile sur câble creuse un peu sous le vent
      bow: (v) => new THREE.Vector3(0.018, 0, 0.03).multiplyScalar(Math.sin(Math.PI * v)),
      mat: code0Mat,
      roll: rollMat,
      trim: (_a, boom) => boom * 0.52,
      hero,
    }),
    spi: headsail({
      tack: spritTip.clone().setY(0.116),
      head: top.clone().setY(mastTop - 0.015),
      chord: (v) => 0.03 + 0.56 * Math.pow(1 - Math.pow(v, 2.3), 0.55),
      draft: 0.3,
      twist: 0.35,
      // asymétrique : le guindant part loin devant et au vent du bout-dehors
      bow: (v) => new THREE.Vector3(-0.03, 0, -0.15).multiplyScalar(Math.sin(Math.PI * Math.pow(v, 0.85))),
      mat: spiMat,
      roll: rollSpi,
      trim: (a) => (Math.min(46, Math.max(14, a * 0.3)) * Math.PI) / 180,
      hero,
    }),
  };
  for (const h of Object.values(headsails)) heel.add(h.pivot);
  const jib = headsails.foc.pivot;
  headsails.code0.pivot.visible = false;
  headsails.spi.pivot.visible = false;

  // mât, gréement et voiles : regroupés et articulés au pied de mât, pour la quête
  const spar = new THREE.Group();
  spar.position.set(0, 0.085, mastZ);
  for (const o of heel.children.slice(s0)) {
    o.position.sub(spar.position);
    spar.add(o);
  }
  heel.add(spar);
  for (const h of Object.values(headsails)) heel.add(h.deck);

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return { root, heel, main, jib, materials, parts: { coque: [hullMat, hullMatSb], foils: [foilMat], mat: [mastMat] }, spar, foilParts, headsails };
}

/** Oriente voiles et gîte selon l'angle au vent (twa > 0 : vent de tribord). */
export function trimBoat(rig: BoatRig, twa: number, tws: number) {
  const side = twa >= 0 ? 1 : -1;
  const a = Math.abs(twa);
  const boom = (Math.min(78, Math.max(6, a * 0.5)) * Math.PI) / 180;
  rig.main.rotation.y = -side * boom;
  rig.main.scale.x = -side; // le creux de la voile passe sous le vent
  if (rig.headsails) {
    // voiles d'avant bordées autour de leur guindant : l'amure et la têtière restent en place
    for (const h of Object.values(rig.headsails)) {
      h.pivot.quaternion.setFromAxisAngle(h.axis, -side * h.trim(a, boom));
      h.pivot.scale.x = -side;
    }
  } else {
    rig.jib.rotation.y = -side * boom * 0.45;
    rig.jib.scale.x = -side;
  }
  rig.heel.rotation.z = (side * Math.min(1, tws / 25) * (a < 120 ? 15 : 6) * Math.PI) / 180;
}

/**
 * Voiles d'avant selon la voile à poste et le changement en cours : boudin sur le pont, hissage,
 * déroulé, enroulement de l'ancienne. Sans effet sur un modèle importé (il n'a que son foc).
 */
export function showSails(rig: BoatRig, b: SailChangeState, time: number) {
  const hs = rig.headsails;
  if (!hs) return;
  const show = sailShow(b);
  for (const id of Object.keys(hs) as SailId[]) {
    const h = hs[id];
    const s = show[id];
    h.pivot.visible = !!s;
    h.deck.visible = !!s && s.deck > 0.01;
    if (!s) continue;
    h.setOpen(s.open, s.flap, time);
    h.cloth.visible = s.open > 0.01;
    h.furled.visible = s.hoist > 0.005 && s.roll > 0.02;
    h.furled.scale.set(s.roll, Math.max(0.001, s.hoist * h.len), s.roll);
    if (h.deck.visible) {
      h.deck.position.z = DECK_FROM + (h.tackZ - DECK_FROM) * s.slide;
      h.deck.scale.z = s.deck * DECK_LEN;
    }
  }
}

export function disposeBoat(rig: BoatRig) {
  if (!rig.shared) rig.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
  for (const m of rig.materials) m.dispose();
}

/** Fait briller une pièce (0 = éteint). */
export function highlightPart(rig: BoatRig, part: 'coque' | 'foils' | 'mat' | null, amount: number) {
  for (const key of ['coque', 'foils', 'mat'] as const) {
    for (const m of rig.parts[key]) {
      m.emissive.set(0x4da3ff);
      m.emissiveIntensity = key === part ? amount : 0;
    }
  }
}
