# Sémaphore

Une carte Home Assistant qui affiche vos caméras Frigate comme une scène 2.5D unique :
secteurs de vision projetés au sol, détections positionnées géographiquement,
étages empilables, et rejeu temporel qui pilote toute la scène.

![Sémaphore : étages séparés, secteurs de vision arrêtés par les murs, détections au sol](docs/semaphore.png)

*Le banc d'essai, en vue éclatée. Le fond beige est le style keyless de MapLibre —
sans clé MapTiler il n'y a ni imagerie ni bâtiments. Ce qu'on voit malgré tout :
les pièces extrudées, les cônes qui s'arrêtent net sur les murs plutôt que de les
traverser, et la traînée orange d'un objet suivi au sol.*

---

## Le parti pris

**Une caméra est un feu à secteurs.** Sur une carte marine, la couverture d'un phare
se dessine comme un secteur angulaire coloré : blanc quand la passe est libre, rouge
et vert quand elle ne l'est pas. Un champ de vision est le même objet — un coin
angulaire dont le sens change selon l'endroit où l'on se trouve dedans. Reprendre la
convention donne une palette qui *porte de l'information* au lieu de décorer, et
évite le fond noir + accent acide qu'on voit partout.

D'où le nom : un sémaphore est une station de guet côtière. La palette vient des
cartes du SHOM.

| Couleur | Rôle |
|---|---|
| `#F4E7BE` blanc de secteur | veille, rien à signaler |
| `#E2A23A` jaune de balise | mouvement non classifié |
| `#D9503C` rouge de secteur | objet détecté |
| `#2F9E6B` vert de secteur | flux dégradé |
| `#5B7285` ardoise | hors ligne |

---

## Les quatre décisions structurantes

### 1. Le cône tient compte des obstacles

Un cône théorique traverse les murs et ment sur la couverture réelle. `fov.ts`
calcule un **isovist** : on lance un rayon vers chaque sommet d'obstacle (plus un
échantillonnage régulier pour lisser l'arc), on garde la première intersection, et
le polygone obtenu s'arrête au mur.

Les obstacles viennent de deux sources : les emprises de bâtiments moissonnées dans
les tuiles vectorielles pour l'extérieur, et les murs déclarés en GeoJSON pour
chaque niveau intérieur.

Effet de bord heureux : ce polygone est **étoilé par rapport à l'apex** par
construction. Chaque sommet est l'extrémité d'un rayon partant de la caméra. Il se
triangule donc en éventail trivial — pas d'earcut, pas de géométrie CPU par frame.

### 2. Tous les secteurs dans un seul buffer, animés par shader

`gl/scene-layer.ts` empile tous les cônes dans **un buffer, un draw call**. Le
balayage, l'atténuation radiale, l'arc extérieur et l'assombrissement en mode focus
sont calculés dans le fragment shader à partir d'un uniform `u_time`.

Conséquence : passer une caméra de « veille » à « détection » n'upload rien de
géométrique, et un tableau de bord au repos n'envoie **aucun octet au GPU par
frame**. La géométrie n'est recalculée qu'au changement de config, de niveau, ou à
l'arrivée de nouvelles tuiles — quelques fois par session.

### 3. Les niveaux sont des quads texturés en altitude

La source `image` de MapLibre est soudée au sol, ce qui rend la vue éclatée
multi-étages impossible. `gl/plan-layer.ts` dessine chaque plan comme un quad
texturé à l'altitude voulue (~100 lignes). C'est ce qui débloque toute la moitié
intérieure de la carte : les étages se séparent verticalement, s'estompent
indépendamment, et partagent l'ordre de profondeur des secteurs.

Extérieur = niveau à l'élévation 0 sans plan, le fond de carte suffit.

### 4. Un seul tick, une seule boucle

Home Assistant émet ses changements d'état par rafales et Frigate publie une mise à
jour MQTT par frame suivie. Tout est replié dans **une passe à 10 Hz**
(`semaphore-card.ts::update_`). La boucle rAF, elle, n'existe que s'il y a une
raison : orbite en cours, plan en fondu, ou secteur en balayage. Quand tout se
stabilise, la boucle s'arrête.

S'y ajoutent un `IntersectionObserver` et `visibilitychange` : carte hors écran ou
onglet caché → boucle coupée, vignettes coupées.

