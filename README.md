# Sémaphore

Une carte Home Assistant qui dessine **le plan de votre maison en 2.5D** — murs,
pièces, portes — et y projette la couverture réelle de vos caméras Frigate.

Pas de fond de carte. Pas de compte à créer. Tout se dessine à la souris, en
mètres, sur une grille.

![Sémaphore : plan en 2.5D, cônes de vision arrêtés par les murs](docs/semaphore.png)

---

## Le parti pris

**Une caméra est un feu à secteurs.** Sur une carte marine, la couverture d'un
phare se dessine comme un secteur angulaire coloré : blanc quand la passe est
libre, rouge et vert quand elle ne l'est pas. Un champ de vision est le même
objet. Reprendre la convention donne une palette qui *porte de l'information* au
lieu de décorer.

D'où le nom : un sémaphore est une station de guet côtière.

| Couleur | Rôle |
|---|---|
| `#F4E7BE` blanc de secteur | veille, rien à signaler |
| `#E2A23A` jaune de balise | mouvement non classifié |
| `#D9503C` rouge de secteur | objet détecté |
| `#2F9E6B` vert de secteur | flux dégradé |
| `#5B7285` ardoise | hors ligne |

---

## Les quatre décisions structurantes

### 1. Un mur est décrit une fois et servi deux fois

Chaque mur est extrudé en faces pour l'image **et** aplati en segments pour le
lancer de rayons. Une porte se soustrait des deux dans la même passe. Il n'y a
donc pas deux géométries qui pourraient diverger : si vous redressez un mur, le
cône qu'il bloque se recalcule dans le même geste.

Conséquence directe : **une caméra voit à travers une porte ouverte**, parce que
l'ouverture est un trou dans la ligne de vue autant que dans la maçonnerie. Une
ouverture peut être marquée opaque si ce n'est pas ce que vous voulez.

### 2. Les pièces ne portent pas les murs

Une pièce est une dalle, un nom et une surface. Tout ce qui bloque la vue vit
dans les murs. C'est ce qui permet un mur isolé, une cloison qui s'arrête au
milieu d'une pièce, une haie, un muret de terrasse — des choses qui n'enferment
rien et qu'un modèle « pièce = contour fermé » ne sait pas exprimer.

### 3. La projection est orthographique, pas en perspective

Une perspective est plus jolie sur une capture d'écran et hostile au dessin :
les parallèles convergent, la grille change de pas selon l'endroit, et retrouver
le point du monde sous le curseur demande un lancer de rayon.

En orthographique, un mètre fait le même nombre de pixels partout, la grille
reste une grille, et l'inverse écran → monde est une forme close exacte. On
clique un point, on obtient ce point. Le pitch 0 donne un plan à plat pour
tracer ; le pitch 45 donne la lecture 2.5D. C'est la même caméra, sans
changement de mode.

### 4. Canvas 2D, pas WebGL

Une maison fait quelques centaines de polygones. Le GPU n'apportait rien et
coûtait le texte net, le hit-testing simple, et 310 kB de MapLibre. Le bundle
complet fait **40 kB gzip**, sans autre dépendance que Lit.

---

## L'éditeur de plan

Bouton **Plan** dans le rail. La vue s'aplatit, la grille apparaît, la couverture
s'estompe pour ne pas masquer ce que vous tracez.

| Outil | Raccourci | Geste |
|---|---|---|
| Sélection | `G` | tirer un sommet, un mur, une caméra. Suppr efface |
| Mur | `M` | cliquer chaque angle ; chaque segment devient un mur |
| Pièce | `P` | cliquer le contour, double-clic ou Entrée pour fermer |
| Ouverture | `O` | cliquer sur un mur pour y percer une porte |
| Caméra | `C` | cliquer l'emplacement, puis tirer les poignées |

**Ce qui rend le tracé praticable :**

- **Accrochage hiérarchisé** : un sommet existant l'emporte sur une arête de
  mur, qui l'emporte sur le verrou d'angle, qui l'emporte sur la grille. Le plus
  spécifique que vous pouviez vouloir gagne. `Maj` libère tout.
