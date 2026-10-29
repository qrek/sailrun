import * as THREE from 'three';

/**
 * La vie du village départ : foule sur le quai et le chemin de ronde, guirlandes de fanions,
 * grands drapeaux plume, goélands qui tournent, semi-rigides de spectateurs qui croisent dans le bassin,
 * grand pavois sur les bateaux voisins. Tout est instancié ; seuls les goélands et les bateaux bougent.
 * Échelle : 1 unité ≈ 7 m (le bateau mesure 2,6 unités), un passant mesure ≈ 0,25.
 */

const QUAY_Y = 0.42;
const WALK_Y = QUAY_Y + 2.7;

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const CLOTHES = ['#e63946', '#f1faee', '#1d3557', '#457b9d', '#ffb703', '#fb8500', '#2a9d8f', '#e9c46a', '#8338ec', '#ff006e', '#06d6a0', '#118ab2', '#f4a261', '#264653', '#ffffff', '#ef476f'];
const SKIN = ['#f1c7a5', '#e0ac85', '#c68863', '#8d5a3b', '#f6d7bf'];
const FLAGS = ['#e63946', '#ffd166', '#118ab2', '#ffffff', '#06d6a0', '#1d3557', '#ef476f', '#fb8500'];

interface Placed {
  x: number;
  y: number;
  z: number;
}

/** Un passant : tronc arrondi et tête, en deux maillages instanciés (vêtements, peau). */
function crowd(spots: Placed[], seed: number): THREE.Group {
  const r = rng(seed);
  const g = new THREE.Group();
  const body = new THREE.CapsuleGeometry(0.042, 0.11, 4, 8);
  body.translate(0, 0.097, 0);
  const legs = new THREE.CapsuleGeometry(0.034, 0.06, 3, 6);
  legs.translate(0, 0.03, 0);
  const head = new THREE.SphereGeometry(0.032, 10, 8);
  head.translate(0, 0.205, 0);
  const n = spots.length;
  const mk = (geo: THREE.BufferGeometry, rough: number) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: rough }), n);
    m.castShadow = true;
    m.receiveShadow = false;
    return m;
  };
  const bodies = mk(body, 0.8);
  const legsM = mk(legs, 0.85);
  const heads = mk(head, 0.6);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  spots.forEach((p, i) => {
    const s = 0.88 + r() * 0.24;
    m.makeScale(s, s * (0.9 + r() * 0.2), s).setPosition(p.x, p.y, p.z);
    bodies.setMatrixAt(i, m);
    legsM.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
    bodies.setColorAt(i, c.set(CLOTHES[Math.floor(r() * CLOTHES.length)]));
    legsM.setColorAt(i, c.set(r() < 0.6 ? '#2b3a55' : r() < 0.5 ? '#3d3d3d' : '#d9c7a7'));
    heads.setColorAt(i, c.set(SKIN[Math.floor(r() * SKIN.length)]));
  });
  g.add(bodies, legsM, heads);
  return g;
}

/** Guirlande de fanions triangulaires le long d'une chaînette entre deux points. */
function bunting(lines: [THREE.Vector3, THREE.Vector3][], seed: number, size = 1): THREE.Group {
  const r = rng(seed);
  const g = new THREE.Group();
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-0.05, 0, 0, 0.05, 0, 0, 0, -0.12, 0], 3));
  tri.computeVertexNormals();
  const flags: THREE.Matrix4[] = [];
  const cols: string[] = [];
  const cord: number[] = [];
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const [a, b] of lines) {
    const len = a.distanceTo(b);
    const sag = (0.08 * size + len * 0.06) * (size < 1 ? 0.3 : 1);
    const n = Math.max(4, Math.floor(len / (0.16 * size)));
    let prev = a.clone();
    const dir = b.clone().sub(a).setY(0).normalize();
    const yaw = Math.atan2(dir.x, dir.z) + Math.PI / 2;
    q.setFromAxisAngle(up, yaw);
    const k0 = Math.floor(r() * FLAGS.length);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const p = a.clone().lerp(b, t);
      p.y -= sag * 4 * t * (1 - t);
      cord.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
      if (i < n) {
        flags.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(size, size, size)));
        cols.push(FLAGS[(k0 + i) % FLAGS.length]);
      }
    }
  }
  const mesh = new THREE.InstancedMesh(tri, new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide }), flags.length);
  const c = new THREE.Color();
  flags.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.set(cols[i]));
  });
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cord, 3));
  g.add(mesh, new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x3a3f46 })));
  return g;
}

