"""
Tuiles hexagonales des continents, façon jeu de stratégie.

Pour chaque hexagone de la carte on calcule :
- le biome (prairie, plaine, désert, toundra, neige, jungle) depuis Blue Marble (NASA, domaine public)
- le relief (plat, collines, montagnes) depuis l'ombrage Natural Earth et la palette ETOPO1
- la présence de forêt

Sortie : public/terrain/hex.png, une case par hexagone (lignes décalées, pointe en haut)
    R = 10 + 40 × biome      G = 10 + 100 × relief      B = 10 + 200 × forêt + 40 × terre

    pip install basemap-data pillow numpy
    python scripts/build_hexes.py
"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw
import mpl_toolkits.basemap_data as bmd

LONMIN, LONMAX, LATMIN, LATMAX = -95, 22, -12, 68
LON0, LAT0 = -37, 30
KX = math.cos(math.radians(30))
HEX_R = 0.4  # rayon de l'hexagone, en unités monde (1 = 1° de latitude)
RES = 15  # pixels par degré (résolution de Blue Marble)

SRC = list(bmd.__path__)[0]
ROOT = os.path.join(os.path.dirname(__file__), '..')
Image.MAX_IMAGE_PIXELS = None

W = (LONMAX - LONMIN) * RES
H = (LATMAX - LATMIN) * RES


def crop(name):
    img = Image.open(os.path.join(SRC, name)).convert('RGB')
    w, h = img.size
    box = (round((LONMIN + 180) / 360 * w), round((90 - LATMAX) / 180 * h), round((LONMAX + 180) / 360 * w), round((90 - LATMIN) / 180 * h))
    return np.asarray(img.crop(box).resize((W, H), Image.LANCZOS), dtype=np.float32) / 255.0


# masque des terres : mêmes côtes que le jeu
land = json.load(open(os.path.join(ROOT, 'src', 'data', 'land.json')))
m = Image.new('L', (W, H), 0)
d = ImageDraw.Draw(m)
for poly in land:
    for k, ring in enumerate(poly):
        pts = [((ring[i] - LONMIN) * RES, (LATMAX - ring[i + 1]) * RES) for i in range(0, len(ring), 2)]
        d.polygon(pts, fill=255 if k == 0 else 0)
landm = np.asarray(m) > 127

bm = crop('bmng.jpg')
sr = crop('shadedrelief.jpg')
et = crop('etopo1.jpg')

# grille hexagonale en coordonnées monde
S = math.sqrt(3) * HEX_R  # écart entre colonnes
DY = 1.5 * HEX_R  # écart entre lignes
X0 = (LONMIN - LON0) * KX
Z0 = -(LATMAX - LAT0)
COLS = int(math.ceil(((LONMAX - LONMIN) * KX) / S)) + 2
ROWS = int(math.ceil((LATMAX - LATMIN) / DY)) + 2
print('grille', COLS, 'x', ROWS)

lon = LONMIN + (np.arange(W) + 0.5) / RES
lat = LATMAX - (np.arange(H) + 0.5) / RES
X = ((lon - LON0) * KX)[None, :].repeat(H, 0)
Z = (-(lat - LAT0))[:, None].repeat(W, 1)


def nearest(X, Z):
    """Indice (col, ligne) de l'hexagone le plus proche, même calcul que le shader."""
    j0 = np.round((Z - Z0) / DY)
    best = np.full(X.shape, 1e9)
    bi = np.zeros(X.shape, np.int32)
    bj = np.zeros(X.shape, np.int32)
    for dj in (-1, 0, 1):
        j = j0 + dj
        off = np.where(np.mod(j, 2) == 1, S / 2, 0)
        i = np.round((X - X0 - off) / S)
        cx = X0 + i * S + off
        cz = Z0 + j * DY
        dd = (X - cx) ** 2 + (Z - cz) ** 2
        upd = dd < best
        best = np.where(upd, dd, best)
        bi = np.where(upd, i, bi).astype(np.int32)
        bj = np.where(upd, j, bj).astype(np.int32)
    return bi, bj


bi, bj = nearest(X, Z)
ok = (bi >= 0) & (bi < COLS) & (bj >= 0) & (bj < ROWS)
hid = np.where(ok, bj * COLS + bi, 0)
N = COLS * ROWS
L = landm & ok
idx = hid[L]


def agg(v):
    return np.bincount(idx, weights=v[L], minlength=N)


cnt = np.bincount(idx, minlength=N).astype(np.float32)
tot = np.bincount(hid[ok], minlength=N).astype(np.float32)
safe = np.maximum(cnt, 1)
r, g, b = (agg(bm[..., k]) / safe for k in range(3))
bright = (r + g + b) / 3
chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)

# rugosité : écart-type de l'ombrage (fort dans les montagnes)
lum = sr.mean(-1)
m1 = agg(lum) / safe
m2 = agg(lum * lum) / safe
rug = np.sqrt(np.maximum(0, m2 - m1 * m1))

# altitude approchée depuis la palette ETOPO1 : vert = bas, ocre = moyen, brun = haut, blanc = sommets
er, eg, eb = et[..., 0], et[..., 1], et[..., 2]
mx = np.maximum(np.maximum(er, eg), eb)
mn = np.minimum(np.minimum(er, eg), eb)
hue = np.zeros_like(er)
dlt = np.maximum(mx - mn, 1e-5)
hue = np.where(mx == er, ((eg - eb) / dlt) % 6, np.where(mx == eg, (eb - er) / dlt + 2, (er - eg) / dlt + 4)) * 60
sat = dlt / np.maximum(mx, 1e-5)
elev = np.where(hue > 70, 0.1, np.where(hue > 40, 0.35, 0.55 + (1 - mx) * 0.5))
elev = np.where((sat < 0.15) & (mx > 0.8), 0.9, elev)
el = agg(elev) / safe

