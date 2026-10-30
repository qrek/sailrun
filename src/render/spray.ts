/**
 * Embruns d'étrave (vue immersive). L'étrave mouillée pulvérise un peu d'eau en continu ; quand elle plonge dans
 * une vague, c'est une gerbe. Chaque goutte part de la flottaison le long de l'étrave, monte, retombe sous son
 * poids et s'étale en brume que le vent apparent emporte sous le vent et vers l'arrière. Elle disparaît en
 * retombant dans l'eau ou en se dissipant. Rien quand les foils ont sorti l'étrave de l'eau.
 *
 * Repère du bateau, comme la flottabilité : 1 = une longueur de coque, étrave vers -z, tribord vers +x.
 */

import * as THREE from 'three';
import { Hull, halfBeam } from './buoyancy';

const G = 9.81 / 18;
const N = 900;
/** l'eau part de l'étrave jusqu'aux épaules de la carène */
const BOW = -0.44;
const SHOULDER = -0.16;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface SprayInput {
  hull: Hull;
  /** hauteur de l'eau sous un point (repère du bateau) */
  water: (x: number, z: number) => number;
  /** vitesse du bateau, en nœuds */
  spd: number;
  /** vent apparent (x, z) dans le repère du bateau, vers où il souffle, en longueurs / s */
  wind: [number, number];
}

const SPRAY_VS = /* glsl */ `
  attribute vec4 aLife; // âge (0 → 1), taille, graine, opacité
  uniform float uPx;
  varying vec4 vLife;
  varying float vNear;
  #include <fog_pars_vertex>
  void main() {
    vLife = aLife;
    if (aLife.w <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float depth = -mvPosition.z;
    // la goutte s'étale en brume en vieillissant
    float size = aLife.y * (0.3 + 0.7 * sqrt(aLife.x));
    gl_PointSize = min(size * uPx / max(depth, 0.01), 220.0);
    // tout contre l'objectif, on l'efface plutôt que de voiler l'écran
    vNear = smoothstep(0.2, 0.6, depth);
    #include <fog_vertex>
  }`;

