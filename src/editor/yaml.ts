import type { SemaphoreConfig } from '../types';

/**
 * A tiny YAML writer.
 *
 * Pulling in js-yaml to emit one config block would add ~30 kB to a card that
 * already carries MapLibre. The subset needed here — maps, lists, numbers,
 * short strings, inline coordinate pairs — is small enough to write out.
 *
 * Coordinates are rounded to seven decimals: about a centimetre, well past what
 * any consumer camera placement needs, and it keeps the block readable.
 */

const PRECISION = 7;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(PRECISION)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  // Quote anything YAML could misread as a number, bool, or special token.
  return /^[A-Za-z_][\w .'\-àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]*$/.test(s) &&
    !['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(s.toLowerCase())
    ? s
    : JSON.stringify(s);
}

/** A pair of numbers renders inline — a column of lat/lng is unreadable. */
function isCoord(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number');
}

/** Returns a one-line rendering, or null when the value needs its own block. */
function inline(value: unknown): string | null {
  if (isCoord(value)) return `[${value.map(scalar).join(', ')}]`;
  if (Array.isArray(value)) return value.length ? null : '[]';
  if (value && typeof value === 'object') {
    return Object.keys(value as object).length ? null : '{}';
  }
  return scalar(value);
}

/**
 * Emits unindented lines. Working in lines rather than concatenated strings is
 * what keeps list-of-object indentation correct — the `- ` marker belongs to the
 * item's first line, and every following line of that item gets two spaces.
 */
function lines(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      const flat = inline(item);
      if (flat !== null) {
        out.push(`- ${flat}`);
        continue;
      }
      const child = lines(item);
      out.push(`- ${child[0]}`);
      for (let i = 1; i < child.length; i++) out.push(`  ${child[i]}`);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  const out: string[] = [];
  for (const [k, v] of entries) {
    const flat = inline(v);
    if (flat !== null) {
      out.push(`${k}: ${flat}`);
      continue;
    }
    out.push(`${k}:`);
    for (const l of lines(v)) out.push(`  ${l}`);
  }
  return out;
}

export function toYaml(config: Partial<SemaphoreConfig>): string {
  return lines(config).join('\n') + '\n';
}

/**
 * Strips the keys the editor never touches, so the copied block is the plan and
 * the cameras rather than a wholesale dump the user has to diff by eye.
 */
export function planYaml(config: SemaphoreConfig): string {
  return toYaml({
    levels: config.levels.map((l) => ({
      id: l.id,
      name: l.name,
      elevation: l.elevation,
      wallHeight: l.wallHeight,
      rooms: l.rooms?.map((r) => ({
        id: r.id,
        name: r.name,
        height: r.height,
        thickness: r.thickness,
        floor: r.floor,
        transparent: r.transparent,
        ring: r.ring,
      })),
    })),
    cameras: config.cameras.map((c) => ({
      name: c.name,
      label: c.label,
      position: c.position,
      level: c.level,
      height: c.height,
      azimuth: Math.round(c.azimuth),
      fov: Math.round(c.fov),
      range: Math.round(c.range * 10) / 10,
      resolution: c.resolution,
      calibration: c.calibration,
    })),
  });
}

/**
 * Copies, by whichever route the browser allows.
 *
 * `navigator.clipboard` only exists in a secure context, and a great many Home
 * Assistant installs are reached over plain HTTP at `homeassistant.local:8123`.
 * On those the async API is simply `undefined`, so the deprecated
 * `execCommand` path is not a legacy nicety — it is the only one that works.
 *
 * Returns false when both fail, which is the card's cue to show the block for
 * manual selection rather than swallowing the user's work.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied or insecure context — try the old way */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen rather than hidden: `display:none` cannot hold a selection.
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
