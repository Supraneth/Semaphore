import type { CameraState } from './types';

/**
 * The nautical chart palette.
 *
 * On a paper chart a lighthouse's coverage is drawn as a coloured angular
 * sector: white where the channel is clear, red and green where it is not. A
 * field of view is the same object — a wedge whose meaning depends on where you
 * stand inside it. Borrowing the convention gives colours that *carry
 * information* instead of decorating, and sidesteps the black-background,
 * acid-accent look every other surveillance UI has.
 *
 * Every colour in the card comes from here. Nothing else may hard-code a hex.
 */
export const CHART = {
  /** Clear sector: nothing to report. */
  sectorWhite: '#F4E7BE',
  /** Unclassified movement — a buoy light, not yet a hazard. */
  buoyYellow: '#E2A23A',
  /** A classified object is in the sector. */
  sectorRed: '#D9503C',
  /** Degraded feed: the light is lit but not to be trusted. */
  sectorGreen: '#2F9E6B',
  /** Off air. A sector fill and a border — never text. */
  slate: '#5B7285',
  /**
   * The same slate, lifted until it can be read.
   *
   * `slate` on `ink` is about 3.2:1, which is under the 4.5:1 that 11 px text
   * needs — and 11 px is exactly the size it was being used at, on the track
   * labels, the legend and the panel's meta line. This one is 6.1:1. The
   * darker value stays for the things that are not text: an offline sector, a
   * hairline, an empty lane.
   */
  slateText: '#8FA3B4',

  /** Deep chart blue — halos, strokes, the ground under everything. */
  ink: '#0C2233',
  /** Chart paper. Text on ink, floors on the map. */
  parchment: '#EFE7D4',
  /** Paper in shadow: wall faces. */
  parchmentShade: '#D6CDB6',
  /** Basemap building extrusions, a shade off the ink. */
  massing: '#12303F',
} as const;

/** `#RRGGBB` to a `[0,255]` triple. */
export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * `#RRGGBB` plus an alpha, as a canvas fill string.
 *
 * Every translucent colour in the renderer goes through here rather than being
 * written as an `rgba(...)` literal, so the palette above stays the only place
 * a colour is defined.
 */
export function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#')) return hex;
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/**
 * Blends `over` onto `base`, `t` of the way.
 *
 * Solid geometry is shaded by *colour*, never by opacity. A wall face at 70 %
 * alpha shows the floor and the coverage through it, which is exactly what
 * makes a house look like a stack of glass boxes instead of a building.
 */
export function mix(base: string, over: string, t: number): string {
  const [r0, g0, b0] = hexRgb(base);
  const [r1, g1, b1] = hexRgb(over);
  const k = Math.max(0, Math.min(1, t));
  const at = (a: number, b: number): number => Math.round(a + (b - a) * k);
  return `rgb(${at(r0, r1)}, ${at(g0, g1)}, ${at(b0, b1)})`;
}

export interface StateStyle {
  css: string;
  /** Base alpha of the sector fill. */
  intensity: number;
  /**
   * Sweep speed in revolutions per second. Zero means a still sector — and a
   * still sector is what lets the rAF loop stop entirely.
   */
  sweep: number;
  caption: string;
}

export const STATE_STYLES: Record<CameraState, StateStyle> = {
  nominal: {
    css: CHART.sectorWhite,
    intensity: 0.16,
    sweep: 0,
    caption: 'Veille',
  },
  motion: {
    css: CHART.buoyYellow,
    intensity: 0.3,
    sweep: 0.22,
    caption: 'Mouvement',
  },
  alert: {
    css: CHART.sectorRed,
    intensity: 0.42,
    sweep: 0.5,
    caption: 'Détection',
  },
  degraded: {
    css: CHART.sectorGreen,
    intensity: 0.24,
    sweep: 0.12,
    caption: 'Flux dégradé',
  },
  offline: {
    css: CHART.slate,
    intensity: 0.08,
    sweep: 0,
    caption: 'Hors ligne',
  },
};

/**
 * Colour for a detection blip.
 *
 * People are the thing you actually look for, so they get the red that already
 * means "classified object". Vehicles get the buoy yellow. Everything else —
 * Frigate will happily label a cat — falls back to chart white so an unusual
 * label never reads as more urgent than a person.
 */
const LABEL_COLOURS: Record<string, string> = {
  person: CHART.sectorRed,
  car: CHART.buoyYellow,
  motorcycle: CHART.buoyYellow,
  bus: CHART.buoyYellow,
  truck: CHART.buoyYellow,
  bicycle: CHART.sectorGreen,
  dog: CHART.sectorGreen,
  cat: CHART.sectorGreen,
};

export function labelCss(label: string): string {
  return LABEL_COLOURS[label] ?? CHART.sectorWhite;
}

/**
 * A Frigate label, in the language the rest of the card speaks.
 *
 * The verdict line is a sentence someone reads at a glance from across the
 * room; `person — Entrée` makes them parse it. Anything Frigate emits that is
 * not in this list falls through unchanged, which is right — a custom model's
 * label is the user's own word and translating it would be a guess.
 */
const LABEL_NAMES: Record<string, string> = {
  person: 'Personne',
  car: 'Voiture',
  truck: 'Camion',
  bus: 'Bus',
  motorcycle: 'Moto',
  bicycle: 'Vélo',
  dog: 'Chien',
  cat: 'Chat',
};

export function labelName(label: string): string {
  return LABEL_NAMES[label] ?? label;
}

/**
 * Animation timings, in milliseconds.
 *
 * Three durations, not a scale: 180 for something that just acknowledges a
 * click, 320 for a panel arriving, 650 for a change of scene. Camera flights
 * get 900 because the map has further to travel than any DOM element.
 */
export const MOTION = {
  tap: 180,
  panel: 320,
  scene: 650,
  flight: 900,
  /** Overshoot-free arrival. Everything that lands uses this. */
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;
