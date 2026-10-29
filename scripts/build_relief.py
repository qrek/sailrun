"""
Relief réel de la zone de jeu : altitude des terres et profondeur des océans.

Source : tuiles « Terrarium » du jeu de données Terrain Tiles d'AWS (domaine ouvert, dérivé de
SRTM, GMTED, ETOPO1 et GEBCO ; attribution Mapzen / Tilezen). Téléchargées une fois dans un cache.

Sorties dans public/terrain/ :
    height.png   R,G = altitude sur 16 bits ((m + 11000) × 2), B = occlusion ambiante (creux plus sombres)
    depth.png    profondeur de l'océan pour l'eau (0 = haut-fond, 1 = grand fond), comme avant

    python scripts/build_relief.py
"""
import io
import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, map_coordinates

LONMIN, LONMAX, LATMIN, LATMAX = -95, 22, -12, 68
RES = 20  # pixels par degré
Z = 6  # niveau de zoom des tuiles (≈ 45 px par degré à l'équateur)
ROOT = os.path.join(os.path.dirname(__file__), '..')
CACHE = os.environ.get('TERRARIUM_CACHE', os.path.join(os.path.expanduser('~'), '.cache', 'terrarium'))
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
os.makedirs(CACHE, exist_ok=True)

N = 2 ** Z


def tx(lon):
    return (lon + 180) / 360 * N


def ty(lat):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * N


x0, x1 = int(math.floor(tx(LONMIN))), int(math.floor(tx(LONMAX)))
y0, y1 = int(math.floor(ty(LATMAX))), int(math.floor(ty(LATMIN)))
print(f'tuiles x {x0}..{x1}, y {y0}..{y1} ({(x1 - x0 + 1) * (y1 - y0 + 1)})')

mosaic = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.float32)
for y in range(y0, y1 + 1):
    for x in range(x0, x1 + 1):
        path = os.path.join(CACHE, f'{Z}_{x}_{y}.png')
        if not os.path.exists(path):
            with urllib.request.urlopen(URL.format(z=Z, x=x, y=y), timeout=30) as r:
                open(path, 'wb').write(r.read())
        a = np.asarray(Image.open(path).convert('RGB'), np.float32)
        e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
        mosaic[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = e
    sys.stdout.write('.')
    sys.stdout.flush()
print()

# reprojection Mercator -> grille lon/lat régulière
W = (LONMAX - LONMIN) * RES
H = (LATMAX - LATMIN) * RES
lon = LONMIN + (np.arange(W) + 0.5) / RES
lat = LATMAX - (np.arange(H) + 0.5) / RES
px = (np.array([tx(v) for v in lon]) - x0) * 256 - 0.5
py = (np.array([ty(v) for v in lat]) - y0) * 256 - 0.5
PX, PY = np.meshgrid(px, py)
elev = map_coordinates(mosaic, [PY, PX], order=1, mode='nearest').astype(np.float32)

# cohérence avec les côtes du jeu (le masque terre / mer de la simulation fait foi)
land = json.load(open(os.path.join(ROOT, 'src', 'data', 'land.json')))
m = Image.new('L', (W, H), 0)
d = ImageDraw.Draw(m)
for poly in land:
    for k, ring in enumerate(poly):
        pts = [((ring[i] - LONMIN) * RES, (LATMAX - ring[i + 1]) * RES) for i in range(0, len(ring), 2)]
        d.polygon(pts, fill=255 if k == 0 else 0)
landm = np.asarray(m, np.float32) / 255.0
# distance douce à la côte, pour des plages qui descendent sous l'eau
soft = gaussian_filter(landm, 1.2)
elev = np.where(landm > 0.5, np.maximum(elev, 2 + 30 * np.clip(soft - 0.5, 0, 0.5)), np.minimum(elev, -3 - 60 * np.clip(0.5 - soft, 0, 0.5)))
# lacs et dépressions de l'intérieur des terres : on remonte au niveau du sol
elev = np.where(landm > 0.5, np.maximum(elev, 1.0), elev)

# occlusion ambiante : un point plus bas que son voisinage reçoit moins de lumière
h = np.clip(elev, 0, None)
ao = np.clip(1 - (gaussian_filter(h, 6) - h) / 600, 0.45, 1)
ao = gaussian_filter(ao, 1)

# sous l'eau, seul le haut des pentes compte pour le terrain (le reste est caché par la mer) : ça allège le fichier
elev_t = np.maximum(elev, -400)
ao = np.where(elev_t < 0, 1, ao)
enc = np.clip(np.round((elev_t + 11000) * 2), 0, 65535).astype(np.uint32)
out = np.zeros((H, W, 3), np.uint8)
out[..., 0] = enc >> 8
out[..., 1] = enc & 255
out[..., 2] = np.clip(ao * 255, 0, 255).astype(np.uint8)
Image.fromarray(out, 'RGB').save(os.path.join(ROOT, 'public', 'terrain', 'height.png'), optimize=True)

# profondeur pour l'eau (même convention que l'ancien depth.png : 0 = haut-fond, 1 = grand fond)
dep = np.clip(-elev / 5200, 0, 1) ** 0.55
dep = np.where(landm > 0.5, 0, dep)
dep = gaussian_filter(dep, 0.8)
Image.fromarray(np.clip(dep * 255, 0, 255).astype(np.uint8), 'L').resize((1755, 1200), Image.LANCZOS).save(os.path.join(ROOT, 'public', 'terrain', 'depth.png'), optimize=True)

print('altitude max', float(elev.max()), 'profondeur max', float(elev.min()))
print('height.png', W, 'x', H)
