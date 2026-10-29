import * as THREE from 'three';
import { KX, LAT0, LATMAX, LATMIN, LON0, LONMAX, LONMIN } from '../sim/geo';

/** Bruit et utilitaires partagés par les shaders de la carte. */
export const GLSL_NOISE = /* glsl */ `
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
`;

/** Conversion monde → coordonnées de texture de la carte (lon/lat). */
export const GLSL_MAPUV = /* glsl */ `
vec2 mapUv(vec3 w) {
  float lon = w.x / ${KX.toFixed(6)} + ${LON0.toFixed(1)};
  float lat = -w.z + ${LAT0.toFixed(1)};
  return vec2((lon - ${LONMIN.toFixed(1)}) / ${(LONMAX - LONMIN).toFixed(1)}, (lat - ${LATMIN.toFixed(1)}) / ${(LATMAX - LATMIN).toFixed(1)});
}
`;

export interface SharedUniforms {
  uTime: { value: number };
  uDay: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  uSkyColor: { value: THREE.Color };
  uZoom: { value: number };
}

export function sharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uDay: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0, 0.5, -1).normalize() },
    uFogColor: { value: new THREE.Color('#9FD3EA') },
    uFogNear: { value: 20 },
    uFogFar: { value: 80 },
    uSkyColor: { value: new THREE.Color('#B8E2F2') },
    uZoom: { value: 11 },
  };
}

/**
 * Océan : couleur selon la profondeur réelle (ETOPO1), houle animée, reflets du ciel et du soleil,
 * écume le long des côtes, quadrillage discret. Couvre bien plus large que la carte pour l'horizon.
 */
