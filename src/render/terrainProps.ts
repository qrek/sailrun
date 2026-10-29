import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { KX, LAT0, LATMAX, LATMIN, LON0, LONMAX, LONMIN, Rng, fromX, fromZ, isLand } from '../sim/geo';
import type { HexGrid } from './ocean';

/** Contenu d'une case de la grille de placement, décodé depuis hex.png (la grille ne se voit pas). */
export interface HexCell {
  biome: number; // 0 prairie, 1 plaine, 2 désert, 3 toundra, 4 neige, 5 jungle
  relief: number; // 0 plat, 1 collines, 2 montagnes
  forest: boolean;
  land: boolean;
}

export function decodeHex(img: HTMLImageElement, grid: HexGrid): HexCell[] {
  const c = document.createElement('canvas');
  c.width = grid.cols;
  c.height = grid.rows;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, grid.cols, grid.rows).data;
  const out: HexCell[] = [];
  for (let k = 0; k < grid.cols * grid.rows; k++) {
    const r = d[k * 4];
    const gg = d[k * 4 + 1];
    const b = d[k * 4 + 2] - 10;
    out.push({
      biome: Math.round((r - 10) / 40),
      relief: Math.round((gg - 10) / 100),
      forest: b >= 150,
      land: b % 200 >= 30,
    });
  }
  return out;
}


/* ---------- géométries procédurales (couleurs dans les sommets, ombrage doux) ---------- */

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function paint(g: THREE.BufferGeometry, f: (y: number) => RGB): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const p = ng.attributes.position as THREE.BufferAttribute;
  const col: number[] = [];
  for (let k = 0; k < p.count; k++) col.push(...f(p.getY(k)));
  ng.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return ng;
}

const TRUNK: RGB = [0.42, 0.3, 0.2];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const hash3 = (x: number, y: number, z: number) => {
  const t = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return t - Math.floor(t);
};

/** Sapin : quatre étages de branches arrondis, vert-bleu, et un tronc. Hauteur ≈ 1. */
export function pineGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.045, 0.06, 0.2, 6);
  trunk.translate(0, 0.1, 0);
  parts.push(paint(trunk, () => TRUNK));
  const tiers = [
    [0.36, 0.36, 0.12],
    [0.3, 0.33, 0.33],
    [0.23, 0.3, 0.53],
    [0.14, 0.26, 0.72],
  ];
  for (const [r, h, y0] of tiers) {
    const c = new THREE.ConeGeometry(r, h, 10, 2);
    // bas de chaque étage légèrement retroussé : silhouette plus douce
    const p = c.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) if (p.getY(k) < -h / 2 + 1e-4) p.setY(k, p.getY(k) + 0.04);
    c.computeVertexNormals();
    c.translate(0, y0 + h / 2, 0);
    parts.push(paint(c, (y) => mix([0.12, 0.33, 0.25], [0.32, 0.58, 0.4], clamp01((y - y0) / h))));
  }
  return mergeGeometries(parts)!;
}

/** Feuillu « nuage » : un houppier de boules bosselées, sombre dessous, lumineux au soleil. */
export function cloudTreeGeo(seg: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.045, 0.065, 0.36, 6);
  trunk.translate(0, 0.18, 0);
  parts.push(paint(trunk, () => TRUNK));
  const blobs = [
    [0, 0.66, 0, 0.3],
    [0.2, 0.56, 0.06, 0.22],
    [-0.18, 0.57, -0.08, 0.23],
    [0.04, 0.55, 0.2, 0.21],
    [-0.04, 0.54, -0.21, 0.2],
    [0.06, 0.86, -0.02, 0.2],
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.7)));
    const p = b.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const vx = p.getX(k);
      const vy = p.getY(k);
      const vz = p.getZ(k);
      const f = 1 + 0.12 * (hash3(Math.round(vx * 40), Math.round(vy * 40), Math.round(vz * 40)) - 0.5);
      p.setXYZ(k, vx * f, vy * f * 0.92, vz * f);
    }
    b.computeVertexNormals();
    b.translate(x, y, z);
    parts.push(paint(b, (yy) => mix([0.2, 0.42, 0.14], [0.6, 0.84, 0.3], clamp01((yy - 0.38) / 0.62))));
  }
  return mergeGeometries(parts)!;
}

