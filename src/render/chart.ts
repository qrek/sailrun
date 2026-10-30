import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(workerUrl);
import { Boat, SAILS, SailId, bestSail } from '../sim/boat';
import { LonLat, dist } from '../sim/geo';
import { WindSource } from '../sim/wind';

/**
 * Carte marine de la course : vraies côtes OpenStreetMap (tuiles vectorielles OpenFreeMap) à toutes
 * les échelles, relief Natural Earth, quadrillage des degrés, échelle de distance. Par-dessus : le vent
 * en traits qui filent (canvas), les bateaux, les traces, la route conseillée, la trajectoire prévue,
 * les marques, l'arrivée et la sonde. Tout est en coordonnées géographiques : les distances sont vraies.
 */

const OFM = 'https://tiles.openfreemap.org';
const SAIL_LABEL: Record<string, string> = Object.fromEntries(SAILS.map((s) => [s.id, s.name.toUpperCase()]));
const SAIL_COLOR: Record<SailId, string> = { foc: '#22D3EE', code0: '#A78BFA', spi: '#FB7185' };
/** Changement de voile en cours, pour l'anneau du cercle de cap (p : avancement 0 → 1). */
export type RingSailChange = { from: SailId; to: SailId; p: number; back: boolean };

/** Étiquette du joueur : la voile à poste, ou le changement en cours (l'anneau du cercle de cap montre l'avancement). */
const sailLabel = (b: Boat) => {
  if (b.sailTo === null) return SAIL_LABEL[b.sail] ?? '';
  return b.sailBack ? `RETOUR ${SAIL_LABEL[b.sail]}` : `${SAIL_LABEL[b.sail]} → ${SAIL_LABEL[b.sailTo]}`;
};

function graticule(): FeatureCollection {
  const f: Feature[] = [];
  for (let lon = -90; lon <= 20; lon += 5) f.push({ type: 'Feature', properties: { major: lon % 10 === 0 }, geometry: { type: 'LineString', coordinates: [[lon, -10], [lon, 66]] } });
  for (let lat = -10; lat <= 65; lat += 5) {
    const coords: number[][] = [];
    for (let lon = -95; lon <= 25; lon += 2.5) coords.push([lon, lat]);
    f.push({ type: 'Feature', properties: { major: lat % 10 === 0 }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features: f };
}

/**
 * Relief : tuiles d'altitude « terrarium » (AWS Open Data, Mapzen/SRTM/GEBCO). Les fonds marins sont
 * ramenés à 0 m pour que la mer reste plate en 3D : seules les terres prennent du relief.
 */
let protocolOn = false;
function seaLevelDem() {
  if (protocolOn) return;
  protocolOn = true;
  maplibregl.addProtocol('seadem', async (params: maplibregl.RequestParameters, abort: AbortController) => {
    const url = params.url.replace('seadem://', 'https://');
    const r = await fetch(url, { signal: abort.signal });
    if (!r.ok) throw new Error(`relief ${r.status}`);
    const bmp = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, bmp.width, bmp.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // altitude = R × 256 + G + B / 256 − 32768
      if (d[i] < 128) {
        d[i] = 128;
        d[i + 1] = 0;
        d[i + 2] = 0;
      }
    }
    g.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };
  });
}

/** Petit écran ou machine modeste : tuiles de relief deux fois moins nombreuses, moins de vent animé. */
const LITE = typeof window !== 'undefined' && (Math.min(window.innerWidth, window.innerHeight) < 700 || (navigator.hardwareConcurrency ?? 8) <= 4);

/** Repères de la course : quelques ports et archipels, pas de villes ni de routes. */
const PLACES: [string, number, number, number][] = [
  ['Saint-Malo', -2.02, 48.65, 1],
  ['Brest', -4.49, 48.39, 0],
  ['La Corogne', -8.41, 43.37, 0],
  ['Lisbonne', -9.14, 38.72, 0],
  ['Madère', -16.95, 32.75, 1],
  ['Açores', -27.2, 38.6, 1],
  ['Canaries', -15.6, 28.2, 1],
  ['Cap-Vert', -23.6, 15.6, 1],
  ['Bermudes', -64.75, 32.3, 1],
  ['Antigua', -61.8, 17.07, 0],
  ['Guadeloupe', -61.55, 16.25, 1],
  ['Martinique', -61.0, 14.6, 0],
];
function placesFC(): FeatureCollection {
  return { type: 'FeatureCollection', features: PLACES.map(([name, lon, lat, big]) => ({ type: 'Feature', properties: { name, big }, geometry: { type: 'Point', coordinates: [lon, lat] } })) };
}

/**
 * Carte « jeu de voile » : l'océan et les terres sont peints à partir des vraies altitudes et profondeurs
 * (dégradés francs façon atlas illustré), relief ombré stylisé, côtes dessinées avec un liseré d'écume,
 * noms des océans et quelques repères seulement. Globe quand on dézoome, à plat quand on zoome.
 */
