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
    --semaphore-ink: ${ink};
    --semaphore-parchment: ${parchment};
    --semaphore-radius: var(--ha-card-border-radius, 12px);
  }

  ha-card {
    overflow: hidden;
    padding: 0;
  }

  .stage {
    position: relative;
    width: 100%;
    /* Tall enough that a 55° pitch still shows ground in front of the cameras,
       capped so the card never eats a phone screen whole. */
    aspect-ratio: 16 / 10;
    max-height: 70vh;
    background: var(--semaphore-ink);
  }

  .map {
    position: absolute;
    inset: 0;
  }

  /* MapLibre injects its own chrome; keep it in the chart palette. */
  .map .maplibregl-ctrl-attrib {
    background: rgba(12, 34, 51, 0.72);
    color: var(--semaphore-parchment);
    font-size: 10px;
  }
  .map .maplibregl-ctrl-attrib a {
    color: var(--semaphore-parchment);
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

  .rail button,
  .panel header button,
  .editor button {
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
  .editor button:hover,
  .panel header button:hover {
    background: rgba(12, 34, 51, 0.92);
  }

  .rail button[aria-pressed='true'],
  .editor button[aria-pressed='true'] {
    background: ${white};
    border-color: ${white};
    color: var(--semaphore-ink);
  }

  .rail button:focus-visible,
  .editor button:focus-visible,
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

  /* ---- plan editor ----------------------------------------------------- */

  .editor {
    position: absolute;
    left: 12px;
    bottom: 12px;
    width: min(300px, 60%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: var(--semaphore-radius);
    background: rgba(12, 34, 51, 0.9);
    border: 1px solid rgba(244, 231, 190, 0.16);
    backdrop-filter: blur(10px);
    animation: rise ${panel} ${ease} both;
  }

  .editor .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .editor .tip {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: ${slate};
  }

  .editor input {
    font: inherit;
    font-size: 12px;
    padding: 5px 9px;
    border-radius: 6px;
    color: var(--semaphore-parchment);
    background: rgba(244, 231, 190, 0.08);
    border: 1px solid rgba(244, 231, 190, 0.2);
  }

  .editor input:focus-visible,
  .editor .yaml:focus-visible {
    outline: 2px solid ${white};
    outline-offset: 1px;
  }

  /* The manual-copy fallback. Monospace and scrollable: it is meant to be
     selected and read, not admired. */
  .editor .yaml {
    font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", monospace;
    font-size: 11px;
    line-height: 1.45;
    height: 160px;
    resize: vertical;
    white-space: pre;
    padding: 8px;
    border-radius: 6px;
    color: var(--semaphore-parchment);
    background: rgba(12, 34, 51, 0.9);
    border: 1px solid rgba(244, 231, 190, 0.2);
  }

  /* ---- timeline -------------------------------------------------------- */

  .timeline {
    position: relative;
    padding: 8px 12px 10px;
    background: var(--ha-card-background, var(--card-background-color, transparent));
    cursor: ew-resize;
    touch-action: none;
  }

  .timeline .lanes {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .timeline .lane {
    position: relative;
    height: 7px;
    border-radius: 3px;
    background: rgba(91, 114, 133, 0.22);
    overflow: hidden;
  }

  .timeline .mark {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 2px;
    border-radius: 3px;
    cursor: pointer;
  }

  .timeline .cursor {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    margin-left: -1px;
    background: ${white};
    box-shadow: 0 0 6px ${red};
    pointer-events: none;
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

  /* An orbiting map and a sweeping sector are ambient motion, not information.
     Anyone who asked the OS to stop that gets a still card. */
  @media (prefers-reduced-motion: reduce) {
    .chip,
    .panel,
    .editor,
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
