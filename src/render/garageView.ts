import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BoatLook, BoatRig, boatModelVersion, buildBoat, disposeBoat, highlightPart, trimBoat } from './boatModel';
import { Engine, InputHandler } from './engine';
import { bannerTexture } from './harbourTown';
import { buildSaintMalo } from './saintMalo';
import { HarbourLife, buildHarbourLife, dressShip } from './harbourLife';
import { setFoam, stylizedWaterMaterial } from './stylizedWater';
import { SKY_FS, SKY_VS, Wave, seaState, skyUniforms, waveHeight } from './immersive';

/**
 * Le « garage » : ton bateau amarré au ponton du village départ, un matin de course.
 * Ponton en bois, pare-battages, amarres, les autres IMOCA à couple, les quais, le phare
 * à l'entrée du port, les drapeaux et la grande banderole du départ.
 * Le bateau mesure 1 unité dans son repère, mis à l'échelle × S dans la scène.
 */

const S = 2.6; // longueur du bateau dans la scène
const LIVERIES = ['#2563EB', '#E11D48', '#FACC15', '#10B981', '#8B5CF6', '#F97316', '#0EA5E9', '#F43F5E'];

/** Étalonnage net : contraste en S léger, couleurs franches, ombres bleutées, vignettage discret. Pas de halo. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.22 }, uWarm: { value: 0.025 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVig, uWarm; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, 1.18);
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.35);
      // ombres légèrement bleutées, hautes lumières dorées
      col += vec3(uWarm, uWarm * 0.45, -uWarm * 0.6) * smoothstep(0.3, 1.2, l);
      col += vec3(-0.01, 0.0, 0.025) * (1.0 - smoothstep(0.0, 0.35, l));
      vec2 d = vUv - 0.5;
      col *= 1.0 - uVig * smoothstep(0.25, 0.85, length(d * vec2(1.15, 1.0)));
      gl_FragColor = vec4(col, c.a);
    }`,
};

/** Planches du ponton. */
function planksTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    const v = 120 + Math.floor(Math.random() * 40);
    g.fillStyle = `rgb(${v + 30},${v + 8},${v - 25})`;
    g.fillRect(0, i * 16, 256, 15);
    g.fillStyle = 'rgba(40,25,10,0.5)';
    g.fillRect(0, i * 16 + 15, 256, 1);
    for (let k = 0; k < 30; k++) {
      g.fillStyle = `rgba(60,35,15,${Math.random() * 0.12})`;
      g.fillRect(Math.random() * 256, i * 16 + Math.random() * 15, 20 + Math.random() * 60, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Nuages de beau temps : quelques gros cumulus peints, loin derrière la ville. */
function cloudTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  // masses arrondies, base plate, ombre douce dessous
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 14; i++) {
      const x = 70 + rnd() * 372;
      const rad = 34 + rnd() * 62 * (1 - Math.abs(x - 256) / 300);
      const y = 190 - rad * (0.55 + rnd() * 0.4);
      const grd = g.createRadialGradient(x, y - rad * 0.3, rad * 0.1, x, y, rad);
      if (pass === 0) {
        grd.addColorStop(0, 'rgba(196,212,232,0.9)');
        grd.addColorStop(1, 'rgba(196,212,232,0)');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(x, y + 10, rad, 0, Math.PI * 2);
      } else {
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(0.75, 'rgba(250,252,255,0.95)');
        grd.addColorStop(1, 'rgba(250,252,255,0)');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(x, y, rad * 0.92, 0, Math.PI * 2);
      }
      g.fill();
    }
  }
  g.globalCompositeOperation = 'destination-out';
  const cut = g.createLinearGradient(0, 180, 0, 215);
  cut.addColorStop(0, 'rgba(0,0,0,0)');
  cut.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = cut;
  g.fillRect(0, 180, 512, 76);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function clouds(): THREE.Group {
  const grp = new THREE.Group();
  const spots: [number, number, number, number][] = [
    [-0.9, 120, 210, 1], [-0.45, 160, 260, 2], [0.1, 140, 230, 3], [0.6, 110, 200, 4], [1.2, 150, 240, 5], [1.9, 130, 220, 6], [2.6, 120, 250, 7], [-1.6, 140, 230, 8],
  ];
  for (const [a, h, size, seed] of spots) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size / 2), new THREE.MeshBasicMaterial({ map: cloudTexture(seed * 7919), transparent: true, depthWrite: false, fog: false }));
    const d = 620;
    m.position.set(Math.sin(a) * d, h, -Math.cos(a) * d);
    m.lookAt(0, h, 0);
    m.renderOrder = -1;
    grp.add(m);
  }
  return grp;
}

