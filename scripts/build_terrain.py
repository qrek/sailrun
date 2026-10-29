"""
Prépare les textures de la carte à partir de données du domaine public :
- Natural Earth « shaded relief » (couleurs et ombrage des terres)
- ETOPO1 (NOAA) en image colorée, dont on déduit une profondeur et une altitude approchées

Les images source viennent du paquet Python basemap-data :
    pip install basemap-data pillow numpy scipy
    python scripts/build_terrain.py

Sorties dans public/terrain/ :
    relief.jpg      couleurs des terres (zone de jeu)
    relief-s.jpg    version légère pour mobile
    elev.png        R = altitude des terres, G = profondeur de l'océan (0..255)
"""
import os
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
import mpl_toolkits.basemap_data as bmd

LONMIN, LONMAX, LATMIN, LATMAX = -95, 22, -12, 68
SRC = list(bmd.__path__)[0]
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'terrain')
os.makedirs(OUT, exist_ok=True)
Image.MAX_IMAGE_PIXELS = None


def crop(img):
    W, H = img.size
    x0 = (LONMIN + 180) / 360 * W
    x1 = (LONMAX + 180) / 360 * W
    y0 = (90 - LATMAX) / 180 * H
    y1 = (90 - LATMIN) / 180 * H
    return img.crop((round(x0), round(y0), round(x1), round(y1)))


# 1. couleurs des terres
sr = crop(Image.open(os.path.join(SRC, 'shadedrelief.jpg')).convert('RGB'))
sr.save(os.path.join(OUT, 'relief.jpg'), quality=86, optimize=True, progressive=True)
sr.resize((sr.width // 2, sr.height // 2), Image.LANCZOS).save(os.path.join(OUT, 'relief-s.jpg'), quality=84, optimize=True, progressive=True)
print('relief', sr.size)

# 2. profondeur approchée depuis la palette ETOPO1 (bleu foncé = profond, cyan clair = haut-fond)
import json
from PIL import ImageDraw
et_img = crop(Image.open(os.path.join(SRC, 'etopo1.jpg')).convert('RGB'))
W, H = et_img.size
et = np.asarray(et_img, dtype=np.float32) / 255.0
v = et.mean(-1)

# masque des terres à partir des mêmes côtes que le jeu
land = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'src', 'data', 'land.json')))
mask_img = Image.new('L', (W, H), 0)
d = ImageDraw.Draw(mask_img)
px = lambda lon: (lon - LONMIN) / (LONMAX - LONMIN) * W
py = lambda lat: (LATMAX - lat) / (LATMAX - LATMIN) * H
for poly in land:
    for k, ring in enumerate(poly):
        pts = [(px(ring[i]), py(ring[i + 1])) for i in range(0, len(ring), 2)]
        d.polygon(pts, fill=255 if k == 0 else 0)
landm = np.asarray(mask_img, dtype=np.float32) / 255.0

depth = np.clip(1.0 - (v - 0.2) / 0.62, 0, 1)
depth = depth ** 0.8
depth = depth * (1 - landm)
depth = gaussian_filter(depth, 1.4)
depth = depth * (1 - landm)
Image.fromarray(np.clip(depth * 255, 0, 255).astype(np.uint8), 'L').save(os.path.join(OUT, 'depth.png'), optimize=True)
print('depth', depth.shape)