/** Rocher facetté gris clair, mousse sur le dessus. Taille ≈ 1. */
export function rockGeo(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k);
    const y = p.getY(k);
    const z = p.getZ(k);
    const f = 0.75 + 0.5 * hash3(Math.round(x * 10) + seed, Math.round(y * 10), Math.round(z * 10));
    p.setXYZ(k, x * f * (1 + 0.3 * (seed % 2)), Math.max(-0.1, y * f * 0.8), z * f);
  }
  g.translate(0, 0.1, 0);
  g.computeVertexNormals();
  return paint(g, (y) => (y > 0.38 ? [0.56, 0.72, 0.32] : mix([0.56, 0.57, 0.59], [0.9, 0.9, 0.88], clamp01((y + 0.1) / 0.5))));
}

/** Ombre douce au pied des arbres et des rochers. */
function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(10,30,10,0.55)');
  grd.addColorStop(0.55, 'rgba(10,30,10,0.25)');
  grd.addColorStop(1, 'rgba(10,30,10,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export interface TerrainProps {
  group: THREE.Group;
  /** Arbres, masqués quand on dézoome (trop petits pour être vus). */
  trees: THREE.Group;
}

/**
 * Forêts en volume (InstancedMesh découpés par zones pour que seules les zones à l'écran soient
 * dessinées), plantées sur le relief d'après la carte des biomes. Pas d'arbres dans les pentes raides
 * ni au-dessus de la limite des arbres.
 */
