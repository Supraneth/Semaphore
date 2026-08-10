import { css, unsafeCSS } from 'lit';
import { CHART, MOTION, withAlpha } from './theme';

/**
 * Card chrome.
 *
 * Two palettes coexist deliberately. The frame — card background, text, radii —
 * follows the Home Assistant theme variables, so Sémaphore looks native next to
 * every other card on the dashboard. The scene itself keeps the chart palette
 * regardless of theme, because those colours are the legend: a white sector has
 * to mean "clear" whether the user runs a light or a dark dashboard.
 *
 * Everything responsive here answers to `@container`, never to `@media`. A card
 * is 1100 px wide in a panel view and 320 px in the second masonry column of the
 * same phone-sized window; the viewport cannot tell those apart and the stage
 * itself can.
 */

const ink = unsafeCSS(CHART.ink);
const parchment = unsafeCSS(CHART.parchment);
const white = unsafeCSS(CHART.sectorWhite);
const red = unsafeCSS(CHART.sectorRed);
const slate = unsafeCSS(CHART.slate);
const tap = unsafeCSS(`${MOTION.tap}ms`);
const panel = unsafeCSS(`${MOTION.panel}ms`);
const ease = unsafeCSS(MOTION.ease);

/** Glass over the scene. One recipe, so every floating control is one family. */
const glassBg = unsafeCSS(withAlpha(CHART.ink, 0.72));
const glassBgSolid = unsafeCSS(withAlpha(CHART.ink, 0.9));
const glassEdge = unsafeCSS(withAlpha(CHART.parchment, 0.16));
const glassEdgeLit = unsafeCSS(withAlpha(CHART.parchment, 0.28));