export function createOcean(shared: SharedUniforms, depth: THREE.Texture, coast: THREE.Texture, wind: THREE.Texture): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uDepth: { value: depth }, uCoast: { value: coast }, uWind: { value: wind }, uWindAlpha: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uDepth;
      uniform sampler2D uCoast;
      uniform sampler2D uWind;
      uniform float uTime, uDay, uFogNear, uFogFar, uZoom, uWindAlpha;
      uniform vec3 uSunDir, uFogColor, uSkyColor;
      varying vec3 vWorld;
      ${GLSL_NOISE}
      ${GLSL_MAPUV}
      // houle sans motif répété : octaves de bruit tournées les unes par rapport aux autres,
      // pas d'ondes planes (elles dessinaient des rayures régulières)
      const mat2 R1 = mat2(0.80, 0.60, -0.60, 0.80);
      const mat2 R2 = mat2(0.36, -0.93, 0.93, 0.36);
      const mat2 R3 = mat2(-0.53, 0.85, -0.85, -0.53);
      float swell(vec2 p, float t, float fine) {
        float h = 0.0;
        h += noise(R1 * p * 6.0 + vec2(t * 0.32, t * 0.21)) * 0.42;
        h += noise(R2 * p * 13.0 - vec2(t * 0.55, -t * 0.27)) * 0.30;
        h += noise(R3 * p * 27.0 + vec2(t * 0.75, t * 0.45)) * 0.20 * fine;
        h += noise(R1 * p * 58.0 - vec2(t * 1.1, -t * 0.6)) * 0.10 * fine;
        h += noise(R2 * p * 121.0 + vec2(t * 1.4, t * 0.3)) * 0.05 * fine;
        return h;
      }
      // palette de force du vent (nœuds), façon cartes de prévision
      vec3 windColor(float k) {
        // palette façon routage : bleu calme, vert établi, jaune frais, rouge fort, violet tempête
        vec3 c = vec3(0.30, 0.26, 0.62);
        c = mix(c, vec3(0.16, 0.40, 0.80), smoothstep(0.0, 6.0, k));
        c = mix(c, vec3(0.10, 0.64, 0.78), smoothstep(6.0, 11.0, k));
        c = mix(c, vec3(0.20, 0.72, 0.42), smoothstep(11.0, 17.0, k));
        c = mix(c, vec3(0.62, 0.80, 0.30), smoothstep(17.0, 22.0, k));
        c = mix(c, vec3(0.92, 0.80, 0.28), smoothstep(22.0, 27.0, k));
        c = mix(c, vec3(0.94, 0.52, 0.18), smoothstep(27.0, 32.0, k));
        c = mix(c, vec3(0.86, 0.20, 0.24), smoothstep(32.0, 40.0, k));
        c = mix(c, vec3(0.70, 0.18, 0.62), smoothstep(40.0, 50.0, k));
        return c;
      }
      void main() {
        vec2 uv = mapUv(vWorld);
        float inside = smoothstep(0.0, 0.04, uv.x) * smoothstep(1.0, 0.96, uv.x) * smoothstep(0.0, 0.05, uv.y) * smoothstep(1.0, 0.95, uv.y);
        vec2 cuv = clamp(uv, 0.001, 0.999);
        float d = mix(0.92, texture2D(uDepth, cuv).r, inside);
        float c = texture2D(uCoast, cuv).r * inside;
        float shallow = 1.0 - d;

        // eaux tropicales turquoise, plateaux tempérés plus gris-vert
        float lat0 = uv.y * ${(LATMAX - LATMIN).toFixed(1)} + ${LATMIN.toFixed(1)};
        float tropic = 1.0 - smoothstep(24.0, 36.0, lat0);
        // mer de diorama : bleu-vert franc au large, turquoise lumineux près des côtes
        // bleu d'océan : profond et dense au large, à peine plus clair sur les plateaux côtiers
        vec3 deep = vec3(0.018, 0.105, 0.245);
        vec3 mid = vec3(0.03, 0.17, 0.34);
        vec3 shelf = mix(vec3(0.05, 0.25, 0.40), vec3(0.06, 0.32, 0.47), tropic);
        vec3 lagoon = mix(vec3(0.13, 0.40, 0.50), vec3(0.18, 0.52, 0.60), tropic);
        vec3 col = mix(deep, mid, smoothstep(0.0, 0.55, shallow));
        col = mix(col, shelf, smoothstep(0.55, 0.88, shallow));
        col = mix(col, lagoon, smoothstep(0.86, 1.0, shallow) * 0.85);

        // calque de force du vent
        float kn = texture2D(uWind, cuv).r * 64.0;
        // la couleur du vent remplace la teinte de l'eau (pas de mélange boueux), un peu plus sombre au large
        vec3 wc = windColor(kn) * (0.62 + 0.55 * smoothstep(0.0, 1.0, shallow));
        col = mix(col, wc, uWindAlpha * 0.78 * inside);

        // isobathes : lignes de profondeur discrètes, façon carte marine
        float iso = 0.0;
        float fwd = max(fwidth(d), 1e-4) * 1.1;
        for (int i = 0; i < 5; i++) {
          float level = 0.1 + float(i) * 0.18;
          iso = max(iso, 1.0 - smoothstep(0.0, fwd, abs(d - level)));
        }
        col = mix(col, vec3(0.78, 0.9, 1.0), iso * 0.05 * inside * (1.0 - 0.6 * uWindAlpha));

        // houle : normale par différences finies, détails atténués de loin
        vec2 p = vWorld.xz;
        float t = uTime;
        float fine = clamp(1.6 - uZoom / 14.0, 0.0, 1.0);
        float e = 0.006;
        // déformation lente du domaine et zones plus ou moins agitées : rien ne se répète
        vec2 q = p + 0.35 * vec2(noise(p * 0.55 + t * 0.02), noise(p * 0.55 + 5.2 - t * 0.02));
        float agit = 0.55 + 0.6 * noise(p * 0.22 + 1.7);
        float hx = swell(q + vec2(e, 0.0), t, fine) - swell(q - vec2(e, 0.0), t, fine);
        float hz = swell(q + vec2(0.0, e), t, fine) - swell(q - vec2(0.0, e), t, fine);
        vec3 N = normalize(vec3(-hx * 0.32 * agit, 1.0, -hz * 0.32 * agit));
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(uSunDir);
        vec3 H = normalize(L + V);
        col *= 0.82 + 0.25 * max(dot(N, L), 0.0);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        col = mix(col, uSkyColor, fres * 0.55);
        float spec = pow(max(dot(N, H), 0.0), 700.0);
        float glint = pow(max(dot(N, H), 0.0), 80.0) * 0.03;
        col += vec3(1.0, 0.94, 0.82) * (spec * 0.6 + glint) * (0.25 + 0.75 * uDay) * (1.0 - 0.5 * uWindAlpha);

        // écume le long des côtes
        // eau claire le long des côtes, puis un liseré d'écume net qui ondule
        col = mix(col, lagoon, smoothstep(0.03, 0.34, c) * 0.4 * (1.0 - uWindAlpha));
        float wob = 0.035 * sin(t * 1.3 + (p.x + p.y) * 9.0) + 0.03 * (noise(p * 40.0 + t * 0.2) - 0.5);
        float fw2 = max(fwidth(c), 1e-4);
        float ring = 1.0 - smoothstep(0.0, fw2 * 2.2 + 0.012, abs(c - (0.41 + wob)));
        float ring2 = (1.0 - smoothstep(0.0, fw2 * 1.6 + 0.008, abs(c - (0.27 + wob * 1.6)))) * step(0.5, noise(p * 25.0 - t * 0.15));
        col = mix(col, vec3(0.97, 0.99, 1.0), (ring * 0.9 + ring2 * 0.45) * inside);

        // quadrillage tous les 10°
        float lon = uv.x * ${(LONMAX - LONMIN).toFixed(1)} + ${LONMIN.toFixed(1)};
        float lat = uv.y * ${(LATMAX - LATMIN).toFixed(1)} + ${LATMIN.toFixed(1)};
        vec2 g = abs(fract(vec2(lon, lat) / 10.0 + 0.5) - 0.5) * 10.0;
        vec2 fw = fwidth(vec2(lon, lat)) * 1.2;
        float line = 1.0 - min(smoothstep(0.0, fw.x, g.x), smoothstep(0.0, fw.y, g.y));
        col = mix(col, vec3(0.75, 0.9, 1.0), line * 0.10 * inside);

        // nuit : bleu profond et reflets de lune
        vec3 night = col * vec3(0.18, 0.24, 0.42) + vec3(0.0, 0.01, 0.03);
        col = mix(night, col, uDay);

        float fogF = smoothstep(uFogNear, uFogFar, length(vWorld - cameraPosition));
        col = mix(col, uFogColor, fogF);
        // ces shaders composent en sRGB : on repasse en linéaire, three réencode selon la cible
        col = clamp(col, 0.0, 1.0);
        col = mix(col / 12.92, pow((col + 0.055) / 1.055, vec3(2.4)), step(0.04045, col));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const w = (LONMAX - LONMIN) * KX * 5;
  const h = (LATMAX - LATMIN) * 5;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(((LONMIN + LONMAX) / 2 - LON0) * KX, 0, -((LATMIN + LATMAX) / 2 - LAT0));
  mesh.frustumCulled = false;
  return mesh;
}

/** Ciel : dégradé horizon → zénith, halo du soleil. Le brouillard de la carte prend la couleur de l'horizon. */
export function createSky(shared: SharedUniforms): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { ...shared, uZenith: { value: new THREE.Color('#3E86C6') } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uFogColor, uSunDir, uZenith;
      uniform float uDay;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float t = smoothstep(-0.02, 0.45, d.y);
        vec3 zen = mix(vec3(0.01, 0.03, 0.08), uZenith, uDay);
        vec3 col = mix(uFogColor, zen, t);
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += vec3(1.0, 0.85, 0.6) * (pow(s, 12.0) * 0.25 + pow(s, 300.0) * 1.2) * uDay;
        col += vec3(0.7, 0.8, 1.0) * pow(s, 400.0) * (1.0 - uDay) * 0.8;
        // ces shaders composent en sRGB : on repasse en linéaire, three réencode selon la cible
        col = clamp(col, 0.0, 1.0);
        col = mix(col / 12.92, pow((col + 0.055) / 1.055, vec3(2.4)), step(0.04045, col));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/** Terres : relief ombré Natural Earth, flancs couleur terre, grain fin pour la lecture de près. */
export interface HexGrid {
  r: number;
  cols: number;
  rows: number;
}

