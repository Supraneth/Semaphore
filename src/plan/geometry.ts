import type { Level, Opening, Point, Room, Wall } from '../types';
import type { Segment } from '../fov';

/**
 * Turning the document into things to draw and things to raycast.
 *
 * The load-bearing rule: a wall is described once and used twice — extruded
 * into faces for the picture, and flattened into segments for the isovist.
 * Openings subtract from both in the same pass, so a door you can see through
 * is a door you can also see through in the coverage calculation. Two sources
 * of wall geometry would let the picture and the coverage disagree, which is
 * the failure mode that makes a tool like this untrustworthy.
 */

export const DEFAULT_THICKNESS = 0.2;
export const DEFAULT_WALL_HEIGHT = 2.5;

export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
export const len = (v: Point): number => Math.hypot(v[0], v[1]);
export const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function normalise(v: Point): Point {
  const l = len(v);
  return l < 1e-9 ? [0, 0] : [v[0] / l, v[1] / l];
}

/** Point at `t` metres from `a` towards `b`. */
export function along(a: Point, b: Point, t: number): Point {
  const u = normalise(sub(b, a));
  return [a[0] + u[0] * t, a[1] + u[1] * t];
}

/** Wall bearing in degrees, 0 = +y, clockwise — the same convention as azimuth. */
export function bearing(a: Point, b: Point): number {
  return (((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI) + 360) % 360;
}

/**
 * Shortest distance from `p` to segment `a`-`b`, plus where along it that
 * happened. Used for hit-testing walls and for placing an opening where the
 * user clicked on one.
 */
export function projectOnSegment(
  p: Point,
  a: Point,
  b: Point,
): { distance: number; t: number; point: Point } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  const raw = l2 < 1e-12 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2;
  const t = Math.max(0, Math.min(1, raw));
  const point: Point = [a[0] + abx * t, a[1] + aby * t];
  return { distance: dist(p, point), t: t * Math.sqrt(l2), point };
}

export const wallThickness = (wall: Wall): number => wall.thickness ?? DEFAULT_THICKNESS;

export const wallHeight = (wall: Wall, level: Level): number =>
  wall.height ?? level.wallHeight ?? DEFAULT_WALL_HEIGHT;

/**
 * The wall's footprint as a rectangle.
 *
 * Extended by half the thickness at both ends so that walls meeting at a corner
 * overlap instead of leaving a notch. At 20 cm the overlap is invisible and it
 * is far more robust than a real miter join on the concave, three-way and
 * near-parallel junctions people actually draw.
 */
export function wallFootprint(wall: Wall): [Point, Point, Point, Point] {
  const t = wallThickness(wall) / 2;
  const u = normalise(sub(wall.b, wall.a));
  const n: Point = [-u[1] * t, u[0] * t];
  const a: Point = [wall.a[0] - u[0] * t, wall.a[1] - u[1] * t];
  const b: Point = [wall.b[0] + u[0] * t, wall.b[1] + u[1] * t];
  return [
    [a[0] + n[0], a[1] + n[1]],
    [b[0] + n[0], b[1] + n[1]],
    [b[0] - n[0], b[1] - n[1]],
    [a[0] - n[0], a[1] - n[1]],
  ];
}

/** Openings, clamped to the wall and sorted, so spans never overlap or escape. */
export function tidyOpenings(wall: Wall): Opening[] {
  const total = dist(wall.a, wall.b);
  const out: Opening[] = [];
  for (const o of [...(wall.openings ?? [])].sort((p, q) => p.at - q.at)) {
    const at = Math.max(0, Math.min(total, o.at));
    const width = Math.max(0.05, Math.min(total - at, o.width));
    if (width <= 0.05) continue;
    const previous = out[out.length - 1];
    if (previous && at < previous.at + previous.width) continue;
    out.push({ ...o, at, width });
  }
  return out;
}

/**
 * The solid stretches of a wall: its length minus its openings.
 *
 * Returned as `[start, end]` pairs in metres along the wall. Both the renderer
 * and the occluder builder consume this, which is what keeps them agreeing.
 */
export function solidSpans(wall: Wall): Array<[number, number]> {
  const total = dist(wall.a, wall.b);
  if (total < 1e-6) return [];
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const o of tidyOpenings(wall)) {
    if (o.at > cursor + 1e-6) spans.push([cursor, o.at]);
    cursor = Math.max(cursor, o.at + o.width);
  }
  if (cursor < total - 1e-6) spans.push([cursor, total]);
  return spans;
}

/**
 * Sight blockers for a level.
 *
 * A transparent wall contributes nothing. An opening contributes nothing unless
 * it is explicitly marked `blocksSight` — a doorway is a hole in the sight line
 * as much as in the masonry, and getting that wrong is what makes an indoor
 * camera's cone obviously wrong to anyone who lives there.
 */
export function occludersFor(level: Level): Segment[] {
  const segments: Segment[] = [];

  for (const wall of level.walls ?? []) {
    if (wall.transparent) continue;
    const total = dist(wall.a, wall.b);
    if (total < 1e-6) continue;

    const blocking = new Set(
      tidyOpenings(wall)
        .filter((o) => o.blocksSight)
        .map((o) => o.id),
    );

    // Opaque openings are put back by treating them as solid, so the span list
    // is computed from the openings that really are holes.
    const holes = tidyOpenings(wall).filter((o) => !blocking.has(o.id));
    let cursor = 0;
    const push = (from: number, to: number): void => {
      if (to - from < 1e-6) return;
      segments.push([along(wall.a, wall.b, from), along(wall.a, wall.b, to)]);
    };
    for (const o of holes) {
      push(cursor, o.at);
      cursor = Math.max(cursor, o.at + o.width);
    }
    push(cursor, total);
  }

  return segments;
}

/** Signed area of a ring. Negative means clockwise. */
export function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export const area = (ring: Point[]): number => Math.abs(signedArea(ring));

/** Centroid of a ring, for placing the label inside the room. */
export function centroid(ring: Point[]): Point {
  const a = signedArea(ring);
  if (Math.abs(a) < 1e-9) {
    // Degenerate ring: fall back to the mean so a label still lands somewhere
    // sensible rather than at the origin.
    const n = ring.length || 1;
    return [
      ring.reduce((s, p) => s + p[0], 0) / n,
      ring.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function pointInRing(p: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Every vertex in a level, for snapping and for framing the view. */
export function levelPoints(level: Level): Point[] {
  const points: Point[] = [];
  for (const wall of level.walls ?? []) points.push(wall.a, wall.b);
  for (const room of level.rooms ?? []) points.push(...room.ring);
  return points;
}

export function allPoints(levels: Level[], extra: Point[] = []): Point[] {
  const points = [...extra];
  for (const level of levels) points.push(...levelPoints(level));
  return points;
}

export function findRoom(levels: Level[], id: string): Room | undefined {
  for (const level of levels) {
    const room = level.rooms?.find((r) => r.id === id);
    if (room) return room;
  }
  return undefined;
}

export function findWall(levels: Level[], id: string): Wall | undefined {
  for (const level of levels) {
    const wall = level.walls?.find((w) => w.id === id);
    if (wall) return wall;
  }
  return undefined;
}