function style(): StyleSpecification {
  return {
    version: 8,
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    projection: { type: 'globe' },
    sources: {
      // altitudes et profondeurs réelles (terrarium : AWS Open Data, Mapzen/SRTM/GEBCO)
      depth: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: LITE ? 512 : 256, maxzoom: LITE ? 9 : 10, encoding: 'terrarium', attribution: 'Mapzen, SRTM, GEBCO' },
      // même source, fonds marins ramenés à 0 m : seule la terre prend du relief en 3D
      dem: { type: 'raster-dem', tiles: ['seadem://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 512, maxzoom: 9, encoding: 'terrarium' },
      omt: { type: 'vector', url: `${OFM}/planet`, attribution: '© OpenMapTiles © OpenStreetMap' },
      grat: { type: 'geojson', data: graticule() },
      places: { type: 'geojson', data: placesFC() },
    },
    sky: { 'sky-color': '#8fc4ef', 'horizon-color': '#e4f1fb', 'fog-color': '#d3e7f6', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.9, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 1, 1, 5, 0.6, 7, 0] },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#1a6fb8' } },
      {
        id: 'paint',
        type: 'color-relief',
        source: 'depth',
        paint: {
          'color-relief-color': [
            'interpolate', ['linear'], ['elevation'],
            -7000, '#0b2f6b', -5000, '#0f3f86', -3500, '#13509d', -2000, '#1765b3', -800, '#1d78c0', -200, '#248bcb', -60, '#2f9dd2', -15, '#4fb6dc', -0.5, '#86d3e4',
            0, '#efe1b0', 15, '#b9d886', 120, '#8cc265', 400, '#73ab52', 900, '#86a253', 1500, '#b39c66', 2300, '#cbb390', 3200, '#e8e1d4', 4200, '#ffffff',
          ],
        },
      },
      { id: 'shade', type: 'hillshade', source: 'depth', paint: { 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#163a5c', 'hillshade-highlight-color': '#fffaf0', 'hillshade-accent-color': '#244a5a', 'hillshade-illumination-anchor': 'map' } },
      // côtes dessinées : liseré d'écume flou puis trait blanc net
      { id: 'surf', type: 'line', source: 'omt', 'source-layer': 'water', filter: ['==', ['get', 'class'], 'ocean'], paint: { 'line-color': '#c8f3f4', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 8, 7, 12, 14], 'line-blur': ['interpolate', ['linear'], ['zoom'], 2, 1, 8, 5, 12, 9] } },
      { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', filter: ['==', ['get', 'class'], 'ocean'], paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.4, 12, 2.2] } },
      { id: 'grat', type: 'line', source: 'grat', paint: { 'line-color': '#ffffff', 'line-opacity': ['case', ['get', 'major'], 0.13, 0.06], 'line-width': 0.8, 'line-dasharray': [4, 3] } },
      { id: 'sea-names', type: 'symbol', source: 'omt', 'source-layer': 'water_name', filter: ['match', ['get', 'class'], ['ocean', 'sea', 'bay'], true, false], layout: { 'text-field': ['upcase', ['coalesce', ['get', 'name:fr'], ['get', 'name']]], 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 12, 8, 18], 'text-letter-spacing': 0.35, 'text-max-width': 9 }, paint: { 'text-color': 'rgba(255,255,255,0.72)', 'text-halo-color': 'rgba(10,50,100,0.35)', 'text-halo-width': 1 } },
      { id: 'place-dot', type: 'circle', source: 'places', paint: { 'circle-radius': 3, 'circle-color': '#ffffff', 'circle-stroke-color': '#16426e', 'circle-stroke-width': 1.5 } },
      { id: 'place-name', type: 'symbol', source: 'places', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['case', ['==', ['get', 'big'], 1], 13, 11.5], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-letter-spacing': 0.04 }, paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(20,55,40,0.75)', 'text-halo-width': 1.6 } },
    ],
  };
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Silhouette de bateau vue de dessus, en champ de distance pour la teinter par concurrent. */
function boatIcon(): { width: number; height: number; data: Uint8Array } {
  const W = 48;
  const H = 48;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(24, 3);
  g.bezierCurveTo(33, 13, 34, 26, 32.5, 40);
  g.lineTo(31, 45);
  g.lineTo(17, 45);
  g.lineTo(15.5, 40);
  g.bezierCurveTo(14, 26, 15, 13, 24, 3);
  g.fill();
  const img = g.getImageData(0, 0, W, H);
  return { width: W, height: H, data: new Uint8Array(img.data.buffer) };
}

export interface ChartFrame {
  wind: WindSource;
  windT: number;
  focus: LonLat;
}

