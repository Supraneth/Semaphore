import { css, unsafeCSS } from 'lit';
import { CHART, MOTION, withAlpha } from './theme';

/**
 * The chrome every Sémaphore element shares.
 *
 * The card, the event feed and the video wall are separate custom elements with
 * separate shadow roots, so a stylesheet cannot simply cascade into them. This
 * is the part that must look identical in all three — glass, segmented
 * controls, icon buttons, state pips — kept in one place so a change to the
 * glass recipe cannot apply to two of the three.
 *
 * Everything responsive lives in the consumers, never here: a rule about width
 * belongs to whatever is being made narrow.
 */

const ink = unsafeCSS(CHART.ink);
const parchment = unsafeCSS(CHART.parchment);
const white = unsafeCSS(CHART.sectorWhite);
const tap = unsafeCSS(`${MOTION.tap}ms`);
const ease = unsafeCSS(MOTION.ease);

export const glassBg = unsafeCSS(withAlpha(CHART.ink, 0.72));
export const glassBgSolid = unsafeCSS(withAlpha(CHART.ink, 0.9));
export const glassEdge = unsafeCSS(withAlpha(CHART.parchment, 0.16));
export const glassEdgeLit = unsafeCSS(withAlpha(CHART.parchment, 0.28));

export const chrome = css`
  :host {
    --semaphore-ink: ${ink};
    --semaphore-parchment: ${parchment};
    --semaphore-radius: var(--ha-card-border-radius, 12px);
    --semaphore-inset: 10px;
  }

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
  button.icon:focus-visible {
    outline: 2px solid ${white};
    outline-offset: 2px;
  }

  /* Carries the state colour of whatever it sits in, via currentColor. */
  .pip {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
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

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }

  @media (pointer: coarse) {
    .segmented button {
      padding: 9px 13px;
    }
    button.icon {
      width: 36px;
      height: 36px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      animation: none !important;
      transition: none !important;
    }
  }
`;