frac = cnt / np.maximum(tot, 1)
isl = cnt > 0
row = np.arange(N) // COLS
clat = LATMAX - (row * DY) - 0  # z0 correspond à LATMAX
clat = LAT0 - (Z0 + row * DY)

# biomes : 0 prairie, 1 plaine, 2 désert, 3 toundra, 4 neige, 5 jungle
biome = np.zeros(N, np.int32)
biome[(r > g * 0.93)] = 1
biome[(r > g * 1.06) & (bright > 0.33)] = 2
biome[(np.abs(clat) > 56) & (biome < 2)] = 3
biome[(bright > 0.5) & (chroma < 0.14)] = 3  # pas de banquise : la neige reste sur les sommets
forest = (g > r * 1.06) & (bright < 0.19) & (biome != 4)
biome[forest & (np.abs(clat) < 20)] = 5
forest &= biome != 2

# relief : les hexagones les plus rugueux deviennent des montagnes, les suivants des collines
score = rug / max(1e-6, np.percentile(rug[isl & (frac > 0.4)], 95)) * 0.75 + el * 0.45
cand = isl & (frac > 0.45)
q_m = np.percentile(score[cand], 95)
q_h = np.percentile(score[cand], 80)
relief = np.zeros(N, np.int32)
relief[cand & (score >= q_h)] = 1
relief[cand & (score >= q_m)] = 2
forest &= relief < 2

print('terres', int(isl.sum()), 'montagnes', int((relief == 2).sum()), 'collines', int((relief == 1).sum()), 'forêts', int(forest.sum()))
print('biomes', np.bincount(biome[isl], minlength=6))

out = np.zeros((ROWS, COLS, 4), np.uint8)
out[..., 0] = (10 + 40 * biome).reshape(ROWS, COLS)
out[..., 1] = (10 + 100 * relief).reshape(ROWS, COLS)
out[..., 2] = (10 + 200 * forest + 40 * isl).reshape(ROWS, COLS)
out[..., 3] = 255
Image.fromarray(out, 'RGBA').save(os.path.join(ROOT, 'public', 'terrain', 'hex.png'), optimize=True)
json.dump({'r': HEX_R, 'cols': COLS, 'rows': ROWS}, open(os.path.join(ROOT, 'src', 'data', 'hexgrid.json'), 'w'))
print('ok')

# ---------- couleurs des terres, continues (sans tuiles) ----------
# même palette que les biomes, mais calculée pixel par pixel puis adoucie : un rendu « peint »
from scipy.ndimage import gaussian_filter

lm = landm.astype(np.float32)
den = np.maximum(gaussian_filter(lm, 1.6), 1e-3)
bms = np.stack([gaussian_filter(bm[..., k] * lm, 1.6) / den for k in range(3)], -1)  # moyenne sur les terres seules
R, G, B = bms[..., 0], bms[..., 1], bms[..., 2]
br = (R + G + B) / 3
ch = bms.max(-1) - bms.min(-1)
LAT = lat[:, None].repeat(W, 1)
sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))
pal = {
    # palette « diorama » : verts frais tirant sur le jaune, sable clair, roche gris clair
    'grass': np.array([0.55, 0.71, 0.34]),
    'plains': np.array([0.68, 0.71, 0.44]),
    'desert': np.array([0.90, 0.78, 0.56]),
    'tundra': np.array([0.62, 0.66, 0.52]),
    'snow': np.array([0.94, 0.96, 0.98]),
    'jungle': np.array([0.38, 0.62, 0.28]),
    'forest': np.array([0.38, 0.58, 0.29]),
    'rock': np.array([0.70, 0.70, 0.68]),
}
ratio = R / np.maximum(G, 1e-3)
w_pl = sm(0.88, 0.98, ratio)
w_de = sm(1.0, 1.12, ratio) * sm(0.28, 0.38, br)
w_fo = sm(1.0, 0.94, ratio) * sm(0.24, 0.17, br)
w_tu = sm(52, 60, np.abs(LAT))
w_sn = sm(0.45, 0.58, br) * sm(0.18, 0.1, ch) * 0  # pas de banquise : la neige reste sur les sommets
col = pal['grass'][None, None] * np.ones((H, W, 1))
col = col * (1 - w_pl[..., None]) + pal['plains'] * w_pl[..., None]
col = col * (1 - w_de[..., None]) + pal['desert'] * w_de[..., None]
fo = np.where(np.abs(LAT)[..., None] < 20, pal['jungle'], pal['forest'])
col = col * (1 - w_fo[..., None] * 0.8) + fo * (w_fo[..., None] * 0.8)
col = col * (1 - w_tu[..., None] * 0.6 * (1 - w_de[..., None])) + pal['tundra'] * (w_tu[..., None] * 0.6 * (1 - w_de[..., None]))
# massifs : ton rocheux là où le relief est marqué
lum_hp = lum - gaussian_filter(lum, 6)
rug_px = gaussian_filter(np.abs(lum_hp), 3)
w_ro = sm(np.percentile(rug_px[landm], 80), np.percentile(rug_px[landm], 97), rug_px)
col = col * (1 - w_ro[..., None] * 0.55) + pal['rock'] * (w_ro[..., None] * 0.55)
col = col * (1 - w_sn[..., None]) + pal['snow'] * w_sn[..., None]
col = np.stack([gaussian_filter(col[..., k], 0.8) for k in range(3)], -1)
img = Image.fromarray(np.clip(col * 255, 0, 255).astype(np.uint8), 'RGB')
img.save(os.path.join(ROOT, 'public', 'terrain', 'land.jpg'), quality=88, optimize=True)
print('land.jpg', img.size)
