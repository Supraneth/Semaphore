import type { Point } from '../types';

const DEG = Math.PI / 180;

/**
 * The 2.5D camera.
 *
 * Deliberately **orthographic**, not perspective. A perspective view is prettier
 * for a hero shot and actively hostile to drawing: parallel walls converge, the
 * grid spacing changes across the screen, and the inverse mapping needs a ray
 * cast against the floor plane. Orthographic keeps every metre the same number
 * of pixels, so a grid stays a grid, and `unproject` is an exact closed form —
 * click a point, get that point, every time.
 *
 * Pitch 0 is a flat plan view, which is the right mode for tracing. Pitch 55-65
 * is the 2.5D reading. It is the same camera either way, so there is no mode
 * switch and no second code path.
 */
export class View {
  /** Degrees clockwise. 0 looks along +y. */
  yaw = 0;
  /** Degrees. 0 = top-down, 90 = edge-on. */
  pitch = 55;
  /** Pixels per metre. */
  zoom = 34;
  /** World point held at the centre of the canvas. */
  center: Point = [0, 0];

  /** Canvas size in CSS pixels. */
  width = 0;
  height = 0;

  private cy = 1;
  private sy = 0;
  private cp = 1;
  private sp = 0;

  constructor(init?: Partial<View>) {
    Object.assign(this, init);
    this.refresh();
  }

  /** Must be called after any change to yaw or pitch. */
  refresh(): void {
    // Pitch is clamped short of 90: at exactly edge-on the floor plane
    // collapses to a line and unproject divides by zero.
    this.pitch = Math.max(0, Math.min(85, this.pitch));
    this.zoom = Math.max(4, Math.min(400, this.zoom));
    const y = this.yaw * DEG;
    const p = this.pitch * DEG;
    this.cy = Math.cos(y);
    this.sy = Math.sin(y);
    this.cp = Math.cos(p);
    this.sp = Math.sin(p);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** World metres → screen pixels. `z` is height above the floor. */
  project(x: number, y: number, z = 0): Point {
    const dx = x - this.center[0];
    const dy = y - this.center[1];
    const east = dx * this.cy + dy * this.sy;
    const north = -dx * this.sy + dy * this.cy;
    return [
      this.width / 2 + east * this.zoom,
      this.height / 2 - (north * this.cp + z * this.sp) * this.zoom,
    ];
  }

  projectPoint(p: Point, z = 0): Point {
    return this.project(p[0], p[1], z);
  }

  /**
   * Screen pixels → world metres on the floor plane.
   *
   * Exact inverse of `project` at z = 0. This is what every click, drag and
   * snap goes through, so it has to be exact rather than iterative.
   */
  unproject(sx: number, sy: number): Point {
    const east = (sx - this.width / 2) / this.zoom;
    const north = -(sy - this.height / 2) / this.zoom / this.cp;
    return [
      this.center[0] + east * this.cy - north * this.sy,
      this.center[1] + east * this.sy + north * this.cy,
    ];
  }

  /**
   * Depth key for the painter's algorithm: how far north a point sits after
   * yaw. Larger is further away, so it is drawn first.
   */
  depth(x: number, y: number): number {
    return -(x - this.center[0]) * this.sy + (y - this.center[1]) * this.cy;
  }

  /**
   * Zooms about a fixed screen point, so the world under the cursor stays
   * under the cursor. Anything else feels like the map is fighting you.
   */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.unproject(sx, sy);
    this.zoom *= factor;
    this.refresh();
    const after = this.unproject(sx, sy);
    this.center[0] += before[0] - after[0];
    this.center[1] += before[1] - after[1];
  }

  /** Drags the world with the pointer, in world units. */
  panBy(dxPixels: number, dyPixels: number): void {
    const east = dxPixels / this.zoom;
    const north = -dyPixels / this.zoom / this.cp;
    this.center[0] -= east * this.cy - north * this.sy;
    this.center[1] -= east * this.sy + north * this.cy;
  }

  /**
   * Frames a set of world points.
   *
   * `maxHeight` matters as much as the footprint: a wall, and especially a
   * separated upper storey, is painted above its own floor, so the screen
   * height a scene needs is `depth·cos(pitch) + height·sin(pitch)`. Fitting to
   * the footprint alone puts the top of the building off the canvas.
   */
  fit(points: Point[], margin = 1.5, maxHeight = 0): void {
    if (!points.length || !this.width || !this.height) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    this.center = [(minX + maxX) / 2, (minY + maxY) / 2];
    const w = maxX - minX + margin * 2;
    const h = maxY - minY + margin * 2;
    // A depth of `h` metres occupies `h · cos(pitch) · zoom` pixels on screen,
    // so the height budget gives `zoom ≤ height / (h · cos pitch)`. Multiplying
    // by cos here instead of dividing is the same mistake twice over and shrank
    // every scene by a factor of cos².
    const screenDepth = Math.max(0.5, h) * this.cp + maxHeight * this.sp;
    this.zoom = Math.min(this.width / Math.max(0.5, w), this.height / screenDepth);
    this.refresh();

    // Centre what is painted, not the footprint it stands on. The painted mass
    // spans z = 0 to `maxHeight`, so its middle projects that far above the
    // canvas centre and the content has to come back down by the same amount.
    this.panBy(0, (maxHeight / 2) * this.sp * this.zoom);
  }

  snapshot(): { yaw: number; pitch: number; zoom: number; center: Point } {
    return { yaw: this.yaw, pitch: this.pitch, zoom: this.zoom, center: [...this.center] as Point };
  }
}
