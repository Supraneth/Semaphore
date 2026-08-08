import type { Point } from './types';

/** A sight blocker: one wall edge, in local metres. */
export type Segment = readonly [Point, Point];

export interface IsovistRequest {
  origin: Point;
  /** Lens heading in degrees, 0 = north, clockwise. */
  azimuth: number;
  /** Horizontal aperture in degrees. */
  fov: number;
  /** Maximum useful distance in metres. */
  range: number;
  occluders: Segment[];
  /** Angular sampling in degrees. Default 1.5. */
  resolution?: number;
}

const DEG = Math.PI / 180;
/**
 * Rays are also fired this far either side of every occluder corner. Small
 * enough that the pair straddles the corner, large enough to survive float
 * error at 30 m — where it works out to about 1.5 mm of lateral offset.
 */
const CORNER_EPS = 5e-5;
/** Angles closer than this collapse into one ray; below it they are noise. */
const ANGLE_EPS = 1e-6;

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * Explodes closed rings into edges.
 *
 * Rings are implicitly closed — the last point joins the first — because that
 * is how both the room editor and GeoJSON-minus-the-duplicate store them.
 */
export function occludersFromPolygons(rings: Point[][]): Segment[] {
  const segments: Segment[] = [];
  for (const ring of rings) {
    if (ring.length < 2) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) continue;
      segments.push([a, b]);
    }
  }
  return segments;
}

/**
 * Drops segments that cannot possibly block this camera.
 *
 * Harvesting building footprints from vector tiles hands us every polygon in
 * every loaded tile — thousands of edges, nearly all of them a suburb away.
 * Testing each one against every ray would make the isovist quadratic in the
 * size of the basemap rather than in the size of the scene. A bounding-box
 * reject against the range circle is one comparison per segment and removes
 * essentially all of them.
 */
function withinRange(segments: Segment[], origin: Point, range: number): Segment[] {
  const [ox, oy] = origin;
  const out: Segment[] = [];
  for (const s of segments) {
    const minX = Math.min(s[0][0], s[1][0]);
    const maxX = Math.max(s[0][0], s[1][0]);
    const minY = Math.min(s[0][1], s[1][1]);
    const maxY = Math.max(s[0][1], s[1][1]);
    if (maxX < ox - range || minX > ox + range) continue;
    if (maxY < oy - range || minY > oy + range) continue;
    out.push(s);
  }
  return out;
}

/**
 * Distance from `origin` along a unit ray to the nearest blocker, capped at
 * `range`. Returns `range` when the ray reaches open air.
 */
function castRay(
  origin: Point,
  dx: number,
  dy: number,
  range: number,
  segments: Segment[],
): number {
  let nearest = range;
  const [ox, oy] = origin;

  for (const [a, b] of segments) {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const denom = cross(dx, dy, ex, ey);
    // Parallel: either no hit, or a grazing overlap that the corner rays of the
    // adjoining edges already account for.
    if (Math.abs(denom) < 1e-12) continue;

    const qx = a[0] - ox;
    const qy = a[1] - oy;
    const t = cross(qx, qy, ex, ey) / denom;
    if (t <= 0 || t >= nearest) continue;

    const u = cross(qx, qy, dx, dy) / denom;
    if (u < 0 || u > 1) continue;

    nearest = t;
  }
  return nearest;
}

/**
 * The visible region of a camera, as a polygon.
 *
 * A plain wedge traverses walls and lies about coverage. This fires a ray at
 * every occluder corner (plus a regular sweep to keep the outer arc smooth),
 * keeps the first intersection, and stops the polygon at the wall.
 *
 * The result is **star-shaped with respect to the apex** by construction: every
 * vertex is the far end of a ray leaving the camera. That is not a nicety — it
 * is what lets `SceneLayer` triangulate as a trivial fan, with no earcut and no
 * CPU geometry per frame. Any change here has to preserve it.
 *
 * Returns the apex first, then the rim in increasing angle.
 */
export function computeIsovist(req: IsovistRequest): Point[] {
  const { origin, azimuth, range } = req;
  const resolution = Math.max(0.25, req.resolution ?? 1.5);
  const fov = Math.min(360, Math.max(1, req.fov));

  const segments = withinRange(req.occluders, origin, range);

  const half = fov / 2;
  const start = azimuth - half;
  const end = azimuth + half;
  const full = fov >= 359.9;

  // Bearings are clockwise from north, so the ray for angle θ is
  // (sin θ, cos θ) — not the (cos, sin) of a maths convention.
  const angles: number[] = [];
  const steps = Math.ceil(fov / resolution);
  for (let i = 0; i <= steps; i++) angles.push(start + (fov * i) / steps);

  // A corner only changes the silhouette if it is inside the wedge and inside
  // the range; testing that here keeps the ray count proportional to the scene,
  // not to the basemap.
  const seen = new Set<string>();
  for (const seg of segments) {
    for (const p of seg) {
      const dx = p[0] - origin[0];
      const dy = p[1] - origin[1];
      if (dx * dx + dy * dy > range * range) continue;

      const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (!full) {
        // Fold the corner's bearing into the same revolution as the wedge
        // before comparing, otherwise a wedge crossing north rejects its own
        // corners.
        const rel = (((bearing - start) % 360) + 360) % 360;
        if (rel > fov) continue;
      }
      const key = bearing.toFixed(6);
      if (seen.has(key)) continue;
      seen.add(key);
      angles.push(bearing - CORNER_EPS, bearing, bearing + CORNER_EPS);
    }
  }

  angles.sort((a, b) => a - b);

  const rim: Point[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const angle of angles) {
    if (angle - previous < ANGLE_EPS) continue;
    // Corner rays nudged outside the wedge would widen the cone past its own
    // aperture, so they are pulled back to the edge rather than dropped.
    const clamped = full ? angle : Math.min(end, Math.max(start, angle));
    if (clamped - previous < ANGLE_EPS) continue;
    previous = clamped;

    const theta = clamped * DEG;
    const dx = Math.sin(theta);
    const dy = Math.cos(theta);
    const t = castRay(origin, dx, dy, range, segments);
    rim.push([origin[0] + dx * t, origin[1] + dy * t]);
  }

  return [[origin[0], origin[1]], ...rim];
}

/**
 * Fraction of the wedge that survives occlusion, in `[0,1]`.
 *
 * Useful as a diagnostic — a camera reading 0.3 is mostly pointed at a wall.
 */
export function isovistCoverage(isovist: Point[], range: number, fov: number): number {
  if (isovist.length < 3 || range <= 0) return 0;
  const apex = isovist[0];
  let area = 0;
  for (let i = 1; i < isovist.length - 1; i++) {
    const a = isovist[i];
    const b = isovist[i + 1];
    area += Math.abs(
      cross(a[0] - apex[0], a[1] - apex[1], b[0] - apex[0], b[1] - apex[1]),
    ) / 2;
  }
  const ideal = (Math.min(360, fov) * DEG * range * range) / 2;
  return ideal > 0 ? Math.min(1, area / ideal) : 0;
}