---

## Deux gestes qui font l'ergonomie

**La vue épaule.** Cliquer sur une caméra place la caméra virtuelle *derrière* la
caméra physique : `bearing` = azimut, `pitch` 68°, recul proportionnel à la portée.
Le cap de la carte s'aligne sur le cap de l'objectif, et la relation entre l'image
et le terrain devient évidente sans un mot d'explication. Coût : un `easeTo`.

**Le blip au sol.** Frigate publie une bounding box ; le bas de cette box est
l'endroit où l'objet touche le sol, et le sol est un plan. Une homographie à
4 points (`homography.ts`) suffit donc à convertir la box en position
géographique. Une personne qui traverse le jardin devient un point qui traverse la
carte, avec sa traîne, relayé d'un cône à l'autre.

La calibration se fait une fois par caméra : 4 points dans l'image, 4 points sur la
carte.

---

## L'éditeur de plan

Bouton **Plan** dans le rail, en haut à gauche de la carte. Trois outils :

| Outil | Geste |
|---|---|
| Tracer une pièce | clic à chaque angle, double-clic ou Entrée pour fermer |
| Poser une caméra | clic pour l'emplacement, puis les poignées |
| Ajuster | tirer un sommet, Suppr pour effacer la sélection |

Deux poignées suffisent pour les trois nombres d'une caméra : la **rouge** fixe
le cap et la portée d'un seul geste, la **verte** ouvre ou ferme l'angle.

Les sommets s'aimantent entre eux sous 45 cm, donc deux pièces voisines
partagent réellement leur mur au lieu de laisser une fente par laquelle une
caméra verrait à travers.

Le bouton **Copier le YAML** met le bloc `levels` + `cameras` dans le
presse-papier, prêt à coller dans l'éditeur de carte Lovelace.

### Pourquoi des pièces vectorielles plutôt qu'un plan raster

Une pièce tracée sert **deux fois** : elle est extrudée en murs pour la lecture
2.5D, et aplatie en segments pour le lancer de rayons. Une seule géométrie, donc
l'image et le calcul de couverture ne peuvent jamais diverger — si vous
redressez un mur, le cône qu'il bloque se recalcule dans le même geste.

Les murs sortent en `fill-extrusion` native de MapLibre, qui gère déjà
`fill-extrusion-base` : un étage surélevé n'a besoin de rien de plus. Le plan
raster (`plan.url`) reste disponible comme calque de décalque sous les pièces,
le temps de les tracer.

---

## Configuration

```yaml
type: custom:semaphore-card
maptiler-api-key: VOTRE_CLE
map-style: hybrid          # hybrid | streets | topo | demo (sans clé, sans imagerie)
topic-prefix: frigate
timeline-hours: 24
decay-seconds: 12
orbit-speed: 0.9           # °/s au repos, 0 pour couper
orbit-resume: 6            # secondes d'immobilité avant que l'orbite reprenne
fov-resolution: 1.5        # pas angulaire de l'isovist, en degrés
box-format: auto           # auto | xyxy | xywh — voir « Si les blips atterrissent loin »
alert-labels: [person, car]

levels:
  - id: exterieur
    name: Extérieur
    elevation: 0
  - id: rdc
    name: Rez-de-chaussée
    elevation: 0.2
    plan:
      url: /local/semaphore/rdc.png
      corners:                       # TL, TR, BR, BL
        - [-2.75012, 47.66041]
        - [-2.74951, 47.66041]
        - [-2.74951, 47.66004]
        - [-2.75012, 47.66004]
    wallHeight: 2.6
    rooms:                           # tracées avec l'éditeur, pas à la main
      - id: rdc-1
        name: Salon
        ring:
          - [-2.7500100, 47.6603800]
          - [-2.7497400, 47.6603800]
          - [-2.7497400, 47.6602100]
          - [-2.7500100, 47.6602100]
      - id: rdc-2
        name: Cuisine
        transparent: true            # verrière : dessinée, mais transparente
        ring:
          - [-2.7497400, 47.6603800]
          - [-2.7495600, 47.6603800]
          - [-2.7495600, 47.6602100]
          - [-2.7497400, 47.6602100]

cameras:
  - name: allee
    label: Allée
    position: [-2.74996, 47.66018]
    level: exterieur
    height: 3.2
    azimuth: 212           # cap de l'objectif, 0 = nord
    fov: 96
    range: 28
    resolution: [1280, 720]
    calibration:
      image:  [[0.08, 0.62], [0.93, 0.60], [0.97, 0.98], [0.04, 0.99]]
      ground: [[-2.75004, 47.66009], [-2.74988, 47.66011],
               [-2.74990, 47.66016], [-2.75001, 47.66015]]

  - name: salon
    label: Salon
    position: [-2.74990, 47.66030]
    level: rdc
    height: 2.4
    azimuth: 45
    fov: 110
    range: 9
```

