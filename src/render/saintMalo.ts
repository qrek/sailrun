import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bannerTexture } from './harbourTown';
import { cloudTreeGeo, pineGeo, rockGeo } from './terrainProps';

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

/** Fronton triangulaire (plaqué sur la façade). */
function gableWall(w: number, h: number, t: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  sh.moveTo(-w / 2, 0);
  sh.lineTo(w / 2, 0);
  sh.lineTo(0, h);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
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
  const Z0 = -110;
  const Z1 = 110;

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
  const plaster = new Builder(0.42);
  // palette : granits clairs, sombres, chauds, et quelques façades enduites
  const GRANITES = ['#ffffff', '#f3eee6', '#e2ddd5', '#d5cfc6', '#f7ecd9', '#e9e6e1', '#c9c3ba', '#efe2cc'];
  const PLASTERS = ['#f7f4ec', '#f3e7d3', '#e9eef0', '#f1e2d8', '#e6e9df'];
  const SHUT = ['#5d6b78', '#6f7e70', '#8a8e93', '#4f6378', '#7b3f3a', '#2f5d7c', '#9a8f7a'];
  for (const row of rows) {
    let z = Z0 + r() * 1.5;
    while (z < Z1) {
      // un vide de temps en temps (cour, jardin, ruelle)
      if (r() < 0.06) {
        z += 0.8 + r() * 1.2;
        continue;
      }
      const big = r() < 0.08; // hôtel particulier d'armateur
      const w = big ? 3.2 + r() * 0.8 : 1.3 + r() * 1.9;
      const floors = (big ? 5 : 3 + Math.floor(r() * 4)) + row.back;
      const h = floors * FLOOR + 0.3;
      const isPlaster = !big && r() < 0.22;
      const tint = isPlaster ? PLASTERS[Math.floor(r() * PLASTERS.length)] : GRANITES[Math.floor(r() * GRANITES.length)];
      const body = isPlaster ? plaster : house;
      const setback = (r() - 0.5) * 0.7;
      const rx = row.x + setback;
      const cz = z + w / 2;
      const front = rx + row.d / 2; // façade côté bassin
      body.add(new RoundedBoxGeometry(row.d, h, w - 0.04, 2, 0.05), rx, row.base + h / 2, cz, 0, tint);
      body.add(new THREE.BoxGeometry(row.d + 0.16, 0.08, w + 0.02), rx, row.base + h, cz, 0, '#f6f2ea');
      // toits variés : long pan, pignon sur le bassin, croupe
      const kind = big ? 2 : r();
      const roofH = 0.95 + r() * 0.75;
      const slate = ['#ffffff', '#e8edf3', '#dfe5ec', '#f2f2f2', '#d3dae2'][Math.floor(r() * 5)];
      if (kind < 0.6) {
        roofs.add(gableGeo(row.d, roofH, w - 0.06, 0.1), rx, row.base + h + 0.04, cz, 0, slate);
      } else if (kind < 0.82) {
        // pignon tourné vers le bassin
        roofs.add(gableGeo(w - 0.06, roofH * 1.15, row.d, 0.1), rx, row.base + h + 0.04, cz, Math.PI / 2, slate);
      } else {
        const hip = new THREE.ConeGeometry(0.72, roofH, 4, 1);
        hip.rotateY(Math.PI / 4);
        hip.scale(row.d * 0.98, 1, (w - 0.06) * 0.98);
        roofs.add(hip, rx, row.base + h + 0.04 + roofH / 2, cz, 0, slate);
      }
      // souches de cheminée : de zéro à deux, sur les murs mitoyens
      const nch = big ? 2 : Math.floor(r() * 2.6);
      for (let k = 0; k < nch; k++) {
        const side = k === 0 ? (r() < 0.5 ? -1 : 1) : -1 * (k === 1 ? 1 : -1);
        const ch = roofH * 0.8 + 0.4 + r() * 0.45;
        const cw = 0.3 + r() * 0.18;
        body.add(new RoundedBoxGeometry(row.d * (0.32 + r() * 0.2), ch, cw, 2, 0.04), rx - 0.1 + r() * 0.2, row.base + h + ch / 2 - 0.05, cz + side * (w / 2 - cw / 2 - 0.02), 0, tint);
        const pots = 1 + Math.floor(r() * 4);
        for (let j = 0; j < pots; j++) house.add(new THREE.CylinderGeometry(0.045, 0.05, 0.14 + r() * 0.06, 8), rx - 0.15 + j * 0.12, row.base + h + ch + 0.05, cz + side * (w / 2 - cw / 2 - 0.02), 0, ['#b8644b', '#9d5a46', '#c27a5c'][j % 3]);
      }
      // lucarnes : aucune à trois
      const nd = kind < 0.6 ? Math.min(3, Math.floor(r() * (w / 0.9 + 1))) : big ? 3 : 0;
      for (let k = 0; k < nd; k++) {
        const dz = (k - (nd - 1) / 2) * (w / (nd + 0.4));
        const lx = front - 0.32;
        const ly = row.base + h + 0.28;
        body.add(new THREE.BoxGeometry(0.5, 0.56, 0.5), lx, ly + 0.1, cz + dz, 0, tint);
        roofs.add(gableGeo(0.56, 0.32, 0.56, 0.05), lx, ly + 0.38, cz + dz, Math.PI / 2, slate);
        wins.push({ x: lx + 0.255, y: ly + 0.1, z: cz + dz, sx: 1, sy: 0.75, sz: 0.62 });
        frames.push({ x: lx + 0.25, y: ly + 0.1, z: cz + dz, sx: 1, sy: 0.82, sz: 0.7 });
      }
      // fenêtres : grilles différentes selon la maison
      const cols = Math.max(1, Math.round(w / (0.6 + r() * 0.35)));
      const shut = r() < 0.5 ? SHUT[Math.floor(r() * SHUT.length)] : null;
      const tallFloor = 1 + Math.floor(r() * 2);
      for (let f = 0; f < floors; f++) {
        const wy = row.base + 0.42 + f * FLOOR;
        if (wy < QUAY_Y + WALL_Y + 0.6 && row.back === 0) continue; // caché par le rempart
        for (let c = 0; c < cols; c++) {
          if (big && c === Math.floor(cols / 2) && f === tallFloor) continue;
          const wz = cz + (c - (cols - 1) / 2) * (w / cols);
          const tall = f === tallFloor ? 1.15 : 1;
          frames.push({ x: front + 0.005, y: wy, z: wz, sx: 1, sy: tall, sz: 1 });
          wins.push({ x: front + 0.012, y: wy, z: wz, sx: 1, sy: tall, sz: 1 });
          if (shut) shutters.push({ x: front + 0.02, y: wy, z: wz - 0.27, color: shut }, { x: front + 0.02, y: wy, z: wz + 0.27, color: shut });
        }
      }
      // fronton central des hôtels d'armateurs
      if (big) {
        body.add(gableWall(1.4, 0.55, 0.12), front + 0.06, row.base + h, cz, 0, '#f6f2ea');
      }
      z += w;
    }
  }
  const pm = plaster.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  if (pm) scene.add(pm);

  /* le château : donjon et tours rondes crénelées, au bout du rempart */
  const chz = -38;
  stone.add(new THREE.BoxGeometry(4.2, 7.2, 4.6), -19.5, TOWN_Y + 3.6 - 1.4, chz, 0, '#ebe5dc');
  for (const [dx, dz, rad, hh] of [[2.2, -2.4, 1.3, 7.6], [2.2, 2.4, 1.15, 7.0], [-2.1, -2.4, 1.0, 6.4]] as const) {
    stone.add(new THREE.CylinderGeometry(rad, rad * 1.08, hh, 24, 1), -19.5 + dx, TOWN_Y + hh / 2 - 1.4, chz + dz, 0, '#f2ede4');
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 7) stone.add(merlonGeo, -19.5 + dx + Math.cos(a) * (rad - 0.1), TOWN_Y + hh - 1.4 + 0.17, chz + dz + Math.sin(a) * (rad - 0.1), -a, STONE_TINTS[Math.floor(r() * STONE_TINTS.length)]);
  }
  for (let z2 = chz - 2.1; z2 <= chz + 2.1; z2 += 0.6) stone.add(merlonGeo, -19.5 + 2.0, TOWN_Y + 7.2 - 1.4 + 0.17, z2, 0, '#f2ede4');

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
  buildBay(scene, small, r, slateMat);
  return banner;
}

