import { css, unsafeCSS, type CSSResult } from 'lit';
import { CHART, MOTION, withAlpha } from '../src/theme';

/**
 * The editor's chrome.
 *
 * The card borrows Home Assistant's theme variables because it is a guest on
 * someone else's dashboard. This is not a guest — it is a full window with no
 * host to match, so it commits to the chart palette outright: ink for the
 * ground, parchment for the paper, and the sector colours reserved for things
 * that carry meaning rather than decorating a button.
 */

const u = (value: string): CSSResult => unsafeCSS(value);

const ink = u(CHART.ink);
const massing = u(CHART.massing);
const parchment = u(CHART.parchment);
const slate = u(CHART.slate);
const yellow = u(CHART.buoyYellow);
const red = u(CHART.sectorRed);
const green = u(CHART.sectorGreen);

const hairline = u(withAlpha(CHART.parchment, 0.14));
const raised = u(withAlpha(CHART.parchment, 0.06));
const hover = u(withAlpha(CHART.parchment, 0.12));
const panelFill = u(withAlpha(CHART.massing, 0.72));
const barFill = u(withAlpha(CHART.massing, 0.5));
const sunk = u(withAlpha(CHART.ink, 0.65));
const scrim = u(withAlpha(CHART.ink, 0.72));
const veil = u(withAlpha(CHART.ink, 0.78));

const pressedFill = u(withAlpha(CHART.buoyYellow, 0.18));
const pressedEdge = u(withAlpha(CHART.buoyYellow, 0.55));
const accentFill = u(withAlpha(CHART.buoyYellow, 0.22));
const accentEdge = u(withAlpha(CHART.buoyYellow, 0.6));
const focusRing = u(withAlpha(CHART.buoyYellow, 0.75));
const alarmFill = u(withAlpha(CHART.sectorRed, 0.14));
const alarmHover = u(withAlpha(CHART.sectorRed, 0.22));
const alarmEdge = u(withAlpha(CHART.sectorRed, 0.5));
const alarmEdgeHover = u(withAlpha(CHART.sectorRed, 0.6));

const tap = u(`${MOTION.tap}ms`);
const panelIn = u(`${MOTION.panel}ms`);
const ease = u(MOTION.ease);

export const styles = css`
  :host {
    --paper: ${parchment};
    --muted: ${slate};
    --line: ${hairline};
    --accent: ${yellow};

    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
    background: ${ink};
    color: var(--paper);
    font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
    overflow: hidden;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
    color: inherit;
  }

  button {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: ${raised};
    padding: 6px 10px;
    cursor: pointer;
    transition: background ${tap} ${ease}, border-color ${tap} ${ease};
  }
  button:hover:not(:disabled) {
    background: ${hover};
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  button[aria-pressed='true'] {
    background: ${pressedFill};
    border-color: ${pressedEdge};
    color: var(--accent);
  }
  button.primary {
    background: ${accentFill};
    border-color: ${accentEdge};
    color: var(--accent);
  }
  button.danger:hover:not(:disabled) {
    background: ${alarmHover};
    border-color: ${alarmEdgeHover};
  }

  input,
  select,
  textarea {
    border: 1px solid var(--line);
    border-radius: 7px;
    background: ${sunk};
    padding: 5px 8px;
    min-width: 0;
  }
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  button:focus-visible {
    outline: 2px solid ${focusRing};
    outline-offset: 1px;
  }
  input[type='number'],
  input[type='text'] {
    width: 100%;
  }

  kbd {
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 4px;
    font-size: 10px;
    opacity: 0.7;
    margin-left: auto;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }

  /* ---- top bar ---------------------------------------------------------- */

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    background: ${barFill};
  }
  .brand {
    font-weight: 600;
    letter-spacing: 0.04em;
    margin-right: 8px;
  }
  .brand span {
    font-weight: 400;
    color: var(--muted);
    margin-left: 8px;
    letter-spacing: 0;
  }
  .spacer {
    flex: 1;
  }
  .saved {
    color: var(--muted);
    font-size: 12px;
  }

  /* ---- layout ----------------------------------------------------------- */

  main {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr) 330px;
    min-height: 0;
  }

  .tools {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 10px;
    border-right: 1px solid var(--line);
    overflow-y: auto;
  }
  .tools button {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
  }
  .tools hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 6px 0;
    width: 100%;
  }

  .stage {
    position: relative;
    min-width: 0;
    min-height: 0;
    /* The canvas is sized from this box, so this box must never be sized by
       the canvas. */
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .tip {
    position: absolute;
    left: 12px;
    top: 12px;
    right: 12px;
    margin: 0;
    padding: 7px 10px;
    border-radius: 9px;
    background: ${scrim};
    border: 1px solid var(--line);
    pointer-events: none;
    max-width: 62ch;
  }

  .side {
    border-left: 1px solid var(--line);
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  section.card {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: ${panelFill};
    padding: 10px;
  }
  section.card > h2 {
    margin: 0 0 8px;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 110px;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .row > label {
    color: var(--muted);
  }
  .row.wide {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .row.wide > label {
    font-size: 12px;
  }
  .pair {
    display: flex;
    gap: 6px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chips button {
    padding: 4px 8px;
    font-size: 12px;
  }
  .chips input[type='color'] {
    width: 30px;
    height: 26px;
    padding: 2px;
    background: ${sunk};
    cursor: pointer;
  }

  /* A colour is its own label — a name for it would be a worse one. */
  button.swatch {
    width: 26px;
    height: 26px;
    padding: 0;
    background: var(--swatch);
    border: 1px solid var(--line);
  }
  button.swatch:hover:not(:disabled) {
    background: var(--swatch);
    filter: brightness(1.15);
  }
  button.swatch[aria-pressed='true'] {
    background: var(--swatch);
    border-color: ${parchment};
    box-shadow: 0 0 0 2px ${ink}, 0 0 0 3px ${parchment};
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .list .entry {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .list .entry > button:first-child {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list .entry small {
    color: var(--muted);
    white-space: nowrap;
  }

  .note {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  /* ---- checks ----------------------------------------------------------- */

  .checks {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .checks li {
    display: flex;
    gap: 7px;
    align-items: baseline;
    font-size: 12px;
  }
  .checks li::before {
    content: '●';
    font-size: 9px;
  }
  .checks li.error::before {
    color: ${red};
  }
  .checks li.warning::before {
    color: ${yellow};
  }
  .checks li.info::before {
    color: ${slate};
  }
  .checks li.pass::before {
    color: ${green};
  }

  /* ---- status bar ------------------------------------------------------- */

  .status {
    display: flex;
    gap: 18px;
    align-items: center;
    padding: 6px 14px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .status .keys {
    margin-left: auto;
  }

  /* ---- dialog ----------------------------------------------------------- */

  .veil {
    position: fixed;
    inset: 0;
    background: ${veil};
    display: grid;
    place-items: center;
    padding: 24px;
    z-index: 10;
  }
  .dialog {
    width: min(760px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: ${massing};
    padding: 16px;
    animation: rise ${panelIn} ${ease};
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dialog {
      animation: none;
    }
  }
  .dialog header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dialog h2 {
    margin: 0;
    font-size: 15px;
  }
  .dialog textarea {
    flex: 1;
    min-height: 240px;
    resize: vertical;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
  }
  .dialog .actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .problem {
    margin: 0;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid ${alarmEdge};
    background: ${alarmFill};
  }
`;
