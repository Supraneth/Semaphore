# Sémaphore

Carte Lovelace Home Assistant : le plan de votre maison en 2.5D — murs, pièces,
portes — avec la couverture réelle de vos caméras Frigate dessinée par-dessus,
comme des **feux à secteurs** de carte marine.

Pas de fond cartographique. Tout est en **mètres**, dans un repère local dont
l'origine est là où vous décidez que se trouve le coin de la maison.

Inspiration de départ : [Helios](https://github.com/ReikanYsora/Helios) pour le
style 2.5D. Sémaphore en diverge sur deux points assumés — Helios est
auto-configuré et garde un fond de carte ; ici on dessine son plan, et il n'y a
pas de carte. Utilisateur en Bretagne, d'où la métaphore nautique.

## État

Complet et exécuté — mais jamais dans un vrai Home Assistant.

Vérifié mécaniquement :

- `tsc --noEmit` strict passe, `vite build` produit `dist/semaphore.js`
  (~33 kB gzip — plus aucune dépendance runtime hors Lit, et plus d'éditeur).
- **La carte se manipule** : glisser pivote, molette et pincement zooment, le
  pincement ne fait pas tourner, et plus aucun préréglage ne s'attribue un angle
  trouvé à la main. Vérifié en pilotant de vrais événements souris et tactiles.
- Les murs sont opaques : le dessus d'un mur mesure exactement `#EFE7D4`.
- Une couleur par caméra teinte bien le secteur au repos.
- **La timeline est vérifiée sur ce qu'elle affiche** : pistes nommées, axe des
  heures, un repère par événement portant étiquette / heure / durée, largeur
  minimale respectée pour un événement de 5 s, curseur à l'heure exacte, clic
  ouvrant l'événement dans le panneau, fenêtre vide annoncée.
- Le format tient : proportion par défaut et réglée, hauteur en pixels, plafond,
  et une cellule de grille qui l'emporte sur tout le reste.
- **L'éditeur autonome tourne**, piloté en Chromium headless via CDP : tracé
  d'une chaîne de murs, longueur au clavier, annuler/refaire, pose puis
  annulation d'une caméra, ajout et duplication de niveau (identifiants tous
  régénérés), import d'un YAML écrit à la main — flow maps, commentaires,
  accents, séquences à fleur de clé —, refus d'un YAML fautif en nommant la
  ligne sans toucher au plan affiché, persistance après rechargement, export
  relu. Aucune exception, console propre.
- L'aller-retour `cardYaml` → `parseYaml` → `validateConfig` est un point fixe.
- **Le cadrage est vérifié dans les conditions de Home Assistant** : une carte
  créée dans un conteneur de 0 × 0 puis dimensionnée se cadre sur le bâtiment ;
  une config portant sa propre `view` reste où elle est.
- Volume de couverture et mât peints à 45°, absents à plat ; les trois
  préréglages appliquent bien inclinaison **et** lacet.
- La carte **rend réellement** : testée dans un Chromium headless. Le canvas se
  peint, les chips se positionnent, la timeline se remplit, aucune erreur
  console.
- L'éditeur passe de bout en bout : tracé d'une chaîne de murs, longueur tapée
  au clavier (4,20 m demandé → 4,200 m obtenu), annuler/refaire au geste près,
  percement d'une porte, copie YAML.
- Le chemin Frigate est testé hors navigateur : MQTT → heuristique de box →
  homographie → traînée.
- 45 contrôles numériques : une porte est un trou dans la ligne de vue autant
  que dans le mur, une ouverture marquée opaque bloque à nouveau,
  `project`/`unproject` sont exactement inverses, l'accrochage respecte sa
  hiérarchie, la migration depuis l'ancienne config géographique rend les bonnes
  dimensions en mètres, et le YAML émis relu par `js-yaml` redonne la même
  géométrie.

Ce qui reste non vérifié est listé plus bas — c'est du contrat Home Assistant,
pas du calcul.

## Stack

Lit 3 · TypeScript strict · Canvas 2D · Vite 5. **Aucune** autre dépendance
runtime. MapLibre a été retiré : sans fond de carte il ne servait plus à rien et
coûtait 310 kB gzip.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/types.ts` | modèle de scène en mètres : murs, ouvertures, pièces, niveaux |
| `src/config.ts` | validation nommant l'entrée fautive + migration depuis lng/lat |
| `src/fov.ts` | isovist avec occlusions |
| `src/homography.ts` | DLT 4 points, bbox Frigate → position sur le plan |
| `src/frigate.ts` | souscription MQTT, suivi des détections, URLs média |
| `src/theme.ts` | palette carte marine, styles d'état, tempos |
| `src/plan/view.ts` | caméra 2.5D orthographique, `project` / `unproject` exacts, `VIEW_PRESETS` |
| `src/plan/controls.ts` | pivoter, zoomer, déplacer hors édition — souris et tactile |
| `src/plan/geometry.ts` | murs → faces et → occultants, ouvertures, aires |
| `src/plan/renderer.ts` | tout le rendu, Canvas 2D, algorithme du peintre |
| `src/plan/editor.ts` | outils, accrochage, saisie clavier, glisser-déposer |
| `src/plan/snap.ts` | hiérarchie d'accrochage : sommet > arête > angle > grille |
| `src/plan/history.ts` | annuler/refaire par instantanés |
| `src/plan/scene.ts` | orchestration, isovists, boucle rAF |
| `src/plan/yaml.ts` | sérialiseur YAML minimal (pas de js-yaml) |
| `src/semaphore-card.ts` | carte Lit : rail, outils, inspecteur, timeline |
| `src/semaphore-card-css.ts` | styles de la carte |
| `studio/studio.ts` | éditeur autonome : rail d'outils, niveaux, inspecteur, options, contrôles |
| `studio/studio-css.ts` | styles de l'éditeur (palette carte marine assumée, pas de variables HA) |
| `studio/project.ts` | page blanche, maison d'exemple, sauvegarde locale, import, contrôles |
| `studio/yaml-parse.ts` | lecteur YAML, sous-ensemble suffisant pour une config Lovelace |
| `dev/` | banc d'essai : faux HA + générateur d'événements Frigate |

`studio/` et `dev/` ne sont **jamais** dans `dist/semaphore.js` : `vite build`
part de `src/semaphore-card.ts` et rien d'autre. C'est ce qui autorise l'éditeur
à être aussi bavard qu'il le faut sans peser sur la carte.

`src/plan/editor.ts`, `snap.ts` et `history.ts` non plus : **la carte n'a pas de
mode édition** et `Scene` ne construit pas le `PlanEditor` — c'est `studio/` qui
l'instancie et qui rend l'overlay, via `Scene.setEditing()` et `Scene.overlay`.
Une seule référence depuis `scene.ts` suffirait à retomber dans le bundle. Le
bundle est passé de 42 à 33 kB gzip le jour où elle a disparu.

## Invariants à ne pas casser

Ce sont les décisions qui portent le projet. Si un changement les contredit,
c'est probablement le changement qui a tort.

1. **Un mur est décrit une fois et servi deux fois.** Extrudé en faces pour
   l'image, aplati en segments pour le raycaster — et les ouvertures se
   soustraient des deux dans la même passe. Ne jamais introduire une seconde
   source de murs : c'est ce qui garantit que l'image et le calcul de couverture
   ne peuvent pas diverger.

2. **Les pièces ne portent pas les murs.** Une pièce est une dalle, un nom et
   une aire. Tout ce qui bloque la vue vit dans `Wall`. C'est ce qui permet un
   mur isolé, une cloison qui s'arrête au milieu, une haie.

3. **Une ouverture est un trou dans la ligne de vue autant que dans le mur.**
   Par défaut on voit à travers une porte. `blocksSight` est l'exception.

4. **La projection est orthographique.** Une perspective est plus jolie et
   hostile au dessin : les parallèles convergent, la grille change de pas, et
   l'inverse écran→monde demande un lancer de rayon. En orthographique
   `unproject` est une forme close exacte — on clique un point, on obtient ce
   point.

5. **Le polygone d'isovist est étoilé par rapport à l'apex.** Chaque sommet est
   l'extrémité d'un rayon partant de la caméra.

6. **La géométrie n'est recalculée qu'au changement de géométrie.** Jamais par
   frame. Voir `Scene.refreshIsovists` et le drapeau `dirty`.

7. **La boucle rAF ne peint que s'il y a une raison** : secteur en balayage,
   orbite, ou frame invalidée. Au repos elle ne dessine rien. Plus
   `IntersectionObserver` + `visibilitychange`.

8. **Un seul tick à 10 Hz.** HA émet ses états par rafales, Frigate publie une
   mise à jour MQTT par frame suivie. Tout est coalescé dans
   `SemaphoreCard.update_()`. Ne jamais réagir événement par événement.

9. **Les cônes ne retombent pas instantanément.** Décroissance de 12 s par
   défaut : un secteur qui clignote est un secteur auquel on cesse de se fier.

10. **L'accrochage a une hiérarchie fixe** : sommet existant > arête de mur >
    verrou d'angle > grille. Le plus spécifique que l'utilisateur pouvait
    vouloir gagne. Maj libère tout.

11. **`capture()` s'appelle avant la mutation** et empile l'état courant. Un
    geste = une annulation. Ne pas réintroduire de cache « dernier état
    capturé » : il retarde d'une mutation et fait reculer la première annulation
    de deux crans. L'instantané couvre **les niveaux et les caméras** : quand il
    ne couvrait que les niveaux, poser ou supprimer une caméra empilait un point
    de restauration qui restaurait tout sauf la caméra.

12. **L'éditeur autonome ne duplique aucun rendu.** Il instancie le même `Scene`
    et le même `Renderer` que la carte : ce qu'il montre est ce que la carte
    dessinera, sans quoi l'export ne vaut rien. L'édition, elle, n'existe que
    là — toute nouvelle capacité passe par un champ de `PlanEditor.setField` ou
    par `PlanEditor.edit()`, jamais par une seconde implémentation.

13. **Ce que l'éditeur écrit, il doit savoir le relire.** `cardYaml` →
    `parseYaml` → `validateConfig` est un point fixe, vérifié : géométrie,
    caméras et options identiques après un aller-retour, et un deuxième
    aller-retour produit exactement le même texte. Un changement du writer sans
    changement du reader est un bug qui ne se voit qu'à la réouverture.

14. **La config est validée avant d'être touchée.** `validateConfig` échoue en
    nommant l'entrée et le champ fautifs. Une `TypeError` au-dessus d'une carte
    vide n'apprend rien à personne.

15. **Tout changement de pitch ou d'éclatement recadre.** Aplatir une vue à 45°
    rend la scène 40 % plus haute à l'écran ; séparer les étages y ajoute
    plusieurs mètres. Sans recadrage, le bâtiment quitte le canvas.
    Corollaire : **le premier cadrage a lieu à la première mesure non nulle du
    canvas**, pas à la construction. Home Assistant crée une carte avant de la
    dimensionner — onglet inactif, colonne de maçonnerie, aperçu d'éditeur — et
    `View.fit` sur un canvas de 0 × 0 est un no-op silencieux. Voir
    `Scene.framed`.

16. **Le lacet fait partie de la lecture, pas seulement l'inclinaison.** À lacet
    0 on regarde dans l'axe +y : tous les murs est-ouest sont vus de profil et
    une maison rectangulaire inclinée s'aplatit en élévation — la hauteur est
    dessinée et invisible. D'où `VIEW_PRESETS` (Plan 0°/0°, 2.5D 45°/20°,
    Relief 62°/32°) et un défaut à 2.5D. Ne jamais exposer un réglage
    d'inclinaison seul : il permettrait de demander la 3D et de ne rien obtenir.
    Le plan, lui, doit rester dans l'axe, sans quoi la grille cesse d'être une
    règle.

17. **La maçonnerie est opaque ; l'alpha ne représente jamais la matière.** Une
    face de mur translucide laisse voir le sol et la couverture au travers et la
    maison se lit comme une pile de boîtes en verre. L'ombrage passe donc par
    `mix()` vers l'encre, pas par `withAlpha`. L'alpha ne sert qu'à estomper un
    étage qui n'est pas l'étage actif.

18. **La carte se manipule sans mode.** Glisser pivote, molette et pincement
    zooment. `ViewControls` est attaché par `Scene` tant que rien n'édite.
    Un tableau de bord se lit sur un téléphone : toute interaction réservée au
    clic droit n'existe pas. Et dès que l'utilisateur tourne à la main, plus
    aucun préréglage ne se déclare actif — un bouton qui prétend décrire un
    angle qu'il ne décrit pas est pire que pas de bouton.

19. **Une couleur personnalisée ne remplace que l'état de repos.** Les quatre
    autres états gardent la palette : ce sont eux la légende. Un rouge qui
    voudrait dire « caméra du salon » sur une caméra et « quelqu'un est là » sur
    une autre détruit la seule chose que la palette apportait.

20. **La timeline répond à quoi, quand, et sur quelle caméra — ou elle
    disparaît.** Une bande de repères sans nom de piste, sans axe des heures et
    avec un curseur qui n'affiche rien n'informe de rien : c'est ce qu'elle a
    été et c'est pour ça qu'on l'a refaite. Les repères ont une largeur
    minimale, sans quoi un événement de cinq secondes sur six heures — le cas
    ordinaire — occuperait 0,02 % de la largeur. `show-timeline: false` la
    retire.

21. **La carte ne décide de sa taille qu'à défaut.** Une cellule de grille de
    Home Assistant l'emporte sur `height`, qui l'emporte sur `aspect-ratio`.
    `getGridOptions()` est ce qui fait apparaître les poignées de
    redimensionnement ; sans lui la carte est figée. Et le cas « le tableau de
    bord annonce des rangées puis ne donne aucune hauteur » a besoin d'un
    plancher, sinon la scène tombe à zéro pixel.

22. **La couverture est un volume, et c'est le même polygone.** Le tronc de cône
    est dessiné comme une seule silhouette — objectif, puis le pourtour de
    l'isovist dans l'ordre, fermé. Une seule passe : cent triangles translucides
    partageant des arêtes se composeraient en bandes. Ne pas fabriquer une
    seconde géométrie pour l'air : un faisceau arrêté par un mur en plan doit
    l'être en l'air par construction.

## Conventions

- Commentaires en anglais, interface utilisateur en français.
- Les commentaires expliquent **pourquoi**, jamais quoi. Pas de commentaire qui
  paraphrase la ligne suivante.
- Palette dans `theme.ts` uniquement, jamais de hex en dur ailleurs. Les
  couleurs translucides passent par `withAlpha()`, pas par un littéral `rgba`.
- Le chrome de la carte suit les variables de thème HA ; seule la palette marine
  est fixe.
- `prefers-reduced-motion` coupe orbite et balayage.
- Durées d'animation : 180 / 320 / 650 ms, courbe
  `cubic-bezier(0.22, 1, 0.36, 1)` pour les arrivées. Constantes dans `MOTION`.

## Commandes

```bash
npm install
npm run dev        # http://localhost:5173/            — éditeur de plan autonome
                   # http://localhost:5173/bench.html  — la carte, faux HA
npm run typecheck
npm run build      # dist/semaphore.js
```

L'éditeur autonome (`studio/`) est la voie normale pour décrire une maison :
plein écran, document local, export d'une config complète et import de celle qui
tourne déjà dans Home Assistant. Il n'a aucune dépendance à `hass`.

Le banc d'essai (`dev/`) fait tourner la vraie carte sans Home Assistant : faux
`hass` implémentant seulement `states`, `connection.subscribeMessage` et
`callWS`, plus un générateur de pistes Frigate synthétiques. La maison de 9 × 7 m
sur deux niveaux qu'il affiche est `sampleHouse()` dans `studio/project.ts` — une
seule description, servie à l'éditeur comme au banc.

Ne marchent pas hors HA : le flux vidéo du panneau focus, les vignettes
`camera_proxy`.

## Distribution

Dépôt HACS de catégorie **Dashboard**. `dist/` reste hors du dépôt : le workflow
`release.yml` construit sur tag `v*` et attache `semaphore.js` aux assets de la
release, ce que HACS télécharge pour les plugins. Le dépôt doit rester
**public** — HACS ne sait pas lire un dépôt privé.

## Points d'incertitude à vérifier en vrai

Tout ce qui suit tient à un contrat Home Assistant / Frigate qu'aucun test hors
HA ne peut trancher. Chacun a un repli qui évite que l'échec soit fatal.

- `frigate/events/get` en commande websocket n'est pas documenté officiellement.
  `fetchHistory` l'essaie, puis tente le proxy HTTP `/api/frigate/<id>/events`,
  puis retombe sur le buffer local. Les trois chemins sont écrits ; seul le
  troisième est testé.
- Le format de `after.box` varie selon les versions (`[x1,y1,x2,y2]` vs
  `[x,y,w,h]`, pixels ou normalisé). `normaliseBox()` tranche par heuristique et
  **`box-format: xyxy|xywh` force le choix** — à régler une fois un vrai payload
  observé. Le symptôme d'une erreur ici est un blip très loin de sa caméra.
- `ha-camera-stream` est utilisé pour le focus. Hors HA c'est un stub ; vérifier
  que l'élément existe dans la version de HA visée.
- Le topic MQTT suppose que l'intégration MQTT de HA expose `mqtt/subscribe`.
  Si la souscription échoue, la carte dessine quand même la scène : elle
  n'allume simplement jamais de secteur.
- `entity_picture` est supposé porter déjà une query string (il porte un token).
  `livePreviewUrl` ajoute `?v=1` sinon, pour que le cache-buster reste valide.

## Suite, par ordre de valeur

1. **Calibration 4 points dans l'éditeur.** Poser une caméra se fait à la
   souris, mais les correspondances image ↔ sol qui donnent les blips s'écrivent
   encore à la main. Il faut afficher le snapshot à côté du plan et cliquer
   4 paires. Sans ça, pas de détections positionnées. C'est maintenant le seul
   champ de la config qu'on ne peut pas produire à la souris — l'éditeur
   autonome est l'endroit où le faire, puisqu'il peut lire une image du disque.
2. **Calque de décalque complet.** `Underlay` est modélisé, rendu et sérialisé,
   et `applyScale()` existe ; il manque l'entrée d'URL et le geste « tracer une
   longueur connue » dans l'interface. Là encore l'éditeur autonome peut prendre
   un fichier local là où la carte ne peut prendre qu'une URL.
3. **Rejeu complet.** Le curseur de timeline gèle déjà le temps de la scène ; il
   reste à rejouer les trajectoires historiques et à caler la vidéo dessus.
4. **Éditeur Lovelace natif** (`getConfigElement`) pour écrire la config au lieu
   de copier du YAML.
5. **Escaliers et trémies**, pour que deux niveaux se lisent comme un volume.
6. **PTZ** : suivre la valeur de pan live plutôt que l'azimut fixe.
7. **i18n** : les chaînes sont en français en dur dans `semaphore-card.ts`.

## Défauts connus

- Les chips de caméra (DOM) peuvent recouvrir les libellés de pièce (canvas).
  Aucune détection de collision entre les deux calques.
- Le mode focus recadre la vue mais ne la restaure pas en sortant.
- Sur mobile, la scène capte le glissé à un doigt : on ne peut pas faire défiler
  le tableau de bord en partant de la carte. `touch-action: none` était déjà là
  avant que le geste serve à quelque chose, donc rien n'a régressé — mais un
  doigt qui fait défiler et deux qui pivotent serait plus poli.
- L'angle trouvé à la main n'est pas mémorisé : recharger la page remet la vue
  de la config.
