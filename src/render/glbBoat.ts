import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { BoatLook, BoatRig, SAIL_CLOTH, hullTexture, jibTexture, sailTexture, setCustomBoat } from './boatModel';

/**
 * Modèle d'IMOCA importé (GLB, fait sous Blender / Meshy). S'il est présent dans public/models/imoca.glb,
 * il remplace le bateau codé au garage et dans la vue embarquée. Le modèle codé reste la solution de repli.
 *
 * Conventions (détaillées dans docs/MODELE-IMOCA.md) :
 *  - repère glTF : étrave vers -Z, mât vers +Y, flottaison à y = 0 (sous Blender : étrave vers +Y, flottaison à Z = 0) ;
 *  - l'échelle est libre : la longueur de l'objet « hull » (ou de tout le modèle) est ramenée à 1 ;
 *  - objets nommés, animés autour de leur origine : spar (mât + gréement + voiles), main, jib, foil_L, foil_R ;
 *    variantes facultatives : foils_c / foils_grands / foils_derives ;
 *  - matériaux nommés, pilotés par la livrée : livery (peinture complète, UV au gabarit), tint (couleur unie),
 *    accent (couleur secondaire), sail (tissu), sail_main / sail_jib (voiles avec nom et numéro, UV au gabarit),
 *    foil (pièces mises en valeur au garage).
 */

const BASE = import.meta.env.BASE_URL;
export const MODEL_URL = `${BASE}models/imoca.glb`;

interface Template {
  scene: THREE.Group;
  /** pour le message de chargement */
  info: string;
}
let template: Template | null = null;
let loading: Promise<boolean> | null = null;

/** « Foil_L.001 » → « foil_l » */
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.\d+$/, '')
    .trim();

const PIVOTS = ['spar', 'main', 'jib', 'foil_l', 'foil_r'] as const;
const PIVOT_PREFIX = '__pivot_';

/** Insère un groupe pivot à l'origine de l'objet : on anime le pivot sans toucher à la pose d'origine. */
function wrapPivot(node: THREE.Object3D, key: string) {
  const parent = node.parent;
  if (!parent) return;
  const pivot = new THREE.Group();
  pivot.name = PIVOT_PREFIX + key;
  pivot.position.copy(node.position);
  parent.add(pivot);
  parent.remove(node);
  node.position.set(0, 0, 0);
  pivot.add(node);
}

/** Côté de chaque sommet (bâbord < 0 < tribord), en repère bateau : la peinture est miroir d'un bord à l'autre. */
function bakeSide(mesh: THREE.Mesh, toModel: THREE.Matrix4) {
  const g = mesh.geometry as THREE.BufferGeometry;
  if (g.getAttribute('aSide')) return;
  const p = g.getAttribute('position');
  const side = new Float32Array(p.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(toModel);
    side[i] = v.x < 0 ? -1 : 1;
  }
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
}

function prepare(scene: THREE.Group): Template {
  scene.updateMatrixWorld(true);
  // longueur de référence : la coque si elle est nommée, sinon tout le modèle
  let hull: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (!hull && /^(hull|coque)/.test(norm(o.name))) hull = o;
  });
  const box = new THREE.Box3().setFromObject(hull ?? scene);
  const size = box.getSize(new THREE.Vector3());
  const model = new THREE.Group();
  model.add(scene);
  let info = '';
  // modèle couché sur l'axe X (export Meshy brut) : on le remet dans l'axe
  if (size.x > size.z * 1.6) {
    scene.rotation.y = Math.PI / 2;
    info += 'axe corrigé (X → Z) · ';
    [size.x, size.z] = [size.z, size.x];
  }
  const len = Math.max(size.z, 1e-6);
  model.scale.setScalar(1 / len);
  info += `longueur ${len.toFixed(2)} → 1`;

  // pivots animés
  const found: Record<string, THREE.Object3D> = {};
  scene.traverse((o) => {
    const n = norm(o.name);
    for (const k of PIVOTS) if (n === k && !found[k]) found[k] = o;
    if (n === 'foil_g') found.foil_l ??= o;
    if (n === 'foil_d') found.foil_r ??= o;
  });
  for (const [k, o] of Object.entries(found)) wrapPivot(o, k);

  // côtés pour la peinture et ombres
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const toModel = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    if (mats.some((x) => norm(x.name).startsWith('livery'))) bakeSide(m, toModel);
    if (mats.some((x) => /^(sail_main|grand_voile)$/.test(norm(x.name)))) {
      // axe bâbord → tribord du bateau, exprimé dans le repère de la voile
      const back = new THREE.Matrix4().copy(toModel).invert();
      const side = new THREE.Vector3(1, 0, 0).transformDirection(back);
      m.geometry.computeBoundingBox();
      const c = m.geometry.boundingBox!.getCenter(new THREE.Vector3());
      m.userData.sailSide = side.toArray();
      m.userData.sailCenter = c.toArray();
    }
  });
  const root = new THREE.Group();
  root.add(model);
  return { scene: root, info };
}

