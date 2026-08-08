import type { CameraRuntime, Detection, Level, Point } from '../types';
import { CHART, STATE_STYLES, labelCss, mix, withAlpha } from '../theme';
import { View } from './view';
import {
  DEFAULT_MOUNT_HEIGHT,
  along,
  area,
  centroid,
  dist,
  normalise,
  signedArea,
  solidSpans,
  sub,
  wallHeight,
  wallThickness,
} from './geometry';
import { formatArea, formatMetres } from './snap';

/**
 * The whole scene, painted on a 2D canvas.
 *
 * No WebGL. A house is a few hundred polygons, which Canvas 2D draws in well
 * under a millisecond — the GPU was buying nothing here, and it cost crisp
 * text, easy hit-testing, and 350 kB of MapLibre. What it buys instead is that
 * every label, dimension and handle lives in the same coordinate system as the
 * geometry, so nothing can drift out of alignment.
 *
 * Depth is handled by layer, not by a global sort: floors, then coverage, then
 * walls, then anything that is really UI. Within the wall layer, faces are
 * sorted far-to-near. Sectors stop at walls by construction, so the one case a
 * global sort would fix cannot arise.
 */

export interface RenderInput {
  levels: Level[];
  activeLevel: string;
  runtimes: CameraRuntime[];
  detections: Detection[];
  /** Seconds, for the sweep. Frozen while the timeline is scrubbed. */
  time: number;
  grid: number;
  /** Flattens everything but the active level. */
  focusCamera: string | null;
  showGrid: boolean;
  /** Room names and areas. */
  showLabels: boolean;
  /** Opacity of the floor slabs. */
  floorOpacity: number;
  reducedMotion: boolean;
  /** Storey separation in metres. 0 stacks them. */
  explode: number;
  /** While drawing, coverage is context and must not shout over the plan. */
  editing?: boolean;
}

const TRAIL_FADE_MS = 8000;
/** Below this the minor grid is visual noise rather than a guide. */
const MIN_GRID_PIXELS = 7;

