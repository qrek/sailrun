import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cloudTreeGeo, pineGeo, rockGeo } from './terrainProps';

/**
 * Le village du port de départ, façon diorama (mêmes couleurs que la carte) :
 * quai de pierre claire, maisons pastel à volets, toits de tuile et d'ardoise bleue,
 * colline verte plantée d'arbres « nuage », rochers clairs, phare, tentes et pavillons.
 *
 * Tout est fusionné par matériau (couleurs dans les sommets) ou instancié : quelques dizaines
 * d'appels de dessin pour toute la ville. Repère : le port est côté +x, le quai court le long de z.
 */

const QUAY_Y = 0.42; // dessus du quai
const QUAY_X0 = -11; // bord du quai côté eau
const ROW_X = [-13.55, -16.1, -18.6]; // milieu des rangées de maisons

const WALLS = ['#fdf3df', '#f7e1b5', '#fde7d1', '#e3f0e6', '#dcebf5', '#f9d9c8', '#fff6e8', '#f2e6c8', '#e8f3dc'];
const SHUTTERS = ['#2f7fb6', '#3aa17e', '#e05a47', '#f2b134', '#5b8fd6', '#2b6c8f', '#8fbf4a'];
const ROOFS = ['#d46e4e', '#c9654a', '#56708b', '#e08a5a', '#64809e'];

