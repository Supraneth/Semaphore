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
  // Quote anything YAML could misread as a number, bool, or special token. A
  // colon is allowed as long as no space follows it, which is what lets
  // `custom:semaphore-card` be written the way every other card writes it —
  // quoting it is legal but reads as a mistake in a config people diff by eye.
  return /^[A-Za-z_][\w .'\-àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]*(:[^\s]+)?$/.test(s) &&
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

/**
 * Serialises any plain object.
 *
 * Deliberately untyped: `planYaml` builds a trimmed, rounded shape that is not
 * a `SemaphoreConfig` — half its fields are optional and it drops the ones the
 * editor never touches. Shapes are checked on the way back in, by
 * `validateConfig`, so the writer stays a writer.
 */
export function toYaml(value: Record<string, unknown>): string {
  return lines(value).join('\n') + '\n';
}

/**
 * Emits the block the editor is responsible for: the levels, their walls,
 * rooms and openings, and the cameras.
 *
 * Everything else in the config — topic prefix, timeline span, alert labels —
 * is typed by hand and never touched here, so the copied block is something
 * you can read rather than a wholesale dump to diff by eye.
 */
export function planYaml(config: SemaphoreConfig): string {
  return toYaml(planBody(config));
}

/**
 * The whole card configuration, ready to paste.
 *
 * `planYaml` emits the block the in-card editor owns, which assumes the rest of
 * the config already exists around it. The standalone editor has no such
 * surrounding config: what it produces is the entire card, `type` line
 * included, or the user has to assemble two halves by hand — which is where a
 * working plan turns into a card that will not load.
 */
export function cardYaml(config: SemaphoreConfig): string {
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length ? (v as string[]) : undefined;

  // Scalars first, then the two long blocks. A reader scanning the pasted
  // config finds every knob in the first dozen lines instead of hunting for
  // `decay-seconds` under two hundred coordinates.
  return toYaml({
    type: config.type || 'custom:semaphore-card',
    'topic-prefix': config['topic-prefix'],
    'instance-id': config['instance-id'],
    'box-format': config['box-format'] === 'auto' ? undefined : config['box-format'],
    'alert-labels': strings(config['alert-labels']),
    'timeline-hours': config['timeline-hours'],
    'decay-seconds': config['decay-seconds'],
    'orbit-speed': config['orbit-speed'],
    'orbit-resume': config['orbit-resume'],
    'fov-resolution': config['fov-resolution'],
    ...planBody(config, { view: true }),
  });
}

function planBody(
  config: SemaphoreConfig,
  options: { view?: boolean } = {},
): Record<string, unknown> {
  const round = (n: number | undefined, places = 2): number | undefined =>
    n === undefined ? undefined : Math.round(n * 10 ** places) / 10 ** places;
  const pt = (p: [number, number]): [number, number] => [round(p[0])!, round(p[1])!];

  return {
    grid: config.grid,
    // Only when they differ from the default: a config that repeats every
    // default back at you is one nobody reads twice.
    'show-grid': config['show-grid'] === false ? false : undefined,
    'show-labels': config['show-labels'] === false ? false : undefined,
    'show-timeline': config['show-timeline'] === false ? false : undefined,
    height: config.height,
    'max-height': config['max-height'],
    'aspect-ratio': config['aspect-ratio'],
    'floor-opacity':
      config['floor-opacity'] !== undefined && Math.abs(config['floor-opacity'] - 0.1) > 1e-6
        ? round(config['floor-opacity'], 2)
        : undefined,
    view:
      options.view && config.view
        ? {
            yaw: round(config.view.yaw, 1),
            pitch: round(config.view.pitch, 1),
            zoom: round(config.view.zoom, 1),
            center: config.view.center ? pt(config.view.center) : undefined,
          }
        : undefined,
    levels: config.levels.map((l) => ({
      id: l.id,
      name: l.name,
      elevation: l.elevation,
      wallHeight: l.wallHeight,
      underlay: l.underlay
        ? {
            url: l.underlay.url,
            origin: pt(l.underlay.origin),
            scale: round(l.underlay.scale, 6),
            rotation: round(l.underlay.rotation),
            opacity: l.underlay.opacity,
          }
        : undefined,
      walls: l.walls?.length
        ? l.walls.map((w) => ({
            id: w.id,
            a: pt(w.a),
            b: pt(w.b),
            thickness: round(w.thickness),
            height: round(w.height),
            transparent: w.transparent,
            openings: w.openings?.length
              ? w.openings.map((o) => ({
                  id: o.id,
                  kind: o.kind,
                  at: round(o.at),
                  width: round(o.width),
                  sill: round(o.sill),
                  head: round(o.head),
                  blocksSight: o.blocksSight,
                  entity: o.entity,
                }))
              : undefined,
          }))
        : undefined,
      rooms: l.rooms?.length
        ? l.rooms.map((r) => ({ id: r.id, name: r.name, color: r.color, ring: r.ring.map(pt) }))
        : undefined,
    })),
    cameras: config.cameras.map((c) => ({
      name: c.name,
      label: c.label,
      position: pt(c.position),
      level: c.level,
      height: round(c.height),
      azimuth: Math.round(c.azimuth),
      fov: Math.round(c.fov),
      range: round(c.range, 1),
      entity: c.entity,
      color: c.color,
      resolution: c.resolution,
      calibration: c.calibration
        ? { image: c.calibration.image, ground: c.calibration.ground.map(pt) }
        : undefined,
    })),
  };
}

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