export function buildTerrainProps(cells: HexCell[], grid: HexGrid, small: boolean, heightAt: (lon: number, lat: number) => number, elevAt: (lon: number, lat: number) => number): TerrainProps {
  const group = new THREE.Group();
  group.name = 'terrain-props';
  const trees = new THREE.Group();
  group.add(trees);
  const S = Math.sqrt(3) * grid.r;
  const DY = 1.5 * grid.r;
  const X0 = (LONMIN - LON0) * KX;
  const Z0 = -(LATMAX - LAT0);
  const rng = new Rng(4242);

  type Inst = { x: number; y: number; z: number; s: number; rot: number; color: number };
  const pines: Inst[] = [];
  const leafy: Inst[] = [];
  const rocks: Inst[][] = [[], [], []];
  const shadows: Inst[] = [];

  const treesPerCell = small ? 4 : 9;
  // rochers : sur les côtes (terre avec de l'eau tout près) et dans les reliefs
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const cell = cells[j * grid.cols + i];
      if (!cell.land) continue;
      const cx = X0 + i * S + (j % 2 === 1 ? S / 2 : 0);
      const cz = Z0 + j * DY;
      const clat = fromZ(cz);
      const clon = fromX(cx);
      if (clon < LONMIN + 3 || clon > LONMAX - 3 || clat < LATMIN + 3 || clat > LATMAX - 3) continue;
      const n = (cell.relief >= 1 ? 2 : 0) + (small ? 1 : 3);
      for (let k = 0; k < n; k++) {
        const a = rng.next() * Math.PI * 2;
        const d = Math.sqrt(rng.next()) * grid.r * 1.05;
        const x = cx + Math.cos(a) * d;
        const z = cz + Math.sin(a) * d;
        const lon = fromX(x);
        const lat = fromZ(z);
        if (!isLand(lon, lat)) continue;
        const r = 0.035;
        let coast = false;
        for (let q = 0; q < 6 && !coast; q++) coast = !isLand(lon + (Math.cos((q * Math.PI) / 3) * r) / KX, lat + Math.sin((q * Math.PI) / 3) * r);
        if (!coast && (cell.relief < 1 || rng.next() > 0.35)) continue;
        if (elevAt(lon, lat) > 2400) continue;
        const sc = (coast ? 0.02 : 0.028) * (0.6 + rng.next() * 1.0);
        const y = heightAt(lon, lat);
        rocks[Math.floor(rng.next() * 3)].push({ x, y: y - sc * 0.15, z, s: sc, rot: rng.next() * Math.PI * 2, color: 0xffffff });
      }
    }
  }
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const cell = cells[j * grid.cols + i];
      // hors forêt : quelques bosquets épars dans les prairies et plaines
      if (!cell.land || (!cell.forest && (cell.biome > 1 || cell.relief === 2))) continue;
      const cx = X0 + i * S + (j % 2 === 1 ? S / 2 : 0);
      const cz = Z0 + j * DY;
      const clat = fromZ(cz);
      const clon = fromX(cx);
      if (clon < LONMIN + 3 || clon > LONMAX - 3 || clat < LATMIN + 3 || clat > LATMAX - 3) continue;
      const conifer = Math.abs(clat) > 42 || cell.biome === 3;
      const jungle = cell.biome === 5;
      const nTrees = cell.forest ? treesPerCell : rng.next() < 0.45 ? Math.ceil(treesPerCell * 0.35) : 0;
      for (let k = 0; k < nTrees; k++) {
        const a = rng.next() * Math.PI * 2;
        const d = Math.sqrt(rng.next()) * grid.r * 1.05;
        const x = cx + Math.cos(a) * d;
        const z = cz + Math.sin(a) * d;
        const lon = fromX(x);
        const lat = fromZ(z);
        if (!isLand(lon, lat)) continue;
        const el = elevAt(lon, lat);
        // limite des arbres plus basse vers le nord ; on évite aussi les plages
        const treeLine = 2600 - Math.max(0, Math.abs(lat) - 35) * 55;
        if (el > treeLine || el < 15) continue;
        const y = heightAt(lon, lat);
        const e = 0.02;
        const slope = Math.hypot(heightAt(lon + e / KX, lat) - y, heightAt(lon, lat + e) - y) / e;
        if (slope > 0.9) continue;
        const sc = (conifer ? 0.06 : 0.055) * (0.7 + rng.next() * 0.6);
        const b = 0.88 + rng.next() * 0.22;
        const c = new THREE.Color(b * (jungle ? 0.95 : 1), b * (jungle ? 1.06 : 1), b * (jungle ? 0.9 : 1));
        // quelques arbres jaunes ou roux, comme dans les références
        if (!conifer && rng.next() < 0.07) c.setRGB(1.35, 1.0, 0.45);
        else if (!conifer && rng.next() < 0.03) c.setRGB(1.5, 0.75, 0.38);
        (conifer ? pines : leafy).push({ x, y: y - 0.002, z, s: sc, rot: rng.next() * Math.PI * 2, color: c.getHex() });
        shadows.push({ x: x + sc * 0.25, y: y + 0.0015, z: z + sc * 0.2, s: sc * (conifer ? 1.0 : 1.35), rot: 0, color: 0xffffff });
      }
    }
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const CHUNK = 6;
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[]) => {
    const byChunk = new Map<string, Inst[]>();
    for (const it of list) {
      const key = `${Math.floor(it.x / CHUNK)},${Math.floor(it.z / CHUNK)}`;
      let arr = byChunk.get(key);
      if (!arr) byChunk.set(key, (arr = []));
      arr.push(it);
    }
    for (const arr of byChunk.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, arr.length);
      arr.forEach((it, k) => {
        q.setFromAxisAngle(up, it.rot);
        m4.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.s, it.s, it.s));
        mesh.setMatrixAt(k, m4);
        mesh.setColorAt(k, col.setHex(it.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = !small && !(mat as THREE.MeshBasicMaterial).transparent;
      parent.add(mesh);
    }
  };

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, envMapIntensity: 0.35 });
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, flatShading: true, envMapIntensity: 0.5 });
  const shadowMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  shadowGeo.rotateX(-Math.PI / 2);
  for (const sh of rocks.flat()) shadows.push({ x: sh.x + sh.s * 0.2, y: sh.y + sh.s * 0.15 + 0.0015, z: sh.z + sh.s * 0.15, s: sh.s * 1.5, rot: 0, color: 0xffffff });
  add(trees, shadowGeo, shadowMat, shadows);
  add(trees, pineGeo(), mat, pines);
  add(trees, cloudTreeGeo(small ? 6 : 9), mat, leafy);
  rocks.forEach((list, k) => add(group, rockGeo(k * 7 + 3), rockMat, list));
  return { group, trees };
}