/** Bruit doux déterministe. */
function vnoise(x: number, y: number): number {
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

/** Hauteur de la colline derrière le quai. */
export function hillHeight(x: number, z: number): number {
  if (x > -14.25) return QUAY_Y;
  const d = -14.25 - x;
  const rise = d < 6 ? d * 0.34 : 2.04 + (d - 6) * 0.55;
  return QUAY_Y + rise + (vnoise(x * 0.25, z * 0.25) - 0.5) * 0.6 * Math.min(1, d / 4) + Math.max(0, Math.abs(z) - 22) * 0.05;
}

class Batch {
  private parts: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  add(geo: THREE.BufferGeometry, color: string | THREE.Color, x: number, y: number, z: number, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()) as THREE.BufferGeometry;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.e.set(0, ry, rz);
    this.q.setFromEuler(this.e);
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(this.m);
    this.parts.push(g);
  }
  mesh(mat: THREE.Material, shadows = true): THREE.Mesh | null {
    if (!this.parts.length) return null;
    const g = mergeGeometries(this.parts)!;
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** Store rayé (blanc et gris clair : la couleur vient de l'instance). */
function awningTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 8;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#ffffff' : '#c8c8c8';
    g.fillRect(i * 8, 0, 8, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Banderole du départ. */
export function bannerTexture(title: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0B1E33';
  g.fillRect(0, 0, 1024, 160);
  g.fillStyle = '#FF7A1A';
  g.fillRect(0, 0, 1024, 14);
  g.fillRect(0, 146, 1024, 14);
  g.fillStyle = '#FFFFFF';
  g.font = 'italic 800 76px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(`VILLAGE DÉPART · ${title.toUpperCase()}`, 512, 84, 980);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface Inst {
  m: THREE.Matrix4;
  c: THREE.Color;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[], shadows = false): THREE.InstancedMesh | null {
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((it, i) => {
    im.setMatrixAt(i, it.m);
    im.setColorAt(i, it.c);
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = shadows;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}

export function buildTown(scene: THREE.Scene, small: boolean): THREE.Mesh {
  const rnd = (() => {
    let s = 7;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  })();
  const walls = new Batch(); // murs, pignons, cheminées, corniches (mat)
  const roofs = new Batch(); // toits (un peu satinés)
  const stone = new Batch(); // quai, soubassements, jetée
  const wood = new Batch(); // portes, bancs
  const iron = new Batch(); // réverbères, bornes, garde-corps
  const frames: Inst[] = [];
  const glass: Inst[] = [];
  const shutters: Inst[] = [];
  const awnings: Inst[] = [];
  const flowers: Inst[] = [];
  const trees: Inst[] = [];
  const pines: Inst[] = [];
  const rocks: Inst[][] = [[], [], []];
  const tmp = new THREE.Object3D();
  const put = (list: Inst[], x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string | THREE.Color, ry = 0, rx = 0) => {
    tmp.position.set(x, y, z);
    tmp.rotation.set(rx, ry, 0);
    tmp.scale.set(sx, sy, sz);
    tmp.updateMatrix();
    list.push({ m: tmp.matrix.clone(), c: new THREE.Color(color) });
  };
  const box = new THREE.BoxGeometry(1, 1, 1);

  /* ---------- quai, promenade, jetée ---------- */
  stone.add(box, '#ddd5c4', -12.6, QUAY_Y - 0.5, 0, 0, 0, 3.4, 1.0, 92);
  stone.add(box, '#f0ebe0', QUAY_X0 - 0.1, QUAY_Y + 0.02, 0, 0, 0, 0.22, 0.06, 92); // margelle
  for (let z = -40; z < 40; z += 0.8) stone.add(box, z % 1.6 === 0 ? '#d3cab8' : '#d9d1c0', QUAY_X0 + 0.02, QUAY_Y - 0.55, z + 0.4, 0, 0, 0.06, 0.9, 0.76); // appareillage
  stone.add(box, '#e4ddcf', -6, 0.1, -40, 0, 0, 24, 0.8, 1.6); // jetée du phare

  /* ---------- colline : terrain vert, chemins de sable ---------- */
  const HW = 70;
  const HD = 34;
  const hg = new THREE.PlaneGeometry(HD, HW, small ? 40 : 64, small ? 80 : 128);
  hg.rotateX(-Math.PI / 2);
  hg.translate(-14.25 - HD / 2, 0, 0);
  const hp = hg.attributes.position as THREE.BufferAttribute;
  const hcol = new Float32Array(hp.count * 3);
  const grassA = new THREE.Color('#8cc152');
  const grassB = new THREE.Color('#b4d36b');
  const forest = new THREE.Color('#5f9e46');
  const sand = new THREE.Color('#ecd9a8');
  const rock = new THREE.Color('#c9c7c0');
  const cc = new THREE.Color();
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i);
    const z = hp.getZ(i);
    const y = hillHeight(x, z) - 0.02;
    hp.setY(i, y);
    const n = vnoise(x * 0.35, z * 0.35);
    const n2 = vnoise(x * 1.3 + 40, z * 1.3);
    cc.copy(grassA).lerp(grassB, n);
    if (n2 > 0.62) cc.lerp(forest, (n2 - 0.62) * 2.2);
    // sentier sableux qui serpente dans la colline
    const path = Math.abs(z - 6 * Math.sin(x * 0.18) - 3);
    if (path < 0.35 && x < -15) cc.lerp(sand, 1 - path / 0.35);
    const steep = Math.abs(hillHeight(x + 0.2, z) - hillHeight(x - 0.2, z)) / 0.4;
    if (steep > 0.7) cc.lerp(rock, Math.min(1, (steep - 0.7) * 2));
    hcol[i * 3] = cc.r;
    hcol[i * 3 + 1] = cc.g;
    hcol[i * 3 + 2] = cc.b;
  }
  hg.setAttribute('color', new THREE.BufferAttribute(hcol, 3));
  hg.computeVertexNormals();
  const hill = new THREE.Mesh(hg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  hill.receiveShadow = true;
  scene.add(hill);

  /* ---------- maisons ---------- */
  const occupied: [number, number, number][] = []; // [x, z0, z1] pour ne pas planter d'arbres dedans
  const roundBox = new RoundedBoxGeometry(1, 1, 1, 2, 0.06);
  const gable = (() => {
    const sh = new THREE.Shape();
    sh.moveTo(-0.5, 0);
    sh.lineTo(0.5, 0);
    sh.lineTo(0, 1);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false });
    g.translate(0, 0, -0.5);
    g.rotateY(Math.PI / 2); // triangle dans le plan x-y -> faîtage le long de z
    return g;
  })();
  const house = (x: number, z: number, row: number, k: number) => {
    const floors = row === 0 ? 2 + (k % 3 === 0 ? 1 : 0) + (k % 7 === 0 ? 1 : 0) : 1 + (k % 2) + (k % 5 === 0 ? 1 : 0);
    const bays = 2 + (k % 3 === 1 ? 1 : 0);
    const w = bays * 0.56 + 0.1;
    const d = 1.25;
    const fh = 0.46;
    const ground = row === 0 ? QUAY_Y : Math.min(hillHeight(x + d / 2, z), hillHeight(x + d / 2, z + w), hillHeight(x - d / 2, z), hillHeight(x - d / 2, z + w));
    const h = 0.52 + floors * fh;
    const wall = WALLS[(k * 5 + row * 3) % WALLS.length];
    const sh = SHUTTERS[(k * 3 + row) % SHUTTERS.length];
    const roofC = ROOFS[(k + row * 2) % ROOFS.length];
    const cz = z + w / 2;
    // soubassement en pierre (rattrape la pente) et corps de la maison
    const baseH = Math.max(0.08, (row === 0 ? 0 : Math.max(hillHeight(x + d / 2, z), hillHeight(x - d / 2, z + w)) - ground) + 0.08);
    stone.add(box, '#d8cfbe', x, ground + baseH / 2 - 0.04, cz, 0, 0, d + 0.04, baseH, w + 0.04);
    const y0 = ground + baseH - 0.04;
    walls.add(roundBox, wall, x, y0 + h / 2, cz, 0, 0, d, h, w);
    // corniche blanche
    walls.add(box, '#ffffff', x, y0 + h - 0.02, cz, 0, 0, d + 0.06, 0.05, w + 0.06);
    // pignons et toit à deux pans (faîtage le long du quai)
    const rh = 0.42 + (k % 2) * 0.12;
    walls.add(gable, wall, x, y0 + h, cz, 0, 0, d, rh, w - 0.02);
    const slope = Math.atan2(rh, d / 2);
    const len = Math.hypot(rh, d / 2) + 0.12;
    for (const sgn of [-1, 1]) {
      roofs.add(roundBox, roofC, x + (sgn * d) / 4 + sgn * 0.02, y0 + h + rh / 2 + 0.03, cz, 0, sgn * slope, len, 0.07, w + 0.16);
    }
    roofs.add(box, '#f4efe6', x, y0 + h + rh + 0.03, cz, 0, 0, 0.1, 0.06, w + 0.18); // faîtière
    // cheminée
    const chz = k % 2 ? z + 0.22 : z + w - 0.22;
    walls.add(roundBox, '#f6f1e6', x - 0.15, y0 + h + rh * 0.75, chz, 0, 0, 0.2, 0.42, 0.24);
    walls.add(box, '#9a8f80', x - 0.15, y0 + h + rh * 0.75 + 0.22, chz, 0, 0, 0.24, 0.05, 0.28);
    // fenêtres, volets, jardinières (façade côté port, +x)
    const fx = x + d / 2;
    for (let f = 0; f < floors; f++) {
      for (let b = 0; b < bays; b++) {
        const wz = z + 0.33 + b * 0.56;
        const wy = y0 + 0.62 + f * fh + 0.13;
        put(frames, fx + 0.005, wy, wz, 0.03, 0.3, 0.22, '#ffffff');
        put(glass, fx + 0.012, wy, wz, 0.02, 0.24, 0.16, '#2b4a63');
        put(shutters, fx + 0.03, wy, wz - 0.17, 0.015, 0.29, 0.1, sh);
        put(shutters, fx + 0.03, wy, wz + 0.17, 0.015, 0.29, 0.1, sh);
        if ((f + b + k) % 3 === 0) {
          wood.add(box, '#7a5236', fx + 0.05, wy - 0.17, wz, 0, 0, 0.06, 0.05, 0.22);
          for (let i = 0; i < 4; i++) put(flowers, fx + 0.07, wy - 0.13, wz - 0.08 + i * 0.055, 0.035, 0.035, 0.035, ['#e2445c', '#f6a623', '#ffffff', '#d94f9a'][(i + k) % 4]);
        }
      }
      // balcon filant au premier étage, une maison sur quatre
      if (f === 1 && k % 4 === 2) {
        const by = y0 + 0.62 + f * fh - 0.04;
        stone.add(box, '#f1ece2', fx + 0.12, by, cz, 0, 0, 0.26, 0.04, w - 0.1);
        iron.add(box, '#26323d', fx + 0.24, by + 0.16, cz, 0, 0, 0.02, 0.02, w - 0.1);
        for (let i = 0; i <= Math.round((w - 0.1) / 0.06); i++) iron.add(box, '#26323d', fx + 0.24, by + 0.08, z + 0.05 + i * 0.06, 0, 0, 0.012, 0.16, 0.012);
      }
    }
    // rez-de-chaussée : porte, ou vitrine avec store pour les commerces du quai
    const shop = row === 0 && k % 3 !== 2;
    if (shop) {
      put(glass, fx + 0.01, y0 + 0.28, cz - 0.08, 0.02, 0.34, w - 0.42, '#3a5a74');
      wood.add(box, '#6d4a31', fx + 0.01, y0 + 0.24, z + w - 0.17, 0, 0, 0.03, 0.42, 0.2);
      tmp.position.set(fx + 0.17, y0 + 0.55, cz);
      tmp.rotation.set(0, 0, -0.5);
      tmp.scale.set(0.38, 0.02, w - 0.06);
      tmp.updateMatrix();
      awnings.push({ m: tmp.matrix.clone(), c: new THREE.Color(['#e05a47', '#2f7fb6', '#3aa17e', '#f2b134'][k % 4]) });
    } else {
      wood.add(box, ['#6d4a31', '#2f7fb6', '#3aa17e'][k % 3], fx + 0.01, y0 + 0.25, cz, 0, 0, 0.03, 0.44, 0.24);
      walls.add(box, '#ffffff', fx + 0.015, y0 + 0.49, cz, 0, 0, 0.03, 0.04, 0.3);
    }
    occupied.push([x, z - 0.1, z + w + 0.1]);
    return w;
  };
  ROW_X.forEach((rx, row) => {
    let z = -30 + row * 0.7;
    let k = row * 11;
    while (z < 30) {
      // ruelles qui montent entre les maisons, plus larges en haut
      const w = house(rx + (row ? (rnd() - 0.5) * 0.3 : 0), z, row, k);
      z += w + (row === 0 ? 0.02 : 0.25 + rnd() * 0.9);
      if (row === 0 && k % 6 === 5) z += 0.5;
      k++;
    }
  });

  /* ---------- quai : réverbères, bornes, bancs, pots de fleurs ---------- */
  for (let z = -27; z <= 27; z += 2.4) {
    iron.add(new THREE.CylinderGeometry(0.05, 0.065, 0.12, 10), '#26323d', -11.25, QUAY_Y + 0.06, z);
    if (Math.round(z / 2.4) % 2 === 0) {
      iron.add(new THREE.CylinderGeometry(0.014, 0.02, 0.66, 8), '#26323d', -11.6, QUAY_Y + 0.33, z + 1.2);
      iron.add(new THREE.CylinderGeometry(0.045, 0.03, 0.09, 6), '#26323d', -11.6, QUAY_Y + 0.7, z + 1.2);
    } else {
      wood.add(box, '#a7764d', -12.0, QUAY_Y + 0.1, z, 0, 0, 0.12, 0.03, 0.4);
      iron.add(box, '#26323d', -12.0, QUAY_Y + 0.05, z - 0.17, 0, 0, 0.1, 0.1, 0.02);
      iron.add(box, '#26323d', -12.0, QUAY_Y + 0.05, z + 0.17, 0, 0, 0.1, 0.1, 0.02);
      stone.add(new THREE.CylinderGeometry(0.09, 0.07, 0.14, 12), '#c97a58', -12.55, QUAY_Y + 0.07, z + 0.6);
      put(trees, -12.55, QUAY_Y + 0.1, z + 0.6, 0.28, 0.22, 0.28, '#ffffff');
    }
  }

  /* ---------- végétation et rochers sur la colline ---------- */
  const inHouse = (x: number, z: number) => occupied.some(([hx, z0, z1]) => Math.abs(x - hx) < 0.9 && z > z0 && z < z1);
  const nTrees = small ? 140 : 260;
  for (let i = 0; i < nTrees; i++) {
    const x = -14.6 - rnd() * 22;
    const z = -34 + rnd() * 68;
    if (inHouse(x, z)) continue;
    // des bosquets plutôt que des arbres semés au hasard
    if (vnoise(x * 0.35 + 9, z * 0.35) < 0.42 && x > -21) continue;
    const y = hillHeight(x, z) - 0.03;
    const s = 0.55 + rnd() * 0.55 + Math.max(0, -x - 20) * 0.03;
    const tint = rnd() < 0.08 ? '#ffd27a' : rnd() < 0.5 ? '#ffffff' : '#e8ffd8';
    if (x < -23 && rnd() < 0.45) put(pines, x, y, z, s * 0.9, s * 1.1, s * 0.9, '#ffffff', rnd() * 6);
    else put(trees, x, y, z, s, s, s, tint, rnd() * 6);
  }
  for (let i = 0; i < (small ? 40 : 90); i++) {
    const x = -14.6 - rnd() * 24;
    const z = -34 + rnd() * 68;
    if (inHouse(x, z)) continue;
    const s = 0.2 + rnd() * 0.45;
    put(rocks[i % 3], x, hillHeight(x, z) - 0.05, z, s * 1.2, s, s, '#ffffff', rnd() * 6);
  }
  // rochers au pied de la jetée et du phare
  for (let i = 0; i < 26; i++) {
    const x = -16 + rnd() * 26;
    const z = -40 + (rnd() < 0.5 ? -1 : 1) * (0.9 + rnd() * 0.5);
    const s = 0.3 + rnd() * 0.5;
    put(rocks[i % 3], x, -0.1, z, s * 1.3, s, s, '#ffffff', rnd() * 6);
  }

  /* ---------- phare ---------- */
  const white = '#f7f4ec';
  walls.add(new THREE.CylinderGeometry(0.3, 0.42, 3.2, 24), white, 6, 2.0, -40);
  walls.add(new THREE.CylinderGeometry(0.33, 0.36, 0.5, 24), '#d6362e', 6, 2.6, -40);
  walls.add(new THREE.CylinderGeometry(0.31, 0.33, 0.3, 24), '#d6362e', 6, 1.2, -40);
  stone.add(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 24), '#e9e3d6', 6, 3.62, -40);
  iron.add(new THREE.CylinderGeometry(0.24, 0.24, 0.42, 16), '#26323d', 6, 3.86, -40);
  roofs.add(new THREE.ConeGeometry(0.3, 0.32, 16), '#d6362e', 6, 4.24, -40);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.34, 16), new THREE.MeshStandardMaterial({ color: 0xfff1c0, emissive: 0xffd27a, emissiveIntensity: 0.8, roughness: 0.2 }));
  lantern.position.set(6, 3.86, -40);
  scene.add(lantern);

  /* ---------- tentes du village départ, banderole, pavillons ---------- */
  const tentMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 });
  for (const tz of [-6.2, -5.1, 8.6, 9.7]) {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(0.46, 0.42, 4, 1), tentMat);
    tent.rotation.y = Math.PI / 4;
    tent.position.set(-12.05, QUAY_Y + 0.55, tz);
    tent.castShadow = true;
    scene.add(tent);
    walls.add(box, '#ffffff', -12.05, QUAY_Y + 0.17, tz, 0, 0, 0.64, 0.34, 0.64);
    iron.add(box, '#ff7a1a', -12.05, QUAY_Y + 0.33, tz, 0, 0, 0.66, 0.04, 0.66);
  }
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.7), new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }));
  banner.position.set(-11.75, 1.35, 1.7);
  banner.rotation.y = Math.PI / 2;
  scene.add(banner);
  for (const z of [-0.6, 4.0]) iron.add(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 8), '#c6ccd2', -11.75, QUAY_Y + 0.75, z);
  const flagColors = ['#e2445c', '#ffffff', '#2f6fd6', '#f6c623', '#1aa37a'];
  const flags: Inst[] = [];
  for (const [z0, z1] of [
    [-24, -8],
    [8, 24],
  ]) {
    for (let i = 0; i <= 26; i++) {
      const t = i / 26;
      put(flags, -11.55, 1.55 - Math.sin(t * Math.PI) * 0.32, z0 + t * (z1 - z0), 0.06, 0.16, 0.06, flagColors[i % flagColors.length], 0, Math.PI);
    }
  }

  /* ---------- assemblage ---------- */
  const matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  const satin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.6 });
  for (const m of [walls.mesh(matte), roofs.mesh(satin), stone.mesh(matte), wood.mesh(matte), iron.mesh(metal, false)]) if (m) scene.add(m);
  const white1 = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.5, envMapIntensity: 1.6 });
  const awnMat = new THREE.MeshStandardMaterial({ map: awningTexture(), roughness: 0.75 });
  const plant = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, flatShading: true });
  const out = [
    instanced(box, white1, frames),
    instanced(box, glassMat, glass),
    instanced(box, white1, shutters),
    instanced(box, awnMat, awnings, true),
    instanced(new THREE.IcosahedronGeometry(1, 0), white1, flowers),
    instanced(cloudTreeGeo(small ? 6 : 7), plant, trees, true),
    instanced(pineGeo(), plant, pines, true),
    instanced(new THREE.ConeGeometry(1, 1, 3), white1, flags),
    ...rocks.map((list, k) => instanced(rockGeo(k * 5 + 2), rockMat, list, true)),
  ];
  for (const o of out) if (o) scene.add(o);
  return banner;
}
