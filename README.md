# Sail Run — prototype

Jeu de course au large façon Virtual Regatta : tu es le skipper de ton IMOCA sur la **Route du Rhum –
Destination Guadeloupe 2026**, contre les 23 vrais engagés de la classe, dans le **vent réel** (prévisions GFS).
Trois courses d'entraînement à vent simulé restent disponibles.

## Lancer le jeu

Il faut Node.js 22 (ou 20.19 minimum).

```bash
npm install
npm run dev
```

Puis ouvrir l'adresse affichée (http://localhost:5173). Le terminal affiche aussi une adresse
« Network » : ouvre-la sur ton téléphone (même Wi-Fi) pour jouer sur mobile.

Autres commandes :

| Commande | Rôle |
| --- | --- |
| `npm run build` | vérifie les types et construit la version en ligne dans `dist/` (déployable sur Vercel tel quel) |
| `npm test` | teste la simulation : chaque course se termine, personne ne reste bloqué sur une côte, le garage est cohérent |
| `npm run wind` | met à jour l'instantané des prévisions GFS embarqué (`public/wind/gfs-snapshot.json`), utilisé quand Open-Meteo est injoignable |
| `npm run calibrate` | recalcule `src/data/calibration.json` (temps simulé de chaque bateau sur chaque course, ≈ 30 s) |

## Ce qu'il y a dedans

- **Temps réel, toujours** : la Route du Rhum suit le vrai calendrier (départ le 1er novembre 2026 à 13 h 02),
  les entraînements partent au moment où tu les lances. Avant le départ, un compte à rebours ; en arrivant en retard,
  tu pars de la ligne pendant que les autres ont déjà avancé. Pour tester vite : ajoute `?dev` à l'adresse,
  l'accélération du temps réapparaît.
- **Carte marine à l'échelle** (MapLibre) : imagerie NASA Blue Marble (terres et fonds marins), relief ombré et
  3D légère (tuiles d'altitude AWS Terrain, mer ramenée à 0 m), vraies côtes OpenStreetMap en zoom fort
  (tuiles OpenFreeMap), quadrillage des degrés, échelle en km ou milles, vent en traits qui filent.
- **Interface épurée** : à l'écran, seulement la boussole (on tourne la couronne, la trajectoire s'affiche,
  bouton OK juste en dessous) et le choix de voile. Le reste (prévisions, télémétrie, classement, skipper,
  polaire, relief, vue immersive, options) est derrière la barre d'icônes à droite.

- **Route du Rhum 2026, classe IMOCA** : départ au large de la pointe du Grouin le dimanche 1er novembre à 13 h 02,
  Cap Fréhel à laisser à bâbord, l'Atlantique, puis la côte sous le vent de Basse-Terre, la **bouée de Basse-Terre**
  et la ligne de Pointe-à-Pitre. Les marques s'affichent sur la carte ; l'arrivée ne compte qu'une fois les marques passées.
