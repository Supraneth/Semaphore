import type { Detection } from './types';

/**
 * Times and spans, written the way the card speaks them.
 *
 * Shared because the verdict line, the feed, the timeline axis and the focus
 * panel all say the same things and must say them identically — "il y a 4 min"
 * in one place and "4 minutes" in another reads as two different systems.
 */

export const two = (n: number): string => String(n).padStart(2, '0');

export const clockLabel = (t: number): string => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

export const hourLabel = (t: number): string => `${two(new Date(t).getHours())} h`;

/** A span, in the coarsest unit that still says something. */
export function durationLabel(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${two(rest)}` : `${hours} h`;
  }
  return `${Math.round(hours / 24)} j`;
}

export const spanOf = (det: Detection): number =>
  (det.endTime ?? Date.now()) - det.startTime;

/**
 * How long ago, as a phrase.
 *
 * "il y a 3 s" for something happening right now reads as a stopwatch rather
 * than as news, and it changes on every tick — which on a line carrying
 * `aria-live` means a screen reader announcing the same event ten times.
 */
export function agoLabel(t: number, now: number): string {
  const delta = now - t;
  return delta < 45_000 ? "à l'instant" : `il y a ${durationLabel(delta)}`;
}

/** A day marker for the feed: today and yesterday are worth naming. */
export function dayLabel(t: number, now: number): string {
  const day = new Date(t);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(day, today)) return "Aujourd'hui";
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(day, yesterday)) return 'Hier';
  return day.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
