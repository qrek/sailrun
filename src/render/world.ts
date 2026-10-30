import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Boat } from '../sim/boat';
import { D2R, LAND, LATMAX, LATMIN, LONMAX, LONMIN, LonLat, Rng, clamp, smooth, fromX, fromZ, isLand, toX, toZ } from '../sim/geo';
import { WindSource } from '../sim/wind';
import { BoatRig, buildBoat, disposeBoat, showSails, trimBoat } from './boatModel';
import { Clouds } from './clouds';
import { Engine, InputHandler } from './engine';
import HEXGRID from '../data/hexgrid.json';
import { TerrainProps, buildTerrainProps, decodeHex } from './terrainProps';
import { SharedUniforms, createOcean, createSky, sharedUniforms } from './ocean';
import { Terrain } from './terrain';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { PlaceLabels } from './places';
import { IMOCA_RHUM_2026 } from '../data/fleet';

interface BoatView {
  boat: Boat;
  rig: BoatRig;
  wake: THREE.Mesh;
  trail: THREE.Line;
  tag: HTMLDivElement;
}

export interface WorldFrame {
  dt: number;
  time: number; // horloge réelle (s), pour les animations
  wind: WindSource;
  windT: number; // heure météo
  focus: LonLat;
  day: number; // 0 nuit → 1 jour
}

const HAZE_DAY = new THREE.Color('#A9D8EC');
const HAZE_NIGHT = new THREE.Color('#06111F');
const SKY_DAY = new THREE.Color('#CDEBF6');
const SKY_NIGHT = new THREE.Color('#0B1A2E');
const MAX_TRAIL = 1200;
const BOT_NUMBERS: Record<string, string> = { lea: 'FRA 17', max: 'FRA 33', julien: 'FRA 8', sam: 'FRA 59', nico: 'FRA 2' };

/** Texture 1×1 en attendant le chargement des vraies. */
function placeholder(value: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([value, value, value, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

function wakeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 512);
  // haut du canvas = juste derrière la poupe
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(64 + side * 10, 0);
    g.quadraticCurveTo(64 + side * 30, 220, 64 + side * 60, 512);
    g.stroke();
  }
  const wash = g.createLinearGradient(0, 0, 0, 512);
  wash.addColorStop(0, 'rgba(255,255,255,0.85)');
  wash.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  wash.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = wash;
  g.beginPath();
  g.moveTo(52, 0);
  g.lineTo(76, 0);
  g.lineTo(90, 512);
  g.lineTo(38, 512);
  g.closePath();
  g.fill();
  // fondu vers l'arrière
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createLinearGradient(0, 0, 0, 512);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, 128, 512);
  return new THREE.CanvasTexture(c);
}