Le seul champ vraiment pénible à remplir à la main est `position` / `azimuth` /
`fov`. C'est ce que règle l'éditeur visuel — bouton **Plan**.

### Le minimum qui fonctionne

Une caméra n'a besoin que de deux champs. Le reste a des valeurs par défaut
(`azimuth: 0`, `fov: 90`, `range: 20`, `height: 3`) :

```yaml
type: custom:semaphore-card
maptiler-api-key: VOTRE_CLE
cameras:
  - name: allee                 # le nom Frigate, celui de frigate/<nom>/…
    position: [-2.74996, 47.66018]   # [longitude, latitude], dans cet ordre
```

`position` est **[longitude, latitude]** — l'inverse de ce que Google Maps
affiche quand on copie des coordonnées. Une caméra sans `position` est l'erreur
la plus courante ; la carte vous le dira en la nommant.

### Si les blips atterrissent loin de leur caméra

Le format du champ `box` publié par Frigate a changé selon les versions : deux
coins `[x1,y1,x2,y2]` ou un coin plus une taille `[x,y,w,h]`, en pixels ou déjà
normalisé. La carte devine, et se trompe forcément dans certains cas — le
symptôme est un blip à cent mètres de la caméra, ou aucun blip.

Regardez un vrai payload (`mosquitto_sub -t 'frigate/events'`) et forcez :

```yaml
box-format: xywh    # ou xyxy
```

Les pixels sont détectés seuls, à condition que `resolution` soit renseignée.

---

## Voir la carte sans Home Assistant

