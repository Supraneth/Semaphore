# Sémaphore

Carte Lovelace Home Assistant : une scène 2.5D unique montrant les caméras Frigate
comme des **feux à secteurs** de carte marine — cônes de vision projetés au sol,
détections positionnées géographiquement, pièces extrudées, rejeu temporel.

Inspiration : [Helios](https://github.com/ReikanYsora/Helios) (même stack, thème
différent). Utilisateur en Bretagne, d'où la métaphore nautique.

## État

Complet et exécuté — mais jamais dans un vrai Home Assistant.

Vérifié mécaniquement :

- `tsc --noEmit` strict passe, `vite build` produit `dist/semaphore.js`
  (~350 kB gzip, dont l'essentiel est MapLibre).
- La carte **rend réellement** : testée dans un Chromium headless (SwiftShader),
  les deux programmes GLSL compilent, le contexte WebGL survit, les chips se
  positionnent, la timeline se remplit.
- Les interactions passent de bout en bout : focus caméra, changement de niveau,
  vue éclatée, ouverture de l'éditeur, traçage d'une pièce à la souris,
  copie YAML, scrub de timeline. Aucune erreur console.
- Le chemin Frigate complet est testé hors navigateur : MQTT → heuristique de
  box → homographie → traînée. Une piste synthétique reste à moins de 10 m de sa
  caméra et parcourt bien la distance attendue.
- Calculs vérifiés numériquement : isovist bloqué à 10,00 m par un mur à 10 m,
  sommet de silhouette au coin du mur, polygone trié angulairement (donc
  triangulable en éventail), ouverture respectée, homographie round-trip à
  moins d'un micromètre, quad dégénéré refusé, YAML relu par `js-yaml` avec
  `Yes` et `12:30` correctement quotés pour PyYAML.

Ce qui reste non vérifié est listé plus bas — c'est du contrat Home Assistant,
pas du calcul.

## Stack

Lit 3 · TypeScript strict · MapLibre GL 5 · tuiles MapTiler · Vite 5 · pas d'autre
dépendance runtime.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/types.ts` | schéma de config Lovelace + modèle runtime |
| `src/geo.ts` | plan tangent local en mètres (`LocalFrame`) |
| `src/fov.ts` | isovist avec occlusions |
| `src/homography.ts` | DLT 4 points, bbox Frigate → position au sol |
| `src/rooms.ts` | pièces → murs extrudés + occultants |
| `src/frigate.ts` | souscription MQTT, suivi des détections, URLs média |
| `src/gl/scene-layer.ts` | secteurs + blips, un buffer, un draw call |
| `src/gl/plan-layer.ts` | plans raster texturés en altitude |
| `src/engine.ts` | orchestration MapLibre, niveaux, vols de caméra, boucle rAF |
| `src/editor/plan-editor.ts` | traçage de pièces, poignées, aimantation |
| `src/editor/yaml.ts` | sérialiseur YAML minimal (pas de js-yaml) |
| `src/semaphore-card.ts` | carte Lit : chips, panneau focus, timeline, mode plan |
| `src/semaphore-card-css.ts` | styles de la carte, séparés pour garder le composant lisible |
| `src/theme.ts` | palette carte marine, styles d'état, tempos d'animation |
| `dev/` | banc d'essai : faux HA + générateur d'événements Frigate |

## Invariants à ne pas casser

Ce sont les décisions qui portent le projet. Si un changement les contredit,
c'est probablement le changement qui a tort.

1. **Une seule géométrie pour l'image et le calcul.** Une pièce tracée est
   extrudée en murs *et* aplatie en segments pour le raycaster. Ne jamais
   introduire une seconde source de murs.

2. **Le polygone d'isovist est étoilé par rapport à l'apex.** Chaque sommet est
   l'extrémité d'un rayon partant de la caméra. C'est ce qui permet la
   triangulation en éventail sans earcut. Toute modification de `computeIsovist`
   doit préserver cette propriété.

3. **L'animation est un uniform, pas un upload.** Balayage, atténuation, arc
   extérieur et assombrissement du mode focus vivent dans le fragment shader,
   pilotés par `u_time`. Changer l'état d'une caméra ne doit rien uploader de
   géométrique.

4. **La boucle rAF n'existe que s'il y a une raison.** Voir `Engine.needsFrame()` :
   orbite, fondu de plan, carte en mouvement, ou secteur en balayage. Au repos
   elle s'arrête. Plus `IntersectionObserver` + `visibilitychange`.

5. **Un seul tick à 10 Hz.** HA émet ses états par rafales, Frigate publie une
   mise à jour MQTT par frame suivie. Tout est coalescé dans
   `SemaphoreCard.update_()`. Ne jamais réagir événement par événement.

6. **Un seul flux vidéo live à la fois.** Le reste en snapshots, rafraîchis
   toutes les 10 s et décalés entre caméras.

7. **Les cônes ne retombent pas instantanément.** Décroissance de 12 s par
   défaut : un secteur qui clignote est un secteur auquel on cesse de se fier.

8. **Aimantation à 45 cm** entre sommets dans l'éditeur. Sans elle, deux pièces
   voisines laissent une fente par laquelle une caméra voit à travers le bâtiment.

## Conventions

- Commentaires en anglais, interface utilisateur en français.
- Les commentaires expliquent **pourquoi**, jamais quoi. Pas de commentaire qui
  paraphrase la ligne suivante.
- Palette dans `theme.ts` uniquement, jamais de hex en dur ailleurs.
- Le chrome de la carte suit les variables de thème HA ; seule la palette marine
  est fixe.
- `prefers-reduced-motion` coupe orbite, balayage et vols de caméra.
- Durées d'animation : 180 / 320 / 650 ms, vols à 900 ms, courbe
  `cubic-bezier(0.22, 1, 0.36, 1)` pour les arrivées. Constantes dans `MOTION`.

## Commandes

```bash
npm install
npm run dev        # http://localhost:5173/  — clé optionnelle : ?key=CLE_MAPTILER
npm run typecheck
npm run build      # dist/semaphore.js
```

Sans clé, `map-style` bascule sur `demo` : le style keyless de MapLibre. Pas
d'imagerie ni de bâtiments, donc rien de plaçable, mais la scène, les secteurs,
les blips et l'éditeur tournent. C'est la différence entre un banc d'essai qui
démarre et un banc d'essai qui exige un compte.

Le banc d'essai (`dev/`) fait tourner la vraie carte sans Home Assistant : faux
`hass` implémentant seulement `states`, `connection.subscribeMessage` et
`callWS`, plus un générateur de pistes Frigate synthétiques. Changer `HOME` dans
`dev/main.ts` pour ses propres coordonnées.

Ne marchent pas hors HA : le flux vidéo du panneau focus, les vignettes
`camera_proxy`.

## Distribution

Dépôt HACS de catégorie **Dashboard**. `dist/` reste hors du dépôt : le workflow
`release.yml` construit sur tag `v*` et attache `semaphore.js` aux assets de la
release, ce que HACS télécharge pour les plugins.

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
- `SceneLayer.resolveMatrix()` gère MapLibre 4 et 5 ; seule la 5 est testée.
- `ha-camera-stream` est utilisé pour le focus. Hors HA c'est un stub ; vérifier
  que l'élément existe dans la version de HA visée.
- Le topic MQTT suppose que l'intégration MQTT de HA expose `mqtt/subscribe`.
  Si la souscription échoue, la carte dessine quand même la scène : elle
  n'allume simplement jamais de secteur.
- `entity_picture` est supposé porter déjà une query string (il porte un token).
  `livePreviewUrl` ajoute `?v=1` sinon, pour que le cache-buster de la carte
  reste valide.

## Suite, par ordre de valeur

1. **Calibration 4 points dans l'éditeur.** Poser une caméra se fait à la souris,
   mais les correspondances image ↔ sol qui donnent les blips s'écrivent encore à
   la main. Il faut afficher le snapshot à côté de la carte et cliquer 4 paires.
   Sans ça, pas de détections positionnées.
2. **Rejeu complet.** Le curseur de timeline gèle déjà `u_time` ; il reste à
   rejouer les trajectoires historiques et à caler la vidéo dessus.
3. **Éditeur Lovelace natif** (`getConfigElement`) pour écrire la config au lieu
   de copier du YAML.
4. **PTZ** : suivre la valeur de pan live plutôt que l'azimut fixe.
5. **Externaliser MapLibre** en import CDN pour ramener le bundle sous 60 kB.
6. **i18n** : les chaînes sont en français en dur dans `semaphore-card.ts`.