/** Peinture de coque : flanc bâbord et flanc tribord tirés de la même île UV (u = 0 à l'étrave, liston en haut). */
function liveryMaterial(base: THREE.MeshStandardMaterial, look: BoatLook): THREE.MeshPhysicalMaterial {
  const name = look.name ?? 'SAIL RUN';
  const port = hullTexture(look.color, name, false, look.pattern, look.accent).clone();
  const stbd = hullTexture(look.color, name, true, look.pattern, look.accent).clone();
  for (const t of [port, stbd]) {
    t.flipY = false;
    t.needsUpdate = true;
  }
  const m = new THREE.MeshPhysicalMaterial({ map: port, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1, normalMap: base.normalMap ?? null });
  m.name = base.name;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMapStbd = { value: stbd };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSide;\nvarying float vSide;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSide = aSide;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uMapStbd;\nvarying float vSide;')
      .replace('#include <map_fragment>', 'vec4 sampledDiffuseColor = vSide < 0.0 ? texture2D(map, vMapUv) : texture2D(uMapStbd, vec2(1.0 - vMapUv.x, vMapUv.y));\ndiffuseColor *= sampledDiffuseColor;');
  };
  m.customProgramCacheKey = () => 'livery';
  return m;
}

/**
 * Grand-voile lisible des deux bords et sur les deux amures : on retourne l'image selon le côté d'où on la regarde
 * (en repère bateau) et selon le miroir appliqué pour passer le creux sous le vent.
 */
function readableSail(base: THREE.MeshStandardMaterial, map: THREE.Texture, mesh: THREE.Mesh): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.map = map;
  m.color.set('#ffffff');
  m.side = THREE.DoubleSide;
  const side = new THREE.Vector3().fromArray((mesh.userData.sailSide as number[]) ?? [1, 0, 0]);
  const center = new THREE.Vector3().fromArray((mesh.userData.sailCenter as number[]) ?? [0, 0, 0]);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSailSide = { value: side };
    sh.uniforms.uSailCenter = { value: center };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSailSide, uSailCenter;\nvarying float vFlip;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvec3 camL = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;\nvFlip = ((dot(camL - uSailCenter, uSailSide) > 0.0) != (determinant(mat3(modelMatrix)) < 0.0)) ? 1.0 : 0.0;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlip;')
      .replace('#include <map_fragment>', 'vec4 sampledDiffuseColor = texture2D(map, vFlip > 0.5 ? vec2(1.0 - vMapUv.x, vMapUv.y) : vMapUv);\ndiffuseColor *= sampledDiffuseColor;');
  };
  m.customProgramCacheKey = () => 'sail-readable';
  return m;
}

function canvasMap(t: THREE.CanvasTexture): THREE.CanvasTexture {
  const c = t.clone();
  c.flipY = false;
  c.needsUpdate = true;
  return c;
}