Un banc d'essai est inclus : la carte réelle tourne dans un navigateur ordinaire,
avec un faux Home Assistant qui rejoue des événements Frigate synthétiques (pistes
qui traversent la scène, secteurs qui s'allument, timeline qui se remplit).

```bash
npm install
npm run dev
```

Puis ouvrez `http://localhost:5173/`. **La clé MapTiler est optionnelle** : sans
elle, le banc bascule sur le style keyless de MapLibre — pas d'imagerie ni de
bâtiments, donc rien de plaçable, mais la scène, les secteurs, les blips,
l'éditeur et la timeline tournent tous.

Avec `?key=VOTRE_CLE_MAPTILER` vous obtenez la vraie scène. La clé est gratuite
et se garde ensuite en `localStorage`.

Dans `dev/main.ts`, changez `HOME` pour vos coordonnées : le fond de carte, les
emprises de bâtiments moissonnées et les positions de caméras suivent toutes.
`dev/mock-hass.ts` n'implémente que les trois choses que la carte touche
réellement — `states`, `connection.subscribeMessage` et `callWS`.

Ce qui ne marche pas hors HA : le flux vidéo du panneau focus (remplacé par une
image fixe) et les vraies vignettes `camera_proxy`.

---

## Installation via HACS

Poussez ce dossier sur un dépôt GitHub, puis créez un tag :

```bash
git tag v0.1.0 && git push --tags
```

Le workflow `release.yml` construit le bundle et l'attache à la release — c'est
là que HACS va le chercher pour les dépôts de type *plugin*, d'où le fait que
`dist/` reste hors du dépôt.

Ensuite, dans Home Assistant :

1. HACS → menu ⋮ → **Dépôts personnalisés**
2. URL du dépôt, catégorie **Dashboard**
3. Installer **Sémaphore**, puis recharger le navigateur
4. Ajouter la carte à un tableau de bord

La ressource Lovelace est déclarée automatiquement par HACS. Il faut une clé
MapTiler, gratuite : <https://www.maptiler.com/cloud/>

### Installation manuelle

```bash
npm install && npm run build
```

Copier `dist/semaphore.js` dans `<config>/www/community/semaphore/`, puis ajouter
la ressource `/local/community/semaphore/semaphore.js` en type `module`.

Prérequis côté Home Assistant : l'intégration **MQTT** configurée et Frigate publiant
sur le même broker. C'est indispensable — les binary sensors de l'intégration Frigate
disent *qu'il s'est passé quelque chose*, mais seul le payload `frigate/events` porte
la bounding box, et sans box il n'y a pas de blip.

---

## État

La carte est complète et **elle tourne** — mais elle n'a jamais été chargée dans
un vrai Home Assistant. Ce qui est vérifié, et comment :

| Vérification | Résultat |
|---|---|
| `tsc --noEmit` strict | passe |
| `vite build` | `dist/semaphore.js`, ~350 kB gzip (l'essentiel est MapLibre) |
| Rendu réel (Chromium headless, SwiftShader) | les deux programmes GLSL compilent, contexte WebGL vivant, aucune erreur console |
| Focus, niveaux, vue éclatée, éditeur, traçage d'une pièce, copie YAML, scrub | tout passe de bout en bout |
| MQTT → box → homographie → traînée | piste synthétique à moins de 10 m de sa caméra, déplacement conforme |
| Isovist | mur à 10 m → rayon bloqué à 10,00 m ; bord libre à 40,00 m ; sommet de silhouette au coin ; polygone trié angulairement ; ouverture respectée |
| Homographie | round-trip sous le micromètre ; quad dégénéré refusé |
| YAML | relu par `js-yaml` ; `Yes` et `12:30` quotés comme PyYAML l'exige |

Ce qui reste incertain tient au contrat Home Assistant / Frigate, pas au calcul :
la commande websocket `frigate/events/get`, le format exact de `after.box`, et
la disponibilité de `ha-camera-stream`. Chacun a un repli qui évite que l'échec
soit fatal — voir `CLAUDE.md`.

| Fichier | Rôle |
|---|---|
| `src/types.ts` | schéma de configuration et modèle runtime |
| `src/geo.ts` | plan tangent local en mètres |
| `src/fov.ts` | isovist avec occlusions |
| `src/homography.ts` | DLT 4 points, box → position au sol |
| `src/frigate.ts` | souscription MQTT, suivi des détections, URLs média |
| `src/gl/scene-layer.ts` | secteurs + blips, un draw call |
| `src/gl/plan-layer.ts` | plans d'étage texturés en altitude |
| `src/engine.ts` | orchestration MapLibre, niveaux, vols de caméra, boucle |
| `src/rooms.ts` | pièces → murs extrudés + occultants |
| `src/editor/plan-editor.ts` | traçage, poignées, aimantation |
| `src/editor/yaml.ts` | sérialiseur YAML minimal |
| `src/semaphore-card.ts` | carte Lit, chips, panneau focus, timeline, mode plan |
| `src/semaphore-card-css.ts` | styles de la carte |
| `dev/mock-hass.ts` | faux HA + générateur d'événements Frigate |
| `dev/main.ts` | scène de démonstration |

Volontairement laissé de côté, dans l'ordre où je le ferais :

1. **La calibration à 4 points dans l'éditeur** — placer les caméras se fait déjà
   à la souris, mais les 4 correspondances image ↔ sol qui donnent les blips au
   sol s'écrivent encore à la main. C'est le seul obstacle restant entre une
   config tracée à la souris et des détections positionnées.
2. **Le rejeu complet** — le curseur de timeline gèle déjà le temps du shader ;
   il reste à rejouer les trajectoires historiques et à caler la vidéo dessus.
3. **Éditeur Lovelace natif** (`getConfigElement`), pour écrire la config au lieu
   de copier du YAML.
4. **PTZ** — suivre la valeur de pan live plutôt que l'azimut fixe.
5. **Extrusion des murs intérieurs** à partir des `occluders`, pour que les étages
   aient une épaisseur visible en vue éclatée.
6. **Externaliser MapLibre** en import CDN pour ramener le bundle sous 60 kB.
7. **i18n** — les chaînes sont en français en dur dans `semaphore-card.ts`.

---

MIT.
