import { css, unsafeCSS } from 'lit';
import { CHART, MOTION } from './theme';

/**
 * Card chrome.
 *
 * Two palettes coexist deliberately. The frame — card background, text, radii —
 * follows the Home Assistant theme variables, so Sémaphore looks native next to
 * every other card on the dashboard. The scene itself keeps the chart palette
 * regardless of theme, because those colours are the legend: a white sector has
 * to mean "clear" whether the user runs a light or a dark dashboard.
 */

const ink = unsafeCSS(CHART.ink);
const parchment = unsafeCSS(CHART.parchment);
const white = unsafeCSS(CHART.sectorWhite);
const red = unsafeCSS(CHART.sectorRed);
const slate = unsafeCSS(CHART.slate);
const tap = unsafeCSS(`${MOTION.tap}ms`);
const panel = unsafeCSS(`${MOTION.panel}ms`);
const ease = unsafeCSS(MOTION.ease);

export const styles = css`
  :host {
    display: block;
    /* Auto in a masonry column, the cell's height in a sections grid. */
    height: 100%;
    --semaphore-ink: ${ink};
    --semaphore-parchment: ${parchment};
    --semaphore-radius: var(--ha-card-border-radius, 12px);
  }

  ha-card {
    overflow: hidden;
    padding: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* Height and shape are set inline by stageStyle(): a dashboard row count, an
     explicit height, or the card's own aspect ratio, in that order. */
  .stage {
    position: relative;
    width: 100%;
    min-height: 120px;
    background: var(--semaphore-ink);
  }

  .canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    /* The card owns every gesture over the scene: drag turns it, pinch zooms.
       Leaving the browser its default touch behaviour here would scroll the
       dashboard instead of the house. */
    touch-action: none;
    cursor: grab;
  }
  .canvas:active {
    cursor: grabbing;
  }

  .notice {
    padding: 8px 12px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--semaphore-ink);
    background: ${unsafeCSS(CHART.buoyYellow)};
  }

  /* The overlay must not swallow map drags — only its controls take pointers. */
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .overlay > *,
  .chip {
    pointer-events: auto;
  }

  /* ---- rail ------------------------------------------------------------ */

  .rail {
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
  }

  /* The tilt presets read as one control, not three unrelated pills. */
  .rail .group {
    display: flex;
    gap: 3px;
  }

  .rail button,
  .panel header button {
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.02em;
    color: var(--semaphore-parchment);
    background: rgba(12, 34, 51, 0.74);
    border: 1px solid rgba(244, 231, 190, 0.18);
    border-radius: 999px;
    padding: 5px 12px;
    cursor: pointer;
    backdrop-filter: blur(6px);
    transition: background ${tap} ${ease}, border-color ${tap} ${ease};
  }

  .rail button:hover,
  .panel header button:hover {
    background: rgba(12, 34, 51, 0.92);
  }

  .rail button[aria-pressed='true'] {
    background: ${white};
    border-color: ${white};
    color: var(--semaphore-ink);
  }

  .rail button:focus-visible,
  .chip:focus-visible {
    outline: 2px solid ${white};
    outline-offset: 2px;
  }

  /* ---- status ---------------------------------------------------------- */

  .status {
    position: absolute;
    top: 12px;
    right: 12px;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--semaphore-parchment);
    background: rgba(12, 34, 51, 0.74);
    border-radius: 999px;
    padding: 5px 12px;
    backdrop-filter: blur(6px);
  }

  /* ---- camera chips ---------------------------------------------------- */

  .chip {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px 3px 3px;
    font: inherit;
    font-size: 12px;
    border: 1px solid currentColor;
    border-radius: 999px;
    background: rgba(12, 34, 51, 0.8);
    cursor: pointer;
    white-space: nowrap;
    backdrop-filter: blur(4px);
    /* Only opacity animates. The transform is written every frame by the
       engine and must never be transitioned, or chips lag behind the map. */
    transition: opacity ${panel} ${ease};
    will-change: transform;
  }

  .chip .name {
    color: var(--semaphore-parchment);
  }

  .chip .pip {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }

  .chip.alert .pip {
    animation: pulse 1.6s ${ease} infinite;
  }

  .chip .thumb {
    width: 34px;
    height: 22px;
    object-fit: cover;
    border-radius: 999px;
    flex: none;
    background: rgba(91, 114, 133, 0.4);
  }

  /* Behind the viewer at high pitch, or on a hidden storey: still there, but
     no longer competing for attention. */
  .chip.behind {
    opacity: 0.28;
  }
  .chip.dim {
    opacity: 0.4;
  }
  .chip.behind.dim {
    opacity: 0.15;
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

  /* ---- focus panel ----------------------------------------------------- */

  .panel {
    position: absolute;
    right: 12px;
    bottom: 12px;
    width: min(340px, 46%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: var(--semaphore-radius);
    background: rgba(12, 34, 51, 0.88);
    border: 1px solid rgba(244, 231, 190, 0.16);
    backdrop-filter: blur(10px);
    animation: rise ${panel} ${ease} both;
  }

  .panel header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--semaphore-parchment);
    font-size: 13px;
    letter-spacing: 0.04em;
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

  /* ---- timeline -------------------------------------------------------- */

  .timeline {
    position: relative;
    padding: 8px 12px 10px;
    background: var(--ha-card-background, var(--card-background-color, transparent));
    /* The label column, shared by the axis and every track, so two cameras
       firing at the same minute line up vertically. */
    --label-w: 76px;
    font-size: 11px;
  }

  .timeline .axis,
  .timeline .track {
    display: grid;
    grid-template-columns: var(--label-w) 1fr;
    align-items: center;
    gap: 8px;
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
    height: 15px;
  }

  .timeline .tick {
    position: absolute;
    top: 2px;
    transform: translateX(-50%);
    color: var(--secondary-text-color, ${slate});
    opacity: 0.75;
    white-space: nowrap;
  }
  .timeline .tick.now {
    transform: translateX(-100%);
    opacity: 1;
  }

  /* The empty track, so a camera with nothing to report still reads as a
     camera rather than as a gap in the list. */
  .timeline .rail {
    position: absolute;
    top: 4px;
    height: 7px;
    left: 0;
    right: 0;
    border-radius: 4px;
    background: rgba(91, 114, 133, 0.22);
  }

  .timeline .mark {
    position: absolute;
    top: 2px;
    height: 11px;
    min-width: 3px;
    padding: 0;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    transition: transform ${tap} ${ease};
  }
  .timeline .mark:hover,
  .timeline .mark.on {
    transform: scaleY(1.3);
    box-shadow: 0 0 0 1px var(--card-background-color, ${ink});
  }
  .timeline .mark:focus-visible {
    outline: 2px solid ${white};
    outline-offset: 1px;
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
    padding-left: calc(var(--label-w) + 8px);
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
    gap: 8px;
    padding: 0 10px 8px;
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
    text-align: center;
    color: var(--secondary-text-color, ${slate});
  }

  .panel .empty {
    padding: 24px 8px;
  }

  .empty.error {
    color: ${red};
  }

  /* An orbiting view and a sweeping sector are ambient motion, not information.
     Anyone who asked the OS to stop that gets a still card. */
  @media (prefers-reduced-motion: reduce) {
    .chip,
    .panel,
    .rail button {
      animation: none !important;
      transition: none !important;
    }
    .chip.alert .pip {
      animation: none;
      opacity: 1;
    }
  }
`;
