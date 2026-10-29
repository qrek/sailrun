/**
 * Fabrique un IMOCA de test au format attendu par le jeu (noms, pivots, matériaux, UV de coque),
 * pour vérifier le chargement GLB : `npx tsx scripts/make_test_glb.ts [sortie.glb]`.
 * Ce n'est pas un beau bateau : c'est un gabarit qui respecte docs/MODELE-IMOCA.md.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { writeFileSync } from 'node:fs';

// GLTFExporter lit les Blob avec FileReader : petite version pour Node
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(b: Blob) {
    void b.arrayBuffer().then((r) => {
      this.result = r;
      this.onloadend?.();
    });
  }
  readAsDataURL(b: Blob) {
    void b.arrayBuffer().then((r) => {
      this.result = `data:${b.type};base64,${Buffer.from(r).toString('base64')}`;
      this.onloadend?.();
    });
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;

const L = 18.28; // mètres
const mat = (name: string, color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...extra });
  m.name = name;
  return m;
};

/** Coque : deux flancs, u = 0 à l'étrave → 1 à l'arrière, v glTF = 0 au liston → 1 sous la coque. */
function hull(): THREE.Mesh {
  const N = 40;
  const M = 16;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const side of [-1, 1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const b = 2.85 * (0.5 + 0.5 * Math.sin(Math.min(1, t / 0.7) * Math.PI * 0.5));
      const d = 1.45 + 0.6 * Math.pow(1 - t, 2);
      const k = 0.9 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.62) * (1 - 0.5 * t) + 0.05;
      for (let j = 0; j <= M; j++) {
        const s = j / M;
        const x = s < 0.55 ? b * 0.85 * Math.sin(((s / 0.55) * Math.PI) / 2) : b * (0.85 + 0.15 * Math.sin((((s - 0.55) / 0.45) * Math.PI) / 2));
        const y = s < 0.55 ? -k * Math.cos(((s / 0.55) * Math.PI) / 2) : ((s - 0.55) / 0.45) * d;
        pos.push(side * x, y, -L / 2 + t * L);
        uv.push(t, 1 - s);
      }
    }
    for (let i = 0; i < N; i++)
      for (let j = 0; j < M; j++) {
        const a = base + i * (M + 1) + j;
        const c = a + M + 1;
        if (side > 0) idx.push(a, a + 1, c, c, a + 1, c + 1);
        else idx.push(a, c, a + 1, c, c + 1, a + 1);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat('livery', 0xffffff));
  m.name = 'hull';
  return m;
}

const scene = new THREE.Scene();
const boat = new THREE.Group();
boat.name = 'imoca';
scene.add(boat);
boat.add(hull());

const deck = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.15, L * 0.92), mat('deck', 0x3a4048));
deck.name = 'deck';
deck.position.set(0, 1.55, 0.3);
boat.add(deck);

const keel = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4.4, 0.9), mat('carbon', 0x16191e));
keel.name = 'keel';
keel.position.set(0, -2.3, 0);
boat.add(keel);

for (const [name, sx] of [['foil_L', -1], ['foil_R', 1]] as const) {
  const f = new THREE.Group();
  f.name = name;
  f.position.set(sx * 2.6, 0.6, -2);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.5), mat('foil', 0xf2c230));
  blade.position.set(sx * 1.0, -0.8, 0);
  blade.rotation.z = sx * -0.8;
  f.add(blade);
  boat.add(f);
}

// mât + gréement + voiles : groupe « spar » dont l'origine est le pied de mât
const spar = new THREE.Group();
spar.name = 'spar';
spar.position.set(0, 1.6, -1.5);
boat.add(spar);
const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 29, 12), mat('mast', 0x1b2129));
mast.name = 'mast';
mast.position.y = 14.5;
spar.add(mast);

/** Voile triangulaire, u = 0 au guindant → 1 à la chute, v glTF = 0 en tête → 1 en bordure. */
function sail(name: string, matName: string, foot: number, height: number, z0: number): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(0, 0, z0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.5, 0, 0, height, 0, 0, 0.5, foot], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 1], 2));
  geo.setIndex([0, 2, 1]);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat(matName, 0xffffff, { side: THREE.DoubleSide }));
  m.name = `${name}_cloth`;
  g.add(m);
  return g;
}
spar.add(sail('main', 'sail_main', 8.5, 28, 0.25));
const jib = sail('jib', 'sail_jib', 8.5, 23, 0);
// le foc : amure à l'étrave, la chute vers le mât
jib.position.set(0, 0, -7.3);
spar.add(jib);

const exporter = new GLTFExporter();
const out = process.argv[2] ?? 'public/models/imoca-test.glb';
exporter.parse(
  scene,
  (res) => {
    writeFileSync(out, Buffer.from(res as ArrayBuffer));
    console.log(`écrit ${out}`);
  },
  (err) => console.error(err),
  { binary: true },
);