export class ChartView {
  readonly el: HTMLDivElement;
  private map: MlMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ready = false;
  private boats: Boat[] = [];
  private particles: { lon: number; lat: number; age: number; life: number }[] = [];
  private moving = false;
  private scale: maplibregl.ScaleControl;
  windLayer = true;
  private probeMarker: maplibregl.Marker | null = null;
  private onReady: (() => void)[] = [];
  private followFirst = true;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'chart';
    this.el.hidden = true;
    host.insertBefore(this.el, host.querySelector('#labels'));
    seaLevelDem();
    this.map = new maplibregl.Map({
      container: this.el,
      style: style(),
      center: [-3, 48],
      zoom: 6,
      minZoom: 2,
      maxZoom: 12,
      maxPitch: 60,
      pitch: 0,
      pixelRatio: Math.min(window.devicePixelRatio || 1, LITE ? 1.5 : 2),
      fadeDuration: 150,
      attributionControl: { compact: true },
      dragRotate: false,
      renderWorldCopies: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.scale = new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' });
    this.map.addControl(this.scale, 'bottom-left');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-wind';
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.map.on('movestart', () => (this.moving = true));
    this.map.on('moveend', () => {
      this.moving = false;
      this.resetParticles();
    });
    this.map.on('resize', () => this.sizeCanvas());
    this.map.on('load', () => {
      this.setup();
      // sur téléphone, les crédits se replient derrière le bouton « i » pour libérer la carte
      if (LITE) window.setTimeout(() => this.el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'), 2500);
    });
    this.sizeCanvas();
  }

  /** 3D légère : carte inclinée, montagnes en relief (la mer reste plate). */
  set3d(on: boolean) {
    this.whenReady(() => {
      this.map.setTerrain(on ? { source: 'dem', exaggeration: 1.8 } : null);
      this.map.easeTo({ pitch: on ? 25 : 0, duration: 700 });
    });
  }

  private setup() {
    const m = this.map;
    // relief 3D seulement à la demande (bouton Relief 3D) : c'est la partie la plus lourde de la carte
    m.addImage('boat', boatIcon(), { sdf: true });
    const src = (id: string) => m.addSource(id, { type: 'geojson', data: EMPTY });
    for (const id of ['tracks', 'route', 'cplegs', 'rpath', 'proj', 'projpts', 'marks', 'finish', 'boats', 'ghost']) src(id);
    m.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ffd84d', 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [2, 2] } });
    // tracé voulu (droit d'un point à l'autre), fin et discret
    m.addLayer({ id: 'cplegs', type: 'line', source: 'cplegs', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [2, 2] } });
    // trajet simulé, coloré selon la voile ; rouge hachuré quand on remonte au vent
    m.addLayer({ id: 'rpath-c', type: 'line', source: 'rpath', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0c2c48', 'line-width': 7, 'line-opacity': 0.4 } });
    m.addLayer({ id: 'rpath', type: 'line', source: 'rpath', filter: ['!=', ['get', 'k'], 'up'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'k'], 'foc', '#22D3EE', 'code0', '#A78BFA', 'spi', '#FB7185', '#ffd84d'], 'line-width': 4 } });
    m.addLayer({ id: 'rpath-up', type: 'line', source: 'rpath', filter: ['==', ['get', 'k'], 'up'], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#ff5d6c', 'line-width': 4, 'line-dasharray': [1.2, 1] } });
    m.addLayer({ id: 'tracks', type: 'line', source: 'tracks', paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'me'], 3, 1.6], 'line-opacity': ['case', ['get', 'me'], 0.95, 0.7] } });
    m.addLayer({ id: 'proj', type: 'line', source: 'proj', paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [1, 1.5], 'line-opacity': 0.9 } });
    m.addLayer({ id: 'projpts', type: 'circle', source: 'projpts', paint: { 'circle-radius': 3.5, 'circle-color': '#ffffff', 'circle-stroke-color': '#0c2c48', 'circle-stroke-width': 1.5 } });
    m.addLayer({ id: 'projlbl', type: 'symbol', source: 'projpts', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, -1.1], 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff', 'text-halo-color': '#0c2c48', 'text-halo-width': 1.5 } });
    m.addLayer({ id: 'finish', type: 'circle', source: 'finish', paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 4, 4, 12, 40], 'circle-color': 'rgba(255,216,77,0.15)', 'circle-stroke-color': '#ffd84d', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'finishlbl', type: 'symbol', source: 'finish', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-letter-spacing': 0.1, 'text-allow-overlap': true }, paint: { 'text-color': '#ffd84d', 'text-halo-color': '#0c2c48', 'text-halo-width': 1.5 } });
    m.addLayer({ id: 'marks', type: 'circle', source: 'marks', paint: { 'circle-radius': 6, 'circle-color': ['case', ['get', 'next'], '#3fe3c9', '#ff8a3d'], 'circle-stroke-color': '#06111a', 'circle-stroke-width': 2, 'circle-opacity': ['case', ['get', 'done'], 0.3, 1] } });
    m.addLayer({ id: 'markslbl', type: 'symbol', source: 'marks', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-letter-spacing': 0.08, 'text-allow-overlap': true }, paint: { 'text-color': ['case', ['get', 'next'], '#3fe3c9', '#ffb37a'], 'text-halo-color': '#06111a', 'text-halo-width': 1.5 } });
    m.addLayer({ id: 'ghost', type: 'circle', source: 'ghost', paint: { 'circle-radius': 10, 'circle-color': 'rgba(255,255,255,0.3)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
    m.addLayer({ id: 'me-halo', type: 'circle', source: 'boats', filter: ['==', ['get', 'me'], true], paint: { 'circle-radius': 17, 'circle-color': 'rgba(255,255,255,0.12)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } });
    m.addLayer({
      id: 'boats',
      type: 'symbol',
      source: 'boats',
      layout: {
        'icon-image': 'boat',
        'icon-size': ['case', ['get', 'me'], 0.8, 0.6],
        'icon-rotate': ['get', 'hdg'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // clé basse = placée en premier : l'étiquette du joueur passe toujours
        'symbol-sort-key': ['case', ['get', 'me'], 0, 1],
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['case', ['get', 'me'], 13, 10.5],
        'text-offset': [0, 1.5],
        'text-optional': true,
      },
      paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#ffffff', 'icon-halo-width': 1.6, 'text-color': ['case', ['get', 'me'], '#ffffff', '#e6f2fa'], 'text-halo-color': 'rgba(8,36,66,0.85)', 'text-halo-width': 1.6 },
    });
    this.ready = true;
    for (const f of this.onReady) f();
    this.onReady = [];
  }

  private whenReady(f: () => void) {
    if (this.ready) f();
    else this.onReady.push(f);
  }

  private set(id: string, data: FeatureCollection | Feature) {
    this.whenReady(() => (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data));
  }

  setVisible(on: boolean) {
    this.el.hidden = !on;
    if (on) {
      this.map.resize();
      this.sizeCanvas();
    }
  }

  setUnit(u: 'km' | 'nm') {
    this.scale.setUnit(u === 'km' ? 'metric' : 'nautical');
  }

  /* ---------- objets de course ---------- */
  setBoats(boats: Boat[]) {
    this.boats = boats;
    this.tracksAt = 0;
    this.followFirst = true;
    this.updateBoats();
  }

  private tracksAt = 0;
  updateBoats() {
    const feats: Feature[] = [];
    const tracks: Feature[] = [];
    // les traces bougent peu : on ne les renvoie à la carte que toutes les 5 s
    const now = performance.now();
    const withTracks = now - this.tracksAt > 5000;
    if (withTracks) this.tracksAt = now;
    for (const b of this.boats) {
      feats.push({ type: 'Feature', properties: { hdg: b.hdg, color: b.color, me: b.isPlayer, label: b.isPlayer ? `TOI · ${sailLabel(b)}` : b.name }, geometry: { type: 'Point', coordinates: [b.pos[0], b.pos[1]] } });
      const tr = !withTracks ? [] : b.isPlayer ? b.trail : b.trail.slice(-120);
      if (tr.length) tracks.push({ type: 'Feature', properties: { color: b.isPlayer ? '#ffffff' : b.color, me: b.isPlayer }, geometry: { type: 'LineString', coordinates: [...tr.map((p) => [p[0], p[1]]), [b.pos[0], b.pos[1]]] } });
    }
    this.set('boats', { type: 'FeatureCollection', features: feats });
    if (withTracks) this.set('tracks', { type: 'FeatureCollection', features: tracks });
  }

  /* ---------- checkpoints du joueur ---------- */
  private cpMarkers: maplibregl.Marker[] = [];
  onCpMove: ((i: number, ll: LonLat) => void) | null = null;
  onCpTap: ((i: number) => void) | null = null;

  /** Checkpoints : repères numérotés à faire glisser, et le trajet du bateau jusqu'au dernier. */
  setCheckpoints(from: LonLat | null, cps: { pos: LonLat; eta: string; sel: boolean }[]) {
    this.whenReady(() => {
      while (this.cpMarkers.length > cps.length) this.cpMarkers.pop()!.remove();
      cps.forEach((c, i) => {
        let mk = this.cpMarkers[i];
        if (!mk) {
          const el = document.createElement('div');
          el.className = 'cp';
          el.innerHTML = '<b><i></i></b><span></span>';
          mk = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' });
          const idx = i;
          mk.on('dragend', () => {
            const ll = mk.getLngLat();
            this.onCpMove?.(idx, [ll.lng, ll.lat]);
          });
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            this.onCpTap?.(idx);
          });
          mk.setLngLat(c.pos).addTo(this.map);
          this.cpMarkers[i] = mk;
        }
        mk.setLngLat(c.pos);
        const el = mk.getElement();
        el.querySelector('b i')!.textContent = String(i + 1);
        el.querySelector('span')!.textContent = c.eta;
        el.classList.toggle('sel', c.sel);
        el.classList.toggle('next', i === 0);
      });
      const line = from && cps.length ? [from, ...cps.map((c) => c.pos)] : [];
      this.set('cplegs', line.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } } : EMPTY);
    });
  }

  /** Trajet simulé de la route : segments colorés par voile (foc, code0, spi) ou « up » quand on tire des bords. */
  setRoutePath(segs: { coords: LonLat[]; k: string }[]) {
    this.set('rpath', { type: 'FeatureCollection', features: segs.filter((g) => g.coords.length > 1).map((g) => ({ type: 'Feature', properties: { k: g.k }, geometry: { type: 'LineString', coordinates: g.coords } })) });
  }

  /** Bateau fantôme posé à une position donnée (frise du temps), null = masqué. */
  setGhostPos(p: LonLat | null) {
    this.set('ghost', p ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } } : EMPTY);
  }

  /** Coordonnées écran (dans la page) d'un point géographique. */
  screenOf(p: LonLat): [number, number] | null {
    if (!this.ready || this.el.hidden) return null;
    const a = this.map.project(p);
    const r = this.el.getBoundingClientRect();
    return [a.x + r.left, a.y + r.top];
  }

  /** Mode pose : le pointeur devient une mire, un clic sur la mer pose un checkpoint. */
  setPlacing(on: boolean) {
    this.el.classList.toggle('placing', on);
  }

  focus(pos: LonLat) {
    this.whenReady(() => this.map.easeTo({ center: pos, zoom: Math.max(this.map.getZoom(), 6.5), duration: 700 }));
  }

  setRoute(pts: LonLat[]) {
    this.set('route', pts.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } } : EMPTY);
  }

  private projPts: LonLat[] = [];
  private projDt = 0.5;
  setProjection(pts: LonLat[], dt: number) {
    this.projPts = pts;
    this.projDt = dt;
    const shown = pts.slice(0, Math.ceil(24 / dt) + 1);
    this.set('proj', shown.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: shown } } : EMPTY);
    const marks: Feature[] = [];
    for (const h of [2, 5, 12, 24]) {
      const p = pts[Math.round(h / dt)];
      if (p) marks.push({ type: 'Feature', properties: { label: `${h} h` }, geometry: { type: 'Point', coordinates: p } });
    }
    this.set('projpts', { type: 'FeatureCollection', features: marks });
  }