- **Les vrais engagés IMOCA** (liste d'octobre 2026) : Beyou, Goodchild, Simon, Beccaria, Herrmann, Dorange, Bonafous…
  Chacun avec la génération de son bateau (foiler récent, foiler, dérives droites) et un niveau de jeu : ce sont
  des estimations, à ajuster dans `src/data/fleet.ts`. Les bots ne parlent pas à la radio (ce sont de vraies personnes).
- **Vent réel** : prévisions GFS de la NOAA via l'API gratuite d'Open-Meteo, grille de 2,5° sur la zone de course,
  un pas toutes les 3 h sur 14 jours, rafraîchies toutes les 3 h et gardées en cache. Hors ligne : instantané embarqué.
  Au-delà des prévisions, le vent repasse en douceur sur le modèle simulé.
- **Polaire IMOCA à foils** (approchée d'après des polaires publiques) au lieu de la polaire générique.
- **Préparation au départ** : jeu de voiles, foils, centrage, préparation du skipper. Chaque choix est un compromis
  de quelques dixièmes de pour-cent ; la fiche affiche le temps de course simulé sur la vraie météo et le gain
  (ou la perte) en minutes par rapport à la configuration de série.
- **Télémétrie** : BSP, vitesse cible de la polaire et rendement, TWS/TWD/TWA, cap, VMG vers la marque,
  écart au leader, état des foils, prochaine marque, ETA du routage.
- **Sonde** : un clic (ou un tap) sur la carte pose un repère : vent, courant et houle réels à ce point
  (API marine d'Open-Meteo), distance et cap depuis ton bateau, angle au vent si tu y allais. Elle suit le
  curseur des prévisions. Échap ou la croix pour la retirer. Le courant est affiché, pas encore simulé.

- **3 courses** : Sprint des Açores (au près), Route des Alizés (vent arrière), Transat des Potes (mixte).
- **Garage au port**, façon écran de jeu : ton bateau plein écran au ponton d'un village départ façon diorama (IMOCA voisins, maisons pastel à volets sur la colline, arbres, rochers, tentes, pavillons, phare, banderole de la course), menu des pièces à gauche, fiche technique à droite, gros bouton de départ. En deux étapes : d'abord le bateau (voiles, foils, centrage, livrée), puis la préparation du skipper.
- **Interface de course** : position et distance restante en haut à gauche, classement à la demande, prévisions
  dans un onglet en haut à droite, radio VHF entre bateaux (icône en bas à droite), distances en km ou en milles.
- **Instruments de bord** : speedomètre à aiguille (avec la vitesse cible de la polaire), compas-anémomètre
  (rose des caps sous la ligne de foi, silhouette du bateau, vent, secteurs de près bâbord rouge / tribord vert,
  cap de la route conseillée), bandeau de cap à faire glisser comme sur VR (zone face au vent en rouge, vent en jaune),
  silhouettes des voiles avec un cadenas pour verrouiller la voile, jauge du skipper (forme, fatigue, sommeil).
- **Barre** : au cap fixe ou à angle au vent fixe (le cap suit alors les bascules), ou pilote qui suit la route conseillée.
  Une projection en pointillé montre où sera le bateau dans 2, 5, 12 et 24 h si on ne touche à rien.
- **3 voiles** : Foc (près), Code 0 (travers, fragile dans la brise), Spi (portant). L'étoile marque la meilleure,
  « Auto » change toute seule. Changer de voile coûte 15 min au ralenti. Le panneau **Polaire** trace la vitesse
  de chaque voile selon l'angle au vent et détaille d'où vient la vitesse actuelle.
- **Prévisions** : curseur sur 5 jours, lecture animée, traits de vent animés qui filent plus vite et brillent plus
  quand ça souffle (calque « Vent »), position prévue du bateau (rond jaune), et force / direction exactes
  du vent sous la souris (ou d'un tap sur mobile).
- **Énergie** : sous 25 %, le skipper est épuisé (−12 % de vitesse, manœuvres plus longues, plus de casse).
  Une sieste de 2 h rend environ 28 points, mais pendant qu'il dort personne ne règle les voiles et toucher la barre le réveille.
  Le bouton « ? » l'explique en jeu.
- **Temps** : de « temps réel » (la course continue quand le jeu est fermé, rattrapée au retour)
  à « 1 s = 2 h ». La course est sauvegardée dans le navigateur.
- **Carte en maquette relief** : vrai relief des terres (altitudes réelles, accentuées), côtes là où le terrain
  plonge sous l'eau, neige et roche selon l'altitude et la pente, creux ombrés, forêts plantées sur le relief,
  océan coloré par la vraie bathymétrie, traits de vent animés, nuages, jour et nuit selon l'heure réelle.
- **Vue immersive** (bouton « Immersif » ou touche I) : caméra au ras de l'eau autour de ton bateau, houle réelle
  selon la force et la direction du vent, moutons, sillage, embruns, bateau qui tangue et gîte, ciel et soleil
  selon l'heure, feux de navigation la nuit. Tous les concurrents sont visibles dans leur vraie direction
  (distance ramenée pour qu'on les voie), avec leur nom et leur vraie distance. Bateau en version détaillée
  (accastillage, gréement, lattes).

Les bots choisissent leur bateau plus ou moins bien (Léa est forte, Nico beaucoup moins) et prennent
des options de route différentes.

## Organisation du code

```
src/
  sim/        simulation pure, sans affichage (testée par vitest)
    geo.ts      projection, masque terre / mer, distances
    wind.ts     source de vent (modèle synthétique pour l'instant)
    boat.ts     polaire, vitesse, fatigue, avaries
    router.ts   cap optimal (VMG) en évitant les côtes, route conseillée
    race.ts     une course : bots, événements, tchat, sauvegarde
    solo.ts     course d'un bateau seul (calibration)
  data/       courses, pièces du garage, calibration, côtes (Natural Earth)
  render/     three.js : carte (océan, relief, ciel, nuages), vue immersive, bateau 3D, hangar du garage
  ui/         écrans en HTML : menu, garage, interface de course, instruments de bord
public/terrain/  textures de la carte (générées par scripts/build_terrain.py et scripts/build_hexes.py)
scripts/      calibration du garage et préparation des textures
```

## Données

- Carte de course : NASA Blue Marble Shaded Relief + Bathymetry (GIBS, domaine public), tuiles vectorielles
  OpenFreeMap / OpenMapTiles (© OpenStreetMap contributors, ODbL), altitudes AWS Terrain Tiles (Mapzen, SRTM, GEBCO).
- Côtes : Natural Earth 1:50m (domaine public), via le paquet `world-atlas`.
- Relief des terres : Natural Earth « shaded relief » (domaine public).
- Profondeur de l'océan : déduite de l'image ETOPO1 de la NOAA (domaine public).
- Biomes (forêts, déserts, neige) : NASA Blue Marble (domaine public).
- Relief et fonds marins : tuiles « Terrarium » d'AWS — Terrain tiles: Mapzen, SRTM, GEBCO, ETOPO1 —
  converties par `scripts/build_relief3d.py` en `public/terrain/height.png`.
- Les images viennent du paquet Python `basemap-data` ; `scripts/build_terrain.py` les découpe et
  `scripts/build_hexes.py` en tire les couleurs des continents et l'emplacement des montagnes, collines et forêts.

## Modèle 3D du bateau

Le bateau est codé (`src/render/boatModel.ts`), mais un modèle fait sous Blender ou Meshy le remplace dès qu'il est déposé dans `public/models/imoca.glb`. Glisser un `.glb` sur la page permet de l'essayer sans le publier. Noms des pièces, pivots, matériaux de livrée, UV et réglages d'export : voir [docs/MODELE-IMOCA.md](docs/MODELE-IMOCA.md). `npx tsx scripts/make_test_glb.ts` fabrique un gabarit conforme.

## Positions en direct

Le jeu sait recaler les concurrents sur leurs positions officielles (`src/sim/live.ts`) : il attend un JSON
`{ "at": ms, "positions": [{ "who": "Jérémie Beyou", "lat": 47.1, "lon": -6.2, "cog": 230, "sog": 18, "ts": ms }] }`
à l'adresse donnée par `VITE_LIVE_URL`. La cartographie officielle n'est en ligne qu'au départ : le petit relais
qui la lit et produit ce JSON reste à écrire à ce moment-là. Sans relais, les concurrents sont simulés.

## Prochaines étapes

1. **Météo servie par le jeu** : aujourd'hui chaque navigateur interroge Open-Meteo (limite gratuite ≈ 600 points
   par minute et usage non commercial). En multijoueur, tout le monde doit naviguer dans le même run GFS :
   un job planifié (toutes les 6 h) produit la grille et le jeu la lit sur son propre serveur.
2. **Multijoueur réel** : la simulation tourne déjà en pas de temps fixes et se sérialise. Il faut la faire
   tourner côté serveur (Supabase + une fonction planifiée par exemple) et ne garder dans le navigateur
   que l'affichage et les ordres (cap, sommeil, réparation).
3. **Vue immersive** : y montrer la vraie houle (prévisions de vagues) et les concurrents proches avec leur nom.