interface Face {
  points: Point[];
  z: number[];
  fill: string;
  stroke?: string;
  depth: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement, public view: View) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error("Le canvas 2D n'est pas disponible dans ce navigateur.");
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.view.resize(width, height);
  }

  get metresPerPixel(): number {
    return 1 / this.view.zoom;
  }

  // ---- frame --------------------------------------------------------------

  render(input: RenderInput): void {
    const { ctx, view } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = CHART.ink;
    ctx.fillRect(0, 0, view.width, view.height);

    if (input.showGrid) this.drawGrid(input.grid);

    const levels = input.levels;
    const activeIndex = Math.max(0, levels.findIndex((l) => l.id === input.activeLevel));

    // Far storeys first so a raised floor lands on top of the one below it.
    const order = levels
      .map((level, index) => ({ level, index }))
      .sort((a, b) => this.levelZ(a.level, a.index, input) - this.levelZ(b.level, b.index, input));

    // Stacked, only the active storey is drawn. Ghosting the others sounds
    // helpful and is not: an upper floor's walls land on top of the plan you
    // are reading and turn it into a pile of translucent boxes. Separating the
    // storeys is what the "Séparer" button is for.
    const shown = order.filter(
      ({ level }) => input.explode > 0 || level.id === input.activeLevel,
    );

    for (const { level, index } of shown) {
      const z = this.levelZ(level, index, input);
      const dim = level.id === input.activeLevel ? 1 : 0.45;
      this.drawUnderlay(level, z, dim);
      this.drawFloors(level, z, dim, input.floorOpacity);
    }

    // Coverage sits just above the floor of its own storey, and only on a
    // storey that is actually on screen.
    for (const { rt, base, visible } of this.placedCameras(input, levels, activeIndex, shown)) {
      this.drawSector(rt, base + 0.02, base + mountHeight(rt), input, visible);
    }

    this.drawTrails(input, levels, activeIndex);

    for (const { level, index } of shown) {
      const z = this.levelZ(level, index, input);
      this.drawWalls(level, z, level.id === input.activeLevel ? 1 : 0.45);
    }

    if (input.showLabels) {
      for (const { level, index } of shown) {
        this.drawRoomLabels(level, this.levelZ(level, index, input));
      }
    }

    // Last, over the walls: the mast is an annotation, and it has to reach the
    // chip that floats above the canvas at the same height.
    for (const { rt, base, visible } of this.placedCameras(input, levels, activeIndex, shown)) {
      this.drawCameraMast(rt, base, base + mountHeight(rt), visible ? 1 : 0.45);
    }
  }

  /** Each camera with the storey height it hangs from, skipping hidden ones. */
  private placedCameras(
    input: RenderInput,
    levels: Level[],
    activeIndex: number,
    shown: Array<{ level: Level; index: number }>,
  ): Array<{ rt: CameraRuntime; base: number; visible: boolean }> {
    const out: Array<{ rt: CameraRuntime; base: number; visible: boolean }> = [];
    for (const rt of input.runtimes) {
      const level = this.levelOf(levels, rt.config.level, activeIndex);
      if (!shown.some((s) => s.level.id === level.level.id)) continue;
      out.push({
        rt,
        base: this.levelZ(level.level, level.index, input),
        visible: level.level.id === input.activeLevel,
      });
    }
    return out;
  }

  private levelZ(level: Level, index: number, input: RenderInput): number {
    return level.elevation + input.explode * index;
  }

  private levelOf(levels: Level[], id: string | undefined, fallback: number) {
    const index = levels.findIndex((l) => l.id === id);
    const resolved = index >= 0 ? index : fallback;
    return { level: levels[resolved] ?? levels[0], index: resolved };
  }

  // ---- grid ---------------------------------------------------------------

  /**
   * The grid is drawn in world space, not as a screen pattern, so it tilts and
   * rotates with the scene. That is what makes it a measuring tool rather than
   * wallpaper — a wall parallel to the grid looks parallel from any angle.
   */
  private drawGrid(grid: number): void {
    const { ctx, view } = this;
    if (grid <= 0) return;

    const corners: Point[] = [
      view.unproject(0, 0),
      view.unproject(view.width, 0),
      view.unproject(view.width, view.height),
      view.unproject(0, view.height),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const minX = Math.floor(Math.min(...xs) / grid) * grid;
    const maxX = Math.ceil(Math.max(...xs) / grid) * grid;
    const minY = Math.floor(Math.min(...ys) / grid) * grid;
    const maxY = Math.ceil(Math.max(...ys) / grid) * grid;

    const pixels = grid * view.zoom;
    const minor = pixels >= MIN_GRID_PIXELS;
    // Every fifth line is heavier: at 50 cm spacing that is a metre-and-a-half
    // rhythm the eye can count without reading any numbers.
    const step = minor ? grid : grid * 5;

    ctx.lineWidth = 1;
    for (let x = minX; x <= maxX + 1e-9; x += step) {
      const major = Math.abs(Math.round(x / (grid * 5)) * grid * 5 - x) < 1e-6;
      ctx.strokeStyle = withAlpha(CHART.parchment, major ? 0.13 : 0.06);
      const a = view.project(x, minY);
      const b = view.project(x, maxY);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    for (let y = minY; y <= maxY + 1e-9; y += step) {
      const major = Math.abs(Math.round(y / (grid * 5)) * grid * 5 - y) < 1e-6;
      ctx.strokeStyle = withAlpha(CHART.parchment, major ? 0.13 : 0.06);
      const a = view.project(minX, y);
      const b = view.project(maxX, y);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }

    // The origin, so "where is 0,0" is never a mystery.
    const o = view.project(0, 0);
    ctx.strokeStyle = withAlpha(CHART.buoyYellow, 0.5);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(o[0] - 7, o[1]);
    ctx.lineTo(o[0] + 7, o[1]);
    ctx.moveTo(o[0], o[1] - 7);
    ctx.lineTo(o[0], o[1] + 7);
    ctx.stroke();
  }

  // ---- underlay -----------------------------------------------------------

  private images = new Map<string, HTMLImageElement>();

  private drawUnderlay(level: Level, z: number, dim: number): void {
    const under = level.underlay;
    if (!under?.url || !(under.scale > 0)) return;

    let img = this.images.get(under.url);
    if (!img) {
      img = new Image();
      img.onload = () => this.onImageLoad?.();
      img.src = under.url;
      this.images.set(under.url, img);
    }
    if (!img.complete || !img.naturalWidth) return;

    const { ctx, view } = this;
    const w = img.naturalWidth * under.scale;
    const h = img.naturalHeight * under.scale;
    const rot = ((under.rotation ?? 0) * Math.PI) / 180;

    // The image's own corners, placed in the world, then projected. Doing it
    // corner-first means the underlay tilts with the scene exactly like the
    // geometry traced over it.
    const corner = (u: number, v: number): Point => {
      const lx = u * w;
      const ly = -v * h;
      return [
        under.origin[0] + lx * Math.cos(rot) - ly * Math.sin(rot),
        under.origin[1] + lx * Math.sin(rot) + ly * Math.cos(rot),
      ];
    };

    const tl = view.projectPoint(corner(0, 0), z);
    const tr = view.projectPoint(corner(1, 0), z);
    const bl = view.projectPoint(corner(0, 1), z);

    ctx.save();
    ctx.globalAlpha = (under.opacity ?? 0.45) * dim;
    ctx.setTransform(
      this.dpr * ((tr[0] - tl[0]) / img.naturalWidth),
      this.dpr * ((tr[1] - tl[1]) / img.naturalWidth),
      this.dpr * ((bl[0] - tl[0]) / img.naturalHeight),
      this.dpr * ((bl[1] - tl[1]) / img.naturalHeight),
      this.dpr * tl[0],
      this.dpr * tl[1],
    );
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Set by the card so a late-loading underlay triggers a repaint. */
  onImageLoad?: () => void;

  // ---- floors -------------------------------------------------------------

  private drawFloors(level: Level, z: number, dim: number, opacity: number): void {
    const { ctx, view } = this;
    const rooms = [...(level.rooms ?? [])].sort(
      (a, b) => this.ringDepth(b.ring) - this.ringDepth(a.ring),
    );
    for (const room of rooms) {
      if (room.ring.length < 3) continue;
      ctx.beginPath();
      room.ring.forEach((p, i) => {
        const s = view.projectPoint(p, z);
        if (i === 0) ctx.moveTo(s[0], s[1]);
        else ctx.lineTo(s[0], s[1]);
      });
      ctx.closePath();
      ctx.fillStyle = withAlpha(room.color ?? CHART.parchment, opacity * dim);
      ctx.fill();
      ctx.strokeStyle = withAlpha(room.color ?? CHART.parchment, 0.22 * dim);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private ringDepth(ring: Point[]): number {
    const c = centroid(ring);
    return this.view.depth(c[0], c[1]);
  }

  private drawRoomLabels(level: Level, z: number): void {
    const { ctx, view } = this;
    for (const room of level.rooms ?? []) {
      if (room.ring.length < 3) continue;
      const c = centroid(room.ring);
      const s = view.projectPoint(c, z);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = withAlpha(CHART.ink, 0.85);
      ctx.strokeText(room.name, s[0], s[1] - 7);
      ctx.fillStyle = CHART.parchment;
      ctx.fillText(room.name, s[0], s[1] - 7);

      // The area is a second line of text inside a shape that may be only a
      // few dozen pixels across. Below that it is noise, so it is dropped.
      const a = area(room.ring);
      if (a * this.view.zoom * this.view.zoom < 4200) continue;
      ctx.font = '400 10px system-ui, sans-serif';
      const label = formatArea(a);
      ctx.strokeText(label, s[0], s[1] + 7);
      ctx.fillStyle = withAlpha(CHART.parchment, 0.6);
      ctx.fillText(label, s[0], s[1] + 7);
    }
  }

  // ---- walls --------------------------------------------------------------

  /**
   * Each solid stretch of each wall becomes a box. Back faces are culled and
   * the rest sorted far-to-near, which is all a scene this size needs to look
   * solid — and it means an opening is a real gap you can see the far side
   * through, not a decal painted on a wall.
   */
  private drawWalls(level: Level, base: number, dim: number): void {
    const faces: Face[] = [];
    for (const wall of level.walls ?? []) {
      const h = wallHeight(wall, level);
      const t = wallThickness(wall);
      for (const [from, to] of solidSpans(wall)) {
        const a = along(wall.a, wall.b, from);
        const b = along(wall.a, wall.b, to);
        faces.push(...this.boxFaces(a, b, t, base, base + h, dim));
      }
      // Openings get a lintel above them, so a door reads as a door rather
      // than as a wall that simply stops.
      for (const o of wall.openings ?? []) {
        const head = o.head ?? h;
        if (head >= h - 1e-6) continue;
        const a = along(wall.a, wall.b, o.at);
        const b = along(wall.a, wall.b, o.at + o.width);
        faces.push(...this.boxFaces(a, b, t, base + head, base + h, dim));
      }
      for (const o of wall.openings ?? []) {
        const sill = o.sill ?? 0;
        if (sill <= 1e-6) continue;
        const a = along(wall.a, wall.b, o.at);
        const b = along(wall.a, wall.b, o.at + o.width);
        faces.push(...this.boxFaces(a, b, t, base, base + sill, dim));
      }
    }

    faces.sort((p, q) => q.depth - p.depth);
    const { ctx, view } = this;
    for (const face of faces) {
      ctx.beginPath();
      face.points.forEach((p, i) => {
        const s = view.projectPoint(p, face.z[i]);
        if (i === 0) ctx.moveTo(s[0], s[1]);
        else ctx.lineTo(s[0], s[1]);
      });
      ctx.closePath();
      ctx.fillStyle = face.fill;
      ctx.fill();
      if (face.stroke) {
        ctx.strokeStyle = face.stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  private boxFaces(
    a: Point,
    b: Point,
    thickness: number,
    z0: number,
    z1: number,
    dim: number,
  ): Face[] {
    if (dist(a, b) < 1e-6 || z1 <= z0) return [];
    const t = thickness / 2;
    const u = normalise(sub(b, a));
    const n: Point = [-u[1] * t, u[0] * t];
    // Extended by half the thickness at each end so corners overlap and close.
    const a0: Point = [a[0] - u[0] * t, a[1] - u[1] * t];
    const b0: Point = [b[0] + u[0] * t, b[1] + u[1] * t];
    let ring: Point[] = [
      [a0[0] + n[0], a0[1] + n[1]],
      [b0[0] + n[0], b0[1] + n[1]],
      [b0[0] - n[0], b0[1] - n[1]],
      [a0[0] - n[0], a0[1] - n[1]],
    ];
    if (signedArea(ring) < 0) ring = ring.reverse();

    const faces: Face[] = [];
    const view = this.view;
    // Masonry is opaque. Alpha is spent only on de-emphasising a storey that is
    // not the active one — never on the material itself, or the floor and the
    // coverage show through and the house reads as glass.
    const solid = (colour: string): string => (dim >= 1 ? colour : withAlpha(colour, dim));

    // The top, always visible from above.
    faces.push({
      points: ring,
      z: ring.map(() => z1),
      fill: solid(CHART.parchment),
      stroke: solid(mix(CHART.parchment, CHART.ink, 0.45)),
      depth: Math.min(...ring.map((p) => view.depth(p[0], p[1]))),
    });

    // The sides, back-face culled. The horizontal view direction after yaw is
    // (-sin yaw, cos yaw); a face whose outward normal opposes it is one we
    // can see.
    const yaw = (view.yaw * Math.PI) / 180;
    const viewDir: Point = [-Math.sin(yaw), Math.cos(yaw)];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const outward: Point = [q[1] - p[1], -(q[0] - p[0])];
      if (outward[0] * viewDir[0] + outward[1] * viewDir[1] >= 0) continue;
      // Faces more edge-on to the light read darker, which is the whole of the
      // shading model and enough to make corners legible. Darkening toward the
      // ink rather than fading toward it keeps the face solid.
      const light = 0.55 + 0.3 * Math.abs(normalise(outward)[1]);
      faces.push({
        points: [p, q, q, p],
        z: [z0, z0, z1, z1],
        fill: solid(mix(CHART.ink, CHART.parchmentShade, light)),
        depth: Math.min(view.depth(p[0], p[1]), view.depth(q[0], q[1])),
      });
    }
    return faces;
  }

  // ---- coverage -----------------------------------------------------------

  private drawSector(
    rt: CameraRuntime,
    z: number,
    lensZ: number,
    input: RenderInput,
    visible: boolean,
  ): void {
    const iso = rt.isovist;
    if (iso.length < 3) return;

    const { ctx, view } = this;
    const style = STATE_STYLES[rt.state];
    const css = sectorColour(rt);
    const focused = input.focusCamera;
    let dim = !visible ? 0.12 : focused && focused !== rt.config.name ? 0.22 : 1;
    // Coverage is the point of the card at rest and an obstacle while drawing:
    // a lit sector over the wall you are tracing hides exactly the thing you
    // are trying to place.
    if (input.editing) dim *= 0.3;

    const apex = view.projectPoint(iso[0], z);
    const path = new Path2D();
    iso.forEach((p, i) => {
      const s = view.projectPoint(p, z);
      if (i === 0) path.moveTo(s[0], s[1]);
      else path.lineTo(s[0], s[1]);
    });
    path.closePath();

    // Radial falloff from the lens, in screen space — orthographic keeps the
    // scale uniform, so one gradient is correct across the whole polygon.
    const radiusPixels = rt.config.range * view.zoom;
    const gradient = ctx.createRadialGradient(apex[0], apex[1], 0, apex[0], apex[1], radiusPixels);
    gradient.addColorStop(0, withAlpha(css, style.intensity * 1.5 * dim));
    gradient.addColorStop(0.55, withAlpha(css, style.intensity * 0.8 * dim));
    gradient.addColorStop(1, withAlpha(css, 0));

    ctx.fillStyle = gradient;
    ctx.fill(path);

    ctx.strokeStyle = withAlpha(css, 0.5 * dim);
    ctx.lineWidth = 1;
    ctx.stroke(path);

    if (style.sweep > 0 && !input.reducedMotion && visible) {
      this.drawSweep(path, apex, radiusPixels, css, style.sweep, input.time, dim);
    }

    this.drawSectorVolume(rt, z, lensZ, dim);
  }

  /**
   * The coverage as a solid, not a puddle.
   *
   * A camera three metres up watching a hallway was drawn as a shape lying on
   * the floor, which says nothing about where the lens is or what it means for
   * the sector to be *its*. The honest object is the frustum: apex at the lens,
   * base the isovist on the floor. Filling the silhouette — lens, then the rim
   * in order, closed — draws that ruled surface in a single path, so the
   * translucent fill stays even instead of banding along a hundred shared
   * triangle edges.
   *
   * The same polygon still drives it, so a beam that stops at a wall in plan
   * stops at that wall in the air too. There is no second geometry.
   */
  private drawSectorVolume(rt: CameraRuntime, floorZ: number, lensZ: number, dim: number): void {
    const { ctx, view } = this;
    const iso = rt.isovist;
    const lens = view.projectPoint(iso[0], lensZ);
    const ground = view.projectPoint(iso[0], floorZ);

    // Flat on: the lens lands on its own floor point and the frustum has no
    // silhouette left to draw. This is what makes the plan view stay a plan.
    const rise = ground[1] - lens[1];
    if (rise < 6) return;

    const path = new Path2D();
    path.moveTo(lens[0], lens[1]);
    let first: Point | null = null;
    let last: Point | null = null;
    for (let i = 1; i < iso.length; i++) {
      const s = view.projectPoint(iso[i], floorZ);
      path.lineTo(s[0], s[1]);
      first ??= s;
      last = s;
    }
    if (!first || !last) return;
    path.closePath();

    // Light in the air: brightest at the lens, spent by the time it reaches the
    // floor, where the sector pool takes over. The axis is the vertical rise,
    // so anything past the ground clamps to the last stop.
    const style = STATE_STYLES[rt.state];
    const css = sectorColour(rt);
    const gradient = ctx.createLinearGradient(lens[0], lens[1], ground[0], ground[1]);
    gradient.addColorStop(0, withAlpha(css, style.intensity * 0.55 * dim));
    gradient.addColorStop(1, withAlpha(css, style.intensity * 0.07 * dim));
    ctx.fillStyle = gradient;
    ctx.fill(path);

    // The two extreme rays. Without them a cone reads as a smear; with them the
    // eye finds the apex immediately.
    ctx.strokeStyle = withAlpha(css, 0.3 * dim);
    ctx.lineWidth = 1;
    for (const end of [first, last]) {
      ctx.beginPath();
      ctx.moveTo(lens[0], lens[1]);
      ctx.lineTo(end[0], end[1]);
      ctx.stroke();
    }
  }

  /**
   * The mast, from the lens down to the floor, and the footprint it stands over.
   *
   * Height is the one property of a camera that a plan cannot show and that
   * changes what it sees. The dashed line is also what ties the floating chip
   * back to a place on the floor.
   */
  private drawCameraMast(rt: CameraRuntime, floorZ: number, lensZ: number, dim: number): void {
    const { ctx, view } = this;
    const ground = view.projectPoint(rt.config.position, floorZ);
    const lens = view.projectPoint(rt.config.position, lensZ);
    if (ground[1] - lens[1] < 4) return;

    const css = sectorColour(rt);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(css, 0.5 * dim);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ground[0], ground[1]);
    ctx.lineTo(lens[0], lens[1]);
    ctx.stroke();
    ctx.restore();

    // A circle on the floor is an ellipse on screen, squashed by the pitch —
    // which is exactly what makes it read as lying on the ground.
    const squash = Math.cos((view.pitch * Math.PI) / 180);
    ctx.beginPath();
    ctx.ellipse(ground[0], ground[1], 4, Math.max(0.5, 4 * squash), 0, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(css, 0.55 * dim);
    ctx.fill();
  }

  /**
   * The radar sweep: a wedge of decaying slices, clipped to the sector.
   *
   * Clipping to the isovist rather than to the raw cone is what keeps the beam
   * from sweeping through a wall — the same polygon drives the picture and the
   * animation, so they cannot disagree.
   */
  private drawSweep(
    clip: Path2D,
    apex: Point,
    radius: number,
    color: string,
    speed: number,
    time: number,
    dim: number,
  ): void {
    const { ctx } = this;
    const head = time * speed * Math.PI * 2;
    const slices = 9;
    const arc = 0.5;

    ctx.save();
    ctx.clip(clip);
    for (let i = 0; i < slices; i++) {
      const from = head - (arc * (i + 1)) / slices;
      const to = head - (arc * i) / slices;
      const alpha = 0.16 * dim * (1 - i / slices) ** 2;
      if (alpha < 0.004) continue;
      ctx.beginPath();
      ctx.moveTo(apex[0], apex[1]);
      // Screen angles run clockwise from +x while bearings run clockwise from
      // +y, hence the quarter-turn offset.
      ctx.arc(apex[0], apex[1], radius, from - Math.PI / 2, to - Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = withAlpha(color, alpha);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- detections ---------------------------------------------------------

  private drawTrails(input: RenderInput, levels: Level[], fallback: number): void {
    const { ctx, view } = this;
    const now = Date.now();

    for (const det of input.detections) {
      if (!det.trail.length) continue;
      const rt = input.runtimes.find((r) => r.config.name === det.camera);
      const level = this.levelOf(levels, rt?.config.level, fallback);
      const z = this.levelZ(level.level, level.index, input) + 0.05;
      const color = labelCss(det.label);

      ctx.lineWidth = 2;
      ctx.strokeStyle = withAlpha(color, 0.35);
      ctx.beginPath();
      det.trail.forEach((p, i) => {
        const s = view.projectPoint(p.pos, z);
        if (i === 0) ctx.moveTo(s[0], s[1]);
        else ctx.lineTo(s[0], s[1]);
      });
      ctx.stroke();

      det.trail.forEach((p, i) => {
        const age = Math.min(0.95, (now - p.t) / TRAIL_FADE_MS);
        const head = i === det.trail.length - 1;
        const s = view.projectPoint(p.pos, z);
        ctx.beginPath();
        ctx.arc(s[0], s[1], head ? 6 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(color, (1 - age) * (head ? 1 : 0.5));
        ctx.fill();
        if (head) {
          ctx.beginPath();
          ctx.arc(s[0], s[1], 11, 0, Math.PI * 2);
          ctx.strokeStyle = withAlpha(color, 0.35);
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      });
    }
  }

  // ---- editor overlays ----------------------------------------------------

  /** A dashed run of segments with a length label on each — the draft chain. */
  drawDraft(points: Point[], cursor: Point | null, z: number, closed = false): void {
    const { ctx, view } = this;
    const chain = cursor ? [...points, cursor] : points;
    if (chain.length < 2) return;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = CHART.sectorWhite;
    ctx.lineWidth = 2;
    ctx.beginPath();
    chain.forEach((p, i) => {
      const s = view.projectPoint(p, z);
      if (i === 0) ctx.moveTo(s[0], s[1]);
      else ctx.lineTo(s[0], s[1]);
    });
    if (closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();

    for (let i = 1; i < chain.length; i++) {
      this.drawDimension(chain[i - 1], chain[i], z);
    }
    if (closed && chain.length > 2) this.drawDimension(chain[chain.length - 1], chain[0], z);
  }

  /** The running length of a segment, placed at its midpoint. */
  drawDimension(a: Point, b: Point, z: number, emphasis = false): void {
    const { ctx, view } = this;
    const d = dist(a, b);
    if (d < 0.02) return;
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = view.projectPoint(mid, z);
    const text = formatMetres(d);

    ctx.font = emphasis ? '600 13px system-ui, sans-serif' : '500 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 10;
    const h = emphasis ? 20 : 16;

    ctx.fillStyle = withAlpha(CHART.ink, 0.88);
    ctx.beginPath();
    ctx.roundRect(s[0] - w / 2, s[1] - h / 2, w, h, 4);
    ctx.fill();
    if (emphasis) {
      ctx.strokeStyle = CHART.sectorWhite;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = emphasis ? CHART.sectorWhite : withAlpha(CHART.parchment, 0.9);
    ctx.fillText(text, s[0], s[1]);
  }

  /** A round handle. Filled when selected. */
  drawHandle(p: Point, z: number, color: string, selected = false, radius = 5): void {
    const { ctx, view } = this;
    const s = view.projectPoint(p, z);
    if (selected) {
      ctx.beginPath();
      ctx.arc(s[0], s[1], radius + 5, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(color, 0.25);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(s[0], s[1], radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = CHART.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Marks what the pointer locked onto, so the snap is never a surprise. */
  drawSnapHint(p: Point, z: number, kind: string, angle?: number): void {
    const { ctx, view } = this;
    const s = view.projectPoint(p, z);
    const color =
      kind === 'vertex' ? CHART.sectorRed : kind === 'edge' ? CHART.sectorGreen : CHART.buoyYellow;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (kind === 'vertex') {
      ctx.strokeRect(s[0] - 5, s[1] - 5, 10, 10);
    } else if (kind === 'edge') {
      ctx.beginPath();
      ctx.moveTo(s[0] - 6, s[1] - 6);
      ctx.lineTo(s[0] + 6, s[1] + 6);
      ctx.moveTo(s[0] - 6, s[1] + 6);
      ctx.lineTo(s[0] + 6, s[1] - 6);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(s[0], s[1], 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (angle !== undefined) {
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = color;
      ctx.fillText(`${Math.round(angle)}°`, s[0] + 9, s[1] - 6);
    }
  }

  /** The camera body plus its aim and spread handles. */
  drawCameraGizmo(rt: CameraRuntime, z: number, selected: boolean): void {
    const cam = rt.config;
    this.drawHandle(cam.position, z, CHART.buoyYellow, selected, 7);
    if (!selected) return;

    const aim = pointOnBearing(cam.position, cam.azimuth, cam.range * 0.7);
    const spread = pointOnBearing(cam.position, cam.azimuth + cam.fov / 2, cam.range * 0.7);

    const { ctx, view } = this;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = withAlpha(CHART.parchment, 0.5);
    ctx.lineWidth = 1;
    for (const target of [aim, spread]) {
      const a = view.projectPoint(cam.position, z);
      const b = view.projectPoint(target, z);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();

    this.drawHandle(aim, z, CHART.sectorRed, false, 6);
    this.drawHandle(spread, z, CHART.sectorGreen, false, 6);
  }

  /** Screen position of a world point, for placing DOM chips. */
  toScreen(p: Point, z = 0): Point {
    return this.view.projectPoint(p, z);
  }
}

const mountHeight = (rt: CameraRuntime): number => rt.config.height ?? DEFAULT_MOUNT_HEIGHT;

/**
 * The colour a camera's sector is painted in.
 *
 * A per-camera colour replaces the *resting* colour and nothing else. The other
 * four states keep the chart palette, because those colours are the legend: a
 * red sector has to mean "something is in there" on every camera, or it means
 * nothing anywhere. What the override buys is telling four quiet cameras apart.
 */
function sectorColour(rt: CameraRuntime): string {
  return rt.state === 'nominal' && rt.config.color
    ? rt.config.color
    : STATE_STYLES[rt.state].css;
}

export function pointOnBearing(from: Point, bearingDeg: number, metres: number): Point {
  const t = (bearingDeg * Math.PI) / 180;
  return [from[0] + Math.sin(t) * metres, from[1] + Math.cos(t) * metres];
}