function build(look: BoatLook): BoatRig | null {
  if (!template) return null;
  const root = template.scene.clone(true) as THREE.Group;
  const heel = new THREE.Group();
  const model = root.children[0];
  root.add(heel);
  heel.add(model);
  const materials: THREE.Material[] = [];
  const parts: BoatRig['parts'] = { coque: [], foils: [], mat: [] };
  const sail = SAIL_CLOTH[look.sail ?? 'carbone'] ?? SAIL_CLOTH.carbone;
  const byNode = (name: string) => model.getObjectByName(PIVOT_PREFIX + name);
  const under = (o: THREE.Object3D | undefined, m: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (p === o) return true;
    return false;
  };
  const foilL = byNode('foil_l');
  const foilR = byNode('foil_r');
  let mastNode: THREE.Object3D | undefined;
  model.traverse((o) => {
    if (!mastNode && /^(mast|mat)$/.test(norm(o.name))) mastNode = o;
  });

  // variantes de foils (facultatives)
  model.traverse((o) => {
    const n = norm(o.name);
    const v = /^foils_(c|grands|derives)$/.exec(n);
    if (v) o.visible = v[1] === look.foils;
  });

  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out = list.map((m0) => {
      const base = m0 as THREE.MeshStandardMaterial;
      const n = norm(base.name);
      let m: THREE.MeshStandardMaterial;
      if (n.startsWith('livery')) {
        m = liveryMaterial(base, look);
        parts.coque.push(m);
      } else if (n.startsWith('tint') || n.startsWith('teinte')) {
        m = base.clone();
        m.color.set(look.color);
        parts.coque.push(m);
      } else if (n.startsWith('accent')) {
        m = base.clone();
        m.color.set(look.accent ?? '#ffffff');
      } else if (n === 'sail_main' || n === 'grand_voile') {
        m = readableSail(base, canvasMap(sailTexture(look.color, look.name ?? 'SAIL RUN', look.number ?? 'FRA 60', look.sail)), mesh);
      } else if (n === 'sail_jib' || n === 'foc') {
        m = base.clone();
        m.map = canvasMap(jibTexture(look.color, look.sail));
        m.color.set('#ffffff');
        m.side = THREE.DoubleSide;
      } else if (n.startsWith('sail') || n.startsWith('voile')) {
        m = base.clone();
        m.color.set(sail[0]);
        m.side = THREE.DoubleSide;
      } else if (n.startsWith('foil') || under(foilL, mesh) || under(foilR, mesh)) {
        m = base.clone();
        parts.foils.push(m);
      } else if (under(mastNode, mesh)) {
        m = base.clone();
        parts.mat.push(m);
      } else return base;
      materials.push(m);
      return m;
    });
    mesh.material = Array.isArray(mesh.material) ? out : out[0];
  });

  const group = (name: string) => (byNode(name) as THREE.Group | undefined) ?? new THREE.Group();
  const spar = group('spar');
  const main = group('main');
  const jib = group('jib');
  // pas de pivot « main »/« jib » : on ne fait rien plutôt que d'animer tout le bateau
  return { root, heel, main, jib, materials, parts: parts as BoatRig['parts'], spar, foilParts: [foilL, foilR].filter(Boolean) as THREE.Object3D[], shared: true };
}

/** Charge un GLB (fichier du projet ou fichier déposé) et l'installe comme modèle du bateau. */
export async function loadBoatModel(url = MODEL_URL, quiet = true): Promise<boolean> {
  try {
    if (url === MODEL_URL) {
      const head = await fetch(url, { method: 'HEAD' });
      const type = head.headers.get('content-type') ?? '';
      if (!head.ok || type.includes('text/html')) return false;
    }
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${BASE}draco/`);
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    template = prepare(gltf.scene);
    setCustomBoat((look) => build(look));
    console.info(`[Sail Run] modèle IMOCA chargé (${template.info})`);
    return true;
  } catch (e) {
    if (!quiet) console.warn('[Sail Run] modèle IMOCA illisible, retour au modèle codé', e);
    return false;
  }
}

/** Au démarrage : modèle du projet s'il existe. */
export function preloadBoatModel(): Promise<boolean> {
  loading ??= loadBoatModel();
  return loading;
}

/** Glisser-déposer un .glb sur la page : essai immédiat du modèle, sans rien publier. */
export function enableModelDrop(onLoaded: (ok: boolean, name: string) => void) {
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    const f = e.dataTransfer?.files[0];
    if (!f || !/\.(glb|gltf)$/i.test(f.name)) return;
    e.preventDefault();
    const url = URL.createObjectURL(f);
    const ok = await loadBoatModel(url, false);
    onLoaded(ok, f.name);
  });
}
