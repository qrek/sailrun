import * as THREE from 'three';
import { D2R, LonLat, Rng, isLand, toX, toZ } from '../sim/geo';
import { WindSource } from '../sim/wind';

/** Texture de cumulus : amas de bulles douces, bord inférieur plus plat. */
function cloudTexture(seed: number): THREE.CanvasTexture {
  const rng = new Rng(seed);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 26; i++) {
    const x = 128 + (rng.next() - 0.5) * 150;
    const y = 140 + (rng.next() - 0.7) * 90;
    const r = 26 + rng.next() * 46;
    const grd = g.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r);
    const shade = 230 + Math.floor(rng.next() * 25);
    grd.addColorStop(0, `rgba(${shade},${shade},${shade + 4},0.85)`);
    grd.addColorStop(0.6, `rgba(${shade - 20},${shade - 14},${shade},0.45)`);
    grd.addColorStop(1, 'rgba(200,215,230,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // base plus sombre
  g.globalCompositeOperation = 'source-atop';
  const base = g.createLinearGradient(0, 120, 0, 230);
  base.addColorStop(0, 'rgba(120,140,165,0)');
  base.addColorStop(1, 'rgba(120,140,165,0.55)');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Cloud {
  sprite: THREE.Sprite;
  kind: 'low' | 'cu';
  lon: number;
  lat: number;
  a: number; // angle dans la spirale
  r: number; // rayon dans la spirale (degrés)
  base: number; // opacité de base
  size: number;
}

/**
 * Nuages : une spirale autour de la dépression et des petits cumulus d'alizé
 * qui dérivent avec le vent (à la vitesse du vent, en temps de course).
 */
export class Clouds {
  readonly group = new THREE.Group();
  private clouds: Cloud[] = [];
  private rng = new Rng(7);
  private lastT: number | null = null;

  constructor(small: boolean) {
    const textures = [cloudTexture(1), cloudTexture(2), cloudTexture(3)];
    const nLow = small ? 22 : 36;
    const nCu = small ? 22 : 40;
    for (let i = 0; i < nLow + nCu; i++) {
      const low = i < nLow;
      const mat = new THREE.SpriteMaterial({ map: textures[i % 3], transparent: true, depthWrite: false, fog: true, opacity: 0.9 });
      const sprite = new THREE.Sprite(mat);
      const size = low ? 2.2 + this.rng.next() * 3.2 : 0.9 + this.rng.next() * 1.4;
      sprite.scale.set(size, size * 0.5, 1);
      sprite.renderOrder = 5;
      this.group.add(sprite);
      const arm = i % 3;
      this.clouds.push({
        sprite,
        kind: low ? 'low' : 'cu',
        lon: -60 + this.rng.next() * 45,
        lat: 11 + this.rng.next() * 16,
        a: arm * ((Math.PI * 2) / 3) + this.rng.next() * 1.4,
        r: 1 + this.rng.next() * 9,
        base: low ? 0.7 : 0.55,
        size,
      });
    }
  }

  update(wind: WindSource, t: number, day: number, focus: LonLat, camDist: number) {
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(6, t - this.lastT));
    this.lastT = t;
    const sys = wind.systems?.(t);
    const night = new THREE.Color(0.28, 0.32, 0.42);
    const tint = night.lerp(new THREE.Color(1, 1, 1), day);
    const near = Math.min(1, Math.max(0, (camDist - 4) / 5));
    const fx = toX(focus[0]);
    const fz = toZ(focus[1]);
    for (const c of this.clouds) {
      let x: number;
      let z: number;
      let y: number;
      if (c.kind === 'low') {
        if (!sys) {
          c.sprite.visible = false;
          continue;
        }
        // spirale anti-horaire qui s'enroule vers le centre
        const ang = c.a + t * 0.015 + c.r * 0.35;
        const lon = sys.low[0] + (Math.cos(ang) * c.r) / Math.cos(sys.low[1] * D2R);
        const lat = sys.low[1] + Math.sin(ang) * c.r * 0.8;
        x = toX(lon);
        z = toZ(lat);
        y = 1.6 + (c.r / 10) * 0.8;
      } else {
        const w = wind.at(c.lon, c.lat, t);
        c.lon += (w[0] * dt) / 60 / Math.cos(c.lat * D2R);
        c.lat += (w[1] * dt) / 60;
        if (c.lon < -62 || c.lat < 9 || c.lat > 30 || isLand(c.lon, c.lat)) {
          c.lon = -20 - this.rng.next() * 12;
          c.lat = 12 + this.rng.next() * 16;
        }
        x = toX(c.lon);
        z = toZ(c.lat);
        y = 0.9 + c.size * 0.2;
      }
      c.sprite.visible = true;
      c.sprite.position.set(x, y, z);
      // on évite de masquer son propre bateau
      const dFocus = Math.hypot(x - fx, z - fz);
      const clear = Math.min(1, Math.max(0, (dFocus - 0.6) / 1.4));
      const mat = c.sprite.material as THREE.SpriteMaterial;
      mat.opacity = c.base * near * (0.35 + 0.65 * clear);
      mat.color.copy(tint);
    }
  }
}