export class GarageView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
  private rig: BoatRig | null = null;
  private pivot = new THREE.Group();
  private lookKey = '';
  private dragging = 0;
  private frameRect = { x: 0, y: 0, w: 1, h: 1 };
  private focus: GarageFocus = 'all';
  private camPos = new THREE.Vector3(6.2, 2.1, -6.0);
  private camLook = new THREE.Vector3(0, 1.05, 0);
  private orbit = 0; // rotation de la caméra autour du bateau (glisser)
  private orbitTarget: number | null = 0;
  private glow = 0;
  private clock = 0;
  private waterMat: THREE.ShaderMaterial;
  private skyU: Record<string, THREE.IUniform>;
  private waves: Wave[];
  private flags: THREE.Mesh[] = [];
  private neighbours: { rig: BoatRig; phase: number; spot: [number, number, number]; look: number }[] = [];
  private modelVer = boatModelVersion();
  private lastLook: BoatLook | null = null;
  private banner!: THREE.Mesh;
  private composer: EffectComposer;
  private bannerTitle = '';
  private life!: HarbourLife;
  private foamBase: [number, number, number, number][] = [];

  constructor(private engine: Engine) {
    const s = this.scene;
    const r = engine.renderer;

    // ciel et lumière d'un matin de départ
    this.skyU = skyUniforms();
    (this.skyU.uZenith.value as THREE.Color).setRGB(0.06, 0.32, 0.8);
    (this.skyU.uHorizon.value as THREE.Color).setRGB(0.66, 0.82, 0.95);
    (this.skyU.uSunColor.value as THREE.Color).setRGB(1, 0.9, 0.74);
    // soleil de fin de matinée, de trois-quarts avant : il sculpte la coque
    const sunDir = new THREE.Vector3(0.3, 0.45, -0.85).normalize();
    (this.skyU.uSunDir.value as THREE.Vector3).copy(sunDir);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false }));
    sky.frustumCulled = false;
    s.add(sky);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(sky.geometry, sky.material));
    const pmrem = new THREE.PMREMGenerator(r);
    s.environment = pmrem.fromScene(envScene, 0, 0.1, 2000).texture;
    s.environmentIntensity = 0.55;
    s.fog = new THREE.Fog(0xa9cbe6, 180, 760);

    s.add(new THREE.HemisphereLight(0xcfe4ff, 0x2a3640, 0.6));
    const key = new THREE.DirectionalLight(0xffe2b8, 3.7);
    key.position.copy(sunDir).multiplyScalar(30);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -8;
    sc.right = 8;
    sc.top = 8;
    sc.bottom = -8;
    sc.near = 1;
    sc.far = 80;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    s.add(key, key.target);
    // contre-jour froid : détache la silhouette du bateau du décor
    const rim = new THREE.DirectionalLight(0xa8ccff, 1.4);
    rim.position.set(-20, 12, 26);
    s.add(rim);
    s.add(clouds());

    // bassin : eau d'océan stylisée, anneaux d'écume autour des coques et des pontons
    this.waves = seaState(4, 0.6, -0.8).map((w) => ({ ...w, a: w.a * 0.35 }));
    this.waterMat = stylizedWaterMaterial();
    (this.waterMat.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    this.waterMat.uniforms.uFogNear.value = 180;
    this.waterMat.uniforms.uFogFar.value = 760;
    (this.waterMat.uniforms.uFogColor.value as THREE.Color).set(0xa9cbe6);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), this.waterMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = 0.02;
    s.add(sea);

    this.buildHarbour();

    s.add(this.pivot);
    this.pivot.scale.setScalar(S);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    // post-traitement : étalonnage et vignettage seulement (pas de halo)
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: engine.small ? 0 : 4 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(s, this.camera));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    engine.onResize((w, h) => {
      this.composer.setPixelRatio(r.getPixelRatio());
      this.composer.setSize(w, h);
      this.applyFrame();
    });
  }

  /** Ponton, amarres, quais, phare, voisins, drapeaux. */
  private buildHarbour() {
    const s = this.scene;
    const wood = new THREE.MeshStandardMaterial({ map: planksTexture(), roughness: 0.85 });
    (wood.map as THREE.Texture).repeat.set(1, 10);
    const float = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.7 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xc6ccd2, roughness: 0.3, metalness: 1 });
    const rope = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.8 });
    const fenderMat = new THREE.MeshStandardMaterial({ color: 0x1b4f9c, roughness: 0.45 });

    // ponton principal le long du bord bâbord, et un deuxième pour la rangée voisine
    const pontoon = (x: number, z0: number, z1: number) => {
      const len = z1 - z0;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, len), wood);
      (deck.material as THREE.MeshStandardMaterial).map!.repeat.set(1, len);
      deck.position.set(x, 0.15, (z0 + z1) / 2);
      deck.castShadow = deck.receiveShadow = true;
      s.add(deck);
      const fl = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.12, len - 0.1), float);
      fl.position.set(x, 0.07, (z0 + z1) / 2);
      s.add(fl);
      // taquets et bornes
      for (let z = z0 + 1; z < z1; z += 2.2) {
        for (const sx of [-1, 1]) {
          const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.09), steel);
          cleat.position.set(x + sx * 0.21, 0.185, z);
          s.add(cleat);
        }
      }
      // piliers de guidage
      for (let z = z0 + 2; z < z1; z += 6) {
        const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 12), new THREE.MeshStandardMaterial({ color: 0x5b5148, roughness: 0.9 }));
        pile.position.set(x - 0.3, 0.3, z);
        pile.castShadow = true;
        s.add(pile);
      }
    };
    pontoon(-0.7, -9, 9);
    pontoon(-5.8, -9, 9);

    // amarres de ton bateau : avant, arrière, pointes (petites courbes qui pendent)
    const line = (a: THREE.Vector3, b: THREE.Vector3) => {
      const mid = a.clone().lerp(b, 0.5);
      mid.y -= 0.12;
      s.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 16, 0.012, 5), rope));
    };
    line(new THREE.Vector3(-0.05, 0.3, -1.25), new THREE.Vector3(-0.49, 0.185, -2.1));
    line(new THREE.Vector3(-0.3, 0.25, 1.2), new THREE.Vector3(-0.49, 0.185, 2.1));
    line(new THREE.Vector3(-0.38, 0.26, -0.4), new THREE.Vector3(-0.49, 0.185, 0.6));
    // pare-battages entre la coque et le ponton
    for (const z of [-0.7, 0.1, 0.8]) {
      const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.22, 6, 12), fenderMat);
      f.position.set(-0.43, 0.1, z);
      f.castShadow = true;
      s.add(f);
    }

    // drapeaux en plume le long du ponton, aux couleurs des concurrents
    for (let k = 0; k < 7; k++) {
      const z = -7 + k * 2.3;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.7, 6), steel);
      pole.position.set(-0.93, 0.5, z);
      s.add(pole);
      const fg = new THREE.PlaneGeometry(0.14, 0.42, 6, 8);
      fg.translate(0.07, 0, 0);
      const flag = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ color: LIVERIES[k % LIVERIES.length], roughness: 0.7, side: THREE.DoubleSide }));
      flag.position.set(-0.93, 0.62, z);
      flag.rotation.y = Math.PI / 2 + 0.4;
      (flag.userData as { base: Float32Array }).base = Float32Array.from(fg.attributes.position.array);
      s.add(flag);
      this.flags.push(flag);
    }

    // voisins : d'autres IMOCA amarrés devant, derrière et le long de l'autre ponton
    const spots: [number, number, number][] = [
      [0, 0, -6.2],
      [0, 0, 6.2],
      [-5.15, Math.PI, -3.2],
      [-5.15, Math.PI, 3.2],
      [-6.45, 0, 0],
      [-6.45, 0, -6.2],
    ];
    const foils = ['c', 'grands', 'derives'];
    spots.forEach(([x, rot, z], k) => {
      const look: BoatLook = { hull: k % 2 ? 'ronde' : 'classique', foils: foils[k % 3], mast: k % 3 === 1 ? 'grand' : 'aile', color: LIVERIES[(k + 2) % LIVERIES.length], name: ['ALIZÉ', 'NORDET', 'MISTRAL', 'SUROÎT', 'FOEHN', 'LEVANT'][k], number: `FRA ${10 + k * 7}` };
      const rig = buildBoat(look, false, true);
      rig.root.userData.look = look;
      // au port, les voiles des voisins sont affalées
      rig.jib.visible = false;
      rig.main.visible = false;
      dressShip(rig.root, S, 3 + k);
      rig.root.scale.setScalar(S);
      rig.root.position.set(x, 0.04, z);
      rig.root.rotation.y = rot;
      rig.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
      s.add(rig.root);
      this.neighbours.push({ rig, phase: k * 1.7, spot: [x, rot, z], look: k });
    });

    this.banner = buildSaintMalo(s, this.engine.small);
    // écume : ta coque, les voisins, les flotteurs des pontons
    const foam: [number, number, number, number][] = [[0, 0, 0.42, 1.36]];
    for (const [x, , z] of spots) foam.push([x, z, 0.42, 1.36]);
    foam.push([-0.7, 0, 0.27, 9.05], [-5.8, 0, 0.27, 9.05]);
    for (const x of [-1.0, -6.1]) for (let z = -7; z < 9; z += 6) foam.push([x, z, 0.08, 0.08]);
    this.foamBase = foam;
    setFoam(this.waterMat, foam);
    this.life = buildHarbourLife(s, this.engine.small);
  }

  /** Nom de la course sur la banderole. */
  setRace(title: string) {
    if (title === this.bannerTitle) return;
    this.bannerTitle = title;
    const m = this.banner.material as THREE.MeshStandardMaterial;
    m.map?.dispose();
    m.map = bannerTexture(title);
    m.needsUpdate = true;
  }

  setFrame(x: number, y: number, w: number, h: number) {
    this.frameRect = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    this.applyFrame();
  }

  private applyFrame() {
    const W = this.engine.w;
    const H = this.engine.h;
    const f = this.frameRect;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    this.camera.aspect = W / H;
    this.camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
    // pleine hauteur (ordinateur) : on remplit la zone libre ; téléphone : bateau entier dans le haut
    this.camera.zoom = f.h >= H * 0.9 ? Math.max(0.6, Math.min(1.3, (f.w / W) * 2.4)) : Math.max(0.3, Math.min(0.8, (f.w / f.h) * 0.42));
    this.camera.updateProjectionMatrix();
  }

  /** Cadre la caméra sur une pièce et la fait briller un instant. */
  setFocus(f: GarageFocus) {
    if (f !== this.focus) this.glow = 2.2;
    this.focus = f;
    this.orbitTarget = FOCUS[f].rot;
  }

  /** Relance la surbrillance (après un changement de pièce). */
  pulse() {
    this.glow = 2.2;
  }

  private tuneTarget = { rake: 0, foil: 0, trim: 0, jib: 1 };
  private tuneNow = { rake: 0, foil: 0, trim: 0, jib: 1 };

  /** Les réglages se voient sur le bateau : quête du mât, foils, assiette, taille de la voile d'avant. */
  applyTune(t: { rake: number; foil: number; trim: number }, sails: string) {
    this.tuneTarget = { rake: t.rake, foil: t.foil, trim: t.trim, jib: sails === 'brise' ? 0.82 : sails === 'petittemps' ? 1.16 : 1 };
  }

  setLook(look: BoatLook) {
    this.lastLook = look;
    const key = `${boatModelVersion()}.${look.hull}.${look.foils}.${look.mast}.${look.color}.${look.name ?? ''}.${look.number ?? ''}.${look.accent ?? ''}.${look.pattern ?? ''}.${look.sail ?? ''}`;
    if (key === this.lookKey) return;
    this.lookKey = key;
    if (this.rig) {
      this.pivot.remove(this.rig.root);
      disposeBoat(this.rig);
    }
    this.rig = buildBoat(look, true);
    // à quai, voiles hissées pour la photo, bateau droit
    trimBoat(this.rig, 40, 0);
    this.rig.heel.rotation.z = 0;
    this.pivot.add(this.rig.root);
  }

  /** Réglage du cadrage principal (outil de mise au point, ?dev). */
  debugCam(px: number, py: number, pz: number, lx: number, ly: number, lz: number) {
    FOCUS.all.pos.set(px, py, pz);
    FOCUS.all.look.set(lx, ly, lz);
    this.orbit = 0;
    this.orbitTarget = 0;
  }

  input(): InputHandler {
    return {
      drag: (dx) => {
        this.orbit = Math.max(-1.3, Math.min(1.5, this.orbit - dx * 0.006));
        this.dragging = 3;
        this.orbitTarget = null;
      },
    };
  }

  /** Un modèle importé vient d'arriver : on reconstruit ton bateau et les voisins. */
  private rebuildAll() {
    this.modelVer = boatModelVersion();
    if (this.lastLook) this.setLook(this.lastLook);
    for (const n of this.neighbours) {
      const old = n.rig;
      const look = { ...old.root.userData.look } as BoatLook;
      this.scene.remove(old.root);
      disposeBoat(old);
      const rig = buildBoat(look, false, true);
      rig.root.userData.look = look;
      rig.jib.visible = false;
      rig.main.visible = false;
      dressShip(rig.root, S, 3 + n.look);
      rig.root.scale.setScalar(S);
      rig.root.position.set(n.spot[0], 0.04, n.spot[2]);
      rig.root.rotation.y = n.spot[1];
      rig.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
      this.scene.add(rig.root);
      n.rig = rig;
    }
  }

  frame(dt: number) {
    if (this.modelVer !== boatModelVersion()) this.rebuildAll();
    this.clock += dt;
    const t = this.clock;
    this.waterMat.uniforms.uTime.value = t;
    setFoam(this.waterMat, this.foamBase.concat(this.life.update(t, dt)));
    this.skyU.uTime.value = t;

    // la caméra tourne autour du bateau (côté bassin, pas à travers le ponton)
    if (this.dragging > 0) this.dragging -= dt;
    else if (this.orbitTarget !== null) this.orbit += (this.orbitTarget - this.orbit) * Math.min(1, dt * 2.5);
    else this.orbit += Math.sin(t * 0.15) * dt * 0.04;
    const v = FOCUS[this.focus];
    const k = Math.min(1, dt * 3);
    this.camPos.lerp(v.pos, k);
    this.camLook.lerp(v.look, k);
    const c = Math.cos(this.orbit);
    const sn = Math.sin(this.orbit);
    this.camera.position.set(this.camPos.x * c + this.camPos.z * sn, this.camPos.y, -this.camPos.x * sn + this.camPos.z * c);
    this.camera.lookAt(this.camLook);

    // le bateau bouge doucement à l'amarre
    const lx = 0;
    const h0 = waveHeight(this.waves, lx, 0, t) * S;
    this.pivot.position.y = 0.04 + h0;
    const tn = this.tuneNow;
    const tg = this.tuneTarget;
    const kk = Math.min(1, dt * 4);
    tn.rake += (tg.rake - tn.rake) * kk;
    tn.foil += (tg.foil - tn.foil) * kk;
    tn.trim += (tg.trim - tn.trim) * kk;
    tn.jib += (tg.jib - tn.jib) * kk;
    this.pivot.rotation.z = Math.sin(t * 0.7) * 0.012;
    this.pivot.rotation.x = Math.sin(t * 0.5 + 1) * 0.006 + tn.trim * 0.03;
    if (this.rig) {
      this.rig.spar.rotation.x = tn.rake * 0.09;
      const fs = 1 + tn.foil * 0.28;
      for (const f of this.rig.foilParts) f.scale.set(fs, 1 + tn.foil * 0.18, 1);
      this.rig.jib.scale.y = tn.jib;
      this.rig.jib.scale.z = tn.jib;
    }
    for (const n of this.neighbours) {
      n.rig.root.position.y = 0.04 + Math.sin(t * 0.8 + n.phase) * 0.02;
      n.rig.root.rotation.z = Math.sin(t * 0.6 + n.phase) * 0.015;
    }
    // drapeaux qui flottent
    for (const f of this.flags) {
      const g = f.geometry as THREE.PlaneGeometry;
      const p = g.attributes.position as THREE.BufferAttribute;
      const base = (f.userData as { base: Float32Array }).base;
      for (let i = 0; i < p.count; i++) {
        const x = base[i * 3];
        p.setZ(i, Math.sin(x * 30 - t * 5 + base[i * 3 + 1] * 4) * 0.02 * (x / 0.14));
      }
      p.needsUpdate = true;
      g.computeVertexNormals();
    }

    if (this.rig) {
      this.glow = Math.max(0, this.glow - dt);
      const part = this.focus === 'coque' || this.focus === 'foils' || this.focus === 'mat' ? this.focus : null;
      const amount = Math.min(1, this.glow) * (0.35 + 0.25 * Math.sin(this.clock * 7));
      highlightPart(this.rig, part, amount);
    }
    const r = this.engine.renderer;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    this.composer.render(dt);
  }
}

export type GarageFocus = 'all' | 'coque' | 'foils' | 'mat' | 'skipper';

/** Cadrages : position caméra, point visé, angle autour du bateau. Le ponton est côté bâbord (-x). */
const FOCUS: Record<GarageFocus, { pos: THREE.Vector3; look: THREE.Vector3; rot: number }> = {
  all: { pos: new THREE.Vector3(7.2, 1.45, -6.6), look: new THREE.Vector3(0.15, 1.3, -0.1), rot: 0 },
  coque: { pos: new THREE.Vector3(6.6, 1.2, -4.4), look: new THREE.Vector3(0, 0.4, 0), rot: -0.25 },
  foils: { pos: new THREE.Vector3(4.2, 0.55, -2.4), look: new THREE.Vector3(0.6, 0.05, -0.3), rot: -0.1 },
  mat: { pos: new THREE.Vector3(6.2, 1.0, -5.8), look: new THREE.Vector3(0, 2.4, 0), rot: 0.2 },
  skipper: { pos: new THREE.Vector3(3.4, 1.6, 5.8), look: new THREE.Vector3(-0.4, 0.8, 0.6), rot: 0 },
};
