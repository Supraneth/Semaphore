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
  (~40 kB gzip — plus aucune dépendance runtime hors Lit).
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
| `src/plan/view.ts` | caméra 2.5D orthographique, `project` / `unproject` exacts |
| `src/plan/geometry.ts` | murs → faces et → occultants, ouvertures, aires |
| `src/plan/renderer.ts` | tout le rendu, Canvas 2D, algorithme du peintre |
| `src/plan/editor.ts` | outils, accrochage, saisie clavier, glisser-déposer |
| `src/plan/snap.ts` | hiérarchie d'accrochage : sommet > arête > angle > grille |
| `src/plan/history.ts` | annuler/refaire par instantanés |
| `src/plan/scene.ts` | orchestration, isovists, boucle rAF |
| `src/plan/yaml.ts` | sérialiseur YAML minimal (pas de js-yaml) |
| `src/semaphore-card.ts` | carte Lit : rail, outils, inspecteur, timeline |
| `src/semaphore-card-css.ts` | styles de la carte |
| `dev/` | banc d'essai : faux HA + générateur d'événements Frigate |

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
    de deux crans.

12. **La config est validée avant d'être touchée.** `validateConfig` échoue en
    nommant l'entrée et le champ fautifs. Une `TypeError` au-dessus d'une carte
    vide n'apprend rien à personne.

13. **Tout changement de pitch ou d'éclatement recadre.** Aplatir une vue à 45°
    rend la scène 40 % plus haute à l'écran ; séparer les étages y ajoute
    plusieurs mètres. Sans recadrage, le bâtiment quitte le canvas.

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
npm run dev        # http://localhost:5173/  — aucune clé, aucun compte
npm run typecheck
npm run build      # dist/semaphore.js
```

Le banc d'essai (`dev/`) fait tourner la vraie carte sans Home Assistant : faux
`hass` implémentant seulement `states`, `connection.subscribeMessage` et
`callWS`, plus un générateur de pistes Frigate synthétiques. `dev/main.ts`
décrit une maison de 9 × 7 m sur deux niveaux, en mètres — modifiez-la, ou
dessinez la vôtre avec le mode Plan.

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
   4 paires. Sans ça, pas de détections positionnées.
2. **Calque de décalque complet.** `Underlay` est modélisé, rendu et sérialisé,
   et `applyScale()` existe ; il manque l'entrée d'URL et le geste « tracer une
   longueur connue » dans l'interface.
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
