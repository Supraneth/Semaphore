import type { LngLat, LocalXY } from './types';

const DEG = Math.PI / 180;
/** WGS84 metres per degree of latitude, near enough over a building. */
const M_PER_DEG_LAT = 111_320;

/**
 * A local tangent plane in metres.
 *
 * Every angle, distance and ray in this card is computed here rather than in
 * degrees. Doing geometry on lng/lat means a metre of longitude and a metre of
 * latitude are different numbers, so a circle comes out an ellipse and an
 * isovist ray fired at 45° does not land at 45°.
 *
 * The flat-earth approximation costs nothing at this scale: over the ~200 m a
 * home camera scene spans, the error against a proper projection is under a
 * millimetre.
 */
export class LocalFrame {
  readonly origin: LngLat;
  private readonly mPerDegLng: number;

  constructor(origin: LngLat) {
    this.origin = origin;
    // Longitude degrees shrink towards the poles; latitude degrees do not.
    this.mPerDegLng = M_PER_DEG_LAT * Math.cos(origin[1] * DEG);
  }

  toLocal(ll: LngLat): LocalXY {
    return [
      (ll[0] - this.origin[0]) * this.mPerDegLng,
      (ll[1] - this.origin[1]) * M_PER_DEG_LAT,
    ];
  }

  toLngLat(p: LocalXY): LngLat {
    return [
      this.origin[0] + p[0] / this.mPerDegLng,
      this.origin[1] + p[1] / M_PER_DEG_LAT,
    ];
  }

  /** Ground distance in metres, without a round trip through lng/lat. */
  distance(a: LngLat, b: LngLat): number {
    const p = this.toLocal(a);
    const q = this.toLocal(b);
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
}

/** Mean of a set of positions. Used to centre the scene on the cameras. */
export function centroid(points: LngLat[]): LngLat {
  if (!points.length) return [0, 0];
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/**
 * Signed smallest angle from `a` to `b`, in `(-180, 180]`.
 *
 * Compass headings wrap, so `350°` and `10°` are 20° apart, not 340°. Every
 * comparison of two bearings in this codebase goes through here.
 */
export function bearingDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Normalises any angle into `[0, 360)`. */
export function normaliseBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Bearing in degrees from local point `a` to `b`, 0 = north, clockwise. */
export function bearingBetween(a: LocalXY, b: LocalXY): number {
  return normaliseBearing((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI);
}
