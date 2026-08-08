import type { Level, Point } from '../types';
import { dist, levelPoints, projectOnSegment } from './geometry';

/**
 * Where a click actually lands.
 *
 * Drawing a plan by aiming at pixels produces walls that are 4.03 m long and
 * 0.7° off square, and a scene that never quite closes. Everything the pointer
 * proposes therefore passes through here first, in a fixed order of priority:
 * an existing vertex beats a wall edge, which beats the angle constraint, which
 * beats the grid. The most specific thing the user could plausibly have meant
 * wins.
 */

export type SnapKind = 'vertex' | 'edge' | 'angle' | 'grid' | 'free';

export interface SnapResult {
  point: Point;
  kind: SnapKind;
  /** Set when the result came from an existing vertex or edge. */
  targetId?: string;
  /** Degrees, when the angle constraint fired. */
  angle?: number;
}

export interface SnapOptions {
  level: Level;
  /** Metres per pixel, so tolerances stay constant on screen at any zoom. */
  metresPerPixel: number;
  grid: number;
  /** The point being drawn from, if a chain is in progress. */
  anchor?: Point;
  /** Held Shift releases the angle and grid constraints. */
  free?: boolean;
  /** Extra candidate vertices — a draft ring not yet committed. */
  extra?: Point[];
  /** Vertices to ignore, so a dragged handle does not snap to itself. */
  exclude?: Point[];
}

/** Screen-space tolerances, converted to metres at the current zoom. */
const VERTEX_PIXELS = 12;
const EDGE_PIXELS = 8;
/** Directions the angle constraint locks onto. */
const ANGLE_STEP = 15;
/** How close to a locked direction before it takes over, in degrees. */
const ANGLE_PIXELS = 10;

const near = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

export function snapToGrid(p: Point, grid: number): Point {
  if (grid <= 0) return p;
  return [Math.round(p[0] / grid) * grid, Math.round(p[1] / grid) * grid];
}

/**
 * Locks a direction to a multiple of 15°, measured from the anchor.
 *
 * The tolerance is expressed in pixels rather than degrees on purpose: near the
 * anchor a degree is a fraction of a pixel and the lock would be impossible to
 * escape, while three metres out a fixed 5° tolerance would be a 26 cm dead
 * zone. Converting through the current radius keeps the feel constant.
 */
function constrainAngle(
  anchor: Point,
  target: Point,
  metresPerPixel: number,
): { point: Point; angle: number } | null {
  const dx = target[0] - anchor[0];
  const dy = target[1] - anchor[1];
  const radius = Math.hypot(dx, dy);
  if (radius < 1e-6) return null;

  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  const locked = Math.round(bearing / ANGLE_STEP) * ANGLE_STEP;
  const offBy = Math.abs(((bearing - locked + 540) % 360) - 180);

  const toleranceDeg = ((ANGLE_PIXELS * metresPerPixel) / radius) * (180 / Math.PI);
  if (offBy > Math.max(0.5, Math.min(12, toleranceDeg))) return null;

  const theta = (locked * Math.PI) / 180;
  return {
    point: [anchor[0] + Math.sin(theta) * radius, anchor[1] + Math.cos(theta) * radius],
    angle: (locked + 360) % 360,
  };
}

/**
 * Rounds the distance from the anchor to a whole grid step while keeping the
 * direction. Without this, an angle-locked wall still ends at 4.03 m.
 */
function roundLength(anchor: Point, p: Point, grid: number): Point {
  if (grid <= 0) return p;
  const dx = p[0] - anchor[0];
  const dy = p[1] - anchor[1];
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return p;
  const rounded = Math.max(grid, Math.round(l / grid) * grid);
  return [anchor[0] + (dx / l) * rounded, anchor[1] + (dy / l) * rounded];
}

export function snap(world: Point, options: SnapOptions): SnapResult {
  const { level, metresPerPixel, grid, anchor, free, extra = [], exclude = [] } = options;

  if (free) {
    return { point: world, kind: 'free' };
  }

  const vertexTolerance = VERTEX_PIXELS * metresPerPixel;
  const edgeTolerance = EDGE_PIXELS * metresPerPixel;

  // 1. An existing vertex. This is what makes two rooms share a corner exactly
  //    instead of leaving a gap a camera can see through.
  let best: Point | null = null;
  let bestDistance = vertexTolerance;
  for (const candidate of [...levelPoints(level), ...extra]) {
    if (exclude.some((e) => near(e, candidate))) continue;
    const d = dist(candidate, world);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  if (best) return { point: [best[0], best[1]], kind: 'vertex' };

  // 2. A point on a wall — how a partition gets attached mid-span.
  let edgePoint: Point | null = null;
  let edgeDistance = edgeTolerance;
  let edgeId: string | undefined;
  for (const wall of level.walls ?? []) {
    const hit = projectOnSegment(world, wall.a, wall.b);
    if (hit.distance < edgeDistance) {
      edgeDistance = hit.distance;
      edgePoint = hit.point;
      edgeId = wall.id;
    }
  }
  if (edgePoint) return { point: edgePoint, kind: 'edge', targetId: edgeId };

  // 3. The angle lock, when drawing a chain.
  if (anchor) {
    const locked = constrainAngle(anchor, world, metresPerPixel);
    if (locked) {
      return { point: roundLength(anchor, locked.point, grid), kind: 'angle', angle: locked.angle };
    }
  }

  // 4. The grid.
  return { point: snapToGrid(world, grid), kind: 'grid' };
}

/** Places a point at an exact distance and bearing from the anchor. */
export function pointAt(anchor: Point, bearingDeg: number, metres: number): Point {
  const theta = (bearingDeg * Math.PI) / 180;
  return [anchor[0] + Math.sin(theta) * metres, anchor[1] + Math.cos(theta) * metres];
}

/** `4.2` → `4,20 m`. The plan is French and so are its decimals. */
export function formatMetres(m: number): string {
  return `${m.toFixed(2).replace('.', ',')} m`;
}

export function formatArea(m2: number): string {
  return `${m2.toFixed(1).replace('.', ',')} m²`;
}
