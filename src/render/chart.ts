import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(workerUrl);
import { Boat } from '../sim/boat';
import { LonLat, dist } from '../sim/geo';
import { WindSource } from '../sim/wind';

/**
 * Carte marine de la course : vraies côtes OpenStreetMap (tuiles vectorielles OpenFreeMap) à toutes
 * les échelles, relief Natural Earth, quadrillage des degrés, échelle de distance. Par-dessus : le vent
 * en traits qui filent (canvas), les bateaux, les traces, la route conseillée, la trajectoire prévue,
 * les marques, l'arrivée et la sonde. Tout est en coordonnées géographiques : les distances sont vraies.
 */

const OFM = 'https://tiles.openfreemap.org';

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

function style(): StyleSpecification {
  const label = ['coalesce', ['get', 'name:fr'], ['get', 'name:latin'], ['get', 'name']] as unknown as string;
  return {
    version: 8,
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      // NASA Blue Marble : relief ombré des terres et des fonds marins (domaine public)
      bm: {
        type: 'raster',
        tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'],
        tileSize: 256,
        maxzoom: 8,
        attribution: 'NASA Blue Marble',
      },
      dem: { type: 'raster-dem', tiles: ['seadem://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 11, encoding: 'terrarium', attribution: 'Mapzen, SRTM, GEBCO' },
      omt: { type: 'vector', url: `${OFM}/planet`, attribution: '© OpenMapTiles © OpenStreetMap' },
      grat: { type: 'geojson', data: graticule() },
    },
    sky: { 'sky-color': '#7fb6e6', 'horizon-color': '#d6e8f5', 'fog-color': '#c9dcea', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#123d66' } },
      { id: 'bm', type: 'raster', source: 'bm', paint: { 'raster-saturation': 0.12, 'raster-contrast': 0.08, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } },
      // en zoom fort, l'image satellite devient floue : on reprend la main avec les vraies côtes
      { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', minzoom: 7, filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': '#3f6b34', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 9, 0.45] } },
      { id: 'urban', type: 'fill', source: 'omt', 'source-layer': 'landuse', minzoom: 8, filter: ['match', ['get', 'class'], ['residential', 'commercial', 'industrial'], true, false], paint: { 'fill-color': '#b9b0a0', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 10, 0.5] } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', minzoom: 8, paint: { 'fill-color': '#1f5594', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 10, 0.85] } },
      { id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#1b2a20', 'hillshade-highlight-color': '#fff8e6', 'hillshade-accent-color': '#2a3a2a' } },
      { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', minzoom: 5, paint: { 'line-color': '#f2f7f2', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.15, 10, 0.55], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 11, 1.2] } },
      { id: 'grat', type: 'line', source: 'grat', paint: { 'line-color': '#ffffff', 'line-opacity': ['case', ['get', 'major'], 0.12, 0.06], 'line-width': 0.8 } },
      { id: 'borders', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['==', ['get', 'admin_level'], 2], paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-dasharray': [3, 2], 'line-width': 0.7 } },
      { id: 'sea-names', type: 'symbol', source: 'omt', 'source-layer': 'water_name', layout: { 'text-field': label, 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 8, 15], 'text-letter-spacing': 0.25, 'text-max-width': 8 }, paint: { 'text-color': '#cfe6f7', 'text-halo-color': 'rgba(6,30,52,0.6)', 'text-halo-width': 1 } },
      { id: 'countries', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 7, filter: ['==', ['get', 'class'], 'country'], layout: { 'text-field': label, 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 6, 16], 'text-letter-spacing': 0.06 }, paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,30,20,0.55)', 'text-halo-width': 1.2 } },
      { id: 'towns', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 5, filter: ['match', ['get', 'class'], ['city', 'town'], true, false], layout: { 'text-field': label, 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 10, 14], 'symbol-sort-key': ['get', 'rank'] }, paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(10,25,20,0.7)', 'text-halo-width': 1.2 } },
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
      pitch: 35,
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
    this.map.on('load', () => this.setup());
    this.sizeCanvas();
  }

  /** 3D légère : carte inclinée, montagnes en relief (la mer reste plate). */
  set3d(on: boolean) {
    this.whenReady(() => {
      this.map.setTerrain(on ? { source: 'dem', exaggeration: 2.2 } : null);
      this.map.easeTo({ pitch: on ? 35 : 0, duration: 700 });
    });
  }

  private setup() {
    const m = this.map;
    m.setTerrain({ source: 'dem', exaggeration: 2.2 });
    m.addImage('boat', boatIcon(), { sdf: true });
    const src = (id: string) => m.addSource(id, { type: 'geojson', data: EMPTY });
    for (const id of ['tracks', 'route', 'proj', 'projpts', 'marks', 'finish', 'boats', 'ghost']) src(id);
    m.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ffd84d', 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [2, 2] } });
    m.addLayer({ id: 'tracks', type: 'line', source: 'tracks', paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'me'], 2.2, 1.1], 'line-opacity': ['case', ['get', 'me'], 0.95, 0.5] } });
    m.addLayer({ id: 'proj', type: 'line', source: 'proj', paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [1, 1.5], 'line-opacity': 0.9 } });
    m.addLayer({ id: 'projpts', type: 'circle', source: 'projpts', paint: { 'circle-radius': 3.5, 'circle-color': '#ffffff', 'circle-stroke-color': '#0c2c48', 'circle-stroke-width': 1.5 } });
    m.addLayer({ id: 'projlbl', type: 'symbol', source: 'projpts', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, -1.1], 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff', 'text-halo-color': '#0c2c48', 'text-halo-width': 1.5 } });
    m.addLayer({ id: 'finish', type: 'circle', source: 'finish', paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 4, 4, 12, 40], 'circle-color': 'rgba(255,216,77,0.15)', 'circle-stroke-color': '#ffd84d', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'finishlbl', type: 'symbol', source: 'finish', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-letter-spacing': 0.1, 'text-allow-overlap': true }, paint: { 'text-color': '#ffd84d', 'text-halo-color': '#0c2c48', 'text-halo-width': 1.5 } });
    m.addLayer({ id: 'marks', type: 'circle', source: 'marks', paint: { 'circle-radius': 6, 'circle-color': ['case', ['get', 'next'], '#3fe3c9', '#ff8a3d'], 'circle-stroke-color': '#06111a', 'circle-stroke-width': 2, 'circle-opacity': ['case', ['get', 'done'], 0.3, 1] } });
    m.addLayer({ id: 'markslbl', type: 'symbol', source: 'marks', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-letter-spacing': 0.08, 'text-allow-overlap': true }, paint: { 'text-color': ['case', ['get', 'next'], '#3fe3c9', '#ffb37a'], 'text-halo-color': '#06111a', 'text-halo-width': 1.5 } });
    m.addLayer({ id: 'ghost', type: 'circle', source: 'ghost', paint: { 'circle-radius': 7, 'circle-color': 'rgba(255,216,77,0.25)', 'circle-stroke-color': '#ffd84d', 'circle-stroke-width': 2 } });
    m.addLayer({
      id: 'boats',
      type: 'symbol',
      source: 'boats',
      layout: {
        'icon-image': 'boat',
        'icon-size': ['case', ['get', 'me'], 0.85, 0.55],
        'icon-rotate': ['get', 'hdg'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['case', ['get', 'me'], 1000, 0],
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['case', ['get', 'me'], 13, 10.5],
        'text-offset': [0, 1.5],
        'text-optional': true,
        'text-allow-overlap': ['get', 'me'],
      },
      paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#06111a', 'icon-halo-width': 1.2, 'text-color': ['case', ['get', 'me'], '#ffffff', '#c4dadf'], 'text-halo-color': '#06111a', 'text-halo-width': 1.4 },
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
    this.followFirst = true;
    this.updateBoats();
  }

  updateBoats() {
    const feats: Feature[] = [];
    const tracks: Feature[] = [];
    for (const b of this.boats) {
      feats.push({ type: 'Feature', properties: { hdg: b.hdg, color: b.color, me: b.isPlayer, label: b.isPlayer ? 'TOI' : b.name }, geometry: { type: 'Point', coordinates: [b.pos[0], b.pos[1]] } });
      const tr = b.isPlayer ? b.trail : b.trail.slice(-120);
      if (tr.length) tracks.push({ type: 'Feature', properties: { color: b.isPlayer ? '#ffffff' : b.color, me: b.isPlayer }, geometry: { type: 'LineString', coordinates: [...tr.map((p) => [p[0], p[1]]), [b.pos[0], b.pos[1]]] } });
    }
    this.set('boats', { type: 'FeatureCollection', features: feats });
    this.set('tracks', { type: 'FeatureCollection', features: tracks });
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
  private sizeCanvas() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.resetParticles();
  }

  private resetParticles() {
    this.particles = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private spawn() {
    const b = this.map.getBounds();
    const lon = b.getWest() + Math.random() * (b.getEast() - b.getWest());
    const lat = b.getSouth() + Math.random() * (b.getNorth() - b.getSouth());
    return { lon, lat, age: 0, life: 40 + Math.random() * 60 };
  }

  frame(f: ChartFrame, dt: number) {
    if (this.el.hidden) return;
    if (this.followFirst && this.ready) {
      this.followFirst = false;
      this.jumpTo(f.focus, 7);
    }
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const dpr = W / Math.max(1, this.el.clientWidth);
    // traînées : on estompe l'image précédente
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.84)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    if (!this.windLayer || this.moving) {
      if (!this.windLayer) ctx.clearRect(0, 0, W, H);
      return;
    }
    const n = Math.round(Math.min(2400, (this.el.clientWidth * this.el.clientHeight) / 600));
    while (this.particles.length < n) this.particles.push(this.spawn());
    // déplacement à l'écran : proportionnel à la force du vent, indépendant du zoom
    const pxPerKnot = 0.55 * dpr * Math.min(2, dt * 60);
    ctx.lineWidth = 1.1 * dpr;
    ctx.lineCap = 'round';
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const [u, v] = f.wind.at(p.lon, p.lat, f.windT);
      const s = Math.hypot(u, v);
      const a = this.map.project([p.lon, p.lat]);
      const x0 = a.x * dpr;
      const y0 = a.y * dpr;
      const x1 = x0 + u * pxPerKnot * 0.35;
      const y1 = y0 - v * pxPerKnot * 0.35;
      const ll = this.map.unproject([x1 / dpr, y1 / dpr]);
      p.lon = ll.lng;
      p.lat = ll.lat;
      p.age++;
      if (p.age > p.life || x1 < 0 || y1 < 0 || x1 > W || y1 > H) {
        this.particles[i] = this.spawn();
        continue;
      }
      const alpha = (0.25 + Math.min(1, s / 20) * 0.65) * Math.min(1, p.age / 8) * Math.min(1, (p.life - p.age) / 10);
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }

  /** Distance du centre de la carte au bateau (milles), pour proposer de recentrer. */
  offCenter(p: LonLat): number {
    const c = this.map.getCenter();
    return dist([c.lng, c.lat], p);
  }
}