/** Grand drapeau « plume » (beach flag) planté sur le quai. */
function featherFlag(color: string, accent: string): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 1.25, 6), new THREE.MeshStandardMaterial({ color: 0xd5d9de, metalness: 0.6, roughness: 0.35 }));
  pole.position.y = 0.62;
  g.add(pole);
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.18);
  sh.lineTo(0, 1.22);
  sh.quadraticCurveTo(0.3, 1.24, 0.3, 0.95);
  sh.quadraticCurveTo(0.26, 0.4, 0.04, 0.18);
  sh.closePath();
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = color;
  x.fillRect(0, 0, 64, 256);
  x.fillStyle = accent;
  x.beginPath();
  x.moveTo(0, 256);
  x.bezierCurveTo(30, 180, 50, 120, 64, 30);
  x.lineTo(64, 70);
  x.bezierCurveTo(50, 150, 30, 210, 12, 256);
  x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.ShapeGeometry(sh, 8);
  // UV : la forme tient dans 0,3 × 1,24
  const p = geo.attributes.position as THREE.BufferAttribute;
  const uv: number[] = [];
  for (let i = 0; i < p.count; i++) uv.push(p.getX(i) / 0.3, p.getY(i) / 1.24);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const flag = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, side: THREE.DoubleSide }));
  flag.castShadow = true;
  g.add(flag);
  g.userData.flag = flag;
  return g;
}

/** Goéland : corps fuselé et deux ailes qui battent. */
function gull(): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.6 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.6, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.14, 4, 8), white);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.04, 0, 0, 0.05, 0.3, 0, 0.03, 0.3, 0, 0.03, 0.42, 0, 0.07, 0, 0, -0.04], 3));
  wingGeo.computeVertexNormals();
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(wingGeo, grey);
    w.scale.x = s;
    g.add(w);
  }
  return g;
}

/** Semi-rigide de spectateurs : boudins orange, console, quelques passagers. */
function rib(color: number): THREE.Group {
  const g = new THREE.Group();
  const tube = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  const hullM = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.62), hullM);
  base.position.y = 0.03;
  g.add(base);
  for (const s of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.52, 4, 10), tube);
    t.rotation.x = Math.PI / 2;
    t.position.set(s * 0.12, 0.06, 0.02);
    g.add(t);
  }
  const bow = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), tube);
  bow.scale.set(1.1, 0.5, 1);
  bow.position.set(0, 0.05, -0.27);
  g.add(bow);
  const consoleM = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.06), new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5 }));
  consoleM.position.set(0, 0.1, 0.02);
  g.add(consoleM);
  const motor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.06), new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.4 }));
  motor.position.set(0, 0.08, 0.33);
  g.add(motor);
  g.add(crowd([{ x: 0, y: 0.06, z: 0.12 }, { x: -0.06, y: 0.06, z: -0.1 }, { x: 0.06, y: 0.06, z: -0.06 }], color));
  g.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.castShadow = true) : null));
  return g;
}

/** Kakémono géant suspendu au rempart : aplat de couleur, vague claire, inscription verticale. */
function wallBanner(color: string, accent: string, text: string): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 128, 512);
  g.fillStyle = accent;
  g.beginPath();
  g.moveTo(0, 512);
  g.lineTo(0, 400);
  g.bezierCurveTo(40, 380, 90, 330, 128, 250);
  g.lineTo(128, 300);
  g.bezierCurveTo(90, 380, 50, 430, 30, 512);
  g.fill();
  g.fillRect(0, 0, 128, 10);
  g.save();
  g.translate(78, 360);
  g.rotate(-Math.PI / 2);
  g.font = 'italic 800 62px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.fillStyle = '#ffffff';
  g.fillText(text, 0, 0);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 2.3), new THREE.MeshStandardMaterial({ map: t, roughness: 0.8 }));
  m.receiveShadow = true;
  return m;
}

