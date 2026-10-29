import * as THREE from 'three';
import { Boat } from '../sim/boat';
import { D2R, NM_PER_DEG } from '../sim/geo';
import { BoatRig, boatModelVersion, buildBoat, disposeBoat, trimBoat } from './boatModel';
import { Engine, InputHandler } from './engine';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { toUnit, unitLabel } from '../ui/units';

/** Finition « objectif » : vignette douce et léger grain. */
const LensShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.32 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uVignette; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - uVignette * smoothstep(0.25, 0.85, length(d * vec2(1.0, 0.8)) * 1.35);
      c.rgb *= v;
      c.rgb += (h(vUv * 1000.0 + uTime) - 0.5) * 0.012 * (c.rgb + 0.05);
      gl_FragColor = c;
    }`,
};

/**
 * Vue immersive : la caméra au ras de l'eau, près du bateau.
 * Unités : 1 = une longueur de bateau (≈ 18 m). Le bateau reste à l'origine, étrave vers -z,
 * c'est la mer qui défile. Houle de Gerstner calculée dans le shader et, à l'identique, en JS
 * pour faire tanguer et rouler le bateau.
 */

const UNIT_M = 18; // mètres par unité
const G = 9.81 / UNIT_M; // gravité en unités / s²
export const NWAVES = 6;
// trains de houle : écart d'angle (°) avec le vent, longueur d'onde et hauteur relatives, cambrure
const WAVES: [number, number, number, number][] = [
  [0, 1, 1, 0.55],
  [24, 0.62, 0.55, 0.6],
  [-32, 0.46, 0.4, 0.6],
  [58, 0.31, 0.22, 0.65],
  [-12, 0.22, 0.16, 0.7],
  [92, 0.15, 0.08, 0.7],
];

export const BOT_NUMBERS: Record<string, string> = { lea: 'FRA 17', max: 'FRA 33', julien: 'FRA 8', sam: 'FRA 59', nico: 'FRA 2' };

/** Mer en grille polaire : les mailles grandissent avec la distance (densité constante à l'écran). */
export function polarSeaGeometry(small: boolean, maxR = 1500): THREE.BufferGeometry {
  const SEG = small ? 160 : 256;
  const ratio = small ? 1.035 : 1.02;
  const radii: number[] = [0];
  for (let r = 0.25; r < maxR; r *= ratio) radii.push(r);
  radii.push(maxR);
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let i = 1; i < radii.length; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2 + (i % 2) * (Math.PI / SEG);
      pos.push(Math.cos(a) * radii[i], 0, Math.sin(a) * radii[i]);
    }
  }
  for (let j = 0; j < SEG; j++) idx.push(0, 1 + ((j + 1) % SEG), 1 + j);
  for (let i = 1; i < radii.length - 1; i++) {
    const r0 = 1 + (i - 1) * SEG;
    const r1 = 1 + i * SEG;
    for (let j = 0; j < SEG; j++) {
      const j1 = (j + 1) % SEG;
      idx.push(r0 + j, r0 + j1, r1 + j, r0 + j1, r1 + j1, r1 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Uniformes communs ciel / mer (soleil, couleurs du ciel, heure). */
export function skyUniforms(): Record<string, THREE.IUniform> {
  return {
    uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.8).normalize() },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color(1, 0.92, 0.8) },
    uDay: { value: 1 },
    uTime: { value: 0 },
  };
}

/** Uniformes de la mer, qui partagent ceux du ciel. */
export function seaUniforms(shared: Record<string, THREE.IUniform>): Record<string, THREE.IUniform> {
  return {
    ...shared,
    uWaves: { value: Array.from({ length: NWAVES }, () => new THREE.Vector4()) },
    uWq: { value: Array.from({ length: NWAVES }, () => new THREE.Vector2()) },
    uTravel: { value: 0 },
    uSpeed: { value: 0 },
    uFoam: { value: 1 },
    uAmp: { value: 0.1 },
    uFar: { value: 1400 },
    uDeepCol: { value: new THREE.Color(0.004, 0.045, 0.09) },
    uScatCol: { value: new THREE.Color(0.0, 0.2, 0.24) },
  };
}

/** Recopie un état de mer dans les uniformes du shader. */
export function applyWaves(u: Record<string, THREE.IUniform>, waves: Wave[]) {
  waves.forEach((w, i) => {
    (u.uWaves.value as THREE.Vector4[])[i].set(w.dx, w.dz, w.k, w.a);
    (u.uWq.value as THREE.Vector2[])[i].set(w.q, w.w);
  });
}

export interface Wave {
  dx: number;
  dz: number;
  k: number;
  a: number;
  q: number;
  w: number;
}

/** Houle selon la force du vent (nds) et sa direction (vent qui vient de « from », repère du bateau). */
export function seaState(tws: number, fromX: number, fromZ: number): Wave[] {
  const L0 = 2.2 + tws * 0.24; // longueur d'onde du train principal (unités)
  const A0 = 0.01 + Math.pow(tws, 1.5) * 0.00055; // amplitude (unités) : ≈ 1,3 m à 23 nds
  const base = Math.atan2(-fromX, -fromZ); // la houle va dans le sens du vent
  return WAVES.map(([da, lf, af, q]) => {
    const ang = base + da * D2R;
    const k = (2 * Math.PI) / (L0 * lf);
    return { dx: Math.sin(ang), dz: Math.cos(ang), k, a: A0 * af, q, w: Math.sqrt(G * k) };
  });
}

/** Hauteur de la mer (approchée, sans le déplacement horizontal) au point (x, z) du repère de l'eau. */
export function waveHeight(ws: Wave[], x: number, z: number, t: number): number {
  let h = 0;
  for (const w of ws) h += w.a * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t);
  return h;
}

export const SEA_VS = /* glsl */ `
  #define NW ${NWAVES}
  uniform vec4 uWaves[NW]; // dx, dz, k, a
  uniform vec2 uWq[NW];    // cambrure, pulsation
  uniform float uTime, uTravel;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vCrest;
  varying vec2 vLocal;
  void main() {
    vec3 p = position;
    float r = length(p.xz);
    float fade = 1.0 - smoothstep(120.0, 420.0, r);
    vec2 wp = p.xz + vec2(0.0, -uTravel); // position dans le repère de l'eau (le bateau avance vers -z)
    vec3 d = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float crest = 0.0;
    for (int i = 0; i < NW; i++) {
      vec2 dir = uWaves[i].xy;
      float k = uWaves[i].z;
      float a = uWaves[i].w * fade;
      float q = uWq[i].x;
      float ph = k * dot(dir, wp) - uWq[i].y * uTime;
      float s = sin(ph);
      float c = cos(ph);
      d.x += q * a * dir.x * c;
      d.z += q * a * dir.y * c;
      d.y += a * s;
      n.x -= dir.x * k * a * c;
      n.z -= dir.y * k * a * c;
      n.y -= q * k * a * s;
      crest += s * a;
    }
    p += d;
    vNormal = normalize(n);
    vCrest = crest;
    vLocal = position.xz;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const SKY_FN = /* glsl */ `
  uniform vec3 uSunDir, uZenith, uHorizon, uSunColor;
  uniform float uDay;
  vec3 skyColor(vec3 dir) {
    float h = max(dir.y, 0.0);
    vec3 c = mix(uHorizon, uZenith, pow(h, 0.55));
    float sd = max(dot(dir, uSunDir), 0.0);
    c += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 64.0) * 0.35) * (0.3 + 0.7 * uDay);
    return c;
  }`;

export const SEA_FS = /* glsl */ `
  uniform float uTime, uTravel, uSpeed, uFoam, uFar, uAmp;
  uniform vec3 uDeepCol, uScatCol;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vCrest;
  varying vec2 vLocal;
  ${SKY_FN}
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; } return v; }
  void main() {
    vec2 wp = vLocal + vec2(0.0, -uTravel);
    float dist = length(vWorld - cameraPosition);
    // petites rides animées, atténuées au loin
    float near = 1.0 - smoothstep(6.0, 60.0, dist);
    vec2 rp = wp * 3.2;
    float e = 0.08;
    float r0 = fbm(rp + uTime * 0.35);
    vec2 rg = vec2(fbm(rp + vec2(e, 0.0) + uTime * 0.35) - r0, fbm(rp + vec2(0.0, e) + uTime * 0.35) - r0) / e;
    vec3 n = normalize(vNormal + vec3(-rg.x, 0.0, -rg.y) * 0.16 * near);
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 refl = reflect(-v, n);
    refl.y = abs(refl.y);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    vec3 deep = uDeepCol * (0.25 + 0.75 * uDay);
    vec3 scatter = uScatCol * (0.2 + 0.8 * uDay);
    // la lumière traverse les crêtes : turquoise sous le haut des vagues
    float sss = clamp(vCrest * 6.0 + 0.3, 0.0, 1.0) * pow(max(dot(v, -uSunDir) * 0.5 + 0.5, 0.0), 2.0);
    vec3 col = mix(deep, scatter, sss * 0.8);
    col = mix(col, skyColor(refl), fres);
    // soleil sur l'eau
    vec3 hv = normalize(uSunDir + v);
    float spec = pow(max(dot(n, hv), 0.0), 900.0) * 7.0 + pow(max(dot(n, hv), 0.0), 120.0) * 0.25;
    // scintillement : facettes minuscules qui renvoient le soleil (le halo les fait briller)
    vec2 gp = wp * 26.0 + vec2(uTime * 1.3, -uTime * 0.9);
    vec3 gn = normalize(n + vec3(noise(gp) - 0.5, 0.0, noise(gp + 17.0) - 0.5) * 0.3);
    spec += pow(max(dot(gn, hv), 0.0), 2400.0) * 18.0 * near;
    col += uSunColor * spec * uDay;
    // écume des crêtes (plus il y a de vent, plus il y en a)
    float fn = fbm(wp * 1.6 + vec2(uTime * 0.1, 0.0));
    // moutons : seulement au sommet des plus grosses vagues, plus nombreux quand le vent forcit
    float crestFoam = smoothstep(1.15 - uFoam * 0.3, 1.35, vCrest / uAmp + fn * 0.5) * (0.4 + 0.6 * near) * step(0.01, uFoam);
    // sillage : un V qui s'ouvre derrière le bateau, plus une traînée blanche au centre
    float zb = vLocal.y - 0.45;
    float wake = 0.0;
    if (zb > 0.0) {
      float spread = 0.08 + zb * 0.3; // demi-angle proche de celui d'un sillage de Kelvin
      float edge = abs(abs(vLocal.x) - spread);
      float vee = (1.0 - smoothstep(0.0, 0.04 + zb * 0.025, edge)) * (1.0 - smoothstep(2.0, 16.0, zb));
      float trail = (1.0 - smoothstep(0.05, 0.22 + zb * 0.03, abs(vLocal.x))) * (1.0 - smoothstep(2.0, 40.0, zb));
      float breakup = fbm(vec2(vLocal.x * 7.0, (vLocal.y - uTravel) * 3.0));
      wake = (vee * 0.5 + trail * 0.85) * smoothstep(0.3, 0.8, breakup + 0.25) * uSpeed;
    }
    // vague d'étrave le long de la coque
    float hull = (1.0 - smoothstep(0.1, 0.22, abs(abs(vLocal.x) - 0.12))) * (1.0 - smoothstep(0.0, 0.9, abs(vLocal.y))) * uSpeed;
    float foam = clamp(crestFoam * 0.85 + wake + hull * 0.6 * fbm(vLocal * 9.0 + uTime), 0.0, 1.0);
    col = mix(col, vec3(0.92, 0.96, 1.0) * (0.35 + 0.65 * uDay), foam);
    // horizon : la mer se fond dans le ciel
    vec3 hz = skyColor(normalize(vec3(vWorld.x - cameraPosition.x, 0.0, vWorld.z - cameraPosition.z)));
    col = mix(col, hz, smoothstep(uFar * 0.25, uFar, dist));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export const SKY_VS = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;

export const SKY_FS = /* glsl */ `
  uniform float uTime;
  varying vec3 vDir;
  ${SKY_FN}
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
  void main() {
    vec3 d = normalize(vDir);
    vec3 col = skyColor(d);
    // disque du soleil
    float sd = dot(d, uSunDir);
    col += uSunColor * smoothstep(0.9993, 0.9997, sd) * 6.0 * uDay;
    // nuages : couche projetée sur un plafond, qui défile lentement
    if (d.y > 0.0) {
      vec2 cp = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
      float c = smoothstep(0.48, 0.78, fbm(cp));
      float lit = 0.75 + 0.25 * max(dot(d, uSunDir), 0.0);
      vec3 cc = mix(vec3(0.16, 0.18, 0.24), vec3(1.0, 0.98, 0.95) * lit, uDay);
      col = mix(col, cc, c * smoothstep(0.0, 0.18, d.y) * 0.85);
    }
    // nuit : quelques étoiles
    float st = step(0.9985, hash(floor(d.xz / max(d.y, 0.05) * 300.0))) * (1.0 - uDay) * smoothstep(0.05, 0.3, d.y);
    col += vec3(st);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

interface Other {
  rig: BoatRig;
  id: string;
  tag: HTMLDivElement;
}

export class ImmersiveView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(54, 1, 0.03, 3000);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private lens: ShaderPass;
  private rig: BoatRig | null = null;
  private lookKey = '';
  private others = new Map<string, Other>();
  private sea: THREE.Mesh;
  private sky: THREE.Mesh;
  private seaU: Record<string, THREE.IUniform>;
  private skyU: Record<string, THREE.IUniform>;
  private sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
  private hemi = new THREE.HemisphereLight(0xcfe6ff, 0x0b2a44, 1.0);
  private yaw = 0.62;
  private pitch = 0.1;
  private dist = 2.1;
  private tDist = 2.1;
  private shake = new THREE.Vector3();
  private time = 0;
  private travel = 0;
  private waves: Wave[] = [];
  private bob = new THREE.Vector3();
  private envKey = -1;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private spray: THREE.Points;
  private sprayPos: Float32Array;
  private sprayVel: Float32Array;
  private sprayLife: Float32Array;
  private navLights: THREE.Mesh[] = [];

  private labels: HTMLDivElement;

  constructor(
    private engine: Engine,
    host: HTMLElement,
  ) {
    this.labels = document.createElement('div');
    this.labels.className = 'imm-labels';
    this.labels.hidden = true;
    host.appendChild(this.labels);
    const shared = {
      uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.8).normalize() },
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color(1, 0.92, 0.8) },
      uDay: { value: 1 },
      uTime: { value: 0 },
    };
    this.seaU = {
      ...shared,
      uWaves: { value: Array.from({ length: NWAVES }, () => new THREE.Vector4()) },
      uWq: { value: Array.from({ length: NWAVES }, () => new THREE.Vector2()) },
      uTravel: { value: 0 },
      uSpeed: { value: 0 },
      uFoam: { value: 1 },
      uAmp: { value: 0.1 },
      uFar: { value: 1400 },
    };
    this.skyU = shared;

    const g = polarSeaGeometry(engine.small);
    this.sea = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: this.seaU, vertexShader: SEA_VS, fragmentShader: SEA_FS }));
    this.sea.frustumCulled = false;
    this.scene.add(this.sea);

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false }));
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.envScene.add(new THREE.Mesh(this.sky.geometry, this.sky.material));

    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xbfd4e6, 60, 900);
    this.pmrem = new THREE.PMREMGenerator(engine.renderer);

    // embruns d'étrave
    const NS = 520;
    this.sprayPos = new Float32Array(NS * 3);
    this.sprayVel = new Float32Array(NS * 3);
    this.sprayLife = new Float32Array(NS);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sprayPos, 3));
    const dot = document.createElement('canvas');
    dot.width = dot.height = 32;
    const dg = dot.getContext('2d')!;
    const grd = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    dg.fillStyle = grd;
    dg.fillRect(0, 0, 32, 32);
    this.spray = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.022, map: new THREE.CanvasTexture(dot), transparent: true, opacity: 0.65, depthWrite: false }));
    this.spray.frustumCulled = false;
    this.scene.add(this.spray);

    // post-traitement : halo lumineux sur les reflets, vignette
    const r = engine.renderer;
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(engine.w, engine.h), 0.4, 0.35, 1.25);
    this.composer.addPass(this.bloom);
    this.lens = new ShaderPass(LensShader);
    this.composer.addPass(this.lens);
    this.composer.addPass(new OutputPass());

    engine.onResize((w, h) => {
      this.composer.setPixelRatio(r.getPixelRatio());
      this.composer.setSize(w, h);
      // halo calculé en basse résolution sur téléphone
      this.bloom.resolution.set(w * (engine.small ? 0.5 : 1), h * (engine.small ? 0.5 : 1));
      this.camera.aspect = w / h;
      // sur téléphone, le bateau est remonté au-dessus de la barre d'instruments
      this.camera.setViewOffset(w, h, 0, Math.round(h * (w <= 760 ? 0.17 : 0.05)), w, h);
      this.camera.updateProjectionMatrix();
    });
  }

  input(): InputHandler {
    return {
      drag: (dx, dy) => {
        this.yaw -= dx * 0.006;
        this.pitch = Math.min(1.2, Math.max(0.03, this.pitch + dy * 0.004));
      },
      pinch: (r) => {
        this.tDist = Math.min(14, Math.max(0.9, this.tDist * r));
      },
      wheel: (dy) => {
        this.tDist = Math.min(14, Math.max(0.9, this.tDist * Math.exp(dy * 0.0012)));
      },
    };
  }

  /** Affiche ou masque les étiquettes des concurrents (vue active ou non). */
  setActive(on: boolean) {
    this.labels.hidden = !on;
  }

  /** Remet la caméra derrière le bateau. */
  reset() {
    this.yaw = 0.62;
    this.pitch = 0.1;
    this.tDist = this.engine.small ? 3.4 : 2.1;
  }

  private setPlayer(b: Boat) {
    const key = `${b.hull}.${b.foils}.${b.mast}.${b.color}.${boatModelVersion()}`;
    if (key === this.lookKey && this.rig) return;
    this.lookKey = key;
    if (this.rig) {
      this.scene.remove(this.rig.root);
      disposeBoat(this.rig);
    }
    this.rig = buildBoat({ hull: b.hull, foils: b.foils, mast: b.mast, color: b.color, name: 'Sail Run', number: 'FRA 1' }, true);
    // de près : carbone et gelcoat plus brillants, reflets du ciel bien visibles
    this.rig.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m || !('envMapIntensity' in m)) return;
      m.envMapIntensity = 1.4;
      if (m.roughness > 0.3) m.roughness = Math.max(0.22, m.roughness * 0.7);
    });
    this.scene.add(this.rig.root);
    // feux de navigation : rouge à bâbord, vert à tribord, blanc en tête de mât
    this.navLights = [0xff3030, 0x30ff60, 0xffffff].map((c) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: c }));
      this.rig!.heel.add(m);
      return m;
    });
    this.navLights[0].position.set(-0.07, 0.06, -0.44);
    this.navLights[1].position.set(0.07, 0.06, -0.44);
    this.navLights[2].position.set(0, 1.12, 0);
  }

  /**
   * Concurrents : tous visibles, dans leur vraie direction, mais à une distance « ramenée »
   * (sinon un bateau à 5 milles ne serait qu'un point). L'étiquette donne la vraie distance.
   */
  private updateOthers(me: Boat, boats: Boat[]) {
    const seen = new Set<string>();
    const cl = Math.cos(me.pos[1] * D2R);
    const h = me.hdg * D2R;
    const v = new THREE.Vector3();
    for (const b of boats) {
      if (b.isPlayer || b.finished !== null) continue;
      const eNm = (b.pos[0] - me.pos[0]) * cl * NM_PER_DEG;
      const nNm = (b.pos[1] - me.pos[1]) * NM_PER_DEG;
      const d = Math.hypot(eNm, nNm);
      seen.add(b.id);
      let o = this.others.get(b.id);
      if (!o) {
        const tag = document.createElement('div');
        tag.className = 'tag imm-tag';
        tag.style.background = b.color;
        tag.style.color = b.dark ? '#0B1E33' : '#FFFFFF';
        this.labels.appendChild(tag);
        o = { id: b.id, tag, rig: buildBoat({ hull: b.hull, foils: b.foils, mast: b.mast, color: b.color, name: b.name, number: BOT_NUMBERS[b.id] ?? 'FRA 99' }) };
        this.others.set(b.id, o);
        this.scene.add(o.rig.root);
      }
      // distance ramenée : 1 mille ≈ 11 longueurs, 20 milles ≈ 32, au-delà on reste sur l'horizon
      const dv = Math.max(2.2, 5 + 9 * Math.log1p(d));
      const ux = d > 1e-6 ? eNm / d : 0;
      const un = d > 1e-6 ? nNm / d : 1;
      // repère du bateau : -z = étrave, +x = tribord
      const ex = ux * dv;
      const nz = -un * dv;
      const x = ex * Math.cos(h) + nz * Math.sin(h);
      const z = -ex * Math.sin(h) + nz * Math.cos(h);
      const root = o.rig.root;
      root.position.set(x, waveHeight(this.waves, x, z - this.travel, this.time) - 0.015, z);
      root.rotation.set(0, -(b.hdg - me.hdg) * D2R, 0);
      trimBoat(o.rig, b.twa, b.tws);
      // étiquette au-dessus du mât
      v.set(x, root.position.y + 1.45, z).project(this.camera);
      const tag = o.tag;
      if (v.z > 1 || v.z < -1) {
        tag.style.visibility = 'hidden';
      } else {
        tag.style.visibility = 'visible';
        const sx = ((v.x + 1) / 2) * this.engine.w;
        const sy = ((1 - v.y) / 2) * this.engine.h;
        tag.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
        const du = toUnit(d);
        const dist = du < 10 ? du.toFixed(1).replace('.', ',') : String(Math.round(du));
        tag.textContent = `${b.name} · ${dist} ${unitLabel()}`;
      }
    }
    for (const [id, o] of this.others) {
      if (seen.has(id)) continue;
      this.scene.remove(o.rig.root);
      disposeBoat(o.rig);
      o.tag.remove();
      this.others.delete(id);
    }
  }

  private updateSky(day: number) {
    const zen = new THREE.Color(0.06, 0.24, 0.55).lerp(new THREE.Color(0.01, 0.02, 0.05), 1 - day);
    const hor = new THREE.Color(0.62, 0.76, 0.88).lerp(new THREE.Color(0.05, 0.07, 0.12), 1 - day);
    // aube et crépuscule : horizon plus chaud
    const dusk = Math.max(0, 1 - Math.abs(day - 0.5) * 2.5);
    hor.lerp(new THREE.Color(0.95, 0.62, 0.42), dusk * 0.6);
    (this.skyU.uZenith.value as THREE.Color).copy(zen);
    (this.skyU.uHorizon.value as THREE.Color).copy(hor);
    this.skyU.uDay.value = day;
    (this.scene.fog as THREE.Fog).color.copy(hor);
    this.hemi.intensity = 0.25 + 1.0 * day;
    this.sun.intensity = 0.1 + 2.6 * day;
    // environnement (reflets sur la coque) recalculé quand la lumière change vraiment
    const key = Math.round(day * 12);
    if (key !== this.envKey) {
      this.envKey = key;
      this.scene.environment?.dispose();
      this.scene.environment = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000).texture;
    }
  }

  frame(dt: number, me: Boat, boats: Boat[], day: number, sunAz: number) {
    this.time += dt;
    this.setPlayer(me);
    const rig = this.rig!;
    // vent dans le repère du bateau (d'où il vient)
    const fx = Math.sin(me.twa * D2R);
    const fz = -Math.cos(me.twa * D2R);
    this.waves = seaState(me.tws, fx, fz);
    this.waves.forEach((w, i) => {
      (this.seaU.uWaves.value as THREE.Vector4[])[i].set(w.dx, w.dz, w.k, w.a);
      (this.seaU.uWq.value as THREE.Vector2[])[i].set(w.q, w.w);
    });
    const v = me.spd * 0.0286 * 1.4; // unités / s (un peu accéléré pour la lisibilité)
    this.travel += v * dt;
    this.seaU.uTravel.value = this.travel;
    this.seaU.uTime.value = this.time;
    this.skyU.uTime.value = this.time;
    this.seaU.uSpeed.value = Math.min(1, me.spd / 14);
    this.seaU.uFoam.value = Math.min(1, Math.max(0, (me.tws - 9) / 22));
    this.seaU.uAmp.value = this.waves.reduce((t, w) => t + w.a, 0) * 0.55;

    // soleil : azimut selon l'heure, hauteur selon le jour
    const elev = 0.04 + 0.42 * day; // soleil assez bas : reflets dans le champ
    const sd = new THREE.Vector3(Math.sin(sunAz) * Math.cos(elev), Math.sin(elev), -Math.cos(sunAz) * Math.cos(elev)).normalize();
    (this.skyU.uSunDir.value as THREE.Vector3).copy(sd);
    this.sun.position.copy(sd).multiplyScalar(50);
    this.updateSky(day);

    // le bateau suit la houle : hauteur moyenne, tangage (étrave / poupe), roulis (bâbord / tribord)
    const T = this.time;
    const tz = -this.travel;
    const hb = waveHeight(this.waves, 0, -0.45 + tz, T);
    const hs = waveHeight(this.waves, 0, 0.45 + tz, T);
    const hp = waveHeight(this.waves, -0.12, tz, T);
    const hsb = waveHeight(this.waves, 0.12, tz, T);
    const y = (hb + hs + hp + hsb) / 4 - 0.015;
    this.bob.y += (y - this.bob.y) * Math.min(1, dt * 6);
    rig.root.position.set(0, this.bob.y, 0);
    const pitch = Math.atan2(hb - hs, 0.9) * 0.8;
    const roll = Math.atan2(hp - hsb, 0.24) * 0.25;
    rig.root.rotation.x += (pitch - rig.root.rotation.x) * Math.min(1, dt * 4);
    rig.root.rotation.z += (roll - rig.root.rotation.z) * Math.min(1, dt * 4);
    trimBoat(rig, me.twa, me.tws);
    for (const l of this.navLights) l.visible = day < 0.45;

    this.updateOthers(me, boats);
    this.updateSpray(dt, me);

    // caméra en orbite autour du bateau, qui suit doucement la houle
    this.dist += (this.tDist - this.dist) * Math.min(1, dt * 4);
    const cp = Math.cos(this.pitch);
    const cam = this.camera;
    // légères secousses quand ça va vite et que la mer est formée
    const sh = Math.min(1, me.spd / 25) * Math.min(1, me.tws / 25) * 0.012 * Math.min(1, 2.5 / this.dist);
    this.shake.set(Math.sin(T * 13.1) + Math.sin(T * 7.3), Math.sin(T * 11.7) * 0.6, Math.sin(T * 9.4)).multiplyScalar(sh);
    cam.position.set(Math.sin(this.yaw) * cp * this.dist, 0.28 + Math.sin(this.pitch) * this.dist + this.bob.y * 0.75, Math.cos(this.yaw) * cp * this.dist).add(this.shake);
    // jamais sous l'eau
    const under = waveHeight(this.waves, cam.position.x, cam.position.z + tz, T) + 0.06;
    if (cam.position.y < under) cam.position.y = under;
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0.42 + this.bob.y, 0);
    // la caméra accompagne un peu le roulis du bateau : on se sent à bord
    cam.rotateZ(rig.root.rotation.z * 0.35 + rig.heel.rotation.z * 0.12 * Math.min(1, 2.5 / this.dist));

    const r = this.engine.renderer;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = false;
    this.bloom.strength = 0.08 + 0.12 * day; // juste l’éclat du soleil sur l’eau, pas de halo général
    this.lens.uniforms.uTime.value = T;
    this.composer.render(dt);
  }

  private updateSpray(dt: number, me: Boat) {
    const n = this.sprayLife.length;
    const rate = Math.max(0, me.spd - 10) * 16; // particules / s
    let spawn = rate * dt;
    for (let i = 0; i < n; i++) {
      if (this.sprayLife[i] > 0) {
        this.sprayLife[i] -= dt;
        this.sprayVel[i * 3 + 1] -= 2.2 * dt;
        this.sprayPos[i * 3] += this.sprayVel[i * 3] * dt;
        this.sprayPos[i * 3 + 1] += this.sprayVel[i * 3 + 1] * dt;
        this.sprayPos[i * 3 + 2] += this.sprayVel[i * 3 + 2] * dt;
        if (this.sprayLife[i] <= 0) this.sprayPos[i * 3 + 1] = -10;
      } else if (spawn >= 1 || Math.random() < spawn) {
        spawn -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        this.sprayPos[i * 3] = side * (0.04 + Math.random() * 0.05);
        this.sprayPos[i * 3 + 1] = this.bob.y + 0.02;
        this.sprayPos[i * 3 + 2] = -0.38 + Math.random() * 0.15;
        this.sprayVel[i * 3] = side * (0.3 + Math.random() * 0.5);
        this.sprayVel[i * 3 + 1] = 0.5 + Math.random() * 0.7;
        this.sprayVel[i * 3 + 2] = 0.6 + Math.random() * 0.6;
        this.sprayLife[i] = 0.5 + Math.random() * 0.4;
      } else {
        this.sprayPos[i * 3 + 1] = -10;
      }
    }
    this.spray.geometry.attributes.position.needsUpdate = true;
  }
}
