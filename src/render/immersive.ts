import * as THREE from 'three';
import { Boat, boatSpeed } from '../sim/boat';
import { Hull } from './buoyancy';
import { Spray } from './spray';
import { sailAir } from './sailAir';
import { D2R, NM_PER_DEG } from '../sim/geo';
import { BoatRig, boatModelVersion, buildBoat, disposeBoat, showSails, trimBoat } from './boatModel';
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
    // caméra sous l'eau : le ciel devient le bleu des profondeurs
    uUnder: { value: 0 },
    uUnderCol: { value: new THREE.Color(0.0, 0.07, 0.11) },
  };
}

/** Uniformes de la mer, qui partagent ceux du ciel. */
export function seaUniforms(shared: Record<string, THREE.IUniform>): Record<string, THREE.IUniform> {
  return {
    ...shared,
    uWaves: { value: Array.from({ length: NWAVES }, () => new THREE.Vector4()) },
    uWq: { value: Array.from({ length: NWAVES }, () => new THREE.Vector2()) },
    uWind: { value: new THREE.Vector3(0, -1, 0) }, // sens de la houle (x, z) et force du vent (0 à 1)
    uTravel: { value: 0 },
    uSpeed: { value: 0 },
    uFoam: { value: 1 },
    uAmp: { value: 0.1 },
    uFar: { value: 1400 },
    uDeepCol: { value: new THREE.Color(0.005, 0.06, 0.13) },
    uScatCol: { value: new THREE.Color(0.0, 0.26, 0.28) },
    // transparence : ce qui est sous l'eau (couleur et profondeur, vu de la même caméra)
    uRefr: { value: null },
    uRefrDepth: { value: null },
    uCamNear: { value: 0.03 },
    uCamFar: { value: 3000 },
    // absorption par unité d'eau traversée (≈ 18 m) : le rouge disparaît vite, le bleu porte loin
    uAbsorb: { value: new THREE.Vector3(3.6, 0.85, 0.4) },
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
export function seaState(tws: number, fromX: number, fromZ: number, swell = 1): Wave[] {
  // `swell` grossit la houle (×2 = vagues deux fois plus hautes et ≈ 1,4 fois plus longues)
  const L0 = (2.2 + tws * 0.24) * Math.sqrt(swell); // longueur d'onde du train principal (unités)
  const A0 = (0.01 + Math.pow(tws, 1.5) * 0.00055) * swell; // amplitude (unités) : ≈ 1,3 m à 23 nds
  const base = Math.atan2(-fromX, -fromZ); // la houle va dans le sens du vent
  // crêtes rondes par petit temps, pointues quand la mer du vent se lève (somme des cambrures ≈ 0,3 à 0,7)
  const chop = 0.45 + 0.65 * Math.min(1, tws / 28);
  return WAVES.map(([da, lf, af, q]) => {
    const ang = base + da * D2R;
    const k = (2 * Math.PI) / (L0 * lf);
    const a = A0 * af;
    return { dx: Math.sin(ang), dz: Math.cos(ang), k, a, q: (q * chop) / (k * a * WAVES.length), w: Math.sqrt(G * k) };
  });
}

/**
 * Le bateau tel que la vue le montre, avec le vent de test (?dev) s'il y en a un : il garde ses voiles et la
 * manœuvre en cours (changement de voile animé), seule sa vitesse suit le vent imposé.
 */
export function withTestWind(b: Boat, test: { tws: number | null; twa: number | null }): Boat {
  if (test.tws === null && test.twa === null) return b;
  const tws = test.tws ?? b.tws;
  const twa = test.twa ?? b.twa;
  return { ...b, tws, twa, spd: boatSpeed(twa, tws, b.perf, b.sail) };
}

/** Hauteur de la mer (approchée, sans le déplacement horizontal) au point (x, z) du repère de l'eau. */
export function waveHeight(ws: Wave[], x: number, z: number, t: number): number {
  let h = 0;
  for (const w of ws) h += w.a * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t);
  return h;
}

/**
 * Hauteur exacte de la surface dessinée au point (x, z) du repère de l'eau. La houle de Gerstner décale l'eau
 * sur le côté (c'est ce qui pointe les crêtes) : on cherche d'abord le point d'eau qui arrive en (x, z)
 * (méthode de Newton, quelques pas suffisent), puis on prend sa hauteur.
 */
export function surfaceAt(ws: Wave[], x: number, z: number, t: number): number {
  let px = x;
  let pz = z;
  for (let it = 0; it < 4; it++) {
    let dx = 0;
    let dz = 0;
    let jxx = 1;
    let jzz = 1;
    let jxz = 0;
    for (const w of ws) {
      const ph = w.k * (w.dx * px + w.dz * pz) - w.w * t;
      const c = Math.cos(ph);
      const qs = w.q * w.k * w.a * Math.sin(ph);
      dx += w.q * w.a * w.dx * c;
      dz += w.q * w.a * w.dz * c;
      jxx -= qs * w.dx * w.dx;
      jzz -= qs * w.dz * w.dz;
      jxz -= qs * w.dx * w.dz;
    }
    const ex = px + dx - x;
    const ez = pz + dz - z;
    const det = jxx * jzz - jxz * jxz;
    px -= (jzz * ex - jxz * ez) / det;
    pz -= (jxx * ez - jxz * ex) / det;
  }
  return waveHeight(ws, px, pz, t);
}

export const SEA_VS = /* glsl */ `
  #define NW ${NWAVES}
  uniform vec4 uWaves[NW]; // dx, dz, k, a
  uniform vec2 uWq[NW];    // cambrure, pulsation
  uniform float uTime, uTravel;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vCrest;
  varying float vJac;
  varying vec2 vLocal;
  varying vec4 vClip;
  varying float vViewZ;
  void main() {
    vec3 p = position;
    float r = length(p.xz);
    float fade = 1.0 - smoothstep(120.0, 420.0, r);
    vec2 wp = p.xz + vec2(0.0, -uTravel); // position dans le repère de l'eau (le bateau avance vers -z)
    vec3 d = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float crest = 0.0;
    // jacobien du déplacement horizontal : il passe sous 1 là où la crête se resserre, jusqu'à déferler
    float jxx = 1.0, jzz = 1.0, jxz = 0.0;
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
      float qs = q * k * a * s;
      jxx -= qs * dir.x * dir.x;
      jzz -= qs * dir.y * dir.y;
      jxz -= qs * dir.x * dir.y;
      crest += s * a;
    }
    p += d;
    vNormal = n;
    vCrest = crest;
    vJac = jxx * jzz - jxz * jxz;
    vLocal = position.xz;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    vec4 vw = viewMatrix * w;
    vViewZ = vw.z;
    gl_Position = projectionMatrix * vw;
    vClip = gl_Position;
  }`;

const SKY_FN = /* glsl */ `
  uniform vec3 uSunDir, uZenith, uHorizon, uSunColor, uUnderCol;
  uniform float uDay;
  // sous l'eau : bleu-vert, de plus en plus sombre vers le fond (y = composante verticale du regard)
  vec3 deepColor(float y) {
    return uUnderCol * (y < 0.0 ? mix(0.15, 1.0, smoothstep(-0.9, 0.0, y)) : 1.0 + 0.4 * y);
  }
  vec3 skyColor(vec3 dir) {
    float h = max(dir.y, 0.0);
    vec3 c = mix(uHorizon, uZenith, pow(h, 0.55));
    float sd = max(dot(dir, uSunDir), 0.0);
    c += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 64.0) * 0.35) * (0.3 + 0.7 * uDay);
    return c;
  }`;

export const SEA_FS = /* glsl */ `
  uniform float uTime, uTravel, uSpeed, uFoam, uFar, uAmp;
  #include <packing>
  uniform vec3 uDeepCol, uScatCol, uWind;
  uniform sampler2D uRefr, uRefrDepth;
  uniform float uCamNear, uCamFar;
  uniform vec3 uAbsorb;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vCrest;
  varying float vJac;
  varying vec2 vLocal;
  varying vec4 vClip;
  varying float vViewZ;
  ${SKY_FN}
  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; } return v; }

  // Vaguelettes de 11 m à 40 cm, en éventail autour du vent, au profil pointu exp(sin - 1)
  // (crêtes vives, creux larges), qui avancent à leur vraie vitesse. Retourne la pente (d/dx, d/dz).
  // Chacune s'efface quand elle devient plus fine que quelques pixels : net de près, sans scintillement au loin.
  // (8 seulement sur téléphone, voir le constructeur)
  #ifndef ND
  #define ND 12
  #endif
  vec2 ripples(vec2 p, float px) {
    vec2 g = vec2(0.0);
    float lam = 0.6;
    float a0 = atan(uWind.y, uWind.x);
    float amp = 0.06 + 0.1 * uWind.z;
    for (int i = 0; i < ND; i++) {
      float fi = float(i);
      // directions, phases et longueurs tirées au hasard (mais fixes) : pas de motif régulier
      float ang = a0 + (hash(vec2(fi, 3.7)) - 0.5) * 2.6;
      vec2 dir = vec2(cos(ang), sin(ang));
      float k = 6.2831853 / lam;
      float ph = k * dot(dir, p) - sqrt(${G} * k) * uTime + hash(vec2(fi, 9.1)) * 6.2831853;
      float aa = 1.0 - smoothstep(0.12, 0.45, px / lam);
      vec2 d = dir * exp(sin(ph) - 1.0) * cos(ph);
      g += d * amp * aa;
      // la vaguelette suivante est un peu entraînée par celle-ci : des crêtes qui ne sont pas des droites
      p -= d * lam * 0.06;
      lam *= 0.72 + 0.08 * hash(vec2(fi, 5.3));
    }
    return g;
  }

  // distance (le long de l'axe de la caméra) de ce qui se trouve sous l'eau à cet endroit de l'écran
  float sceneZ(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(uRefrDepth, uv).x, uCamNear, uCamFar); }

  // La surface vue d'en dessous : un miroir (réflexion totale) qui renvoie le bleu des profondeurs, sauf dans
  // la fenêtre de Snell (un cône de 97° au-dessus de la tête) où l'on voit le ciel, le soleil et le haut du bateau.
  vec3 fromBelow(vec3 n, float dist, float foam, vec2 suv, float seaZ) {
    vec3 i = normalize(vWorld - cameraPosition);
    vec3 t = refract(i, -n, 1.33);
    // réflexion totale : la surface renvoie les profondeurs, et les vagues la moirent
    vec3 c = deepColor(reflect(i, -n).y) * 1.15;
    if (dot(t, t) > 1e-4) {
      vec3 through = skyColor(t) + uSunColor * pow(max(dot(t, uSunDir), 0.0), 400.0) * 4.0 * uDay;
      // le haut du bateau, à travers la surface
      vec2 ruv = suv + n.xz * 0.03;
      float z = sceneZ(ruv);
      if (z > seaZ && z < uCamFar * 0.9) through = texture2D(uRefr, ruv).rgb;
      c = mix(c, through, smoothstep(0.0, 0.35, t.y)); // la fenêtre s'assombrit sur son bord
    }
    // l'écume, vue de dessous : des taches claires
    c = mix(c, vec3(0.75, 0.85, 0.9) * (0.25 + 0.75 * uDay), foam * 0.6);
    // l'eau entre la caméra et la surface
    return mix(c, uUnderCol, 1.0 - exp(-dist * 0.3));
  }

  void main() {
    vec2 wp = vLocal + vec2(0.0, -uTravel);
    float dist = length(vWorld - cameraPosition);
    // houle (sommet) + vaguelettes (fragment), additionnées en pentes
    vec2 g = ripples(wp, length(fwidth(wp)));
    vec3 nb = vNormal / max(vNormal.y, 0.25);
    vec3 n = normalize(vec3(nb.x - g.x, 1.0, nb.z - g.y));
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 refl = reflect(-v, n);
    refl.y = abs(refl.y);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    // l'eau : bleu profond ; la lumière traverse le corps des vagues (turquoise), surtout le haut,
    // et davantage quand on regarde vers le soleil
    vec3 deep = uDeepCol * (0.2 + 0.8 * uDay);
    vec3 scatter = uScatCol * (0.15 + 0.85 * uDay);
    float hn = vCrest / max(uAmp, 1e-3);
    float back = pow(max(dot(v, -uSunDir) * 0.5 + 0.5, 0.0), 3.0);
    float sss = smoothstep(-0.6, 1.3, hn) * (0.45 + 0.55 * back);
    vec3 body = mix(deep, scatter, sss);
    // transparence : ce qui est sous la surface (coque, quille, foils), décalé par les vagues
    // et teinté selon l'épaisseur d'eau traversée
    vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
    float seaZ = -vViewZ;
    vec2 ruv = suv + n.xz * 0.035 * (1.0 - smoothstep(2.0, 25.0, dist));
    if (sceneZ(ruv) < seaZ) ruv = suv; // le point décalé est hors de l'eau : on ne lui emprunte pas sa couleur
    float thick = max(sceneZ(ruv) - seaZ, 0.0) * dist / max(seaZ, 1e-3);
    vec3 tr = exp(-uAbsorb * thick);
    vec3 col = texture2D(uRefr, ruv).rgb * tr + body * (1.0 - tr);
    col = mix(col, skyColor(refl), fres);
    // soleil sur l'eau : les vaguelettes le découpent en éclats
    vec3 hv = normalize(uSunDir + v);
    float ndh = max(dot(n, hv), 0.0);
    float spec = pow(ndh, 900.0) * 7.0 + pow(ndh, 120.0) * 0.25;
    col += uSunColor * spec * uDay;

    // moutons : là où la houle se resserre jusqu'à déferler ; il y en a de plus en plus quand le vent forcit
    float fpat = fbm(wp * 2.2 + uWind.xy * uTime * 0.03);
    // dentelle : l'écume est pleine au cœur du déferlement et se troue sur les bords
    float lace = fbm(wp * 9.0 - uWind.xy * uTime * 0.05) + 0.35 * noise(wp * 31.0);
    float thr = 0.7 + 0.13 * uFoam;
    // toutes les crêtes ne déferlent pas : seulement par endroits
    float core = smoothstep(thr, thr - 0.05, vJac + (fpat - 0.5) * 0.12) * smoothstep(0.36, 0.56, fpat) * step(0.01, uFoam);
    float cap = smoothstep(0.78 - 0.4 * core, 0.92 - 0.4 * core, lace) * smoothstep(0.0, 0.08, core);
    // par vent fort, l'écume s'étire en fines traînées dans le sens du vent
    vec2 along = vec2(dot(wp, uWind.xy), dot(wp, vec2(-uWind.y, uWind.x)));
    float streak = smoothstep(0.64, 0.8, fbm(vec2(along.x * 0.5, along.y * 7.0))) * smoothstep(0.55, 0.75, lace) * smoothstep(0.5, 1.0, uFoam) * 0.3;

    // sillage : blanc franc au tableau, puis des plaques d'écume qui se défont sur de l'eau brassée turquoise ;
    // les bras du V de Kelvin, en courts tirets d'écume
    float zb = vLocal.y - 0.42;
    float wake = 0.0;
    float aerated = 0.0;
    if (zb > -0.05 && uSpeed > 0.01) {
      float len = 3.0 + 7.0 * uSpeed; // longueur du sillage (en longueurs de bateau)
      float age = clamp(zb / len, 0.0, 1.0);
      // la traînée ondule un peu et s'élargit
      float x = abs(vLocal.x + (noise(vec2(wp.y * 0.6, 1.0)) - 0.5) * 0.12 * sqrt(max(zb, 0.0)));
      float wide = 0.13 + zb * 0.035;
      float inner = 1.0 - smoothstep(wide * 0.2, wide, x);
      float churn = fbm(vec2(x * 7.0, wp.y * 1.8)) * 0.75 + 0.45 * noise(vec2(x * 30.0, wp.y * 9.0));
      float trail = inner * smoothstep(0.52 + 0.45 * age, 0.66 + 0.45 * age, churn) * (1.0 - age);
      trail = max(trail, inner * (1.0 - smoothstep(0.0, 0.6, zb)) * smoothstep(0.3, 0.5, churn));
      float spread = 0.1 + zb * 0.34;
      float arm = (1.0 - smoothstep(0.0, 0.015 + zb * 0.008, abs(abs(vLocal.x) - spread))) * (1.0 - smoothstep(0.5, 4.0, zb));
      arm *= smoothstep(0.55, 0.75, fbm(vec2(zb * 4.0, wp.y * 2.0)));
      wake = (trail + arm * 0.35) * uSpeed;
      aerated = exp(-x * x / (wide * wide * 0.8)) * (1.0 - age) * (0.6 + 0.4 * fbm(vec2(x * 4.0, wp.y))) * uSpeed;
    }
    // vague d'étrave le long de la coque
    float hull = (1.0 - smoothstep(0.1, 0.22, abs(abs(vLocal.x) - 0.12))) * (1.0 - smoothstep(0.0, 0.9, abs(vLocal.y))) * uSpeed;
    hull *= smoothstep(0.35, 0.65, fbm(vLocal * 9.0 + uTime));

    // eau brassée : turquoise laiteux sous l'écume du sillage
    col = mix(col, scatter * 1.8 + deep, aerated * 0.5);
    float foam = clamp(cap * 0.9 + streak + wake + hull * 0.6, 0.0, 1.0);
    float lit = (0.55 + 0.45 * max(dot(n, uSunDir), 0.0)) * (0.8 + 0.2 * lace);
    col = mix(col, vec3(0.9, 0.95, 1.0) * lit * (0.3 + 0.7 * uDay), foam);
    if (gl_FrontFacing) {
      // horizon : la mer se fond dans le ciel
      vec3 hz = skyColor(normalize(vec3(vWorld.x - cameraPosition.x, 0.0, vWorld.z - cameraPosition.z)));
      col = mix(col, hz, smoothstep(uFar * 0.25, uFar, dist));
    } else {
      col = fromBelow(n, dist, foam, suv, seaZ);
    }
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
  uniform float uTime, uUnder;
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
      // formes tourmentées (bruit déformé par lui-même) plutôt que des taches rondes
      vec2 warp = vec2(fbm(cp * 0.7 + 3.1), fbm(cp * 0.7 + 7.7)) - 0.5;
      float dens = fbm(cp + warp * 0.9);
      float c = smoothstep(0.46, 0.72, dens);
      // bords lumineux, ventre plus gris là où le nuage est épais, liseré doré à contre-jour
      float thick = smoothstep(0.55, 0.9, dens);
      float sunAmt = max(dot(d, uSunDir), 0.0);
      vec3 cc = mix(vec3(1.0, 0.98, 0.95), vec3(0.62, 0.68, 0.78), thick * 0.7) * (0.8 + 0.2 * sunAmt);
      cc += uSunColor * pow(sunAmt, 8.0) * (1.0 - thick) * 0.6;
      cc = mix(vec3(0.16, 0.18, 0.24), cc, uDay);
      col = mix(col, cc, c * smoothstep(0.0, 0.18, d.y) * 0.9);
    }
    // nuit : quelques étoiles
    float st = step(0.9985, hash(floor(d.xz / max(d.y, 0.05) * 300.0))) * (1.0 - uDay) * smoothstep(0.05, 0.3, d.y);
    col += vec3(st);
    // caméra sous l'eau : bleu-vert, plus clair vers la surface, presque noir vers le fond
    if (uUnder > 0.5) col = deepColor(d.y);
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
  /** ce qui est sous l'eau : le bateau seul (calque 1), à mi-résolution, avec sa profondeur */
  private refr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) });
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
  private hull = new Hull();
  private envKey = -1;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private spray = new Spray();
  private navLights: THREE.Mesh[] = [];

  private labels: HTMLDivElement;

  /**
   * Réglages de test (?dev) : vent (nœuds, angle au vent) et houle imposés à la vue, null = ceux de la course.
   * N'agit que sur l'image, jamais sur la simulation.
   */
  readonly test: { tws: number | null; twa: number | null; swell: number } = { tws: null, twa: null, swell: 1 };

  constructor(
    private engine: Engine,
    host: HTMLElement,
  ) {
    this.labels = document.createElement('div');
    this.labels.className = 'imm-labels';
    this.labels.hidden = true;
    host.appendChild(this.labels);
    const shared = skyUniforms();
    this.seaU = seaUniforms(shared);
    this.seaU.uRefr.value = this.refr.texture;
    this.seaU.uRefrDepth.value = this.refr.depthTexture;
    this.seaU.uCamNear.value = this.camera.near;
    this.seaU.uCamFar.value = this.camera.far;
    this.skyU = shared;

    const g = polarSeaGeometry(engine.small);
    // les deux faces : la mer se voit aussi d'en dessous quand la caméra plonge
    this.sea = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: this.seaU, vertexShader: SEA_VS, fragmentShader: SEA_FS, side: THREE.DoubleSide, defines: engine.small ? { ND: 8 } : {} }));
    this.sea.frustumCulled = false;
    this.scene.add(this.sea);

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false }));
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.envScene.add(new THREE.Mesh(this.sky.geometry, this.sky.material));

    this.scene.add(this.hemi, this.sun, this.sun.target);
    // les lumières éclairent aussi la vue sous l'eau
    this.hemi.layers.enable(1);
    this.sun.layers.enable(1);
    this.scene.fog = new THREE.Fog(0xbfd4e6, 60, 900);
    this.pmrem = new THREE.PMREMGenerator(engine.renderer);

    this.scene.add(this.spray.points);

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
      this.refr.setSize(Math.round(w * r.getPixelRatio() * 0.5), Math.round(h * r.getPixelRatio() * 0.5));
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
        // en dessous de 0, la caméra plonge sous l'eau pour voir la carène
        this.pitch = Math.min(1.2, Math.max(-0.75, this.pitch + dy * 0.004));
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
  /** cap affiché (lissé), null avant la première image */
  private vHdg: number | null = null;

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
    // le bateau du joueur est le seul qu'on voit sous l'eau
    this.rig.root.traverse((o) => o.layers.enable(1));
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
        o.rig.root.rotation.order = 'YXZ'; // cap d'abord, puis tangage et roulis dans l'axe du bateau
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
      // posé sur la houle : hauteur sous la coque, tangage et roulis selon la pente de l'eau
      const psi = -(b.hdg - me.hdg) * D2R;
      const bx = -Math.sin(psi) * 0.4; // demi-longueur, vers l'étrave
      const bz = -Math.cos(psi) * 0.4;
      const sx = Math.cos(psi) * 0.12; // demi-largeur, vers tribord
      const sz = -Math.sin(psi) * 0.12;
      const sea = (dx: number, dz: number) => surfaceAt(this.waves, x + dx, z + dz - this.travel, this.time);
      const hb = sea(bx, bz);
      const hs = sea(-bx, -bz);
      const hst = sea(sx, sz);
      const hp = sea(-sx, -sz);
      root.position.set(x, (hb + hs + hst + hp) / 4 - 0.015, z);
      root.rotation.set(Math.atan2(hb - hs, 0.8) * 0.7, psi, Math.atan2(hst - hp, 0.24) * 0.5);
      trimBoat(o.rig, b.twa, b.tws);
      showSails(o.rig, b, this.time);
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
      // toujours le vrai ciel, même si la caméra est sous l'eau à ce moment-là
      const under = this.skyU.uUnder.value;
      this.skyU.uUnder.value = 0;
      this.scene.environment = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000).texture;
      this.skyU.uUnder.value = under;
    }
  }

  /**
   * Une image de la vue au ras de l'eau. `vp` (pixels CSS, origine en haut à gauche) : rendu réduit dans
   * ce rectangle seulement, sans post-traitement — c'est la fenêtre 3D posée sur la carte.
   */
  frame(dt: number, real: Boat, boats: Boat[], day: number, sunAz: number, vp?: { x: number; y: number; w: number; h: number }) {
    this.time += dt;
    // le cap affiché rejoint le vrai cap en douceur : la mer, le vent, les voiles et les concurrents
    // tournent autour du bateau au lieu de sauter d'un coup quand on change de cap
    if (this.vHdg === null || dt > 1) this.vHdg = real.hdg;
    const dh = ((real.hdg - this.vHdg + 540) % 360) - 180;
    const step = Math.sign(dh) * Math.min(Math.abs(dh), Math.max(Math.abs(dh) * Math.min(1, dt * 2.2), 6 * dt));
    this.vHdg = (this.vHdg + step + 360) % 360;
    const vTwa = ((real.twd - this.vHdg + 540) % 360) - 180;
    const test = this.test;
    const me = withTestWind({ ...real, hdg: this.vHdg, twa: Math.abs(dh) < 0.05 ? real.twa : vTwa }, test);
    sunAz += (real.hdg - this.vHdg) * D2R;
    this.setPlayer(me);
    const rig = this.rig!;
    // vent dans le repère du bateau (d'où il vient)
    const fx = Math.sin(me.twa * D2R);
    const fz = -Math.cos(me.twa * D2R);
    this.waves = seaState(me.tws, fx, fz, test.swell);
    applyWaves(this.seaU, this.waves);
    (this.seaU.uWind.value as THREE.Vector3).set(this.waves[0].dx, this.waves[0].dz, Math.min(1, me.tws / 30));
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

    // le bateau flotte sur la houle (pilonnement, tangage, roulis, avec son inertie) ; au portant et au
    // travers, à grande vitesse, les foils portent une partie du poids et soulagent la coque
    const T = this.time;
    const tz = -this.travel;
    const twa = Math.abs(me.twa);
    const lift = me.perf.imoca && twa > 55 && twa < 165 ? 0.6 * Math.min(1, Math.max(0, (me.spd - 11) / 9)) : 0;
    this.hull.step(dt, (x, z) => surfaceAt(this.waves, x, z + tz, T), lift);
    this.bob.y = this.hull.y - 0.015;
    rig.root.position.set(0, this.bob.y, 0);
    rig.root.rotation.x = this.hull.pitch;
    rig.root.rotation.z = this.hull.roll;
    // le vent fait vivre les voiles : risées (gîte, creux), chute qui bat, penons
    const air = sailAir(this.time, me.tws, me.twa, me.spd);
    trimBoat(rig, me.twa, me.tws, air.gust);
    showSails(rig, me, this.time, air);
    for (const l of this.navLights) l.visible = day < 0.45;

    this.updateOthers(me, boats);
    // embruns : le vent apparent les emporte (vent réel + vent de la vitesse, même échelle que la mer qui défile)
    const ka = 0.0286 * 1.4;
    this.spray.step(dt, {
      hull: this.hull,
      water: (x, z) => surfaceAt(this.waves, x, z + tz, T),
      spd: me.spd,
      wind: [-fx * me.tws * ka, -fz * me.tws * ka + v],
    });
    this.spray.light(day, this.skyU.uHorizon.value as THREE.Color);

    // caméra en orbite autour du bateau, qui suit doucement la houle
    this.dist += (this.tDist - this.dist) * Math.min(1, dt * 4);
    const cp = Math.cos(this.pitch);
    const cam = this.camera;
    // légères secousses quand ça va vite et que la mer est formée
    const sh = Math.min(1, me.spd / 25) * Math.min(1, me.tws / 25) * 0.012 * Math.min(1, 2.5 / this.dist);
    this.shake.set(Math.sin(T * 13.1) + Math.sin(T * 7.3), Math.sin(T * 11.7) * 0.6, Math.sin(T * 9.4)).multiplyScalar(sh);
    cam.position.set(Math.sin(this.yaw) * cp * this.dist, 0.28 + Math.sin(this.pitch) * this.dist + this.bob.y * 0.75, Math.cos(this.yaw) * cp * this.dist).add(this.shake);
    // jamais pile à la surface (le plan proche la couperait en deux) : on reste d'un côté ou de l'autre
    const surf = surfaceAt(this.waves, cam.position.x, cam.position.z + tz, T);
    if (Math.abs(cam.position.y - surf) < 0.05) cam.position.y = surf + (cam.position.y > surf ? 0.05 : -0.05);
    const under = cam.position.y < surf;
    cam.up.set(0, 1, 0);
    // vue de dessous : on vise la carène plutôt que le pont
    const low = Math.min(1, Math.max(0, -this.pitch / 0.5));
    cam.lookAt(0, 0.42 - 0.6 * low + this.bob.y, 0);
    // la caméra accompagne un peu le roulis du bateau : on se sent à bord
    cam.rotateZ(rig.root.rotation.z * 0.35 + rig.heel.rotation.z * 0.12 * Math.min(1, 2.5 / this.dist));

    // sous l'eau : on n'y voit qu'à quelques dizaines de mètres, dans un bleu-vert qui suit la lumière du jour
    const waterCol = this.skyU.uUnderCol.value as THREE.Color;
    waterCol.setRGB(0.0, 0.1, 0.15).multiplyScalar(0.12 + 0.88 * day);
    this.skyU.uUnder.value = under ? 1 : 0;
    const fog = this.scene.fog as THREE.Fog;
    if (under) {
      fog.color.copy(waterCol);
      fog.near = 0.1;
      fog.far = 5;
    } else {
      fog.near = 60;
      fog.far = 900;
    }

    const r = this.engine.renderer;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = false;
    this.bloom.strength = 0.08 + 0.12 * day; // juste l’éclat du soleil sur l’eau, pas de halo général
    this.lens.uniforms.uTime.value = T;
    // fenêtre 3D posée sur la carte : on cadre la caméra sur elle avant toute passe
    const H = this.engine.h;
    if (vp) {
      cam.aspect = vp.w / vp.h;
      cam.updateProjectionMatrix();
    }
    // taille des embruns à l'écran : pixels par longueur à une distance de 1, dans l'image qu'on dessine
    this.spray.uniforms.uPx.value = (vp ? vp.h * r.getPixelRatio() : r.domElement.height) * 0.5 * cam.projectionMatrix.elements[5];
    // vue sous l'eau d'abord : la mer la laissera voir par transparence
    const mask = cam.layers.mask;
    cam.layers.set(1);
    r.setRenderTarget(this.refr);
    r.render(this.scene, cam);
    r.setRenderTarget(null);
    cam.layers.mask = mask;
    if (!vp) {
      this.composer.render(dt);
      return;
    }
    r.setScissorTest(true);
    r.setViewport(vp.x, H - vp.y - vp.h, vp.w, vp.h);
    r.setScissor(vp.x, H - vp.y - vp.h, vp.w, vp.h);
    r.render(this.scene, cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.engine.w, H);
    cam.aspect = this.engine.w / H;
    cam.updateProjectionMatrix();
  }
}
