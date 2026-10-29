"""
Relief 3D de la carte à partir des vraies altitudes (terres et fonds marins).

Source : tuiles « Terrarium » publiques d'AWS (Mapzen / Tilezen, dérivées de SRTM, GEBCO, ETOPO1,
NED…), attribution requise : « Terrain tiles: Mapzen, SRTM, GEBCO, ETOPO1 ».

Sorties dans public/terrain/ :
    height.png   R,G = altitude sur 16 bits ((m + 11000) × 2), B = occlusion ambiante (creux sombres)
    height-s.png la même en moitié de résolution, pour téléphone
    depth.png    profondeur de l'océan pour la couleur de l'eau (0 = haut-fond, 255 = grand fond)

    pip install pillow numpy scipy
    python scripts/build_relief3d.py
"""
import io
import json
import math
import os
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, map_coordinates

LONMIN, LONMAX, LATMIN, LATMAX = -95, 22, -12, 68
RES = 20  # pixels par degré
Z = 6  # niveau de zoom des tuiles (≈ 45 px par degré à l'équateur)
ROOT = os.path.join(os.path.dirname(__file__), '..')
CACHE = os.environ.get('TERRAIN_CACHE', os.path.join(ROOT, '.terrain-cache'))
os.makedirs(CACHE, exist_ok=True)

W = (LONMAX - LONMIN) * RES
H = (LATMAX - LATMIN) * RES


def tile_xy(lon, lat):
    n = 2 ** Z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch(x, y):
    p = os.path.join(CACHE, f'{Z}_{x}_{y}.png')
    if not os.path.exists(p):
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png'
        with urllib.request.urlopen(url, timeout=60) as r:
            open(p, 'wb').write(r.read())
    a = np.asarray(Image.open(p).convert('RGB'), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


x0, y0 = tile_xy(LONMIN, LATMAX)
x1, y1 = tile_xy(LONMAX, LATMIN)
tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
print('tuiles', tx1 - tx0 + 1, 'x', ty1 - ty0 + 1)
mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256))
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = fetch(tx, ty)

# reprojection Mercator -> grille lon/lat régulière
lon = LONMIN + (np.arange(W) + 0.5) / RES
lat = LATMAX - (np.arange(H) + 0.5) / RES
LON, LAT = np.meshgrid(lon, lat)
n = 2 ** Z
px = ((LON + 180) / 360 * n - tx0) * 256 - 0.5
py = ((1 - np.log(np.tan(np.radians(LAT)) + 1 / np.cos(np.radians(LAT))) / np.pi) / 2 * n - ty0) * 256 - 0.5
elev = map_coordinates(mosaic, [py, px], order=1, mode='nearest')

# cohérence avec les côtes du jeu (la simulation utilise ces polygones)
land = json.load(open(os.path.join(ROOT, 'src', 'data', 'land.json')))
m = Image.new('L', (W, H), 0)
d = ImageDraw.Draw(m)
for poly in land:
    for k, ring in enumerate(poly):
        pts = [((ring[i] - LONMIN) * RES, (LATMAX - ring[i + 1]) * RES) for i in range(0, len(ring), 2)]
        d.polygon(pts, fill=255 if k == 0 else 0)
landm = np.asarray(m) > 127
# terre : au moins quelques mètres ; mer : au moins quelques mètres de fond
elev = np.where(landm, np.maximum(elev, 4.0), np.minimum(elev, -6.0))
# lissage léger hors des côtes pour éviter le bruit des tuiles
soft = gaussian_filter(elev, 0.7)
elev = np.where(landm, np.maximum(soft, 4.0), np.minimum(soft, -6.0))

# occlusion ambiante : un point plus bas que son voisinage reçoit moins de lumière
hl = np.maximum(elev, 0)
ao = np.zeros_like(hl)
for s, w in ((2, 0.5), (6, 0.35), (16, 0.15)):
    ao += w * np.clip((gaussian_filter(hl, s) - hl) / 600.0, 0, 1)
ao = 1 - np.clip(ao * 1.6, 0, 0.75)

enc = np.clip(np.round((elev + 11000) * 2), 0, 65535).astype(np.uint32)
out = np.zeros((H, W, 3), np.uint8)
out[..., 0] = enc >> 8
out[..., 1] = enc & 255
out[..., 2] = np.clip(ao * 255, 0, 255).astype(np.uint8)
Image.fromarray(out, 'RGB').save(os.path.join(ROOT, 'public', 'terrain', 'height.png'), optimize=True)
# version légère pour téléphone (moitié de la résolution)
e2 = elev.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
ao2 = ao.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
enc2 = np.clip(np.round((e2 + 11000) * 2), 0, 65535).astype(np.uint32)
out2 = np.zeros((H // 2, W // 2, 3), np.uint8)
out2[..., 0] = enc2 >> 8
out2[..., 1] = enc2 & 255
out2[..., 2] = np.clip(ao2 * 255, 0, 255).astype(np.uint8)
Image.fromarray(out2, 'RGB').save(os.path.join(ROOT, 'public', 'terrain', 'height-s.png'), optimize=True)

# profondeur pour l'eau (même convention que l'ancienne : 0 haut-fond, 1 grand fond, terres à 0)
dep = np.clip(-elev / 5200.0, 0, 1) ** 0.55
dep = np.where(landm, 0, dep)
Image.fromarray((dep * 255).astype(np.uint8), 'L').save(os.path.join(ROOT, 'public', 'terrain', 'depth.png'), optimize=True)

print('altitude', int(elev.min()), 'à', int(elev.max()), 'm ; terres', round(landm.mean() * 100), '%')
print('ok', W, 'x', H)
