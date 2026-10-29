import * as THREE from 'three';
import { KX, LAT0, LATMAX, LON0, LONMAX, LONMIN } from '../sim/geo';

/**
 * Relief 3D de la carte, façon maquette : un terrain construit à partir des vraies altitudes
 * (public/terrain/height.png), accentué, découpé en zones qui s'affinent près de la caméra.
 * Les côtes sont simplement l'endroit où le terrain plonge sous la mer (plan y = 0).
 */

const CHUNK = 8; // degrés
const LODS = [1, 2, 4, 8]; // pas de la grille, en pixels
const SKIRT = 0.05;

/** Altitude (m) -> hauteur dans le monde. Accentuée, et un peu tassée vers les sommets. */
export function worldHeight(e: number): number {
  if (e <= 0) return Math.max(-0.035, -0.004 + e * 0.00001);
  return 0.0012 + 0.42 * Math.pow(e / 4800, 0.68);
}

/** Limite des neiges selon la latitude (m). */
const snowLine = (lat: number) => 4800 - Math.max(0, Math.abs(lat) - 20) * 75;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// roche gris clair légèrement bleutée, comme les falaises stylisées des références
const ROCK: RGB = [0.74, 0.74, 0.72];
const ROCK_DARK: RGB = [0.58, 0.59, 0.6];
const SNOW: RGB = [0.97, 0.98, 1.0];
const SAND: RGB = [0.95, 0.86, 0.66];
const ALPINE: RGB = [0.66, 0.72, 0.46];

