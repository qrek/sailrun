import * as THREE from 'three';
import { toX, toZ } from '../sim/geo';

interface Place {
  name: string;
  lon: number;
  lat: number;
  kind: 'ocean' | 'sea' | 'island' | 'port' | 'land';
}

const PLACES: Place[] = [
  { name: 'Océan Atlantique', lon: -42, lat: 34, kind: 'ocean' },
  { name: 'Mer des Sargasses', lon: -60, lat: 28, kind: 'sea' },
  { name: 'Golfe de Gascogne', lon: -6.5, lat: 45.3, kind: 'sea' },
  { name: 'Mer des Caraïbes', lon: -73, lat: 15, kind: 'sea' },
  { name: 'Pot-au-noir', lon: -30, lat: 6, kind: 'sea' },
  { name: 'Açores', lon: -27.5, lat: 38.9, kind: 'island' },
  { name: 'Madère', lon: -16.9, lat: 33.3, kind: 'island' },
  { name: 'Canaries', lon: -15.8, lat: 29.4, kind: 'island' },
  { name: 'Cap-Vert', lon: -24.0, lat: 16.9, kind: 'island' },
  { name: 'Antilles', lon: -62.8, lat: 19.3, kind: 'island' },
  { name: 'Bermudes', lon: -64.8, lat: 32.9, kind: 'island' },
  { name: 'Lorient', lon: -3.37, lat: 47.75, kind: 'port' },
  { name: 'Ponta Delgada', lon: -25.67, lat: 37.74, kind: 'port' },
  { name: 'Fort-de-France', lon: -61.07, lat: 14.6, kind: 'port' },
  { name: 'Antigua', lon: -61.8, lat: 17.07, kind: 'port' },
  { name: 'Las Palmas', lon: -15.42, lat: 28.1, kind: 'port' },
  { name: 'Europe', lon: 3, lat: 47, kind: 'land' },
  { name: 'Afrique', lon: 2, lat: 20, kind: 'land' },
  { name: 'Amérique du Nord', lon: -82, lat: 40, kind: 'land' },
  { name: 'Amérique du Sud', lon: -60, lat: 2, kind: 'land' },
];

/** Noms de lieux en HTML, toujours nets, qui s'affichent selon le zoom. */
export class PlaceLabels {
  private els: { p: Place; el: HTMLDivElement }[] = [];
  private v = new THREE.Vector3();

  constructor(layer: HTMLElement) {
    for (const p of PLACES) {
      const el = document.createElement('div');
      el.className = `place place-${p.kind}`;
      el.textContent = p.name;
      layer.appendChild(el);
      this.els.push({ p, el });
    }
  }

  update(camera: THREE.Camera, w: number, h: number, dist: number) {
    for (const { p, el } of this.els) {
      // les grands noms de loin, les ports et îles de près
      const show =
        p.kind === 'ocean' ? dist > 9 : p.kind === 'land' ? dist > 14 : p.kind === 'sea' ? dist > 5 && dist < 45 : p.kind === 'island' ? dist < 40 : dist < 26;
      this.v.set(toX(p.lon), 0.08, toZ(p.lat)).project(camera);
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      if (!show || this.v.z > 1 || sx < -200 || sx > w + 200 || sy < -40 || sy > h + 40) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  setVisible(on: boolean) {
    for (const { el } of this.els) el.hidden = !on;
  }
}