export interface HarbourLife {
  /** anneaux d'écume des bateaux qui bougent, à ajouter à ceux du décor */
  update(t: number, dt: number): [number, number, number, number][];
}

/**
 * Grand pavois : fanions de l'étrave à la tête de mât puis jusqu'à l'arrière.
 * À appeler sur un bateau encore à l'origine et à l'échelle 1 ; `scale` est l'échelle qu'il aura dans la scène.
 */
export function dressShip(root: THREE.Object3D, scale: number, seed: number): THREE.Group {
  root.updateMatrixWorld(true);
  const top = new THREE.Box3().setFromObject(root).max.y;
  const a = new THREE.Vector3(0, 0.12, -0.62);
  const m = new THREE.Vector3(0, top - 0.03, -0.08);
  const b = new THREE.Vector3(0, 0.14, 0.5);
  const g = bunting([[a, m], [m, b]], seed, 1 / scale);
  root.add(g);
  return g;
}

export function buildHarbourLife(scene: THREE.Scene, small: boolean): HarbourLife {
  const r = rng(77);
  const spots: Placed[] = [];
  // foule sur le quai : devant les tentes, au bord de l'eau, plus dense près du ponton
  const nQuay = small ? 140 : 320;
  for (let i = 0; i < nQuay; i++) {
    const z = (r() - 0.5) * 70 * (r() < 0.6 ? 0.5 : 1);
    const x = -11.25 - r() * (r() < 0.7 ? 0.7 : 2.6);
    spots.push({ x, y: QUAY_Y, z });
  }
  // badauds sur le chemin de ronde des remparts
  for (let i = 0; i < (small ? 60 : 140); i++) spots.push({ x: -14.6 - r() * 1.6, y: WALK_Y, z: (r() - 0.5) * 120 });
  // quelques personnes sur les pontons, près des bateaux
  for (let i = 0; i < 18; i++) spots.push({ x: (r() < 0.5 ? -0.7 : -5.8) + (r() - 0.5) * 0.3, y: 0.18, z: (r() - 0.5) * 16 });
  scene.add(crowd(spots, 11));

  // guirlandes : en zigzag au-dessus du quai, et le long des pontons
  const lines: [THREE.Vector3, THREE.Vector3][] = [];
  for (let z = -35; z < 35; z += 7) {
    lines.push([new THREE.Vector3(-13.9, QUAY_Y + 1.5, z), new THREE.Vector3(-11.25, QUAY_Y + 1.25, z + 3.5)]);
    lines.push([new THREE.Vector3(-11.25, QUAY_Y + 1.25, z + 3.5), new THREE.Vector3(-13.9, QUAY_Y + 1.5, z + 7)]);
  }
  for (const x of [-0.93, -6.03]) for (let z = -8; z < 8; z += 2.3) lines.push([new THREE.Vector3(x, 0.83, z), new THREE.Vector3(x, 0.83, z + 2.3)]);
  scene.add(bunting(lines, 5));
  // mâts des guirlandes au bord du quai
  const poleGeo = new THREE.CylinderGeometry(0.012, 0.015, 1.25, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.4, metalness: 0.4 });
  for (let z = -35; z < 35; z += 7) {
    const p = new THREE.Mesh(poleGeo, poleMat);
    p.position.set(-11.25, QUAY_Y + 0.62, z + 3.5);
    scene.add(p);
  }

  // drapeaux plume
  const featherCols: [string, string][] = [
    ['#e63946', '#ffffff'],
    ['#1d3557', '#ffd166'],
    ['#ffd166', '#e63946'],
    ['#06d6a0', '#1d3557'],
    ['#118ab2', '#ffffff'],
    ['#fb8500', '#1d3557'],
  ];
  const feathers: THREE.Group[] = [];
  for (let k = 0; k < 10; k++) {
    const [c1, c2] = featherCols[k % featherCols.length];
    const f = featherFlag(c1, c2);
    f.position.set(-11.4 - (k % 2) * 0.35, QUAY_Y, -26 + k * 5.6);
    f.rotation.y = -Math.PI / 2 + (r() - 0.5) * 0.6;
    scene.add(f);
    feathers.push(f);
  }

  // kakémonos sur le rempart, face au bassin
  const bannerSet: [string, string, string][] = [
    ['#e63946', '#ffd166', 'SAIL RUN'],
    ['#1d3557', '#06d6a0', 'SAINT-MALO'],
    ['#ffd166', '#e63946', 'GUADELOUPE'],
    ['#118ab2', '#ffffff', 'SAIL RUN'],
    ['#06d6a0', '#1d3557', 'IMOCA'],
    ['#fb8500', '#ffffff', 'SAINT-MALO'],
    ['#ef476f', '#ffffff', 'GUADELOUPE'],
  ];
  bannerSet.forEach(([c1, c2, txt], k) => {
    const b = wallBanner(c1, c2, txt);
    b.position.set(-14.18, QUAY_Y + 1.42, -22 + k * 6.4);
    if (Math.abs(b.position.z - 9) < 2.2) b.position.z += 3; // pas devant la Grande Porte
    b.rotation.y = Math.PI / 2;
    scene.add(b);
  });

  // goélands
  const gulls = Array.from({ length: small ? 5 : 9 }, (_, i) => {
    const g = gull();
    scene.add(g);
    return { g, r: 5 + r() * 16, h: 4 + r() * 6, cx: 4 + r() * 14, cz: (r() - 0.5) * 30, sp: (0.18 + r() * 0.16) * (r() < 0.5 ? -1 : 1), ph: r() * 6.28, i };
  });

  // semi-rigides qui croisent dans le bassin
  const ribs = [0xf25c05, 0xe0e4e8, 0x1b6fd1].map((c, i) => {
    const g = rib(c);
    g.scale.setScalar(1.4);
    scene.add(g);
    return { g, cx: 16 + i * 6, cz: (i - 1) * 10, rx: 7 + i * 2, rz: 18 + i * 6, sp: 0.05 + i * 0.012, ph: i * 2.1, trail: [] as THREE.Vector3[], last: -1 };
  });

  return {
    update(t: number, dt: number) {
      for (const k of gulls) {
        const a = k.ph + t * k.sp;
        k.g.position.set(k.cx + Math.cos(a) * k.r, k.h + Math.sin(t * 0.7 + k.i) * 0.4, k.cz + Math.sin(a) * k.r);
        k.g.rotation.set(0, -a + (k.sp > 0 ? 0 : Math.PI), (k.sp > 0 ? -1 : 1) * 0.35);
        // battements par séries, puis plané
        const flap = Math.max(0, Math.sin(t * 0.6 + k.i * 1.3)) * Math.sin(t * 9 + k.i) * 0.6;
        k.g.children[1].rotation.z = flap;
        k.g.children[2].rotation.z = -flap;
      }
      for (const f of feathers) {
        const fl = f.userData.flag as THREE.Mesh;
        fl.rotation.y = Math.sin(t * 1.3 + f.position.z) * 0.25;
      }
      const foam: [number, number, number, number][] = [];
      for (const b of ribs) {
        const a = b.ph + t * b.sp;
        const x = b.cx + Math.cos(a) * b.rx;
        const z = b.cz + Math.sin(a) * b.rz;
        const dx = -Math.sin(a) * b.rx;
        const dz = Math.cos(a) * b.rz;
        b.g.position.set(x, 0.02 + Math.sin(t * 3 + b.ph) * 0.01, z);
        b.g.rotation.set(0, Math.atan2(-dx, -dz), Math.sin(t * 2 + b.ph) * 0.03);
        // sillage : quelques anneaux qui s'élargissent derrière le bateau
        if (t - b.last > 0.05) {
          b.last = t;
          b.trail.unshift(new THREE.Vector3(x, 0, z));
          if (b.trail.length > 40) b.trail.length = 40;
        }
        foam.push([x, z, 0.3, 0.3]);
        if (!b.trail.length) continue;
        for (const [k, s] of [
          [10, 0.42],
          [22, 0.6],
          [36, 0.8],
        ] as const) {
          const p = b.trail[Math.min(k, b.trail.length - 1)];
          foam.push([p.x, p.z, s, s]);
        }
      }
      void dt;
      return foam;
    },
  };
}