- **Verrou d'angle** à 15°, avec une tolérance exprimée en pixels et non en
  degrés — sinon le verrou est inéchappable près du point de départ et inutile
  à trois mètres.
- **Cote en direct** pendant le tracé, et **saisie au clavier** : tapez `4.2`
  puis Entrée et le mur fait exactement 4,20 m, dans la direction que vise le
  curseur.
- **Annuler / refaire** (`Ctrl+Z` / `Ctrl+Y`), un geste = une annulation.
- **Grille réglable** : 10, 25, 50 cm ou 1 m.
- **Inspecteur numérique** : longueur, épaisseur, hauteur d'un mur ; largeur,
  allège, linteau et type d'une ouverture ; cap, ouverture, portée d'une caméra.
- **Murs autour** : entoure une pièce tracée de ses quatre murs en un clic.

![Le mode Plan : vue à plat, grille, cote en direct et verrou d'angle](docs/editeur.png)

Navigation : molette pour zoomer, clic droit glissé pour pivoter et incliner,
`Alt` ou clic milieu pour déplacer.

Le bouton **Copier le YAML** met le bloc `levels` + `cameras` dans le
presse-papier. Si Home Assistant tourne en HTTP simple — où l'API presse-papier
n'existe pas — le bloc s'affiche pour sélection manuelle plutôt que d'échouer en
silence.

---

## Le blip au sol

Frigate publie une bounding box ; le bas de cette box est l'endroit où l'objet
touche le sol, et le sol est un plan. Une homographie à 4 points suffit donc à
convertir la box en position sur le plan. Une personne qui traverse l'entrée
devient un point qui traverse votre plan, avec sa traînée.

La calibration se fait une fois par caméra : 4 points dans l'image, 4 points sur
le plan.

---

## Configuration

Le minimum qui fonctionne — une caméra n'a besoin que d'un nom et d'une
position :

```yaml
type: custom:semaphore-card
cameras:
  - name: entree            # le nom Frigate, celui de frigate/<nom>/…
    position: [2.4, 0.4]    # en mètres, sur votre plan
```

Le reste a des valeurs par défaut (`azimuth: 0`, `fov: 90`, `range: 8`,
`height: 2.6`). En pratique vous ne l'écrirez pas à la main : dessinez avec le
mode Plan, puis **Copier le YAML**.

<details>
<summary>Configuration complète</summary>

```yaml
type: custom:semaphore-card
grid: 0.5                  # pas de la grille, en mètres
topic-prefix: frigate
timeline-hours: 24
decay-seconds: 12
box-format: auto           # auto | xyxy | xywh
alert-labels: [person, car]

levels:
  - id: rdc
    name: Rez-de-chaussée
    elevation: 0
    wallHeight: 2.5
    walls:
      - id: mur-facade
        a: [0, 0]
        b: [9, 0]
        thickness: 0.2
        openings:
          - id: porte-entree
            kind: door       # door | window | pass
            at: 3.6          # mètres depuis le point a
            width: 1
            head: 2.1
      - { id: mur-est, a: [9, 0], b: [9, 7] }
    rooms:
      - id: salon
        name: Salon
        ring: [[5, 0], [9, 0], [9, 7], [5, 7]]

  - id: etage
    name: Étage
    elevation: 2.7
    wallHeight: 2.4
    walls: []

cameras:
  - name: entree
    label: Entrée
    position: [2.4, 0.4]
    level: rdc
    height: 2.3
    azimuth: 20            # cap de l'objectif, 0 = +y, sens horaire
    fov: 100
    range: 9
    resolution: [1280, 720]
    calibration:
      image:  [[0.08, 0.55], [0.92, 0.55], [0.98, 0.99], [0.02, 0.99]]
      ground: [[0.6, 3.6], [4.4, 3.6], [3.6, 1.0], [1.4, 1.0]]
```
</details>

### Vous veniez de la version cartographique ?

Les configs contenant `maptiler-api-key` sont **converties automatiquement** :
les coordonnées passent en mètres, la première caméra devient l'origine, et les
contours de pièces gagnent les murs qu'ils sous-entendaient. Un bandeau vous le
signale. Ouvrez **Plan**, vérifiez, puis **Copier le YAML** pour figer la
conversion.

### Si les blips atterrissent loin de leur caméra

Le format du champ `box` de Frigate a changé selon les versions : deux coins
`[x1,y1,x2,y2]` ou un coin plus une taille `[x,y,w,h]`, en pixels ou déjà
normalisé. La carte devine, et se trompe forcément dans certains cas.

Regardez un vrai payload (`mosquitto_sub -t 'frigate/events'`) et forcez :

```yaml
box-format: xywh    # ou xyxy
```

---

## Voir la carte sans Home Assistant

```bash
npm install
npm run dev
```

Puis `http://localhost:5173/`. **Aucune clé, aucun compte.** Le banc d'essai fait
tourner la vraie carte avec un faux Home Assistant qui rejoue des événements
Frigate synthétiques. `dev/main.ts` décrit une maison de 9 × 7 m sur deux
niveaux — modifiez-la, ou dessinez la vôtre.

Ce qui ne marche pas hors HA : le flux vidéo du panneau focus et les vraies
vignettes `camera_proxy`.

---

## Installation via HACS

1. HACS → menu ⋮ → **Dépôts personnalisés**
2. URL du dépôt, catégorie **Dashboard**
3. Installer **Sémaphore**, puis recharger le navigateur (Ctrl+F5)
4. Ajouter la carte à un tableau de bord

### Installation manuelle

```bash
npm install && npm run build
```

Copier `dist/semaphore.js` dans `<config>/www/community/semaphore/`, puis
ajouter la ressource `/local/community/semaphore/semaphore.js` en type `module`.

Prérequis côté Home Assistant : l'intégration **MQTT** configurée et Frigate
publiant sur le même broker. Les binary sensors de l'intégration Frigate disent
*qu'il s'est passé quelque chose*, mais seul le payload `frigate/events` porte la
bounding box — et sans box il n'y a pas de blip. Sans MQTT la carte dessine quand
même le plan, elle n'allume simplement jamais de secteur.

---

## État

La carte est complète et **elle tourne** — mais elle n'a jamais été chargée dans
un vrai Home Assistant.

| Vérification | Résultat |
|---|---|
| `tsc --noEmit` strict | passe |
| `vite build` | `dist/semaphore.js`, **40 kB gzip** |
| Rendu réel (Chromium headless) | le canvas se peint, aucune erreur console |
| Éditeur de bout en bout | chaîne de murs, longueur tapée (4,20 m → 4,200 m), annuler/refaire au geste près, percement d'une porte, copie YAML |
| MQTT → box → homographie → traînée | piste synthétique conforme |
| 45 contrôles numériques | ouvertures et ligne de vue, `project`/`unproject` exactement inverses, hiérarchie d'accrochage, migration en mètres, YAML relu par `js-yaml` |

Ce qui reste incertain tient au contrat Home Assistant / Frigate, pas au calcul :
la commande websocket `frigate/events/get`, le format exact de `after.box`, et la
disponibilité de `ha-camera-stream`. Chacun a un repli qui évite que l'échec soit
fatal — voir `CLAUDE.md`.

**Défauts connus** : les chips de caméra peuvent recouvrir les libellés de pièce
(deux calques, aucune détection de collision) ; le mode focus recadre la vue mais
ne la restaure pas en sortant.

### Volontairement laissé de côté

1. **La calibration à 4 points dans l'éditeur** — placer les caméras se fait à la
   souris, mais les correspondances image ↔ sol s'écrivent encore à la main.
2. **Le calque de décalque** — modélisé, rendu et sérialisé ; il manque l'entrée
   d'URL et le geste « tracer une longueur connue » dans l'interface.
3. **Le rejeu complet** — le curseur gèle déjà le temps de la scène ; il reste à
   rejouer les trajectoires historiques.
4. **L'éditeur Lovelace natif** (`getConfigElement`).
5. **Escaliers et trémies**, pour que deux niveaux se lisent comme un volume.
6. **PTZ** et **i18n**.

---

MIT.