/** Tonemapping « Neutral » (Khronos PBR Neutral) puis encodage sRGB, pour l'image linéaire du composer. */
const NeutralPassShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    vec3 toSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    vec3 neutral(vec3 color){
      const float startCompression = 0.8 - 0.04;
      const float desaturation = 0.15;
      float x = min(color.r, min(color.g, color.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      color -= offset;
      float peak = max(color.r, max(color.g, color.b));
      if (peak < startCompression) return color;
      const float d = 1.0 - startCompression;
      float newPeak = 1.0 - d * d / (peak + d - startCompression);
      color *= newPeak / peak;
      float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
      return mix(color, vec3(newPeak), g);
    }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(toSrgb(clamp(neutral(max(c.rgb, 0.0)), 0.0, 1.0)), 1.0);
    }`,
};

/** Zoom : au plus près on voit une centaine de milles, au plus loin une bonne partie de l'Atlantique. */
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 26;

/** La carte 3D : ciel, océan, terres, nuages, vent, bateaux, route conseillée et arrivée. */
export class WorldView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 900);
  private u: SharedUniforms = sharedUniforms();
  private sky: THREE.Mesh;
  private hemi = new THREE.HemisphereLight(0xe8f4ff, 0x5a6a52, 1.1);
  private sun = new THREE.DirectionalLight(0xfff0dc, 1.6);
  private composer: EffectComposer;
  private tiltH: ShaderPass;
  private tiltV: ShaderPass;
  private boats: BoatView[] = [];
  private finish = new THREE.Group();
  private finishTag: HTMLDivElement;
  private routeGeo = new THREE.BufferGeometry();
  private routePts: THREE.Points;
  private rng = new Rng(42);
  private clouds: Clouds;
  private places: PlaceLabels;
  private wakeTex = wakeTexture();
  private props: TerrainProps | null = null;
  private terrain: Terrain | null = null;

  /* champ de vent (calque couleur) */
  private windData: Uint8Array;
  private windTex: THREE.DataTexture;
  private windW = 234;
  private windH = 160;
  private windT = -1e9;
  private windClock = 0;
  private oceanMat!: THREE.ShaderMaterial;
  private windAlpha = 0;
  windColors = false;
  /** Calque « Vent » : traits animés plus nombreux et plus marqués. */
  windLayer = false;
  private windLayerA = 0;

  /* projection de trajectoire et bateau fantôme des prévisions */
  private projLine: THREE.Line;
  private projMarks: { mesh: THREE.Mesh; tag: HTMLDivElement; h: number }[] = [];
  private projPts: LonLat[] = [];
  private projN = 0;
  private projDt = 0.5;
  private ghost: THREE.Group;
  private ghostTag: HTMLDivElement;
  private ghostHours = 0;
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /* caméra */
  yaw = 0;
  pitch = 0.98;
  dist = 11;
  tPitch = 0.98;
  tDist = 11;
  private target = new THREE.Vector3();
  private snap = true;

  /* particules de vent : chacune garde ses dernières positions pour dessiner une traînée */
  private np: number;
  private readonly HIST = 12;
  private pHist: Float32Array; // [lon, lat] × HIST par particule, la tête en premier
  private pAge: Float32Array;
  private pMax: Float32Array;
  private pPos: Float32Array;
  private pAlpha: Float32Array;
  private pGeo = new THREE.BufferGeometry();
  private pMat: THREE.ShaderMaterial;
  private pInit = false;
  private pStep = 0;

  constructor(
    private engine: Engine,
    private labels: HTMLElement,
  ) {
    const s = this.scene;
    s.fog = new THREE.Fog(HAZE_DAY.clone(), 20, 80);
    const pmrem = new THREE.PMREMGenerator(engine.renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.6;
    this.sun.position.set(0, 30, -20);
    if (!engine.small) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
    }
    s.add(this.hemi, this.sun, this.sun.target);

    // profondeur de l'océan (chargée en tâche de fond)
    const depth = placeholder(230);
    const coast = this.coastTexture(engine.small ? 1024 : 2048);
    this.sky = createSky(this.u);
    s.add(this.sky);
    this.windData = new Uint8Array(this.windW * this.windH * 4);
    this.windTex = new THREE.DataTexture(this.windData, this.windW, this.windH);
    this.windTex.magFilter = THREE.LinearFilter;
    this.windTex.minFilter = THREE.LinearFilter;
    this.windTex.needsUpdate = true;
    const ocean = createOcean(this.u, depth, coast, this.windTex);
    this.oceanMat = ocean.material as THREE.ShaderMaterial;
    s.add(ocean);
    const base = import.meta.env.BASE_URL;
    const loader = new THREE.TextureLoader();
    // relief réel (altitude + creux) et couleurs peintes des biomes, puis les forêts plantées dessus
    const terrain = new Terrain(engine.small);
    this.terrain = terrain;
    s.add(terrain.group);
    Promise.all([terrain.load(base), loader.loadAsync(`${base}terrain/hex.png`)]).then(([, hex]) => {
      const props = buildTerrainProps(
        decodeHex(hex.image as HTMLImageElement, HEXGRID),
        HEXGRID,
        engine.small,
        (lon, lat) => terrain.heightAtLonLat(lon, lat),
        (lon, lat) => terrain.elevationAt(lon, lat),
      );
      this.props = props;
      s.add(props.group);
    });
    loader.load(`${base}terrain/depth.png`, (t) => {
      t.colorSpace = THREE.NoColorSpace;
      (ocean.material as THREE.ShaderMaterial).uniforms.uDepth.value = t;
    });

    this.clouds = new Clouds(engine.small);
    s.add(this.clouds.group);

    // particules
    this.np = engine.small ? 900 : 1600;
    const n = this.np;
    const segs = this.HIST - 1;
    this.pHist = new Float32Array(n * this.HIST * 2);
    this.pAge = new Float32Array(n);
    this.pMax = new Float32Array(n);
    // chaque morceau de traînée est un petit ruban (2 triangles), plus lisible qu'une ligne d'un pixel
    this.pPos = new Float32Array(n * segs * 18);
    this.pAlpha = new Float32Array(n * segs * 6);
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    this.pGeo.setAttribute('alpha', new THREE.BufferAttribute(this.pAlpha, 1));
    this.pMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uOpacity: { value: 0.6 } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uOpacity; varying float vA; void main(){ gl_FragColor = vec4(1.0, 1.0, 1.0, vA * uOpacity); }',
    });
    const lines = new THREE.Mesh(this.pGeo, this.pMat);
    lines.frustumCulled = false;
    lines.renderOrder = 4;
    s.add(lines);

    // route conseillée
    this.routeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    this.routeGeo.setDrawRange(0, 0);
    this.routePts = new THREE.Points(this.routeGeo, new THREE.PointsMaterial({ color: 0xffd84d, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false }));
    this.routePts.frustumCulled = false;
    this.routePts.renderOrder = 6;
    s.add(this.routePts);

    // projection : trait pointillé blanc et repères horaires
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(200 * 3), 3));
    pg.setDrawRange(0, 0);
    this.projLine = new THREE.Line(pg, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.9, depthWrite: false }));
    this.projLine.frustumCulled = false;
    this.projLine.renderOrder = 7;
    s.add(this.projLine);
    for (const h of [2, 5, 12, 24]) {
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 8;
      mesh.visible = false;
      s.add(mesh);
      const tag = document.createElement('div');
      tag.className = 'proj-tag';
      tag.textContent = `${h} h`;
      labels.appendChild(tag);
      this.projMarks.push({ mesh, tag, h });
    }
    this.ghost = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), new THREE.MeshBasicMaterial({ color: 0xffd84d, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.35, 20), new THREE.MeshBasicMaterial({ color: 0xffd84d, transparent: true, opacity: 0.95, depthWrite: false }));
    dot.rotation.x = -Math.PI / 2;
    this.ghost.add(ring, dot);
    this.ghost.renderOrder = 9;
    this.ghost.visible = false;
    s.add(this.ghost);
    this.ghostTag = document.createElement('div');
    this.ghostTag.className = 'proj-tag ghost';
    this.ghostTag.hidden = true;
    labels.appendChild(this.ghostTag);

    // arrivée
    s.add(this.finish);
    this.finish.visible = false;
    this.finishTag = document.createElement('div');
    this.finishTag.className = 'tag finish';
    this.finishTag.hidden = true;
    labels.appendChild(this.finishTag);

    this.places = new PlaceLabels(labels);

    // flou de maquette (tilt-shift) en haut et en bas de l'image, en vue 3D.
    // La cible est linéaire ; la dernière passe tonemappe et encode en sRGB.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(engine.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    // la cible intermédiaire n'est ni tonemappée ni encodée : on applique ici le « Neutral » de l'écran
    this.composer.addPass(new ShaderPass(NeutralPassShader));

    engine.onResize((w, h) => {
      this.composer.setPixelRatio(engine.renderer.getPixelRatio());
      this.composer.setSize(w, h);
      this.camera.aspect = w / h;
      // le bateau suivi apparaît un peu au-dessus du centre : le bas de l'écran est occupé par la barre
      this.camera.setViewOffset(w, h, 0, Math.round(h * this.focusLift(w)), w, h);
      this.camera.updateProjectionMatrix();
    });
  }

  /** Proximité des côtes (terres floutées) pour l'écume et les eaux claires. */
  private coastTexture(width: number): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round((width * (LATMAX - LATMIN)) / (LONMAX - LONMIN));
    const g = c.getContext('2d')!;
    const ppd = width / (LONMAX - LONMIN);
    const p = new Path2D();
    for (const poly of LAND) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i += 2) {
          const x = (ring[i] - LONMIN) * ppd;
          const y = (LATMAX - ring[i + 1]) * ppd;
          if (i === 0) p.moveTo(x, y);
          else p.lineTo(x, y);
        }
        p.closePath();
      }
    }
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.filter = `blur(${Math.max(2, ppd * 0.12)}px)`;
    g.fillStyle = '#fff';
    g.fill(p, 'evenodd');
    g.filter = 'none';
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    return t;
  }

  input(): InputHandler {
    return {
      drag: (dx, dy) => {
        this.yaw -= dx * 0.005;
        this.tPitch = clamp(this.tPitch + dy * 0.004, 0.02, 1.2);
      },
      pinch: (r) => {
        this.tDist = clamp(this.tDist * r, ZOOM_MIN, ZOOM_MAX);
      },
      wheel: (dy) => {
        this.tDist = clamp(this.tDist * Math.exp(dy * 0.0012), ZOOM_MIN, ZOOM_MAX);
      },
    };
  }

  view(mode: '2d' | '3d' | 'reset') {
    if (mode === '2d') {
      this.tPitch = 0.02;
      this.yaw = 0;
    } else if (mode === '3d') {
      this.tPitch = 0.66;
    } else {
      // caméra haute : on voit le bateau, les concurrents proches et le vent autour
      this.yaw = 0;
      this.tPitch = 0.62;
      this.tDist = 3.4;
    }
  }

  get is2d() {
    return this.tPitch < 0.2;
  }

  /* ---------- bateaux ---------- */
  setBoats(boats: Boat[]) {
    for (const v of this.boats) {
      this.scene.remove(v.rig.root, v.trail);
      disposeBoat(v.rig);
      v.trail.geometry.dispose();
      v.tag.remove();
    }
    this.boats = boats.map((b) => {
      const fe = b.fleetId ? IMOCA_RHUM_2026.find((f) => f.id === b.fleetId) : undefined;
      const hullName = fe ? fe.skipper.split(' ').slice(1).join(' ').toUpperCase() : b.isPlayer ? 'Sail Run' : b.name;
      const number = fe ? fe.nat : b.isPlayer ? 'FRA 1' : BOT_NUMBERS[b.id] ?? 'FRA 99';
      const rig = buildBoat({ hull: b.hull, foils: b.foils, mast: b.mast, color: b.color, name: hullName, number });
      this.scene.add(rig.root);
      const wakeGeo = new THREE.PlaneGeometry(0.9, 1);
      wakeGeo.translate(0, -0.5, 0);
      wakeGeo.rotateX(-Math.PI / 2);
      const wake = new THREE.Mesh(wakeGeo, new THREE.MeshBasicMaterial({ map: this.wakeTex, transparent: true, depthWrite: false, opacity: 0.8 }));
      wake.position.set(0, 0.015, 0.42);
      wake.renderOrder = 3;
      rig.root.add(wake);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAX_TRAIL + 1) * 3), 3));
      geo.setDrawRange(0, 0);
      const trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: b.isPlayer ? 0xffffff : b.color, transparent: true, opacity: b.isPlayer ? 0.85 : 0.5 }));
      trail.frustumCulled = false;
      trail.renderOrder = 4;
      this.scene.add(trail);
      const tag = document.createElement('div');
      tag.className = 'tag' + (b.isPlayer ? ' me' : '');
      tag.textContent = b.isPlayer ? 'TOI' : b.name;
      tag.style.background = b.color;
      tag.style.color = b.dark ? '#0B1E33' : '#FFFFFF';
      this.labels.appendChild(tag);
      return { boat: b, rig, wake, trail, tag };
    });
  }

  setFinish(p: LonLat | null, radiusNm: number, label: string) {
    this.finish.clear();
    if (!p) {
      this.finish.visible = false;
      this.finishTag.hidden = true;
      return;
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radiusNm / 60, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffd84d }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd84d, transparent: true, opacity: 0.3, depthWrite: false }));
    beam.position.y = 2;
    this.finish.add(ring, beam);
    this.finish.position.set(toX(p[0]), 0, toZ(p[1]));
    this.finish.visible = true;
    this.finishTag.textContent = label;
    this.finishTag.hidden = false;
  }

  private marks: { g: THREE.Group; tag: HTMLDivElement }[] = [];

  /** Marques de parcours (bouées), la prochaine à passer est mise en avant. */
  setMarks(marks: { name: string; pos: LonLat; r: number }[], next: number) {
    if (this.marks.length !== marks.length) {
      for (const m of this.marks) {
        this.scene.remove(m.g);
        m.tag.remove();
      }
      this.marks = marks.map((mk) => {
        const g = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(mk.r, 2) / 60, 0.012, 6, 48), new THREE.MeshBasicMaterial({ color: 0xff8a3d }));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.05;
        const buoy = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 12), new THREE.MeshBasicMaterial({ color: 0xff8a3d }));
        buoy.position.y = 0.06;
        g.add(ring, buoy);
        g.position.set(toX(mk.pos[0]), 0, toZ(mk.pos[1]));
        this.scene.add(g);
        const tag = document.createElement('div');
        tag.className = 'tag mark';
        tag.textContent = mk.name.toUpperCase();
        this.labels.appendChild(tag);
        return { g, tag };
      });
    }
    this.marks.forEach((m, i) => {
      const done = i < next;
      m.g.visible = !done;
      m.tag.hidden = done;
      m.tag.classList.toggle('next', i === next);
    });
  }

  setRoute(pts: LonLat[]) {
    const arr = this.routeGeo.attributes.position.array as Float32Array;
    const n = Math.min(pts.length, 600);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = toX(pts[i][0]);
      arr[i * 3 + 1] = 0.05;
      arr[i * 3 + 2] = toZ(pts[i][1]);
    }
    this.routeGeo.attributes.position.needsUpdate = true;
    this.routeGeo.setDrawRange(0, n);
  }

  snapCamera() {
    this.snap = true;
  }

  /** Trajectoire prévue du joueur (un point toutes les `dt` heures). */
  setProjection(pts: LonLat[], dt: number) {
    this.projPts = pts;
    this.projDt = dt;
    const arr = this.projLine.geometry.attributes.position.array as Float32Array;
    const n = Math.min(pts.length, 200);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = toX(pts[i][0]);
      arr[i * 3 + 1] = 0.045;
      arr[i * 3 + 2] = toZ(pts[i][1]);
    }
    this.projLine.geometry.attributes.position.needsUpdate = true;
    this.projN = n;
    this.projLine.computeLineDistances();
    for (const m of this.projMarks) {
      const p = pts[Math.round(m.h / dt)];
      m.mesh.visible = !!p;
      m.tag.hidden = !p;
      if (p) m.mesh.position.set(toX(p[0]), 0.05, toZ(p[1]));
    }
  }

  /** Position prévue du joueur dans `hours` heures (curseur des prévisions), 0 = masqué. */
  setGhost(hours: number, label: string) {
    this.ghostHours = hours;
    this.ghostTag.textContent = label;
  }

  /** Décalage vertical de l'image (fraction de la hauteur) selon la place prise par l'interface. */
  private focusLift(w: number): number {
    return w <= 760 ? 0.16 : 0.07;
  }

  /** Position (lon, lat) du bateau fantôme, ou null. */
  ghostPos(): LonLat | null {
    const idx = this.ghostHours / this.projDt;
    const i0 = Math.floor(idx);
    const p0 = this.projPts[i0];
    if (this.ghostHours <= 0 || !p0) return null;
    const p1 = this.projPts[Math.min(i0 + 1, this.projPts.length - 1)];
    const k = idx - i0;
    return [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k];
  }

  /** Point de la carte sous le pointeur, ou null. */
  pick(clientX: number, clientY: number): LonLat | null {
    const r = this.engine.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    const lon = fromX(hit.x);
    const lat = fromZ(hit.z);
    if (lon < LONMIN || lon > LONMAX || lat < LATMIN || lat > LATMAX) return null;
    return [lon, lat];
  }

  private probe: THREE.Group | null = null;
  private probeLL: LonLat | null = null;

  /** Sonde posée sur la carte (vent, courant, houle à un point précis). */
  setProbe(ll: LonLat | null) {
    this.probeLL = ll;
    if (!this.probe) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0x3fe3c9, depthWrite: false, transparent: true, opacity: 0.95 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), mat);
      ring.rotation.x = -Math.PI / 2;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 20), mat);
      dot.rotation.x = -Math.PI / 2;
      const bar = (w: number, h: number, x: number, z: number) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0, z);
        return m;
      };
      g.add(ring, dot, bar(0.12, 0.7, 0, -1.35), bar(0.12, 0.7, 0, 1.35), bar(0.7, 0.12, -1.35, 0), bar(0.7, 0.12, 1.35, 0));
      g.renderOrder = 10;
      this.scene.add(g);
      this.probe = g;
    }
    this.probe.visible = !!ll;
    if (ll) this.probe.position.set(toX(ll[0]), 0.06, toZ(ll[1]));
  }

  /** Position écran de la sonde. */
  probeScreen(): [number, number] | null {
    if (!this.probeLL || !this.probe?.visible) return null;
    const sc = Math.max(0.03, this.dist * 0.01);
    this.probe.scale.setScalar(sc);
    return this.project(this.probe.position.x, 0.06, this.probe.position.z);
  }

  setCloudsVisible(on: boolean) {
    this.clouds.group.visible = on;
  }

  /** Recalcule la force du vent sur toute la carte (calque couleur). */
  private updateWindField(wind: WindSource, t: number) {
    const W = this.windW;
    const H = this.windH;
    const d = this.windData;
    for (let j = 0; j < H; j++) {
      const lat = LATMIN + ((j + 0.5) / H) * (LATMAX - LATMIN);
      for (let i = 0; i < W; i++) {
        const lon = LONMIN + ((i + 0.5) / W) * (LONMAX - LONMIN);
        const w = wind.at(lon, lat, t);
        const k = (j * W + i) * 4;
        d[k] = Math.min(255, Math.round((Math.hypot(w[0], w[1]) / 64) * 255));
        d[k + 3] = 255;
      }
    }
    this.windTex.needsUpdate = true;
  }

  setLabelsVisible(on: boolean) {
    for (const v of this.boats) v.tag.hidden = !on;
  }

  /** Masque tout le calque d'étiquettes (écran du garage). */
  setLayerVisible(on: boolean) {
    this.labels.hidden = !on;
  }

  /* ---------- image ---------- */
  frame(f: WorldFrame) {
    this.updateCamera(f.focus);
    this.applyLight(f.day, f.time);
    this.terrain?.update(this.target, this.dist);
    if (this.props) {
      this.props.group.visible = this.dist < 40;
      this.props.trees.visible = this.dist < 22;
    }
    this.windClock -= f.dt;
    this.windAlpha += ((this.windColors ? 1 : 0) - this.windAlpha) * Math.min(1, f.dt * 6);
    this.oceanMat.uniforms.uWindAlpha.value = this.windAlpha;
    if (this.windAlpha > 0.01 && (Math.abs(f.windT - this.windT) > 0.2 || this.windClock <= 0) && this.windClock <= 0) {
      this.updateWindField(f.wind, f.windT);
      this.windT = f.windT;
      this.windClock = 0.25;
    }
    this.windLayerA += ((this.windLayer ? 1 : 0) - this.windLayerA) * Math.min(1, f.dt * 5);
    this.clouds.update(f.wind, f.windT, f.day, f.focus, this.dist);
    this.updateParticles(f);
    this.updateBoats(f.time);
    this.updateProjection();
    this.places.update(this.camera, this.engine.w, this.engine.h, this.dist);
    const r = this.engine.renderer;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = !this.engine.small;
    // le flou n'a de sens que vu de biais
    const tilt = smooth(0.5, 1.0, this.pitch) * (this.engine.small ? 0.7 : 1);
    if (tilt > 0.02) {
      const amt = 2.6 * tilt;
      this.tiltH.uniforms.h.value = amt / this.engine.w;
      this.tiltV.uniforms.v.value = amt / this.engine.h;
      // point net : un peu sous le centre, là où se trouve le bateau suivi
      this.tiltH.uniforms.r.value = 0.5;
      this.tiltV.uniforms.r.value = 0.5;
      this.composer.render();
    } else {
      r.render(this.scene, this.camera);
    }
  }

  private updateCamera(focus: LonLat) {
    const k = this.snap ? 1 : 0.12;
    this.pitch += (this.tPitch - this.pitch) * k;
    this.dist += (this.tDist - this.dist) * k;
    const tx = toX(focus[0]);
    const tz = toZ(focus[1]);
    const kt = this.snap ? 1 : 0.15;
    this.target.x += (tx - this.target.x) * kt;
    this.target.z += (tz - this.target.z) * kt;
    this.snap = false;
    const sp = Math.sin(this.pitch);
    const cp = Math.cos(this.pitch);
    const d = this.dist;
    this.camera.position.set(this.target.x - Math.sin(this.yaw) * sp * d, cp * d + 0.15, this.target.z + Math.cos(this.yaw) * sp * d);
    const look = this.target.clone();
    look.x += Math.sin(this.yaw) * d * 0.1 * sp;
    look.z -= Math.cos(this.yaw) * d * 0.1 * sp;
    this.camera.lookAt(look);
    const near = d * 1.6;
    const far = d * (4.2 + 2.5 * (1 - sp));
    this.u.uFogNear.value = near;
    this.u.uFogFar.value = far;
    this.u.uZoom.value = d;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = near;
    fog.far = far;
    this.sky.position.copy(this.camera.position);
  }

  private applyLight(day: number, time: number) {
    const haze = HAZE_NIGHT.clone().lerp(HAZE_DAY, day);
    this.u.uFogColor.value.copy(haze);
    (this.scene.fog as THREE.Fog).color.copy(haze);
    this.u.uSkyColor.value.copy(SKY_NIGHT.clone().lerp(SKY_DAY, day));
    this.u.uDay.value = day;
    this.u.uTime.value = time;
    // soleil devant la caméra, bas sur l'horizon : reflets dans le champ
    const sd = this.u.uSunDir.value;
    sd.set(Math.sin(this.yaw) * 0.8, 0.38 + 0.2 * day, -Math.cos(this.yaw) * 0.8).normalize();
    // la lumière qui sculpte le relief vient de côté et de derrière la caméra (comme un ombrage de carte),
    // le soleil « de face » ne sert qu'aux reflets sur l'eau
    const az = this.yaw + 2.4;
    const L = new THREE.Vector3(Math.sin(az) * 0.75, 0.48 + 0.12 * day, -Math.cos(az) * 0.75).normalize();
    const reach = Math.max(4, this.dist * 3);
    this.sun.position.copy(L).multiplyScalar(reach).add(this.target);
    this.sun.target.position.copy(this.target);
    this.sun.target.updateMatrixWorld();
    if (this.sun.castShadow) {
      const half = clamp(this.dist * 1.6, 1.5, 22);
      const cam = this.sun.shadow.camera;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 0.1;
      cam.far = reach * 2 + 2;
      cam.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.002 * half;
    }
    this.hemi.intensity = 0.35 + 0.85 * day;
    this.sun.intensity = 0.2 + 1.5 * day;
    this.scene.environmentIntensity = 0.15 + 0.5 * day;
    this.pMat.uniforms.uOpacity.value = (0.5 + 0.3 * day) * (0.4 + 0.6 * this.windLayerA);
  }

  private spawn(i: number, cx: number, cz: number, rx: number, rz: number) {
    let lon = 0;
    let lat = 0;
    for (let k = 0; k < 6; k++) {
      lon = fromX(cx + (this.rng.next() * 2 - 1) * rx);
      lat = fromZ(cz + (this.rng.next() * 2 - 1) * rz);
      if (!isLand(lon, lat)) break;
    }
    const o = i * this.HIST * 2;
    for (let h = 0; h < this.HIST; h++) {
      this.pHist[o + h * 2] = lon;
      this.pHist[o + h * 2 + 1] = lat;
    }
    this.pAge[i] = 0;
    this.pMax[i] = 2.5 + this.rng.next() * 3;
  }

  private updateParticles(f: WorldFrame) {
    const d = this.dist;
    const sp = Math.sin(this.pitch);
    const cx = this.target.x + Math.sin(this.yaw) * d * 0.9 * sp;
    const cz = this.target.z - Math.cos(this.yaw) * d * 0.9 * sp;
    const rx = d * (0.9 + 1.4 * sp);
    const rz = d * (0.7 + 1.4 * sp);
    const n = this.np;
    const H = this.HIST;
    if (!this.pInit) {
      for (let i = 0; i < n; i++) {
        this.spawn(i, cx, cz, rx, rz);
        this.pAge[i] = this.rng.next() * this.pMax[i];
      }
      this.pInit = true;
    }
    const vis = 0.0032 * d;
    const dt = f.dt;
    const cam = this.camera.position;
    // hors calque « Vent », on garde un léger voile de traits pour l'ambiance
    const nShow = Math.round(n * (0.45 + 0.55 * this.windLayerA));
    // on décale l'historique toutes les ~40 ms pour des traînées régulières
    this.pStep += dt;
    const shift = this.pStep >= 0.04;
    if (shift) this.pStep = 0;
    const segs = H - 1;
    for (let i = 0; i < n; i++) {
      const o = i * H * 2;
      this.pAge[i] += dt;
      let lon = this.pHist[o];
      let lat = this.pHist[o + 1];
      const x = toX(lon);
      const z = toZ(lat);
      if (this.pAge[i] > this.pMax[i] || Math.abs(x - cx) > rx * 1.15 || Math.abs(z - cz) > rz * 1.15 || isLand(lon, lat)) {
        this.spawn(i, cx, cz, rx, rz);
        lon = this.pHist[o];
        lat = this.pHist[o + 1];
      }
      const w = f.wind.at(lon, lat, f.windT);
      const cl = Math.cos(lat * D2R);
      lon += (w[0] * vis * dt) / cl;
      lat += w[1] * vis * dt;
      if (shift) this.pHist.copyWithin(o + 2, o, o + (H - 1) * 2);
      this.pHist[o] = lon;
      this.pHist[o + 1] = lat;
      const life = Math.max(0, Math.min(1, this.pAge[i] / 0.5, (this.pMax[i] - this.pAge[i]) / 0.5));
      const kn = Math.hypot(w[0], w[1]);
      // plus le vent est fort, plus le trait est vif (et long, puisqu'il file plus vite)
      const speedA = Math.min(1, 0.3 + kn / 28);
      // largeur à peu près constante à l'écran
      const hx = toX(lon);
      const hz = toZ(lat);
      const cd = Math.hypot(hx - cam.x, cam.y, hz - cam.z);
      const w0 = cd * (0.0008 + 0.0009 * Math.min(1, kn / 25));
      const visible = i < nShow;
      for (let k = 0; k < segs; k++) {
        const a = o + k * 2;
        const ax = k === 0 ? hx : toX(this.pHist[a]);
        const az = k === 0 ? hz : toZ(this.pHist[a + 1]);
        const bx = toX(this.pHist[a + 2]);
        const bz = toZ(this.pHist[a + 3]);
        let dx = bx - ax;
        let dz = bz - az;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        const t0 = k / segs;
        const t1 = (k + 1) / segs;
        const wa = w0 * (1 - 0.8 * t0);
        const wb = w0 * (1 - 0.8 * t1);
        const v = (i * segs + k) * 18;
        const P = this.pPos;
        // a+, b+, b-   /   a+, b-, a-
        P[v] = ax - dz * wa; P[v + 1] = 0.035; P[v + 2] = az + dx * wa;
        P[v + 3] = bx - dz * wb; P[v + 4] = 0.035; P[v + 5] = bz + dx * wb;
        P[v + 6] = bx + dz * wb; P[v + 7] = 0.035; P[v + 8] = bz - dx * wb;
        P[v + 9] = ax - dz * wa; P[v + 10] = 0.035; P[v + 11] = az + dx * wa;
        P[v + 12] = bx + dz * wb; P[v + 13] = 0.035; P[v + 14] = bz - dx * wb;
        P[v + 15] = ax + dz * wa; P[v + 16] = 0.035; P[v + 17] = az - dx * wa;
        const al = visible ? life * speedA : 0;
        const aa = al * (1 - t0) * (1 - t0);
        const ab = al * (1 - t1) * (1 - t1);
        const A = this.pAlpha;
        const u = (i * segs + k) * 6;
        A[u] = aa; A[u + 1] = ab; A[u + 2] = ab; A[u + 3] = aa; A[u + 4] = ab; A[u + 5] = aa;
      }
    }
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.alpha.needsUpdate = true;
  }

  private updateProjection() {
    const s = Math.max(0.025, this.dist * 0.006);
    for (const m of this.projMarks) {
      if (!m.mesh.visible) continue;
      m.mesh.scale.setScalar(s);
      this.placeTag(m.tag, m.mesh.position.x, 0.05, m.mesh.position.z, true);
    }
    (this.projLine.material as THREE.LineDashedMaterial).dashSize = this.dist * 0.012;
    (this.projLine.material as THREE.LineDashedMaterial).gapSize = this.dist * 0.008;
    // le trait s'arrête à 24 h, ou au bateau fantôme s'il est plus loin
    const shown = Math.min(this.projN, Math.ceil(Math.max(24, this.ghostHours) / this.projDt) + 1);
    this.projLine.geometry.setDrawRange(0, shown);
    // bateau fantôme : interpolé sur la trajectoire prévue
    const idx = this.ghostHours / this.projDt;
    const i0 = Math.floor(idx);
    const p0 = this.projPts[i0];
    const p1 = this.projPts[Math.min(i0 + 1, this.projPts.length - 1)];
    if (this.ghostHours > 0 && p0 && p1) {
      const k = idx - i0;
      const x = toX(p0[0] + (p1[0] - p0[0]) * k);
      const z = toZ(p0[1] + (p1[1] - p0[1]) * k);
      this.ghost.visible = true;
      this.ghost.position.set(x, 0.06, z);
      this.ghost.scale.setScalar(Math.max(0.05, this.dist * 0.012));
      this.ghostTag.hidden = false;
      this.placeTag(this.ghostTag, x, 0.06, z, true);
    } else {
      this.ghost.visible = false;
      this.ghostTag.hidden = true;
    }
  }

  private tmp = new THREE.Vector3();

  /** Position écran d'un point 3D, ou null s'il est hors champ. */
  private project(x: number, y: number, z: number): [number, number] | null {
    this.tmp.set(x, y, z).project(this.camera);
    const w = this.engine.w;
    const h = this.engine.h;
    const sx = (this.tmp.x * 0.5 + 0.5) * w;
    const sy = (-this.tmp.y * 0.5 + 0.5) * h;
    if (this.tmp.z > 1 || sx < -80 || sx > w + 80 || sy < -40 || sy > h + 40) return null;
    return [sx, sy];
  }

  private placeTag(el: HTMLElement, x: number, y: number, z: number, beside = false) {
    const sp = this.project(x, y, z);
    if (!sp) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = 'visible';
    el.style.transform = beside ? `translate(${(sp[0] + 10).toFixed(1)}px, ${sp[1].toFixed(1)}px) translate(0, -50%)` : `translate(${sp[0].toFixed(1)}px, ${sp[1].toFixed(1)}px) translate(-50%, -100%)`;
  }

  private updateBoats(time: number) {
    const scale = 0.13 * Math.pow(this.dist / 4.2, 0.55); // plus gros de près, sans devenir énorme quand on dézoome
    const placed: { x: number; y: number; w: number }[] = [];
    // le joueur d'abord : son étiquette garde sa place, les autres s'écartent
    const order = [...this.boats].sort((a, b) => Number(b.boat.isPlayer) - Number(a.boat.isPlayer));
    for (const v of order) {
      const b = v.boat;
      const x = toX(b.pos[0]);
      const z = toZ(b.pos[1]);
      v.rig.root.position.set(x, 0.004 * Math.sin(time * 1.7 + x * 3), z);
      v.rig.root.rotation.y = -b.hdg * D2R;
      v.rig.root.scale.setScalar(scale);
      trimBoat(v.rig, b.twa, b.tws);
      showSails(v.rig, b, time);
      // tangage léger
      v.rig.heel.rotation.x = 0.02 * Math.sin(time * 1.3 + z * 2);
      const sp = Math.min(1, b.spd / 18);
      v.wake.visible = b.spd > 1;
      v.wake.scale.set(0.45 + 0.25 * sp, 1, 0.5 + 0.9 * sp);
      (v.wake.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.38 * sp;
      const p = this.project(x, 1.5 * scale, z);
      if (!p) {
        v.tag.style.visibility = 'hidden';
      } else {
        const w = v.tag.offsetWidth || 60;
        let y = p[1];
        let crowded = false;
        for (let guard = 0; guard < 3; guard++) {
          const hit = placed.find((q) => Math.abs(q.x - p[0]) < (q.w + w) / 2 + 4 && Math.abs(q.y - y) < 24);
          if (!hit) break;
          if (guard === 2 || this.boats.length > 8) crowded = !b.isPlayer;
          y = hit.y - 26;
        }
        // flotte nombreuse : une étiquette qui chevauche est masquée plutôt qu'empilée
        if (crowded) {
          v.tag.style.visibility = 'hidden';
        } else {
          placed.push({ x: p[0], y, w });
          v.tag.style.visibility = 'visible';
          v.tag.style.transform = `translate(${p[0].toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
        }
      }
      const arr = v.trail.geometry.attributes.position.array as Float32Array;
      const tr = b.trail;
      const start = b.isPlayer ? Math.max(0, tr.length - MAX_TRAIL) : Math.max(0, tr.length - 80);
      let n = 0;
      for (let i = start; i < tr.length; i++, n++) {
        arr[n * 3] = toX(tr[i][0]);
        arr[n * 3 + 1] = 0.03;
        arr[n * 3 + 2] = toZ(tr[i][1]);
      }
      arr[n * 3] = x;
      arr[n * 3 + 1] = 0.03;
      arr[n * 3 + 2] = z;
      n++;
      v.trail.geometry.attributes.position.needsUpdate = true;
      v.trail.geometry.setDrawRange(0, n);
    }
    if (this.finish.visible) this.placeTag(this.finishTag, this.finish.position.x, 4.2, this.finish.position.z);
    const ms = Math.max(0.6, this.dist * 0.12);
    for (const m of this.marks) {
      if (!m.g.visible) continue;
      m.g.children[1].scale.setScalar(ms);
      this.placeTag(m.tag, m.g.position.x, 0.12 * ms, m.g.position.z);
    }
  }
}