/** Bruit doux déterministe. */
function vn(x: number, y: number): number {
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

/**
 * La baie fermée : la côte d'en face (Dinard, Saint-Servan) en demi-cercle, collines boisées, villas,
 * rochers et plages ; le môle et son phare ; le Grand Bé et le Fort National sur leurs îlots.
 * Où que l'on tourne la caméra, l'horizon est une côte, jamais un vide.
 */
function buildBay(scene: THREE.Scene, small: boolean, r: () => number, slateMat: THREE.Material) {
  // terrain en anneau : angle de −110° à +110° autour de +x, rayon intérieur variable
  const NA = small ? 90 : 160;
  const NR = 10;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const A0 = (-112 * Math.PI) / 180;
  const A1 = (112 * Math.PI) / 180;
  const heightAt = (a: number, k: number) => {
    // k : 0 au bord de l'eau, 1 au fond
    const ridge = 6 + 16 * vn(a * 3.1 + 4, 1.3) + 8 * vn(a * 9 + 1, 7);
    const rise = Math.pow(Math.min(1, k * 1.6), 1.4);
    return -0.4 + rise * ridge + (k > 0.15 ? (vn(a * 22, k * 6) - 0.5) * 2.2 : 0);
  };
  const innerR = (a: number) => 120 + 45 * vn(a * 2.2 + 9, 3.3) + 20 * vn(a * 7, 1.1);
  const cSand = new THREE.Color('#e9dcb8');
  const cRock = new THREE.Color('#9a958b');
  const cGrass = new THREE.Color('#7fae5a');
  const cForest = new THREE.Color('#3f7a3a');
  for (let i = 0; i <= NA; i++) {
    const a = A0 + ((A1 - A0) * i) / NA;
    const R0 = innerR(a);
    for (let j = 0; j <= NR; j++) {
      const k = j / NR;
      const R = R0 + k * 140;
      const y = heightAt(a, k);
      pos.push(Math.cos(a) * R, y, Math.sin(a) * R);
      const c = new THREE.Color();
      if (y < 0.6) c.copy(cSand);
      else if (k < 0.18) c.copy(cRock).lerp(cGrass, vn(a * 30, 2));
      else c.copy(cGrass).lerp(cForest, Math.min(1, vn(a * 14, k * 5) * 1.4));
      c.offsetHSL(0, 0, (vn(a * 40, k * 9) - 0.5) * 0.08);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NA; i++)
    for (let j = 0; j < NR; j++) {
      const a = i * (NR + 1) + j;
      const b = a + NR + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const land = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  land.receiveShadow = true;
  scene.add(land);

  // villas, arbres et rochers sur la côte d'en face
  const villas: Inst[] = [];
  const villaRoofs: Inst[] = [];
  const trees: Inst[] = [];
  const pines: Inst[] = [];
  const rocks: Inst[] = [];
  const nV = small ? 90 : 220;
  for (let n = 0; n < nV * 3; n++) {
    const a = A0 + (A1 - A0) * r();
    const k = 0.05 + r() * 0.55;
    const R = innerR(a) + k * 140;
    const y = heightAt(a, k);
    if (y < 0.8) continue;
    const x = Math.cos(a) * R;
    const z = Math.sin(a) * R;
    const pick = r();
    if (pick < 0.32 && villas.length < nV) {
      const w = 2 + r() * 2.5;
      const h = 1.6 + r() * 1.8;
      villas.push({ x, y: y + h / 2 - 0.2, z, ry: -a + (r() - 0.5) * 0.4, sx: w, sy: h, sz: w * (0.7 + r() * 0.5), color: ['#f7f4ec', '#f3e7d3', '#efe9e1', '#f6efe0', '#e9e2d6'][Math.floor(r() * 5)] });
      villaRoofs.push({ x, y: y + h - 0.2, z, ry: -a, sx: w * 1.1, sy: 1.1 + r() * 0.7, sz: w * (0.8 + r() * 0.5) });
    } else if (pick < 0.8) {
      const sc = 2.4 + r() * 2.6;
      trees.push({ x, y: y - 0.2, z, ry: r() * 6, sx: sc, sy: sc, sz: sc });
    } else {
      const sc = 2.6 + r() * 2.8;
      pines.push({ x, y: y - 0.2, z, ry: r() * 6, sx: sc, sy: sc * 1.2, sz: sc });
    }
  }
  for (let n = 0; n < (small ? 40 : 90); n++) {
    const a = A0 + (A1 - A0) * r();
    const R = innerR(a) - 1 + r() * 4;
    const sc = 1.5 + r() * 3.5;
    rocks.push({ x: Math.cos(a) * R, y: -0.3, z: Math.sin(a) * R, ry: r() * 6, sx: sc, sy: sc * 0.6, sz: sc });
  }
  const villaGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofGeo = new THREE.ConeGeometry(0.75, 1, 4, 1);
  roofGeo.rotateY(Math.PI / 4);
  roofGeo.translate(0, 0.5, 0);
  const add = (m: THREE.Object3D | null) => m && scene.add(m);
  add(instanced(villaGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), villas, false));
  add(instanced(roofGeo, slateMat, villaRoofs, false));
  add(instanced(cloudTreeGeo(small ? 5 : 6), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), trees, false));
  add(instanced(pineGeo(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), pines, false));
  add(instanced(rockGeo(3), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), rocks, false));

  // le môle des Noires et son phare, qui ferme le bassin côté large
  const mole = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.92 });
  const pts: THREE.Vector3[] = [new THREE.Vector3(-11, 0, 110), new THREE.Vector3(20, 0, 96), new THREE.Vector3(48, 0, 70), new THREE.Vector3(62, 0, 44)];
  const curve = new THREE.CatmullRomCurve3(pts);
  for (let t = 0; t < 1; t += 0.012) {
    const p = curve.getPoint(t);
    const q2 = curve.getPoint(Math.min(1, t + 0.012));
    const seg = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.6, p.distanceTo(q2) + 0.3), stone);
    seg.position.set((p.x + q2.x) / 2, 0.3, (p.z + q2.z) / 2);
    seg.lookAt(q2.x, 0.3, q2.z);
    seg.receiveShadow = true;
    mole.add(seg);
  }
  const tip = curve.getPoint(1);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.95, 6.5, 20), new THREE.MeshStandardMaterial({ color: 0xf6f4ef, roughness: 0.6 }));
  tower.position.set(tip.x, 1.1 + 3.25, tip.z);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.6, 20), new THREE.MeshStandardMaterial({ color: 0xd2342c, roughness: 0.5 }));
  top.position.set(tip.x, 1.1 + 6.5 + 0.8, tip.z);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 10), new THREE.MeshStandardMaterial({ color: 0xfff3c8, emissive: 0xffe2a0, emissiveIntensity: 1.2 }));
  lamp.position.set(tip.x, 1.1 + 6.5 + 1.9, tip.z);
  mole.add(tower, top, lamp);
  mole.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  scene.add(mole);

  // îlots : le Grand Bé (herbe et rochers) et le Fort National
  const islet = (x: number, z: number, rad: number, h: number, fort: boolean) => {
    const geo = new THREE.SphereGeometry(rad, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    geo.scale(1, h / rad, 1);
    const p = geo.attributes.position as THREE.BufferAttribute;
    const c: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const yy = p.getY(i);
      p.setX(i, p.getX(i) * (0.9 + 0.2 * vn(i * 0.7, 1)));
      p.setZ(i, p.getZ(i) * (0.9 + 0.2 * vn(i * 0.9, 2)));
      const cc = yy < h * 0.35 ? cRock : cGrass;
      c.push(cc.r, cc.g, cc.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
    m.position.set(x, -0.5, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    if (fort) {
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.55, rad * 0.6, 2.2, 6), stone);
      wall.position.set(x, h - 0.5 + 0.6, z);
      wall.castShadow = true;
      scene.add(wall);
    }
  };
  islet(78, -46, 9, 6, false);
  islet(104, 18, 7, 4.5, true);
  islet(92, -12, 3, 1.5, false);
}