  /** Position prévue dans `hours` heures, le long de la trajectoire. */
  setGhost(hours: number) {
    const i = hours / this.projDt;
    const p = hours > 0 ? this.projPts[Math.round(i)] : undefined;
    this.set('ghost', p ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } } : EMPTY);
  }

  ghostPos(hours: number): LonLat | null {
    return this.projPts[Math.round(hours / this.projDt)] ?? null;
  }

  setFinish(p: LonLat | null, label: string) {
    this.set('finish', p ? { type: 'Feature', properties: { label }, geometry: { type: 'Point', coordinates: p } } : EMPTY);
  }

  setMarks(marks: { name: string; pos: LonLat }[], next: number) {
    this.set('marks', { type: 'FeatureCollection', features: marks.map((m, i) => ({ type: 'Feature', properties: { name: m.name.toUpperCase(), next: i === next, done: i < next }, geometry: { type: 'Point', coordinates: m.pos } })) });
  }

  /** Sonde : un repère fixé sur la carte (il suit les déplacements de la carte). */
  setProbe(ll: LonLat | null) {
    if (!ll) {
      this.probeMarker?.remove();
      this.probeMarker = null;
      return;
    }
    if (!this.probeMarker) {
      const el = document.createElement('div');
      el.className = 'probe-pin';
      this.probeMarker = new maplibregl.Marker({ element: el });
    }
    this.probeMarker.setLngLat(ll).addTo(this.map);
  }

  probeScreen(): [number, number] | null {
    if (!this.probeMarker || this.el.hidden) return null;
    const p = this.map.project(this.probeMarker.getLngLat());
    const r = this.el.getBoundingClientRect();
    return [p.x + r.left, p.y + r.top];
  }

  /** Point géographique sous le pointeur (coordonnées écran). */
  pick(clientX: number, clientY: number): LonLat | null {
    const r = this.el.getBoundingClientRect();
    const ll = this.map.unproject([clientX - r.left, clientY - r.top]);
    return [ll.lng, ll.lat];
  }

  on(type: 'click' | 'mousemove' | 'mouseout', f: (ll: LonLat | null, x: number, y: number) => void) {
    this.map.on(type, (e: maplibregl.MapMouseEvent) => f(e.lngLat ? [e.lngLat.lng, e.lngLat.lat] : null, e.originalEvent?.clientX ?? 0, e.originalEvent?.clientY ?? 0));
  }

  /** Recentre sur le bateau. */
  recenter(p: LonLat, zoom?: number) {
    this.map.easeTo({ center: p, zoom: zoom ?? Math.max(this.map.getZoom(), 6.5), duration: 800 });
  }

  jumpTo(p: LonLat, zoom: number) {
    this.map.jumpTo({ center: p, zoom });
  }

  /* ---------- vent : traits qui filent ---------- */
  // Le vent est échantillonné sur une grille à l'écran (une fois par seconde, ou quand la carte bouge),
  // puis les traits se déplacent en pixels : plus aucun calcul de projection par trait et par image.
  private field: Float32Array | null = null; // par nœud : dx, dy (px par image à 60 i/s), force (nds)
  private fCols = 0;
  private fRows = 0;
  private fAt = -1e9;
  private fWindT = NaN;
  private readonly CELL = 28;

  private sizeCanvas() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(LITE ? 1.5 : 2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.resetParticles();
  }

  private resetParticles() {
    this.particles = [];
    this.field = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private buildField(wind: WindSource, windT: number) {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const C = this.CELL;
    const cols = Math.ceil(w / C) + 1;
    const rows = Math.ceil(h / C) + 1;
    const f = new Float32Array(cols * rows * 3);
    const k = 0.55 * 0.35; // px par nœud et par image (60 i/s)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const o = (j * cols + i) * 3;
        const x = i * C;
        const y = j * C;
        const ll = this.map.unproject([x, y]);
        // hors du globe : la projection inverse ne retombe pas sur le même pixel
        const back = this.map.project(ll);
        if (!Number.isFinite(ll.lat) || Math.abs(back.x - x) > 3 || Math.abs(back.y - y) > 3) {
          f[o + 2] = -1;
          continue;
        }
        const [u, v] = wind.at(ll.lng, ll.lat, windT);
        f[o] = u * k;
        f[o + 1] = -v * k;
        f[o + 2] = Math.hypot(u, v);
      }
    }
    this.field = f;
    this.fCols = cols;
    this.fRows = rows;
    this.fAt = performance.now();
    this.fWindT = windT;
  }

  private spawn() {
    return { lon: Math.random() * this.el.clientWidth, lat: Math.random() * this.el.clientHeight, age: 0, life: 40 + Math.random() * 60 };
  }

  frame(f: ChartFrame, dt: number) {
    if (this.el.hidden) return;
    if (this.followFirst && this.ready) {
      this.followFirst = false;
      this.jumpTo(f.focus, 7);
    }
    this.placeRing();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = W / Math.max(1, this.el.clientWidth);
    // traînées : on estompe l'image précédente
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.84)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    if (!this.windLayer || this.moving || !this.ready) {
      if (!this.windLayer) ctx.clearRect(0, 0, W, H);
      return;
    }
    const now = performance.now();
    if (!this.field || now - this.fAt > 1500 || Math.abs(f.windT - this.fWindT) > 0.2) this.buildField(f.wind, f.windT);
    const fd = this.field!;
    const cols = this.fCols;
    const C = this.CELL;
    const area = this.el.clientWidth * this.el.clientHeight;
    const n = Math.round(LITE ? Math.min(550, area / 1700) : Math.min(1400, area / 1000));
    while (this.particles.length < n) this.particles.push(this.spawn());
    if (this.particles.length > n) this.particles.length = n;
    const step = Math.min(2, dt * 60);
    // quatre paquets selon la force du vent : quatre tracés seulement par image
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const maxX = this.el.clientWidth;
    const maxY = this.el.clientHeight;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const x = p.lon;
      const y = p.lat;
      const gi = Math.min(cols - 2, Math.max(0, (x / C) | 0));
      const gj = Math.min(this.fRows - 2, Math.max(0, (y / C) | 0));
      const fx = x / C - gi;
      const fy = y / C - gj;
      const o00 = (gj * cols + gi) * 3;
      const o10 = o00 + 3;
      const o01 = o00 + cols * 3;
      const o11 = o01 + 3;
      if (fd[o00 + 2] < 0 || fd[o10 + 2] < 0 || fd[o01 + 2] < 0 || fd[o11 + 2] < 0) {
        this.particles[i] = this.spawn();
        continue;
      }
      const lerp = (k: number) => (fd[o00 + k] * (1 - fx) + fd[o10 + k] * fx) * (1 - fy) + (fd[o01 + k] * (1 - fx) + fd[o11 + k] * fx) * fy;
      const dx = lerp(0) * step;
      const dy = lerp(1) * step;
      const sp = lerp(2);
      const x1 = x + dx;
      const y1 = y + dy;
      p.lon = x1;
      p.lat = y1;
      p.age++;
      if (p.age > p.life || x1 < 0 || y1 < 0 || x1 > maxX || y1 > maxY) {
        this.particles[i] = this.spawn();
        continue;
      }
      const path = paths[sp < 8 ? 0 : sp < 14 ? 1 : sp < 22 ? 2 : 3];
      path.moveTo(x * dpr, y * dpr);
      path.lineTo(x1 * dpr, y1 * dpr);
    }
    ctx.lineWidth = 1.3 * dpr;
    ctx.lineCap = 'round';
    const alpha = [0.2, 0.32, 0.45, 0.6];
    for (let k = 0; k < 4; k++) {
      ctx.strokeStyle = `rgba(255,255,255,${alpha[k]})`;
      ctx.stroke(paths[k]);
    }
  }

  /* ---------- cercle de cap autour du bateau ---------- */
  private ring: HTMLDivElement | null = null;
  private ringState = { pos: null as LonLat | null, hdg: 0, twd: 0, tws: 0, pending: null as number | null, sail: 'foc' as SailId, change: null as RingSailChange | null, show: false };
  private ringKey = '';
  /** appelé quand on tire la poignée (cap vrai), et au relâché */
  onRingDrag: ((hdg: number, done: boolean) => void) | null = null;
  onRingOk: (() => void) | null = null;
  onRingCancel: (() => void) | null = null;

  /** Données du cercle de cap : position et cap du bateau, vent, consigne en cours. */
  setRing(d: { pos: LonLat; hdg: number; twd: number; tws: number; pending: number | null; sail: SailId; change: RingSailChange | null } | null) {
    if (!d) {
      this.ringState.show = false;
      if (this.ring) this.ring.hidden = true;
      return;
    }
    Object.assign(this.ringState, d, { show: true });
    if (!this.ring) this.makeRing();
    this.drawRing();
  }

  private makeRing() {
    const el = document.createElement('div');
    el.className = 'hring';
    el.innerHTML = `<svg viewBox="-130 -130 260 260" aria-label="Cap : tire la poignée pour choisir la direction">
      <g data-sect></g>
      <g data-sxr class="sxr" style="display: none"><circle r="54" class="sxr-t"/><circle r="54" class="sxr-a" data-sxr-arc pathLength="100" transform="rotate(-90)"/></g>
      <circle r="92" class="band"/>
      <g data-ticks></g>
      <line data-cur x1="0" y1="0" x2="0" y2="-92" class="cur"/>
      <line data-pend x1="0" y1="0" x2="0" y2="-92" class="pend"/>
      <g data-wind class="wind"><path d="M0 -128 L0 -104 M-6 -112 L0 -102 L6 -112"/><text y="-116" x="10" data-wtxt></text></g>
      <g data-knob class="knob"><circle r="13"/><text dy="4" data-ktxt></text></g>
      <circle r="92" class="hit"/>
    </svg>
    <div class="hr-ok" data-hrok hidden><button type="button" class="ok" data-ok>OK</button><button type="button" class="x" data-x aria-label="Annuler">✕</button></div>`;
    this.el.appendChild(el);
    this.ring = el;
    el.querySelector('[data-ok]')!.addEventListener('click', () => this.onRingOk?.());
    el.querySelector('[data-x]')!.addEventListener('click', () => this.onRingCancel?.());
    // graduations, une fois
    const ticks: string[] = [];
    for (let a = 0; a < 360; a += 10) {
      const r0 = a % 90 === 0 ? 80 : a % 30 === 0 ? 84 : 87;
      const s = Math.sin((a * Math.PI) / 180);
      const c = -Math.cos((a * Math.PI) / 180);
      ticks.push(`<line x1="${(s * r0).toFixed(1)}" y1="${(c * r0).toFixed(1)}" x2="${(s * 92).toFixed(1)}" y2="${(c * 92).toFixed(1)}"/>`);
    }
    ticks.push('<text x="0" y="-66" class="n">N</text><text x="68" y="4" class="c">E</text><text x="0" y="74" class="c">S</text><text x="-68" y="4" class="c">O</text>');
    el.querySelector('[data-ticks]')!.innerHTML = ticks.join('');
    const svg = el.querySelector('svg')!;
    const hit = el.querySelector<SVGCircleElement>('.hit')!;
    const angleAt = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2);
      const y = e.clientY - (r.top + r.height / 2);
      return ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    };
    let on = false;
    hit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hit.setPointerCapture(e.pointerId);
      on = true;
      el.classList.add('drag');
      this.onRingDrag?.(Math.round(angleAt(e)), false);
    });
    hit.addEventListener('pointermove', (e) => {
      if (on) this.onRingDrag?.(Math.round(angleAt(e)), false);
    });
    const end = (e: PointerEvent) => {
      if (!on) return;
      on = false;
      el.classList.remove('drag');
      this.onRingDrag?.(Math.round(angleAt(e)), true);
    };
    hit.addEventListener('pointerup', end);
    hit.addEventListener('pointercancel', end);
    // MapLibre n'écoute la molette que sur son conteneur : on lui renvoie celle reçue par le cercle, sinon le zoom s'arrête net dessus
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.map.getCanvas().dispatchEvent(new WheelEvent('wheel', e));
      },
      { passive: false },
    );
  }

  private drawRing() {
    const el = this.ring;
    const st = this.ringState;
    if (!el) return;
    const rot = (n: Element | null, a: number) => n?.setAttribute('transform', `rotate(${a.toFixed(1)})`);
    rot(el.querySelector('[data-cur]'), st.hdg);
    const pend = el.querySelector<SVGLineElement>('[data-pend]')!;
    const knob = el.querySelector<SVGGElement>('[data-knob]')!;
    const ka = st.pending ?? st.hdg;
    pend.style.display = st.pending === null ? 'none' : '';
    rot(pend, ka);
    const kr = (ka * Math.PI) / 180;
    knob.setAttribute('transform', `translate(${(Math.sin(kr) * 92).toFixed(1)} ${(-Math.cos(kr) * 92).toFixed(1)})`);
    knob.classList.toggle('on', st.pending !== null);
    el.querySelector('[data-ktxt]')!.textContent = String(Math.round(ka)).padStart(3, '0');
    // changement de voile : un anneau intérieur se remplit (ou se vide pendant une annulation)
    const sx = el.querySelector<SVGGElement>('[data-sxr]')!;
    const ch = st.change;
    sx.style.display = ch ? '' : 'none';
    if (ch) {
      const arc = el.querySelector<SVGCircleElement>('[data-sxr-arc]')!;
      arc.setAttribute('stroke', SAIL_COLOR[ch.back ? ch.from : ch.to]);
      arc.setAttribute('stroke-dasharray', `${(ch.p * 100).toFixed(1)} 100`);
    }
    const okBox = el.querySelector<HTMLElement>('[data-hrok]')!;
    okBox.hidden = st.pending === null;
    if (st.pending !== null) el.querySelector('[data-ok]')!.textContent = `OK ${String(Math.round(st.pending)).padStart(3, '0')}°`;
    rot(el.querySelector('[data-wind]'), st.twd);
    const wt = el.querySelector('[data-wtxt]')!;
    wt.textContent = `${Math.round(st.tws)} nds`;
    wt.setAttribute('transform', `rotate(${(-st.twd).toFixed(1)} 10 -116)`);
    // secteurs : la meilleure voile pour chaque cap, et la zone où le bateau ne remonte pas
    const key = `${Math.round(st.twd / 3)}.${Math.round(st.tws)}`;
    if (key !== this.ringKey) {
      this.ringKey = key;
      const arcs: string[] = [];
      const R = 104;
      const seg = (a0: number, a1: number, color: string, cls: string) => {
        const p = (a: number) => `${(Math.sin((a * Math.PI) / 180) * R).toFixed(1)} ${(-Math.cos((a * Math.PI) / 180) * R).toFixed(1)}`;
        arcs.push(`<path d="M${p(a0)} A${R} ${R} 0 0 1 ${p(a1)}" stroke="${color}" class="${cls}"/>`);
      };
      let start = 0;
      let prev = '';
      const kind = (h: number) => {
        const twa = ((st.twd - h + 540) % 360) - 180;
        return Math.abs(twa) < 38 ? 'nogo' : bestSail(twa, st.tws);
      };
      for (let a = 0; a <= 360; a += 4) {
        const k = a === 360 ? '' : kind(a);
        if (k !== prev) {
          if (prev) seg(start, a, prev === 'nogo' ? '#ff5d6c' : SAIL_COLOR[prev as SailId], prev === 'nogo' ? 'ng' : 'sl');
          start = a;
          prev = k;
        }
      }
      el.querySelector('[data-sect]')!.innerHTML = arcs.join('');
    }
  }

  /** Le cercle suit le bateau à l'écran. */
  private placeRing() {
    const el = this.ring;
    const st = this.ringState;
    if (!el) return;
    const show = st.show && !!st.pos && this.ready && this.map.getZoom() >= 4.5;
    el.hidden = !show;
    if (!show) return;
    const p = this.map.project(st.pos!);
    el.style.transform = `translate(${(p.x - 130).toFixed(1)}px, ${(p.y - 130).toFixed(1)}px)`;
  }

  /** Distance du centre de la carte au bateau (milles), pour proposer de recentrer. */
  offCenter(p: LonLat): number {
    const c = this.map.getCenter();
    return dist([c.lng, c.lat], p);
  }
}
