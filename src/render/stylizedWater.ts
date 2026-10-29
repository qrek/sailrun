import * as THREE from 'three';

/**
 * Eau d'océan stylisée pour le port (façon jeux « cartoon haut de gamme ») :
 * bleu profond qui s'éclaircit vers l'horizon, traits d'écume blancs qui dérivent,
 * anneaux d'écume qui ondulent autour des coques, des piles et le long du quai, reflets du soleil nets.
 */
export const MAX_FOAM = 24;

export function stylizedWaterMaterial(): THREE.ShaderMaterial {
  const foam: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_FOAM; i++) foam.push(new THREE.Vector4(0, 0, 0, 0));
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.32, -0.77).normalize() },
      uDeep: { value: new THREE.Color(0x0a2d5a) },
      uMid: { value: new THREE.Color(0x15589c) },
      uSky: { value: new THREE.Color(0x9cc8ea) },
      uFoam: { value: foam },
      uFoamN: { value: 0 },
      uQuayX: { value: -11 },
      uFogNear: { value: 90 },
      uFogFar: { value: 420 },
      uFogColor: { value: new THREE.Color(0xc9dbe8) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uFoamN, uQuayX, uFogNear, uFogFar;
      uniform vec3 uSunDir, uDeep, uMid, uSky, uFogColor;
      uniform vec4 uFoam[${MAX_FOAM}];
      varying vec3 vWorld;
      float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      const mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        float dist = length(vWorld - cameraPosition);
        vec3 V = normalize(cameraPosition - vWorld);
        // petites vagues : normale à partir de deux couches de bruit qui dérivent
        vec2 q1 = R * p * 1.6 + vec2(t * 0.12, t * 0.05);
        vec2 q2 = R * R * p * 3.7 - vec2(t * 0.09, -t * 0.16);
        float e = 0.05;
        float h0 = noise(q1) + 0.5 * noise(q2);
        float hx = noise(q1 + vec2(e, 0.0)) + 0.5 * noise(q2 + vec2(e, 0.0)) - h0;
        float hz = noise(q1 + vec2(0.0, e)) + 0.5 * noise(q2 + vec2(0.0, e)) - h0;
        float near = 1.0 - smoothstep(15.0, 90.0, dist);
        vec3 N = normalize(vec3(-hx / e * 0.07 * near, 1.0, -hz / e * 0.07 * near));
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        // bleu océan : profond sous la caméra, plus clair et ciel au loin
        vec3 col = mix(uDeep, uMid, smoothstep(-0.2, 0.6, h0 - 0.6) * 0.6 + 0.25);
        col = mix(col, uSky, clamp(fres * 0.5, 0.0, 0.32));
        // traits d'écume qui dérivent (étirés dans le sens du vent)
        vec2 sp = vec2(p.x * 1.6 + p.y * 0.5, p.y * 6.0 - p.x * 1.2) + vec2(t * 0.25, t * 0.08);
        float streak = smoothstep(0.82, 0.9, noise(sp * 2.2)) * smoothstep(0.4, 0.65, noise(p * 0.5 + t * 0.03));
        col = mix(col, vec3(0.93, 0.97, 1.0), streak * 0.28 * near);
        // anneaux d'écume autour des coques et des piles
        float foam = 0.0;
        for (int i = 0; i < ${MAX_FOAM}; i++) {
          if (float(i) >= uFoamN) break;
          vec4 f = uFoam[i];
          vec2 d = (p - f.xy) / f.zw;
          float r = length(d);
          float wob = 0.06 * sin(atan(d.y, d.x) * 7.0 + t * 1.6) + 0.05 * (noise(p * 6.0 + t * 0.4) - 0.5);
          float ring = 1.0 - smoothstep(0.0, 0.07, abs(r - 1.06 - wob));
          float inner = (1.0 - smoothstep(0.98, 1.12 + wob, r)) * step(0.0, r);
          float outer = (1.0 - smoothstep(0.0, 0.05, abs(r - 1.3 - wob * 1.5 - 0.06 * sin(t * 0.9 + float(i))))) * 0.6;
          foam = max(foam, max(ring, max(inner * 0.95, outer)));
        }
        // le long du quai
        float qd = p.x - uQuayX;
        float qw = 0.05 * sin(p.y * 3.0 + t * 1.2) + 0.04 * (noise(vec2(p.y * 4.0, t * 0.5)) - 0.5);
        foam = max(foam, (1.0 - smoothstep(0.0, 0.12, qd - 0.08 - qw)) + (1.0 - smoothstep(0.0, 0.04, abs(qd - 0.42 - qw * 2.0))) * 0.5);
        col = mix(col, vec3(0.96, 0.99, 1.0), clamp(foam, 0.0, 1.0));
        // soleil : reflets nets, façon dessin
        vec3 H = normalize(normalize(uSunDir) + V);
        float spec = pow(max(dot(N, H), 0.0), 260.0);
        col += vec3(1.0, 0.96, 0.86) * smoothstep(0.35, 0.55, spec) * 0.9 * near;
        // brume
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Déclare les anneaux d'écume : [x, z, demi-largeur x, demi-longueur z]. */
export function setFoam(mat: THREE.ShaderMaterial, list: [number, number, number, number][]) {
  const arr = mat.uniforms.uFoam.value as THREE.Vector4[];
  list.slice(0, MAX_FOAM).forEach((f, i) => arr[i].set(f[0], f[1], f[2], f[3]));
  mat.uniforms.uFoamN.value = Math.min(MAX_FOAM, list.length);
}