async function loadPixels(url: string): Promise<ImageData> {
  const res = await fetch(url);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

interface Chunk {
  i0: number; // premier pixel (colonne) de la zone
  j0: number;
  n: number; // taille en pixels
  center: THREE.Vector3;
  meshes: (THREE.Mesh | null)[];
  current: number;
}

export class Terrain {
  readonly group = new THREE.Group();
  private elev: Float32Array | null = null;
  private ao: Uint8Array | null = null;
  private cliff: Float32Array | null = null; // hauteur du rebord de falaise (unités monde)
  private paint: ImageData | null = null;
  private chunks: Chunk[] = [];
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.4 });
  private budget = 0;
  ready = false;
  private res = 20; // pixels de la carte d'altitude par degré
  private w = 0;
  private h = 0;

  constructor(private small: boolean) {
    this.group.name = 'terrain';
  }

  async load(base: string) {
    const [hp, pp] = await Promise.all([loadPixels(`${base}terrain/${this.small ? 'height-s' : 'height'}.png`), loadPixels(`${base}terrain/land.jpg`)]);
    this.w = hp.width;
    this.h = hp.height;
    this.res = this.w / (LONMAX - LONMIN);
    const n = this.w * this.h;
    const elev = new Float32Array(n);
    const ao = new Uint8Array(n);
    const d = hp.data;
    for (let k = 0; k < n; k++) {
      elev[k] = (d[k * 4] * 256 + d[k * 4 + 1]) / 2 - 11000;
      ao[k] = d[k * 4 + 2];
    }
    // bords de la carte : les terres s'enfoncent dans la mer en côte irrégulière (pas de coupe nette)
    const hash = (x: number, y: number) => {
      const t = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return t - Math.floor(t);
    };
    const vnoise = (x: number, y: number) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const u = fx * fx * (3 - 2 * fx);
      const v = fy * fy * (3 - 2 * fy);
      const a = hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u;
      const b = hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u;
      return a * (1 - v) + b * v;
    };
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const edge = Math.min(i, this.w - 1 - i, j, this.h - 1 - j) / this.res; // degrés jusqu'au bord
        if (edge > 4) continue;
        const nz = 0.6 * vnoise(i / 30, j / 30) + 0.4 * vnoise(i / 9, j / 9);
        const f = smooth(0.4, 2.6, edge + (nz - 0.5) * 2.2);
        const k = j * this.w + i;
        if (elev[k] > 0) elev[k] = f > 0.5 ? elev[k] * (f - 0.5) * 2 + 4 : -30 * (1 - f * 2) - 6;
      }
    }
    this.elev = elev;
    this.ao = ao;
    this.cliff = this.cliffField(elev);
    this.paint = pp;
    // zones : on ne garde que celles qui contiennent des terres
    const cpx = CHUNK * this.res;
    for (let j0 = 0; j0 < this.h; j0 += cpx) {
      for (let i0 = 0; i0 < this.w; i0 += cpx) {
        let any = false;
        for (let j = j0; j < Math.min(this.h, j0 + cpx) && !any; j += 2) for (let i = i0; i < Math.min(this.w, i0 + cpx); i += 2) if (elev[j * this.w + i] > 0) { any = true; break; }
        if (!any) continue;
        const nn = Math.min(cpx, this.w - 1 - i0, this.h - 1 - j0);
        const lon = LONMIN + (i0 + nn / 2) / this.res;
        const lat = LATMAX - (j0 + nn / 2) / this.res;
        this.chunks.push({ i0, j0, n: nn, center: new THREE.Vector3((lon - LON0) * KX, 0, -(lat - LAT0)), meshes: LODS.map(() => null), current: -1 });
      }
    }
    this.ready = true;
  }

  /**
   * Rebord de côte : là où le relief voisin est marqué, la terre sort de l'eau en falaise ;
   * sur les côtes basses, elle descend en pente douce (plage). Max glissant séparable sur ~0,4°.
   */
  private cliffField(elev: Float32Array): Float32Array {
    const w = this.w;
    const h = this.h;
    const R = Math.round(this.res * 0.4);
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let m = 0;
        for (let k = Math.max(0, i - R); k <= Math.min(w - 1, i + R); k += 2) m = Math.max(m, elev[j * w + k]);
        tmp[j * w + i] = m;
      }
    }
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        let m = 0;
        for (let k = Math.max(0, j - R); k <= Math.min(h - 1, j + R); k += 2) m = Math.max(m, tmp[k * w + i]);
        // une variation lente évite que toutes les côtes se ressemblent
        const n = 0.7 + 0.6 * this.noise(i / 40, j / 40);
        out[j * w + i] = elev[j * w + i] > 0 ? 0.016 * smooth(120, 900, m) * n : 0;
      }
    }
    return out;
  }

  /** Hauteur du terrain au pixel (i, j), rebord de falaise compris. */
  private hAt(i: number, j: number): number {
    i = Math.min(this.w - 1, Math.max(0, i));
    j = Math.min(this.h - 1, Math.max(0, j));
    const k = j * this.w + i;
    return worldHeight(this.elev![k]) + this.cliff![k];
  }

  /** Hauteur du terrain (monde) au point lon/lat. */
  heightAtLonLat(lon: number, lat: number): number {
    if (!this.elev) return 0;
    const x = (lon - LONMIN) * this.res - 0.5;
    const y = (LATMAX - lat) * this.res - 0.5;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const a = this.hAt(i, j) * (1 - fx) + this.hAt(i + 1, j) * fx;
    const b = this.hAt(i, j + 1) * (1 - fx) + this.hAt(i + 1, j + 1) * fx;
    return a * (1 - fy) + b * fy;
  }

  private noise(x: number, y: number): number {
    const h = (a: number, b: number) => {
      const t = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
      return t - Math.floor(t);
    };
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
  }

  private e(i: number, j: number): number {
    i = Math.min(this.w - 1, Math.max(0, i));
    j = Math.min(this.h - 1, Math.max(0, j));
    return this.elev![j * this.w + i];
  }

  /** Altitude (m) au point lon/lat, interpolée. */
  elevationAt(lon: number, lat: number): number {
    if (!this.elev) return 0;
    const x = (lon - LONMIN) * this.res - 0.5;
    const y = (LATMAX - lat) * this.res - 0.5;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const a = this.e(i, j) * (1 - fx) + this.e(i + 1, j) * fx;
    const b = this.e(i, j + 1) * (1 - fx) + this.e(i + 1, j + 1) * fx;
    return a * (1 - fy) + b * fy;
  }

  /** Hauteur du terrain dans le monde au point (x, z). */
  heightAt(x: number, z: number): number {
    return worldHeight(this.elevationAt(x / KX + LON0, LAT0 - z));
  }

  private paintAt(i: number, j: number): RGB {
    const p = this.paint!;
    const x = Math.min(p.width - 1, Math.max(0, Math.round(((i + 0.5) / this.w) * p.width - 0.5)));
    const y = Math.min(p.height - 1, Math.max(0, Math.round(((j + 0.5) / this.h) * p.height - 0.5)));
    const k = (y * p.width + x) * 4;
    return [p.data[k] / 255, p.data[k + 1] / 255, p.data[k + 2] / 255];
  }

  private build(c: Chunk, lod: number): THREE.Mesh {
    const step = LODS[lod];
    const cols = Math.floor(c.n / step) + 1;
    const rows = cols;
    const nv = cols * rows;
    const ring = 2 * (cols + rows) - 4; // sommets du bord, dupliqués pour la jupe
    const pos = new Float32Array((nv + ring) * 3);
    const nor = new Float32Array((nv + ring) * 3);
    const col = new Float32Array((nv + ring) * 3);
    const idx: number[] = [];
    // taille d'un pixel en unités monde (pour les normales)
    const dxw = (KX / this.res) * step;
    const dzw = (1 / this.res) * step;
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const i = c.i0 + q * step;
        const j = c.j0 + r * step;
        const e = this.e(i, j);
        const h = this.hAt(i, j);
        const lon = LONMIN + (i + 0.5) / this.res;
        const lat = LATMAX - (j + 0.5) / this.res;
        const v = r * cols + q;
        pos[v * 3] = (lon - LON0) * KX;
        pos[v * 3 + 1] = h;
        pos[v * 3 + 2] = -(lat - LAT0);
        // normale à partir des voisins (identique d'une zone à l'autre : pas de couture)
        const hl = this.hAt(i - step, j);
        const hr = this.hAt(i + step, j);
        const hu = this.hAt(i, j - step);
        const hd = this.hAt(i, j + step);
        // normales accentuées : l'ombrage sculpte mieux le relief que la géométrie seule
        const NE = 2.6;
        const nx = ((hl - hr) / (2 * dxw)) * NE;
        const nz = ((hu - hd) / (2 * dzw)) * NE;
        const nl = Math.hypot(nx, 1, nz);
        nor[v * 3] = nx / nl;
        nor[v * 3 + 1] = 1 / nl;
        nor[v * 3 + 2] = nz / nl;
        const slope = 1 - 1 / Math.hypot(nx / NE, 1, nz / NE);
        // couleur : peinture des biomes, roche dans les pentes, alpages, neige, plages, creux plus sombres
        let cc = this.paintAt(i, j);
        // touche peinte : marbrures de végétation à deux échelles, un peu moins saturé
        const mott = 0.6 * this.noise(i / 14, j / 14) + 0.4 * this.noise(i / 4.5, j / 4.5);
        // plaques d'herbe plus claires / plus foncées, comme une maquette peinte
        cc = [cc[0] * (0.9 + 0.18 * mott), cc[1] * (0.92 + 0.14 * mott), cc[2] * (0.94 + 0.08 * mott)];
        if (e > 0) {
          const sl = snowLine(lat);
          cc = mix(cc, ALPINE, smooth(sl - 1300, sl - 500, e) * 0.7);
          cc = mix(cc, mix(ROCK, ROCK_DARK, smooth(0.35, 0.7, slope)), smooth(0.16, 0.38, slope) * 0.95);
          cc = mix(cc, SNOW, smooth(sl - 150, sl + 200, e) * (1 - 0.6 * smooth(0.45, 0.7, slope)));
          cc = mix(cc, SAND, (1 - smooth(5, 60, e)) * 0.9 * (1 - smooth(0.1, 0.22, slope)));
        } else {
          cc = SAND;
        }
        const ao = 0.62 + 0.38 * (this.ao![Math.min(this.h - 1, j) * this.w + Math.min(this.w - 1, i)] / 255);
        col[v * 3] = srgbToLinear(cc[0]) * ao;
        col[v * 3 + 1] = srgbToLinear(cc[1]) * ao;
        col[v * 3 + 2] = srgbToLinear(cc[2]) * ao;
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let q = 0; q < cols - 1; q++) {
        const a = r * cols + q;
        const b = a + 1;
        const cI = a + cols;
        const d = cI + 1;
        idx.push(a, cI, b, b, cI, d);
      }
    }
    // jupe : un rebord qui descend sous le terrain, pour masquer les fissures entre niveaux de détail
    const border: number[] = [];
    for (let q = 0; q < cols; q++) border.push(q);
    for (let r = 1; r < rows; r++) border.push(r * cols + cols - 1);
    for (let q = cols - 2; q >= 0; q--) border.push((rows - 1) * cols + q);
    for (let r = rows - 2; r >= 1; r--) border.push(r * cols);
    border.forEach((v, k) => {
      const s = nv + k;
      pos[s * 3] = pos[v * 3];
      pos[s * 3 + 1] = pos[v * 3 + 1] - SKIRT;
      pos[s * 3 + 2] = pos[v * 3 + 2];
      nor[s * 3] = nor[v * 3];
      nor[s * 3 + 1] = nor[v * 3 + 1];
      nor[s * 3 + 2] = nor[v * 3 + 2];
      col[s * 3] = col[v * 3] * 0.8;
      col[s * 3 + 1] = col[v * 3 + 1] * 0.8;
      col[s * 3 + 2] = col[v * 3 + 2] * 0.8;
    });
    for (let k = 0; k < border.length; k++) {
      const a = border[k];
      const b = border[(k + 1) % border.length];
      const sa = nv + k;
      const sb = nv + ((k + 1) % border.length);
      idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.mat);
    m.castShadow = !this.small;
    m.receiveShadow = !this.small;
    return m;
  }

  /** Choisit le niveau de détail de chaque zone selon la distance au point regardé. */
  update(target: THREE.Vector3, camDist: number) {
    if (!this.ready) return;
    this.budget = 3; // zones construites au plus par image (pas d'à-coups)
    const scale = this.small ? 1.6 : 1;
    for (const c of this.chunks) {
      const d = Math.max(0, Math.hypot(c.center.x - target.x, c.center.z - target.z) - CHUNK * 0.6) + camDist * 0.6;
      let want = d < 3 * scale ? 0 : d < 8 * scale ? 1 : d < 18 * scale ? 2 : 3;
      if (this.small) want = Math.max(1, want);
      if (want === c.current) continue;
      if (!c.meshes[want]) {
        if (this.budget <= 0) {
          // pas encore construit : on garde l'ancien niveau, ou le plus grossier en attendant
          if (c.current === -1) want = 3;
          else continue;
        }
        if (!c.meshes[want]) {
          c.meshes[want] = this.build(c, want);
          this.budget--;
        }
      }
      if (c.current >= 0) this.group.remove(c.meshes[c.current]!);
      this.group.add(c.meshes[want]!);
      c.current = want;
    }
  }
}