export const styles = css`
  :host {
    display: block;
    /* Auto in a masonry column, the cell's height in a sections grid. */
    height: 100%;
    --semaphore-ink: ${ink};
    --semaphore-parchment: ${parchment};
    --semaphore-radius: var(--ha-card-border-radius, 12px);
    /* One inset for every floating control, so the four corners agree. */
    --semaphore-inset: 10px;
  }

  ha-card {
    overflow: hidden;
    padding: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    /* The unit everything below measures itself against. On the card rather
       than on the stage because the stage is one of the things that has to
       answer to it, and an element cannot query its own container. */
    container-type: inline-size;
    container-name: card;
  }

  /* Height and shape are set inline by stageStyle(): a dashboard row count, an
     explicit height, or the card's own aspect ratio, in that order. */
  .stage {
    position: relative;
    width: 100%;
    min-height: 120px;
    background: var(--semaphore-ink);
  }

  /* Shape, when the config did not name one. Wide cards read best long; a card
     the width of a phone needs the height back, or the plan is a letterbox
     between two rows of buttons. */
  .stage.auto-aspect {
    aspect-ratio: 16 / 10;
  }

  .canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    /* Sideways turns the house, downwards scrolls the dashboard. Taking every
       touch — which "none" did — made the card a trap on a phone: a finger
       that landed on it could not scroll the page past it. Two fingers still
       pinch, and pan-y is what keeps the browser from zooming the whole
       document when they do. */
    touch-action: pan-y;
    cursor: grab;
    z-index: 0;
  }
  .canvas:active {
    cursor: grabbing;
  }

  /* The stage takes keyboard focus, so the card can answer keys without a
     window-level listener that would fight every other card on the dashboard.
     Inset, because an outline outside a full-bleed stage is clipped away. */
  .stage:focus {
    outline: none;
  }
  .stage:focus-visible {
    outline: 2px solid ${white};
    outline-offset: -2px;
  }

  /* The scene is a bright parchment plan on a dark ground, and the floating
     chrome sits on whichever of the two it lands on. These two washes give the
     controls something dark to sit against at the very top and bottom without
     touching the middle of the plan. */
  .stage::before,
  .stage::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 76px;
    pointer-events: none;
    /* Between the canvas and the controls, explicitly: a generated box is the
       first child of the stage and would otherwise paint under the canvas. */
    z-index: 1;
  }
  .stage::before {
    top: 0;
    background: linear-gradient(${unsafeCSS(withAlpha(CHART.ink, 0.55))}, transparent);
  }
  .stage::after {
    bottom: 0;
    background: linear-gradient(transparent, ${unsafeCSS(withAlpha(CHART.ink, 0.55))});
  }

  .notice {
    display: flex;
    gap: 8px;
    padding: 10px 14px;
    font-size: 12px;
    line-height: 1.5;
    color: ${parchment};
    background: ${unsafeCSS(withAlpha(CHART.buoyYellow, 0.16))};
    border-bottom: 1px solid ${unsafeCSS(withAlpha(CHART.buoyYellow, 0.4))};
  }
  .notice::before {
    content: '';
    flex: none;
    width: 3px;
    border-radius: 2px;
    background: ${unsafeCSS(CHART.buoyYellow)};
  }

  /* The overlay must not swallow map drags — only its controls take pointers. */
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
  }
  .overlay > *,
  .chip {
    pointer-events: auto;
  }

  /* ---- floating controls ------------------------------------------------ */

  .controls {
    position: absolute;
    left: var(--semaphore-inset);
    display: flex;
    align-items: center;
    gap: 6px;
    /* A card can be narrower than its own controls. Scrolling them beats
       wrapping them into a block that covers the plan. */
    max-width: calc(100% - var(--semaphore-inset) * 2);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .controls::-webkit-scrollbar {
    display: none;
  }
  .controls.at-top {
    top: var(--semaphore-inset);
  }
  .controls.at-bottom {
    bottom: var(--semaphore-inset);
  }

  /* Levels, and the three readings: one choice with one answer each, so they
     read as a single control rather than as loose lozenges. */
  .segmented {
    display: flex;
    flex: none;
    padding: 2px;
    gap: 2px;
    border-radius: 999px;
    background: ${glassBg};
    border: 1px solid ${glassEdge};
    backdrop-filter: blur(8px);
  }

  .segmented button,
  button.icon {
    font: inherit;
    font-size: 12px;
    line-height: 1;
    letter-spacing: 0.02em;
    color: var(--semaphore-parchment);
    background: transparent;
    border: none;
    border-radius: 999px;
    padding: 7px 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: background ${tap} ${ease}, color ${tap} ${ease};
  }

  button.icon {
    flex: none;
    display: grid;
    place-items: center;
    padding: 0;
    width: 32px;
    height: 32px;
    background: ${glassBg};
    border: 1px solid ${glassEdge};
    backdrop-filter: blur(8px);
  }

  button.icon svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .segmented button:hover,
  button.icon:hover {
    background: ${glassEdge};
  }

  .segmented button[aria-pressed='true'] {
    background: ${white};
    color: var(--semaphore-ink);
    font-weight: 600;
  }
  button.icon[aria-pressed='true'] {
    background: ${white};
    border-color: ${white};
    color: var(--semaphore-ink);
  }

  .segmented button:focus-visible,
  button.icon:focus-visible,
  .chip:focus-visible,
  .mark:focus-visible {
    outline: 2px solid ${white};
    outline-offset: 2px;
  }

  /* ---- verdict ---------------------------------------------------------- */

  /* The first thing read, so it gets the first line of the card and the full
     width of it. The tone colour arrives inline, as the text colour and as a
     wash over the ink — one value driving both keeps them from disagreeing. */
  .verdict {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    box-sizing: border-box;
    padding: 11px 14px;
    font: inherit;
    font-size: 13px;
    text-align: left;
    border: none;
    border-bottom: 1px solid ${glassEdge};
    background-color: var(--semaphore-ink);
    box-shadow: inset 3px 0 0 currentColor;
    cursor: pointer;
    transition: filter ${tap} ${ease};
  }
  .verdict:hover:not([disabled]) {
    filter: brightness(1.18);
  }
  /* Nothing to open yet. Still the state of the house, still worth reading. */
  .verdict[disabled] {
    cursor: default;
  }
  .verdict:focus-visible {
    outline: 2px solid ${white};
    outline-offset: -3px;
  }

  .verdict .pip {
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: currentColor;
  }
  .verdict.alert .pip,
  .verdict.motion .pip {
    animation: pulse 1.6s ${ease} infinite;
  }

  .verdict .phrase {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    letter-spacing: 0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Quiet is the one state that should not shout: the phrase reads in the
     card's own ink, and the palette is kept for the things worth a colour. */
  .verdict.nominal .phrase {
    color: var(--semaphore-parchment);
    font-weight: 500;
  }

  .verdict .tags {
    display: flex;
    flex: none;
    gap: 6px;
  }
  .verdict .tag {
    font-size: 11px;
    line-height: 1;
    padding: 4px 8px;
    border: 1px solid currentColor;
    border-radius: 999px;
    white-space: nowrap;
  }

  /* ---- camera chips ---------------------------------------------------- */

  .chip {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 11px 4px 4px;
    font: inherit;
    font-size: 12px;
    border: 1px solid ${glassEdge};
    border-radius: 999px;
    background: ${glassBgSolid};
    cursor: pointer;
    white-space: nowrap;
    backdrop-filter: blur(6px);
    box-shadow: 0 2px 10px ${unsafeCSS(withAlpha(CHART.ink, 0.5))};
    /* Only opacity animates. The transform is written every frame by the
       engine and must never be transitioned, or chips lag behind the map. */
    transition: opacity ${panel} ${ease}, border-color ${tap} ${ease};
    will-change: transform;
  }
  /* Without a preview there is nothing on the left to balance the padding. */
  .chip:not(.has-thumb) {
    padding-left: 11px;
  }
  .chip:hover {
    border-color: ${glassEdgeLit};
  }

  .chip .name {
    color: var(--semaphore-parchment);
    font-weight: 500;
  }

  .chip .pip {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }

  /* Something to report: the dot gets a halo, so a chip reads at the edge of
     vision rather than only when looked at. */
  .chip.alert .pip,
  .chip.motion .pip {
    box-shadow: 0 0 0 3px ${unsafeCSS(withAlpha(CHART.parchment, 0.001))};
    animation: halo 1.8s ${ease} infinite;
  }
  .chip.alert {
    border-color: currentColor;
  }

  .chip .thumb {
    width: 40px;
    height: 26px;
    object-fit: cover;
    /* Not a 999px pill: a 16:9 frame squashed into a lozenge is unreadable as
       a picture, which is the only reason it is there. */
    border-radius: 999px 4px 4px 999px;
    flex: none;
    background: ${unsafeCSS(withAlpha(CHART.slate, 0.35))};
  }

  /* Clamped back onto the stage, so it is a legend entry now, not a pin. */
  .chip.adrift {
    opacity: 0.72;
    border-style: dashed;
  }
  /* Not on this view at all. Hidden rather than removed, so its footprint stays
     measurable for the frame it comes back on. */
  .chip.off {
    visibility: hidden;
    pointer-events: none;
  }
  /* On a storey that is not the active one: still there, no longer competing. */
  .chip.dim {
    opacity: 0.38;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }

  @keyframes halo {
    0%,
    100% {
      box-shadow: 0 0 0 0 ${unsafeCSS(withAlpha(CHART.parchment, 0))};
    }
    50% {
      box-shadow: 0 0 0 4px currentColor;
      opacity: 0.85;
    }
  }

  /* ---- focus panel ----------------------------------------------------- */

  .panel {
    position: absolute;
    right: var(--semaphore-inset);
    bottom: var(--semaphore-inset);
    width: min(340px, 46%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    /* Never taller than the scene it floats over: a short stage — a phone, a
       two-row grid cell — would otherwise get a panel hanging out of the card. */
    max-height: calc(100% - var(--semaphore-inset) * 2);
    box-sizing: border-box;
    overflow: auto;
    border-radius: var(--semaphore-radius);
    background: ${glassBgSolid};
    border: 1px solid ${glassEdge};
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 28px ${unsafeCSS(withAlpha(CHART.ink, 0.55))};
    animation: rise ${panel} ${ease} both;
  }

  .panel header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--semaphore-parchment);
    font-size: 13px;
    letter-spacing: 0.02em;
  }
  .panel header .title {
    flex: 1;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .panel header .pip {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }
  .panel header button.icon {
    width: 28px;
    height: 28px;
    background: transparent;
    border-color: transparent;
  }

  .panel .stream {
    display: block;
    width: 100%;
    border-radius: calc(var(--semaphore-radius) - 4px);
    overflow: hidden;
    background: rgba(0, 0, 0, 0.5);
    aspect-ratio: 16 / 9;
  }

  .panel .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 11px;
    letter-spacing: 0.04em;
    color: ${slate};
  }

  .panel .meta span:first-child {
    color: var(--semaphore-parchment);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }

  /* ---- shortcut sheet --------------------------------------------------- */

  .help {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--semaphore-inset);
    box-sizing: border-box;
    background: ${unsafeCSS(withAlpha(CHART.ink, 0.72))};
    backdrop-filter: blur(4px);
    /* Above the chips and the panel: it is a modal answer to a modal question. */
    z-index: 3;
    animation: rise ${panel} ${ease} both;
  }

  .help .sheet {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(320px, 100%);
    max-height: 100%;
    overflow: auto;
    box-sizing: border-box;
    padding: 12px 14px 14px;
    border-radius: var(--semaphore-radius);
    background: ${glassBgSolid};
    border: 1px solid ${glassEdge};
    box-shadow: 0 8px 28px ${unsafeCSS(withAlpha(CHART.ink, 0.55))};
  }

  .help header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--semaphore-parchment);
    font-size: 13px;
  }
  .help header .title {
    flex: 1;
    font-weight: 600;
  }
  .help header button.icon {
    width: 28px;
    height: 28px;
    background: transparent;
    border-color: transparent;
  }

  .help dl {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 7px 12px;
    margin: 0;
    font-size: 12px;
    color: var(--semaphore-parchment);
  }
  .help dt {
    margin: 0;
  }
  .help dd {
    margin: 0;
    color: ${slate};
  }
  .help kbd {
    display: inline-block;
    min-width: 18px;
    padding: 3px 7px;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1;
    color: var(--semaphore-parchment);
    background: ${glassEdge};
    border: 1px solid ${glassEdgeLit};
    border-radius: 5px;
    white-space: nowrap;
  }
  .help .hint {
    margin: 2px 0 0;
    font-size: 11px;
    line-height: 1.5;
    color: ${slate};
  }

  /* ---- timeline -------------------------------------------------------- */

  .timeline {
    position: relative;
    padding: 8px var(--pad) 10px;
    background: var(--ha-card-background, var(--card-background-color, transparent));
    /* The label column, shared by the axis and every track, so two cameras
       firing at the same minute line up vertically. */
    --label-w: 76px;
    --pad: 12px;
    --gap: 8px;
    /* Where the track column starts, for anything that has to line up with it
       without living inside the grid — the scrub. */
    --track-left: calc(var(--pad) + var(--label-w) + var(--gap));
    font-size: 11px;
  }

  .timeline .axis,
  .timeline .track {
    display: grid;
    grid-template-columns: var(--label-w) 1fr;
    align-items: center;
    gap: var(--gap);
  }

  .timeline .track {
    margin-top: 3px;
  }

  .timeline .track-label {
    color: var(--secondary-text-color, ${slate});
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .timeline .tracks {
    position: relative;
    height: 16px;
  }

  .timeline .tick {
    position: absolute;
    top: 2px;
    transform: translateX(-50%);
    color: var(--secondary-text-color, ${slate});
    opacity: 0.75;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .timeline .tick.now {
    transform: translateX(-100%);
    opacity: 1;
  }

  /* The empty lane, so a camera with nothing to report still reads as a camera
     rather than as a gap in the list. */
  .timeline .lane {
    position: absolute;
    top: 5px;
    height: 7px;
    left: 0;
    right: 0;
    border-radius: 4px;
    background: ${unsafeCSS(withAlpha(CHART.slate, 0.22))};
  }

  .timeline .mark {
    position: absolute;
    top: 3px;
    height: 11px;
    min-width: 3px;
    padding: 0;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    transition: transform ${tap} ${ease};
  }
  /* A five-second event on a six-hour window is three pixels wide, and three
     pixels is not something a thumb can hit. The hit area is grown around the
     mark instead of the mark being grown into a lie about its duration. */
  .timeline .mark::after {
    content: '';
    position: absolute;
    inset: -7px -5px;
  }
  .timeline .mark:hover,
  .timeline .mark.on {
    transform: scaleY(1.35);
    box-shadow: 0 0 0 1px var(--card-background-color, ${ink});
  }

  .timeline .scrub {
    position: absolute;
    top: 8px;
    bottom: 30px;
    width: 1px;
    background: ${white};
    pointer-events: none;
  }
  .timeline .scrub .time {
    position: absolute;
    top: -4px;
    left: 4px;
    padding: 1px 5px;
    border-radius: 999px;
    background: ${ink};
    color: ${parchment};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .timeline .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 8px 0 0;
    padding-left: var(--label-w);
    color: var(--secondary-text-color, ${slate});
  }
  .timeline .legend.quiet {
    display: block;
    padding-left: 0;
    text-align: center;
  }
  .timeline .key {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .timeline .key i,
  .panel .event i {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  .panel .event {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: ${slate};
  }
  .panel .event strong {
    color: var(--semaphore-parchment);
  }

  /* ---- states ---------------------------------------------------------- */

  .empty {
    padding: 16px;
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
    color: var(--secondary-text-color, ${slate});
  }

  .panel .empty {
    padding: 24px 8px;
  }

  .empty.error {
    color: ${red};
  }

  /* ---- narrow cards ----------------------------------------------------- */

  /* A phone, or a masonry column on a desktop. Same answer either way: the
     controls give the plan its space back. */
  @container card (max-width: 460px) {
    :host {
      --semaphore-inset: 8px;
    }
    .stage.auto-aspect {
      aspect-ratio: 4 / 3;
    }
    .segmented button {
      padding: 7px 10px;
    }
    .verdict {
      padding: 9px 12px;
      font-size: 12px;
    }
    /* On a card this narrow the phrase is the whole budget; the counts are
       drawn on the plan anyway, in red, where they cannot be missed. */
    .verdict .tags {
      display: none;
    }
    .chip .thumb {
      display: none;
    }
    .chip {
      padding-left: 11px;
    }
    /* A fixed 76 px label column is a fifth of a phone-width card, taken from
       the track — which is the part carrying the information. */
    .timeline {
      --label-w: 54px;
      --pad: 10px;
    }
  }

  /* Narrower still: the focus panel stops being a corner card and becomes the
     sheet across the bottom that a phone expects, and the controls it would
     bury get out of its way. */
  @container card (max-width: 380px) {
    .panel {
      left: var(--semaphore-inset);
      width: auto;
    }
    /* A 16/9 stream across the full width of a phone card is the whole stage,
       and a sheet that covers everything it was opened from leaves nothing to
       come back to. Sized from the card's own width so it stays right in a
       masonry column as well. */
    .panel .stream {
      max-height: 40cqw;
    }
    .stage.focused .controls.at-bottom {
      display: none;
    }
  }

  /* A finger is not a mouse pointer. Everything it has to hit gets the room to
     be hit, on the axis where there is room to give. */
  @media (pointer: coarse) {
    /* A button offering keyboard shortcuts to a device with no keyboard is a
       control that can only disappoint. */
    .fine-pointer-only {
      display: none;
    }
    .segmented button {
      padding: 9px 13px;
    }
    button.icon {
      width: 36px;
      height: 36px;
    }
    .timeline .tracks {
      height: 20px;
    }
    .timeline .mark::after {
      inset: -10px -7px;
    }
  }

  /* An orbiting view and a sweeping sector are ambient motion, not information.
     Anyone who asked the OS to stop that gets a still card. */
  @media (prefers-reduced-motion: reduce) {
    .chip,
    .panel,
    .segmented button,
    button.icon,
    .timeline .mark {
      animation: none !important;
      transition: none !important;
    }
    .help {
      animation: none !important;
    }
    .chip.alert .pip,
    .chip.motion .pip,
    .verdict .pip {
      animation: none;
      opacity: 1;
      box-shadow: none;
    }
  }
`;
