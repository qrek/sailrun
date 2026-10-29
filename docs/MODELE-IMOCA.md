# Modèle 3D de l'IMOCA — fiche technique

Le jeu charge `public/models/imoca.glb` s'il existe. Sinon il garde le bateau codé.
Pour essayer un modèle sans rien publier, glisse le fichier `.glb` sur la page du jeu (au garage, c'est le plus parlant) : il remplace le bateau jusqu'au rechargement de la page.

`scripts/make_test_glb.ts` fabrique un gabarit qui respecte toutes les règles ci-dessous (`npx tsx scripts/make_test_glb.ts sortie.glb`). Ouvre-le dans Blender pour voir les noms, les origines et les UV attendus.

## 1. Repère et échelle

| | Blender | glTF / jeu |
|---|---|---|
| Étrave (avant) | vers **+Y** | vers −Z |
| Haut du mât | vers **+Z** | vers +Y |
| Flottaison | **Z = 0** | y = 0 |
| Axe du bateau | X = 0 | x = 0 |

- Échelle réelle conseillée : 18,28 m de coque. Le jeu ramène la longueur de l'objet `hull` à 1, donc l'échelle exacte importe peu.
- Applique les transformations avant l'export (Ctrl+A → *All Transforms*) sur les maillages, **pas** sur les objets pivots listés au point 2 : leur origine doit rester à l'endroit indiqué.
- Si le modèle arrive couché sur l'axe X (export Meshy brut), le jeu le remet dans l'axe, mais l'étrave peut se retrouver à l'arrière : mieux vaut l'orienter dans Blender.

## 2. Objets nommés

Les noms ne tiennent pas compte des majuscules ni des suffixes `.001`.

| Nom | Contenu | Origine (pivot) | Ce que fait le jeu |
|---|---|---|---|
| `hull` | la coque seule | indifférente | sert de référence de longueur |
| `spar` | Empty parent du mât, du gréement, de `main` et `jib` | **pied de mât**, sur le pont | quête du mât (rotation avant/arrière) |
| `mast` | le tube du mât (enfant de `spar`) | indifférente | surbrillance « Mât » au garage |
| `main` | Empty parent de la grand-voile et de la bôme | **sur l'axe du mât**, au point d'amure | rotation autour de l'axe vertical (bordé), miroir d'une amure à l'autre |
| `jib` | Empty parent du foc | **point d'amure**, à l'étrave | rotation (bordé) et taille du foc selon le jeu de voiles |
| `foil_L`, `foil_R` | foil bâbord, foil tribord | **point de sortie de coque** | incidence et longueur (réglage « Incidence des foils ») |
| `foils_c`, `foils_grands`, `foils_derives` | *facultatif* : variantes d'appendices | indifférente | seule la variante choisie au garage est visible |

Le reste (pont, roof, cockpit, quille, bulbe, safrans, winchs…) peut porter n'importe quel nom.

## 3. Matériaux pilotés par la livrée

| Nom du matériau | Effet |
|---|---|
| `livery` | peinture complète de la coque : couleur, motif, filet et nom du bateau. Demande les UV du point 4 |
| `tint` | couleur unie de la coque choisie au garage (si tu préfères peindre toi-même les motifs) |
| `accent` | couleur secondaire (filet, liston, têtière) |
| `sail_main` | grand-voile avec nom et numéro de voile, lisible des deux bords. Demande les UV du point 4 |
| `sail_jib` | foc avec sa bande de couleur |
| `sail` | autres voiles : teinte du tissu (carbone, gris, blanc) |
| `foil` | foils (surbrillance au garage) |

Les autres matériaux sont gardés tels quels (texture de base, normal map, rugosité). Le jeu utilise le PBR métal/rugosité de glTF.

## 4. UV

**Coque (`livery`)** : une île rectangulaire par flanc, les deux superposées sur tout le carré 0–1 (ce que donne un modificateur *Mirror* appliqué après le dépliage).
- U = 0 à l'étrave, U = 1 au tableau arrière, sur les deux flancs ;
- V : liston (haut du flanc) **en haut** de l'éditeur UV, dessous de coque en bas ;
- la flottaison doit tomber vers 55 % de la hauteur en partant du bas (le jeu peint la ligne de flottaison et l'antifouling dans le bas de l'image).

**Grand-voile (`sail_main`)** : U = 0 au guindant (le long du mât) → 1 à la chute ; V : têtière en haut de l'éditeur UV, bordure (le long de la bôme) en bas.

## 5. Budget

- 40 000 à 80 000 triangles pour tout le bateau (Meshy sort souvent 300 000 : décime à ~0,15 avec *Decimate*, ou retopologise la coque).
- Textures en 2048 px maximum, JPEG pour la couleur, PNG pour les normal maps.
- Fichier final sous 10 Mo. La compression Draco est acceptée.

## 6. Export Blender

*Fichier → Exporter → glTF 2.0* :
- Format : **glTF Binary (.glb)** ;
- Inclure : *Selected Objects* si la scène contient autre chose ;
- Transformer : **+Y Up** coché ;
- Données → Maillage : *Apply Modifiers*, UV, normales ; Matériaux : *Export* ;
- Compression : Draco facultatif ;
- pas d'animation, pas de caméra ni de lumière.

Dépose ensuite le fichier dans `public/models/imoca.glb` et pousse : Vercel le met en ligne.
