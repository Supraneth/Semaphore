import type { BoxFormat, Calibration, CameraConfig, ImageXY, LngLat } from './types';
import { LocalFrame, centroid } from './geo';

export type { BoxFormat };

/**
 * Image plane → ground plane, by 4-point homography.
 *
 * Frigate publishes a bounding box. The bottom edge of that box is where the
 * object meets the ground, and the ground is a plane. A plane seen through a
 * pinhole lens maps to the image by a projective transform, so four
 * correspondences pin it down exactly — no lens intrinsics, no camera pose, no
 * calibration target. Four paving stones will do.
 *
 * That is the whole trick behind a person walking across the garden becoming a
 * point walking across the map.
 */

/** Row-major 3×3, with `h[8]` fixed at 1. */
export type Homography = number[];

/**
 * Solves `A x = b` by Gaussian elimination with partial pivoting.
 * Returns null when the system is singular — which here means the four points
 * were degenerate (three of them collinear, typically).
 */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const d = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

/**
 * The DLT for exactly four correspondences.
 *
 * Each pair contributes two rows:
 *   [x y 1 0 0 0 -Xx -Xy] · h = X
 *   [0 0 0 x y 1 -Yx -Yy] · h = Y
 * which is eight equations for the eight free parameters, so it is an exact
 * solve rather than a least-squares fit.
 */
export function solveHomography(
  src: Array<[number, number]>,
  dst: Array<[number, number]>,
): Homography | null {
  if (src.length < 4 || dst.length < 4) return null;

  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }

  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

export function applyHomography(h: Homography, p: [number, number]): [number, number] | null {
  const [x, y] = p;
  const w = h[6] * x + h[7] * y + h[8];
  // A point on the horizon maps to infinity. It is not on the ground plane, so
  // there is no honest answer — better no blip than a blip in the next commune.
  if (Math.abs(w) < 1e-9) return null;
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/**
 * A camera's image→ground mapping, solved once and reused.
 *
 * The homography is fitted in local metres rather than in degrees. Longitude
 * and latitude differ by a factor of ~1.5 in metres per degree at this
 * latitude, and their absolute values are large compared to the span of a
 * garden, which makes the 8×8 solve badly conditioned. Fitting in metres around
 * the calibration's own centroid keeps every number small and near-isotropic.
 */
export class GroundProjector {
  private readonly h: Homography | null;
  private readonly frame: LocalFrame;

  constructor(calibration: Calibration) {
    this.frame = new LocalFrame(centroid(calibration.ground));
    this.h =
      calibration.image.length >= 4 && calibration.ground.length >= 4
        ? solveHomography(
            calibration.image.slice(0, 4).map((p) => [p[0], p[1]] as [number, number]),
            calibration.ground.slice(0, 4).map((p) => this.frame.toLocal(p)),
          )
        : null;
  }

  get valid(): boolean {
    return this.h !== null;
  }

  /** Normalised image point → ground position, or null if it cannot land. */
  project(image: ImageXY): LngLat | null {
    if (!this.h) return null;
    const local = applyHomography(this.h, [image[0], image[1]]);
    return local ? this.frame.toLngLat(local) : null;
  }
}

/**
 * Normalises a Frigate box to `[x, y, w, h]` in `[0,1]`.
 *
 * Two things vary across Frigate versions: whether the numbers are pixels or
 * already normalised, and whether they are two corners or a corner plus a size.
 * Pixels are easy — anything above 1.5 cannot be a fraction. The corner/size
 * question has no reliable signature, so `auto` picks the reading that stays
 * inside the frame and falls back to corners when both do. Set `box-format`
 * explicitly once you have looked at one real payload.
 */
export function normaliseBox(
  raw: number[],
  resolution?: [number, number],
  format: BoxFormat = 'auto',
): [number, number, number, number] | null {
  if (!raw || raw.length < 4 || raw.some((n) => typeof n !== 'number' || !isFinite(n))) {
    return null;
  }

  let [a, b, c, d] = raw;
  if (Math.max(a, b, c, d) > 1.5) {
    const [rw, rh] = resolution ?? [1, 1];
    if (rw <= 1 || rh <= 1) return null;
    a /= rw;
    b /= rh;
    c /= rw;
    d /= rh;
  }

  const asCorners = c > a && d > b;
  let corners: boolean;
  if (format === 'xyxy') corners = true;
  else if (format === 'xywh') corners = false;
  else if (!asCorners) corners = false;
  else {
    const cornersFit = c <= 1.001 && d <= 1.001;
    const sizeFits = a + c <= 1.001 && b + d <= 1.001;
    corners = cornersFit || !sizeFits;
  }

  const w = corners ? c - a : c;
  const h = corners ? d - b : d;
  if (w <= 0 || h <= 0) return null;
  return [a, b, w, h];
}

/**
 * Where a detection touches the ground.
 *
 * The bottom-centre of the box, not its middle: an object's centroid floats
 * somewhere inside it, but its feet are on the plane the homography describes.
 */
export function groundPoint(
  camera: CameraConfig,
  raw: number[],
  projector: GroundProjector | null,
  format: BoxFormat = 'auto',
): LngLat | null {
  if (!projector?.valid) return null;
  const box = normaliseBox(raw, camera.resolution, format);
  if (!box) return null;
  const [x, y, w, h] = box;
  return projector.project([x + w / 2, y + h]);
}
