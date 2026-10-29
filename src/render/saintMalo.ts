import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bannerTexture } from './harbourTown';

/**
 * Le village départ de la Route du Rhum : le bassin Vauban, au pied des remparts de Saint-Malo.
 * Quai et remparts de granit, créneaux, bastion, porte fortifiée, maisons d'armateurs hautes
 * en granit avec toits d'ardoise pentus, lucarnes et grandes souches de cheminée, flèche de la
 * cathédrale Saint-Vincent, tentes du village et pavillons.
 *
 * Rendu « stylisé soigné » : textures peintes générées (blocs de granit, ardoises), arêtes adoucies,
 * teintes qui varient d'une maison à l'autre. Tout est fusionné par matériau ou instancié.
 * Repère : l'eau du bassin est côté +x, le quai court le long de z, bord du quai en x = −11.
 */

export const QUAY_X = -11;
const QUAY_Y = 0.42;
const WALL_X0 = -14.2; // pied du rempart (face côté bassin)
const WALL_X1 = -16.6; // arrière du rempart
const WALL_Y = 2.7; // chemin de ronde
const TOWN_Y = 2.1; // sol de la ville close, derrière le rempart

/* ---------- textures peintes ---------- */

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Blocs de granit en assises irrégulières, joints clairs, teintes gris-beige. */
function graniteTexture(seed: number, base: [number, number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const r = rnd(seed);
  g.fillStyle = '#8d8a84';
  g.fillRect(0, 0, 512, 512);
  let y = 0;
  while (y < 512) {
    const h = 28 + Math.floor(r() * 26);
    let x = -Math.floor(r() * 60);
    while (x < 512) {
      const w = 46 + Math.floor(r() * 70);
      const v = (r() - 0.5) * 34;
      const warm = (r() - 0.5) * 14;
      const R = base[0] + v + warm;
      const G = base[1] + v;
      const B = base[2] + v - warm * 0.6;
      g.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
      g.fillRect(x + 2, y + 2, w - 4, h - 4);
      // lumière en haut du bloc, ombre en bas : relief peint
      g.fillStyle = 'rgba(255,255,255,0.13)';
      g.fillRect(x + 2, y + 2, w - 4, 3);
      g.fillStyle = 'rgba(0,0,0,0.16)';
      g.fillRect(x + 2, y + h - 5, w - 4, 3);
      // grain du granit
      for (let k = 0; k < 18; k++) {
        g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(30,30,30,0.12)';
        g.fillRect(x + 3 + r() * (w - 8), y + 3 + r() * (h - 8), 2, 2);
      }
      x += w;
    }
    y += h;
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Ardoises en rangs qui se chevauchent, bleu-gris. */
function slateTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const r = rnd(7);
  g.fillStyle = '#3c4654';
  g.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 16; row++) {
    const y = row * 16;
    const off = row % 2 ? 8 : 0;
    for (let x = -off; x < 256; x += 16) {
      const v = (r() - 0.5) * 22;
      g.fillStyle = `rgb(${(78 + v) | 0},${(90 + v) | 0},${(106 + v) | 0})`;
      g.fillRect(x + 1, y + 1, 14, 15);
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fillRect(x + 1, y + 1, 14, 2);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + 1, y + 14, 14, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Pavés du quai. */
function cobbleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const r = rnd(11);
  g.fillStyle = '#6f6b64';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 18) {
    for (let x = (y / 18) % 2 ? -9 : 0; x < 256; x += 18) {
      const v = (r() - 0.5) * 30;
      g.fillStyle = `rgb(${(150 + v) | 0},${(146 + v) | 0},${(138 + v) | 0})`;
      g.beginPath();
      g.roundRect(x + 2, y + 2, 14, 14, 4);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- fusion avec coordonnées de texture « monde » ---------- */

/**
 * Accumule des géométries transformées ; les UV sont recalculées en coordonnées monde selon
 * l'orientation de chaque face (projection boîte), pour que les blocs gardent la même taille partout.
 */
class Builder {
  private parts: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  constructor(private scale: number) {}
  add(geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, tint?: THREE.Color | string, rx = 0) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()) as THREE.BufferGeometry;
    this.m.makeRotationFromEuler(new THREE.Euler(rx, ry, 0));
    this.m.setPosition(x, y, z);
    g.applyMatrix4(this.m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const uv = new Float32Array(pos.count * 2);
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color(tint ?? '#ffffff');
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nor.getX(i));
      const ny = Math.abs(nor.getY(i));
      const nz = Math.abs(nor.getZ(i));
      let u: number;
      let v: number;
      if (ny > nx && ny > nz) {
        u = pos.getX(i);
        v = pos.getZ(i);
      } else if (nx > nz) {
        u = pos.getZ(i);
        v = pos.getY(i);
      } else {
        u = pos.getX(i);
        v = pos.getY(i);
      }
      uv[i * 2] = u * this.scale;
      uv[i * 2 + 1] = v * this.scale;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    this.parts.push(g);
  }
  build(mat: THREE.Material, shadows = true): THREE.Mesh | null {
    if (!this.parts.length) return null;
    const mesh = new THREE.Mesh(mergeGeometries(this.parts), mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** Toit à deux pans (prisme), faîtage le long de z. */
function gableGeo(w: number, h: number, d: number, over = 0.12): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 - over, 0);
  s.lineTo(w / 2 + over, 0);
  s.lineTo(0, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d + over * 2, bevelEnabled: false });
  g.translate(0, 0, -(d + over * 2) / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

interface Inst {
  x: number;
  y: number;
  z: number;
  ry?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  color?: string;
}
function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[], shadows = false): THREE.InstancedMesh | null {
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  list.forEach((p, i) => {
    q.setFromEuler(e.set(0, p.ry ?? 0, 0));
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1));
    im.setMatrixAt(i, m);
    if (p.color) im.setColorAt(i, new THREE.Color(p.color));
  });
  im.castShadow = shadows;
  im.receiveShadow = true;
  return im;
}

const STONE_TINTS = ['#ffffff', '#f3eee6', '#e9e6e1', '#f7f1e4', '#e4e3e2', '#fbf6ec', '#ece5d8'];

/** Construit Saint-Malo intra-muros et le village de course ; retourne la banderole (titre de la course). */
export function buildSaintMalo(scene: THREE.Scene, small: boolean): THREE.Mesh {
  const r = rnd(2026);
  const granite = graniteTexture(3, [170, 164, 152]);
  const graniteWarm = graniteTexture(5, [186, 176, 158]);
  const stoneMat = new THREE.MeshStandardMaterial({ map: granite, vertexColors: true, roughness: 0.92 });
  const houseMat = new THREE.MeshStandardMaterial({ map: graniteWarm, vertexColors: true, roughness: 0.9 });
  const slateMat = new THREE.MeshStandardMaterial({ map: slateTexture(), vertexColors: true, roughness: 0.7, metalness: 0.05 });
  const cobble = new THREE.MeshStandardMaterial({ map: cobbleTexture(), roughness: 0.95 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.55 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1d2c3c, roughness: 0.15, metalness: 0.3, envMapIntensity: 1.4 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.5, metalness: 0.6 });

  const stone = new Builder(0.42);
  const house = new Builder(0.42);
  const roofs = new Builder(1.1);
  const Z0 = -46;
  const Z1 = 46;

  /* quai : mur de granit et pavés */
  const quayLen = Z1 - Z0;
  stone.add(new THREE.BoxGeometry(WALL_X0 - QUAY_X + 0.01, QUAY_Y + 1.2, quayLen), (QUAY_X + WALL_X0) / 2, (QUAY_Y - 1.2) / 2, 0, 0, '#d8d4cc');
  const quayTop = new THREE.Mesh(new THREE.PlaneGeometry(QUAY_X - WALL_X0, quayLen), cobble);
  (cobble.map as THREE.Texture).repeat.set((QUAY_X - WALL_X0) * 2.2, quayLen * 2.2);
  quayTop.rotation.x = -Math.PI / 2;
  quayTop.position.set((QUAY_X + WALL_X0) / 2, QUAY_Y + 0.003, 0);
  quayTop.receiveShadow = true;
  scene.add(quayTop);
  // margelle du quai
  stone.add(new RoundedBoxGeometry(0.34, 0.1, quayLen, 2, 0.03), QUAY_X - 0.17, QUAY_Y + 0.03, 0, 0, '#ece8e0');

  /* rempart : mur légèrement incliné, chemin de ronde, parapet crénelé */
  const wallShape = new THREE.Shape();
  wallShape.moveTo(0, 0);
  wallShape.lineTo(WALL_X0 - WALL_X1, 0);
  wallShape.lineTo(WALL_X0 - WALL_X1 - 0.28, WALL_Y);
  wallShape.lineTo(0, WALL_Y);
  wallShape.closePath();
  const wallGeo = new THREE.ExtrudeGeometry(wallShape, { depth: quayLen, bevelEnabled: false });
  wallGeo.translate(0, 0, -quayLen / 2);
  stone.add(wallGeo, WALL_X1, QUAY_Y - 0.01, 0, 0, '#ffffff');
  // cordon de pierre sous le parapet
  stone.add(new RoundedBoxGeometry(0.34, 0.14, quayLen, 2, 0.04), WALL_X0 - 0.28, QUAY_Y + WALL_Y - 0.05, 0, 0, '#f2eee6');
  // parapet et créneaux
  const parapetX = WALL_X0 - 0.42;
  stone.add(new THREE.BoxGeometry(0.4, 0.42, quayLen), parapetX, QUAY_Y + WALL_Y + 0.2, 0, 0, '#f5f1ea');
  const merlonGeo = new RoundedBoxGeometry(0.42, 0.34, 0.5, 2, 0.04);
  for (let z = Z0 + 0.5; z < Z1; z += 0.95) stone.add(merlonGeo, parapetX, QUAY_Y + WALL_Y + 0.58, z, 0, STONE_TINTS[Math.floor(r() * STONE_TINTS.length)]);
  // chemin de ronde
  const walk = new THREE.Mesh(new THREE.PlaneGeometry(WALL_X0 - WALL_X1 - 0.7, quayLen), cobble);
  walk.rotation.x = -Math.PI / 2;
  walk.position.set((WALL_X0 - 0.6 + WALL_X1) / 2, QUAY_Y + WALL_Y + 0.002, 0);
  walk.receiveShadow = true;
  scene.add(walk);

  /* bastion rond et porte fortifiée */
  const bastion = (z: number, rad: number, h: number) => {
    stone.add(new THREE.CylinderGeometry(rad * 0.94, rad, h, 28, 1), WALL_X0 - rad * 0.55, QUAY_Y + h / 2, z, 0, '#ffffff');
    stone.add(new THREE.CylinderGeometry(rad + 0.06, rad + 0.06, 0.14, 28, 1), WALL_X0 - rad * 0.55, QUAY_Y + h - 0.05, z, 0, '#f2eee6');
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 9) {
      stone.add(merlonGeo, WALL_X0 - rad * 0.55 + Math.cos(a) * (rad - 0.12), QUAY_Y + h + 0.17, z + Math.sin(a) * (rad - 0.12), -a, STONE_TINTS[Math.floor(r() * STONE_TINTS.length)]);
    }
  };
  bastion(-15, 1.9, WALL_Y + 0.5);
  bastion(26, 1.6, WALL_Y + 0.4);
  // la Grande Porte : deux tours à toit pointu et une voûte sombre
  const gateZ = 9;
  for (const dz of [-1.5, 1.5]) {
    stone.add(new THREE.CylinderGeometry(0.95, 1.0, WALL_Y + 1.4, 24, 1), WALL_X0 - 0.5, QUAY_Y + (WALL_Y + 1.4) / 2, gateZ + dz, 0, '#f7f3ec');
    roofs.add(new THREE.ConeGeometry(1.08, 1.5, 24, 1), WALL_X0 - 0.5, QUAY_Y + WALL_Y + 1.4 + 0.75, gateZ + dz, 0, '#ffffff');
  }
  stone.add(new THREE.BoxGeometry(1.2, WALL_Y + 0.9, 2.2), WALL_X0 - 0.75, QUAY_Y + (WALL_Y + 0.9) / 2, gateZ, 0, '#f2ede4');
  const arch = new THREE.Shape();
  arch.moveTo(-0.55, 0);
  arch.lineTo(-0.55, 0.9);
  arch.absarc(0, 0.9, 0.55, Math.PI, 0, true);
  arch.lineTo(0.55, 0);
  arch.closePath();
  const archMesh = new THREE.Mesh(new THREE.ShapeGeometry(arch), new THREE.MeshBasicMaterial({ color: 0x15181c }));
  archMesh.rotation.y = Math.PI / 2;
  archMesh.position.set(WALL_X0 - 0.14, QUAY_Y, gateZ);
  scene.add(archMesh);

  /* maisons d'armateurs : hautes, granit, toits d'ardoise, lucarnes, souches de cheminée */
  const wins: Inst[] = [];
  const frames: Inst[] = [];
  const shutters: Inst[] = [];
  const rows = small ? [{ x: -19.6, d: 3.4, base: TOWN_Y, back: 0 }] : [
    { x: -19.6, d: 3.4, base: TOWN_Y, back: 0 },
    { x: -24.4, d: 3.2, base: TOWN_Y + 0.7, back: 1 },
  ];
  const FLOOR = 0.62;
  for (const row of rows) {
    let z = Z0 + r() * 1.5;
    while (z < Z1) {
      const w = 1.7 + r() * 1.2;
      const floors = 4 + Math.floor(r() * 2) + row.back;
      const h = floors * FLOOR + 0.3;
      const tint = STONE_TINTS[Math.floor(r() * STONE_TINTS.length)];
      const cz = z + w / 2;
      const front = row.x + row.d / 2; // façade côté bassin
      // corps de la maison (arêtes adoucies) et pignons
      house.add(new RoundedBoxGeometry(row.d, h, w - 0.04, 2, 0.05), row.x, row.base + h / 2, cz, 0, tint);
      // corniche
      house.add(new THREE.BoxGeometry(row.d + 0.16, 0.08, w + 0.02), row.x, row.base + h, cz, 0, '#f6f2ea');
      // toit pentu
      const roofH = 1.15 + r() * 0.5;
      roofs.add(gableGeo(row.d, roofH, w - 0.06, 0.1), row.x, row.base + h + 0.04, cz, 0, ['#ffffff', '#e8edf3', '#dfe5ec', '#f2f2f2'][Math.floor(r() * 4)]);
      // souches de cheminée massives sur les murs mitoyens
      for (const side of [-1, 1]) {
        if (r() < 0.25) continue;
        const ch = roofH + 0.55 + r() * 0.35;
        house.add(new RoundedBoxGeometry(row.d * 0.42, ch, 0.36, 2, 0.04), row.x, row.base + h + ch / 2 - 0.05, cz + side * (w / 2 - 0.2), 0, tint);
        house.add(new THREE.BoxGeometry(row.d * 0.46, 0.08, 0.42), row.x, row.base + h + ch - 0.04, cz + side * (w / 2 - 0.2), 0, '#f6f2ea');
        for (let k = 0; k < 3; k++) house.add(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 8), row.x - row.d * 0.12 + k * row.d * 0.12, row.base + h + ch + 0.06, cz + side * (w / 2 - 0.2), 0, '#b8644b');
      }
      // lucarnes
      const nd = w > 2.3 ? 2 : 1;
      for (let k = 0; k < nd; k++) {
        const dz = nd === 1 ? 0 : (k - 0.5) * w * 0.48;
        const lx = front - 0.32;
        const ly = row.base + h + 0.28;
        house.add(new THREE.BoxGeometry(0.5, 0.56, 0.5), lx, ly + 0.1, cz + dz, 0, tint);
        roofs.add(gableGeo(0.56, 0.32, 0.56, 0.05), lx, ly + 0.38, cz + dz, Math.PI / 2, '#ffffff');
        wins.push({ x: lx + 0.255, y: ly + 0.1, z: cz + dz, sx: 1, sy: 0.75, sz: 0.62 });
        frames.push({ x: lx + 0.25, y: ly + 0.1, z: cz + dz, sx: 1, sy: 0.82, sz: 0.7 });
      }
      // fenêtres de la façade
      const cols = Math.max(2, Math.round(w / 0.72));
      for (let f = 0; f < floors; f++) {
        const wy = row.base + 0.42 + f * FLOOR;
        if (wy < QUAY_Y + WALL_Y + 0.6 && row.back === 0) continue; // caché par le rempart
        for (let c = 0; c < cols; c++) {
          const wz = cz + (c - (cols - 1) / 2) * (w / cols);
          const tall = f === 1 ? 1.12 : 1;
          frames.push({ x: front + 0.005, y: wy, z: wz, sx: 1, sy: tall, sz: 1 });
          wins.push({ x: front + 0.012, y: wy, z: wz, sx: 1, sy: tall, sz: 1 });
          if (r() < 0.35) shutters.push({ x: front + 0.02, y: wy, z: wz + (r() < 0.5 ? -0.27 : 0.27), color: ['#5d6b78', '#6f7e70', '#8a8e93', '#4f6378'][Math.floor(r() * 4)] });
        }
      }
      z += w;
    }
  }

  /* cathédrale Saint-Vincent : tour carrée et flèche */
  const cx = -23.5;
  const cz = 2.5;
  house.add(new THREE.BoxGeometry(2.4, 6.4, 2.4), cx, TOWN_Y + 3.2, cz, 0, '#efe9df');
  house.add(new THREE.BoxGeometry(2.6, 0.18, 2.6), cx, TOWN_Y + 6.4, cz, 0, '#f6f2ea');
  for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) house.add(new THREE.ConeGeometry(0.18, 0.9, 6), cx + dx * 1.1, TOWN_Y + 6.9, cz + dz * 1.1, 0, '#efe9df');
  roofs.add(new THREE.ConeGeometry(1.25, 6.0, 8, 1), cx, TOWN_Y + 6.5 + 3.0, cz, Math.PI / 8, '#d5dee6');
  // abat-sons
  for (const side of [-1, 1]) {
    frames.push({ x: cx + 1.205, y: TOWN_Y + 5.3, z: cz + side * 0.45, sx: 1, sy: 2.2, sz: 0.9 });
    wins.push({ x: cx + 1.21, y: TOWN_Y + 5.3, z: cz + side * 0.45, sx: 1, sy: 2.0, sz: 0.75 });
  }

  /* village de course sur le quai : tentes pagodes, pavillons, banderole */
  const tentMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.75 });
  const tents = new Builder(1);
  for (let z = -30; z < 30; z += 4.2) {
    if (Math.abs(z - gateZ) < 3) continue;
    const tx = -12.6;
    tents.add(new THREE.BoxGeometry(1.5, 0.75, 1.5), tx, QUAY_Y + 0.375, z, 0, '#ffffff');
    tents.add(new THREE.ConeGeometry(1.15, 0.7, 4, 1), tx, QUAY_Y + 0.75 + 0.35, z, Math.PI / 4, '#ffffff');
    tents.add(new THREE.CylinderGeometry(0.012, 0.012, 0.35, 5), tx, QUAY_Y + 1.6, z, 0, '#ffffff');
  }
  const tm = tents.build(tentMat);
  if (tm) scene.add(tm);
  // bandeaux de couleur sur les tentes
  const bands: Inst[] = [];
  const BAND = ['#1d4ed8', '#e11d48', '#0ea5e9', '#f59e0b', '#10b981', '#7c3aed'];
  let bi = 0;
  for (let z = -30; z < 30; z += 4.2) {
    if (Math.abs(z - gateZ) < 3) continue;
    bands.push({ x: -12.6 + 0.752, y: QUAY_Y + 0.62, z, color: BAND[bi++ % BAND.length] });
  }
  const bandMesh = instanced(new THREE.BoxGeometry(0.01, 0.16, 1.5), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), bands);
  if (bandMesh) scene.add(bandMesh);

  // bornes d'amarrage sur la margelle
  const bollards: Inst[] = [];
  for (let z = -40; z < 40; z += 3.1) bollards.push({ x: QUAY_X - 0.3, y: QUAY_Y + 0.14, z });
  const bol = instanced(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 12), iron, bollards, true);
  if (bol) scene.add(bol);

  // réverbères sur le quai
  const lamps: Inst[] = [];
  for (let z = -36; z < 36; z += 7) lamps.push({ x: -13.9, y: QUAY_Y + 0.7, z });
  const lampPost = instanced(new THREE.CylinderGeometry(0.025, 0.035, 1.4, 8), iron, lamps, true);
  if (lampPost) scene.add(lampPost);
  const lampHead = instanced(new THREE.BoxGeometry(0.14, 0.18, 0.14), new THREE.MeshStandardMaterial({ color: 0x2a2f36, emissive: 0xffd9a0, emissiveIntensity: 0.25, roughness: 0.4 }), lamps.map((l) => ({ ...l, y: QUAY_Y + 1.45 })));
  if (lampHead) scene.add(lampHead);

  /* matériaux fusionnés */
  for (const m of [stone.build(stoneMat), house.build(houseMat), roofs.build(slateMat)]) if (m) scene.add(m);
  // fenêtres : encadrement blanc, vitre sombre, volets
  const fr = instanced(new THREE.BoxGeometry(0.02, 0.44, 0.34), white, frames);
  const gl = instanced(new THREE.BoxGeometry(0.02, 0.36, 0.26), glass, wins);
  const sh = instanced(new THREE.BoxGeometry(0.02, 0.4, 0.15), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), shutters);
  for (const m of [fr, gl, sh]) if (m) scene.add(m);

  /* banderole du village départ, entre deux mâts sur le quai */
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.7), new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }));
  banner.position.set(-11.9, 1.75, 2.2);
  banner.rotation.y = Math.PI / 2;
  scene.add(banner);
  for (const dz of [-2.35, 2.35]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 8), white);
    pole.position.set(-11.9, QUAY_Y + 1.1, 2.2 + dz);
    pole.castShadow = true;
    scene.add(pole);
  }
  (banner.material as THREE.MeshStandardMaterial).map = bannerTexture('Route du Rhum');
  return banner;
}