const SPRAY_FS = /* glsl */ `
  uniform vec3 uLit, uShade;
  varying vec4 vLife;
  varying float vNear;
  #include <fog_pars_fragment>
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    // une bouffée irrégulière, pas un disque
    float a = atan(p.y, p.x);
    float s = vLife.z * 6.2832;
    float r = length(p) * (1.0 + 0.2 * sin(a * 3.0 + s) + 0.12 * sin(a * 5.0 - s * 2.0));
    float age = vLife.x;
    float body = 1.0 - smoothstep(0.1 + 0.45 * age, 1.0, r);
    float alpha = body * smoothstep(0.0, 0.1, age) * (1.0 - age) * (1.0 - age) * vLife.w * vNear;
    if (alpha < 0.003) discard;
    // éclairée par le dessus, plus sombre dessous
    vec3 col = mix(uShade, uLit, 0.6 - 0.4 * p.y);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

export class Spray {
  readonly points: THREE.Points;
  readonly uniforms: Record<string, THREE.IUniform>;
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  /** par goutte : âge relatif, taille, graine, opacité (0 = morte) */
  private life = new Float32Array(N * 4);
  private age = new Float32Array(N);
  private span = new Float32Array(N);
  /** 1 = brume (large, pâle, emportée par le vent), 0 = goutte */
  private mist = new Uint8Array(N);
  private next = 0;
  private debt = 0;
  /** enfoncement de l'étrave au pas précédent */
  private wet = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uPx: { value: 500 }, uLit: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.6, 0.65, 0.7) } },
      ]),
      vertexShader: SPRAY_VS,
      fragmentShader: SPRAY_FS,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.uniforms = m.uniforms;
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }

  /** Couleur selon la lumière du jour (0 = nuit, 1 = plein jour) et la couleur de l'horizon. */
  light(day: number, horizon: THREE.Color): void {
    const lit = 0.3 + 0.7 * day;
    (this.uniforms.uLit.value as THREE.Color).setRGB(0.92 * lit, 0.95 * lit, lit);
    (this.uniforms.uShade.value as THREE.Color).setRGB(0.55 * lit, 0.6 * lit, 0.66 * lit).lerp(horizon, 0.35);
  }

  step(dt: number, { hull, water, spd, wind }: SprayInput): void {
    const h = Math.min(dt, 0.1);
    // l'étrave est-elle dans l'eau, et à quelle vitesse s'y enfonce-t-elle ?
    const zb = BOW + 0.06;
    const wet = water(0, zb) - hull.keel(0, zb);
    const plunge = dt > 0 ? clamp((wet - this.wet) / dt, 0, 1.5) : 0;
    this.wet = wet;
    const fast = clamp((spd - 8) / 14, 0, 1);
    // à la mesure du choc : une étrave qui entre dans la vague éclabousse (≈ 2 m/s), un plongeon fait une gerbe (≈ 9 m/s)
    const burst = clamp((plunge - 0.08) / 0.4, 0, 1) * clamp((spd - 4) / 12, 0, 1);
    let rate = 0;
    if (wet > -0.005) rate += 70 * fast; // la vague d'étrave qui se pulvérise
    if (wet > -0.03) rate += 2200 * burst; // la gerbe quand l'étrave tape
    this.debt += rate * h;
    while (this.debt >= 1) {
      this.debt -= 1;
      this.spawn(hull, water, spd, fast, burst);
    }

    const pos = this.pos;
    const vel = this.vel;
    for (let i = 0; i < N; i++) {
      if (this.age[i] >= this.span[i]) continue;
      this.age[i] += h;
      const r = this.age[i] / this.span[i];
      // le vent emporte tout, la brume plus vite ; les gouttes retombent sous leur poids, la brume flotte
      const mist = this.mist[i] === 1;
      const drag = Math.min(1, (mist ? 3 : 2) * (1 + 2 * r) * h);
      vel[i * 3] += (wind[0] - vel[i * 3]) * drag;
      vel[i * 3 + 1] -= G * h + (mist ? vel[i * 3 + 1] * drag * 0.5 : 0);
      vel[i * 3 + 2] += (wind[1] - vel[i * 3 + 2]) * drag;
      pos[i * 3] += vel[i * 3] * h;
      pos[i * 3 + 1] += vel[i * 3 + 1] * h;
      pos[i * 3 + 2] += vel[i * 3 + 2] * h;
      if (r >= 1 || pos[i * 3 + 1] < water(pos[i * 3], pos[i * 3 + 2])) {
        this.age[i] = this.span[i] = 0;
        this.life[i * 4 + 3] = 0;
      } else {
        this.life[i * 4] = r;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aLife.needsUpdate = true;
  }

  private spawn(hull: Hull, water: SprayInput['water'], spd: number, fast: number, burst: number) {
    const side = Math.random() < 0.5 ? -1 : 1;
    // surtout vers l'étrave
    const z = BOW + (SHOULDER - BOW) * Math.random() * Math.random();
    const x = side * halfBeam(z);
    const w = water(x, z);
    // ce coin de carène est sorti de l'eau : rien ne part d'ici
    if (hull.keel(x, z) > w + 0.005) return;
    const i = this.next;
    this.next = (i + 1) % N;
    const k = 0.5 + 0.5 * fast;
    // surtout des gouttes, fines et nettes ; un peu de brume, large et pâle, que le vent emporte
    const mist = Math.random() < 0.25;
    this.pos.set([x, w + 0.003, z], i * 3);
    this.vel.set(
      [
        side * ((0.1 + 0.2 * Math.random()) * k + burst * (0.15 + 0.3 * Math.random())),
        // la gerbe jaillit : jusqu'à 7 m quand l'étrave plonge
        (0.06 + 0.12 * Math.random()) * k + burst * (0.25 + 0.25 * Math.random()),
        // l'eau file le long de la coque vers l'arrière
        (0.3 + 0.4 * Math.random()) * spd * 0.03,
      ],
      i * 3,
    );
    this.age[i] = 0;
    this.span[i] = (mist ? 0.5 + 0.4 * Math.random() : 0.4 + 0.4 * Math.random()) * (1 + 0.5 * burst);
    this.mist[i] = mist ? 1 : 0;
    const size = mist ? 0.035 + 0.03 * Math.random() : 0.01 + 0.014 * Math.random();
    const alpha = mist ? 0.1 + 0.08 * Math.random() : 0.35 + 0.25 * Math.random() + 0.3 * burst;
    this.life.set([0, size * (1 + 0.9 * burst), Math.random(), alpha], i * 4);
  }
}
