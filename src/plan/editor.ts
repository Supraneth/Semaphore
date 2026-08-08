import type { CameraConfig, Level, Opening, Point, Room, Wall } from '../types';
import { History } from './history';
import { Renderer, pointOnBearing } from './renderer';
import { snap, pointAt, type SnapResult } from './snap';
import {
  DEFAULT_THICKNESS,
  dist,
  findWall,
  projectOnSegment,
  tidyOpenings,
  wallHeight,
} from './geometry';
import { CHART } from '../theme';

/**
 * The plan editor.
 *
 * Everything here exists because the previous version was, in the user's
 * words, not practical: you aimed at pixels over a satellite image and hoped.
 * The four things that change that are a grid you can snap to, an angle lock,
 * a length you can read while you draw and type when you know it, and an undo
 * that always works. Nothing else in this file matters as much as those.
 */

export type Tool = 'select' | 'wall' | 'room' | 'camera' | 'opening' | 'scale';

export interface Selection {
  kind: 'wall' | 'room' | 'camera' | 'opening';
  id: string;
  /** The owning wall, when `kind` is `opening`. */
  wallId?: string;
}

type Drag =
  | { kind: 'wall-end'; wallId: string; end: 'a' | 'b' }
  | { kind: 'wall-move'; wallId: string; from: Point; a: Point; b: Point }
  | { kind: 'room-vertex'; roomId: string; index: number }
  | { kind: 'room-move'; roomId: string; from: Point; ring: Point[] }
  | { kind: 'camera'; name: string }
  | { kind: 'camera-aim'; name: string }
  | { kind: 'camera-fov'; name: string }
  | { kind: 'opening'; wallId: string; id: string }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'orbit'; x: number; y: number };

export interface EditorHost {
  levels: Level[];
  cameras: CameraConfig[];
  activeLevel: string;
  grid: number;
  onChange: () => void;
  onRepaint: () => void;
}

/** Screen-pixel radius within which a handle is considered hit. */
const HIT_PIXELS = 11;
const DEFAULT_DOOR_WIDTH = 0.9;

let counter = 0;
const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++counter}`;

export class PlanEditor {
  tool: Tool = 'select';
  selection: Selection | null = null;
  history: History;

  /** Points committed in the current chain. */
  draft: Point[] = [];
  /** Where the pointer currently is, already snapped. */
  cursor: Point | null = null;
  lastSnap: SnapResult | null = null;
  /** Digits typed while drawing, as a length in metres. */
  typed = '';
  /** Held Shift: no grid, no angle lock. */
  free = false;

  private drag: Drag | null = null;
  private bound = false;
  private pointerDown = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: Renderer,
    private host: EditorHost,
  ) {
    this.history = new History(
      () => ({ levels: this.host.levels, cameras: this.host.cameras }),
      (doc) => {
        // Replace in place: the card, the renderer and the isovist cache all
        // hold these same two arrays.
        this.host.levels.length = 0;
        this.host.levels.push(...doc.levels);
        this.host.cameras.length = 0;
        this.host.cameras.push(...doc.cameras);
        this.selection = null;
        this.host.onChange();
      },
    );
  }

  /**
   * Runs an edit made from a panel rather than from the canvas.
   *
   * Same contract as every gesture: one restore point pushed before the
   * mutation, one change reported after it. Without this the side panels would
   * each have to reach for `history` and `onChange` and one of them would
   * eventually forget.
   */
  edit(mutate: () => void): void {
    this.history.capture();
    mutate();
    this.host.onChange();
  }

  // ---- lifecycle ----------------------------------------------------------

  attach(): void {
    if (this.bound) return;
    this.bound = true;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  setTool(tool: Tool): void {
    this.cancelDraft();
    this.tool = tool;
    this.canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this.host.onRepaint();
  }

  // ---- document access ----------------------------------------------------

  private get level(): Level {
    return (
      this.host.levels.find((l) => l.id === this.host.activeLevel) ?? this.host.levels[0]
    );
  }

  private get levelZ(): number {
    return this.level?.elevation ?? 0;
  }

  private cameraOnLevel(cam: CameraConfig): boolean {
    return (cam.level ?? this.host.levels[0]?.id) === this.host.activeLevel;
  }

  // ---- pointer ------------------------------------------------------------

  private local(ev: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  private snapAt(sx: number, sy: number, anchor?: Point): SnapResult {
    const world = this.renderer.view.unproject(sx, sy);
    return snap(world, {
      level: this.level,
      metresPerPixel: this.renderer.metresPerPixel,
      grid: this.host.grid,
      anchor,
      free: this.free,
      extra: this.draft,
      exclude: this.dragExclusions(),
    });
  }

  /** A dragged vertex must not snap to the position it is being dragged from. */
  private dragExclusions(): Point[] {
    const d = this.drag;
    if (!d) return [];
    if (d.kind === 'wall-end') {
      const wall = findWall(this.host.levels, d.wallId);
      return wall ? [wall[d.end]] : [];
    }
    if (d.kind === 'room-vertex') {
      const room = this.findRoom(d.roomId);
      return room ? [room.ring[d.index]] : [];
    }
    return [];
  }

  private onPointerDown = (ev: PointerEvent): void => {
    const [sx, sy] = this.local(ev);
    this.canvas.setPointerCapture(ev.pointerId);
    this.pointerDown = true;

    // Middle button pans, right-drag orbits — the two navigation gestures that
    // never conflict with a drawing tool.
    if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
      this.drag = { kind: 'pan', x: sx, y: sy };
      return;
    }
    if (ev.button === 2) {
      this.drag = { kind: 'orbit', x: sx, y: sy };
      return;
    }
    if (ev.button !== 0) return;

    if (this.tool === 'select') {
      const hit = this.hitTest(sx, sy);
      if (hit) {
        this.history.capture();
        this.drag = hit.drag;
        this.selection = hit.selection;
      } else {
        this.selection = null;
        this.drag = { kind: 'pan', x: sx, y: sy };
      }
      this.host.onChange();
      return;
    }

    if (this.tool === 'camera') {
      const p = this.snapAt(sx, sy).point;
      this.addCamera(p);
      this.setTool('select');
      return;
    }

    if (this.tool === 'opening') {
      this.addOpeningAt(sx, sy);
      return;
    }

    // wall / room / scale all build a chain.
    const anchor = this.draft[this.draft.length - 1];
    const result = this.snapAt(sx, sy, anchor);
    this.draft.push(result.point);
    this.typed = '';

    if (this.tool === 'scale' && this.draft.length === 2) this.commitScale();
    else if (this.tool === 'wall' && this.draft.length >= 2) this.flushWallChain();

    this.host.onRepaint();
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const [sx, sy] = this.local(ev);

    if (this.drag) {
      this.applyDrag(sx, sy, ev);
      this.host.onRepaint();
      return;
    }

    if (this.tool === 'select') {
      this.canvas.style.cursor = this.hitTest(sx, sy) ? 'grab' : 'default';
      return;
    }

    const anchor = this.draft[this.draft.length - 1];
    const result = this.snapAt(sx, sy, anchor);
    this.lastSnap = result;
    // A typed length overrides the pointer's distance but keeps its direction,
    // so you can aim roughly and still land on exactly 4,20 m.
    this.cursor =
      anchor && this.typedLength() !== null
        ? pointAt(anchor, bearingOf(anchor, result.point), this.typedLength()!)
        : result.point;
    this.host.onRepaint();
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(ev.pointerId)) {
      this.canvas.releasePointerCapture(ev.pointerId);
    }
    this.pointerDown = false;
    if (this.drag && this.drag.kind !== 'pan' && this.drag.kind !== 'orbit') {
      this.history.settle();
      this.host.onChange();
    }
    this.drag = null;
  };

  private onPointerLeave = (): void => {
    if (!this.pointerDown) {
      this.cursor = null;
      this.lastSnap = null;
      this.host.onRepaint();
    }
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const [sx, sy] = this.local(ev);
    this.renderer.view.zoomAt(sx, sy, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    this.host.onRepaint();
  };

  private onDoubleClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    if (this.tool === 'room') this.commitRoom();
    else if (this.tool === 'wall') this.cancelDraft();
  };

  private onContextMenu = (ev: Event): void => ev.preventDefault();

  private applyDrag(sx: number, sy: number, ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;

    if (d.kind === 'pan') {
      this.renderer.view.panBy(sx - d.x, sy - d.y);
      d.x = sx;
      d.y = sy;
      return;
    }
    if (d.kind === 'orbit') {
      const view = this.renderer.view;
      view.yaw += (sx - d.x) * 0.4;
      view.pitch -= (sy - d.y) * 0.35;
      view.refresh();
      d.x = sx;
      d.y = sy;
      return;
    }

    const result = this.snapAt(sx, sy, d.kind === 'wall-end' ? this.wallOtherEnd(d) : undefined);
    this.lastSnap = result;
    const p = result.point;

    switch (d.kind) {
      case 'wall-end': {
        const wall = findWall(this.host.levels, d.wallId);
        if (wall) wall[d.end] = p;
        break;
      }
      case 'wall-move': {
        const wall = findWall(this.host.levels, d.wallId);
        if (!wall) break;
        const raw = this.renderer.view.unproject(sx, sy);
        const dx = raw[0] - d.from[0];
        const dy = raw[1] - d.from[1];
        wall.a = this.maybeGrid([d.a[0] + dx, d.a[1] + dy]);
        wall.b = this.maybeGrid([d.b[0] + dx, d.b[1] + dy]);
        break;
      }
      case 'room-vertex': {
        const room = this.findRoom(d.roomId);
        if (room) room.ring[d.index] = p;
        break;
      }
      case 'room-move': {
        const room = this.findRoom(d.roomId);
        if (!room) break;
        const raw = this.renderer.view.unproject(sx, sy);
        const dx = raw[0] - d.from[0];
        const dy = raw[1] - d.from[1];
        room.ring = d.ring.map((q) => this.maybeGrid([q[0] + dx, q[1] + dy]));
        break;
      }
      case 'camera': {
        const cam = this.findCamera(d.name);
        if (cam) cam.position = p;
        break;
      }
      case 'camera-aim':
      case 'camera-fov': {
        const cam = this.findCamera(d.name);
        if (!cam) break;
        const raw = this.renderer.view.unproject(sx, sy);
        const bearing = bearingOf(cam.position, raw);
        if (d.kind === 'camera-aim') {
          cam.azimuth = ev.shiftKey ? bearing : Math.round(bearing);
          cam.range = Math.max(1, Math.round((dist(cam.position, raw) / 0.7) * 2) / 2);
        } else {
          const delta = Math.abs(((bearing - cam.azimuth + 540) % 360) - 180);
          cam.fov = Math.min(340, Math.max(10, Math.round(delta * 2)));
        }
        break;
      }
      case 'opening': {
        const wall = findWall(this.host.levels, d.wallId);
        const opening = wall?.openings?.find((o) => o.id === d.id);
        if (!wall || !opening) break;
        const raw = this.renderer.view.unproject(sx, sy);
        const hit = projectOnSegment(raw, wall.a, wall.b);
        const total = dist(wall.a, wall.b);
        const centre = this.free ? hit.t : Math.round(hit.t / 0.05) * 0.05;
        opening.at = Math.max(0, Math.min(total - opening.width, centre - opening.width / 2));
        break;
      }
    }
    this.host.onChange();
  }

  private maybeGrid(p: Point): Point {
    if (this.free || this.host.grid <= 0) return p;
    const g = this.host.grid;
    return [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
  }

  private wallOtherEnd(d: { wallId: string; end: 'a' | 'b' }): Point | undefined {
    const wall = findWall(this.host.levels, d.wallId);
    return wall ? wall[d.end === 'a' ? 'b' : 'a'] : undefined;
  }

  // ---- hit testing --------------------------------------------------------

  private hitTest(sx: number, sy: number): { drag: Drag; selection: Selection } | null {
    const z = this.levelZ;
    const near = (p: Point, radius = HIT_PIXELS): boolean => {
      const s = this.renderer.toScreen(p, z);
      return Math.hypot(s[0] - sx, s[1] - sy) <= radius;
    };

    // Camera handles first: they sit on top and are the smallest targets.
    for (const cam of this.host.cameras) {
      if (!this.cameraOnLevel(cam)) continue;
      if (this.selection?.kind === 'camera' && this.selection.id === cam.name) {
        if (near(pointOnBearing(cam.position, cam.azimuth, cam.range * 0.7))) {
          return { drag: { kind: 'camera-aim', name: cam.name }, selection: { kind: 'camera', id: cam.name } };
        }
        if (near(pointOnBearing(cam.position, cam.azimuth + cam.fov / 2, cam.range * 0.7))) {
          return { drag: { kind: 'camera-fov', name: cam.name }, selection: { kind: 'camera', id: cam.name } };
        }
      }
      if (near(cam.position, HIT_PIXELS + 2)) {
        return { drag: { kind: 'camera', name: cam.name }, selection: { kind: 'camera', id: cam.name } };
      }
    }

    const level = this.level;

    for (const wall of level?.walls ?? []) {
      for (const end of ['a', 'b'] as const) {
        if (near(wall[end])) {
          return { drag: { kind: 'wall-end', wallId: wall.id, end }, selection: { kind: 'wall', id: wall.id } };
        }
      }
    }

    for (const room of level?.rooms ?? []) {
      for (let i = 0; i < room.ring.length; i++) {
        if (near(room.ring[i])) {
          return {
            drag: { kind: 'room-vertex', roomId: room.id, index: i },
            selection: { kind: 'room', id: room.id },
          };
        }
      }
    }

    // Openings, then wall bodies, then room interiors — most specific first.
    const world = this.renderer.view.unproject(sx, sy);
    const tolerance = HIT_PIXELS * this.renderer.metresPerPixel;

    for (const wall of level?.walls ?? []) {
      for (const o of tidyOpenings(wall)) {
        const mid = pointAlong(wall, o.at + o.width / 2);
        if (near(mid)) {
          return {
            drag: { kind: 'opening', wallId: wall.id, id: o.id },
            selection: { kind: 'opening', id: o.id, wallId: wall.id },
          };
        }
      }
    }

    for (const wall of level?.walls ?? []) {
      const hit = projectOnSegment(world, wall.a, wall.b);
      if (hit.distance <= tolerance) {
        return {
          drag: { kind: 'wall-move', wallId: wall.id, from: world, a: wall.a, b: wall.b },
          selection: { kind: 'wall', id: wall.id },
        };
      }
    }

    for (const room of level?.rooms ?? []) {
      if (pointInRingLocal(world, room.ring)) {
        return {
          drag: { kind: 'room-move', roomId: room.id, from: world, ring: room.ring.map((p) => [...p] as Point) },
          selection: { kind: 'room', id: room.id },
        };
      }
    }

    return null;
  }

  // ---- keyboard -----------------------------------------------------------

  private typedLength(): number | null {
    if (!this.typed) return null;
    const value = parseFloat(this.typed.replace(',', '.'));
    return isFinite(value) && value > 0 ? value : null;
  }

  private onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.key === 'Shift') {
      this.free = false;
      this.host.onRepaint();
    }
  };

  private onKeyDown = (ev: KeyboardEvent): void => {
    // Never steal keys from a field the user is typing in.
    const target = ev.composedPath()[0] as HTMLElement | undefined;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '')) return;

    if (ev.key === 'Shift') {
      this.free = true;
      this.host.onRepaint();
      return;
    }

    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) this.history.redo();
      else this.history.undo();
      this.host.onChange();
      return;
    }
    if (ctrl && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      this.history.redo();
      this.host.onChange();
      return;
    }

    // Typing a number while drawing sets the next segment's length.
    if (this.draft.length && /^[0-9.,]$/.test(ev.key)) {
      this.typed += ev.key;
      this.refreshTypedCursor();
      return;
    }
    if (this.typed && ev.key === 'Backspace') {
      ev.preventDefault();
      this.typed = this.typed.slice(0, -1);
      this.refreshTypedCursor();
      return;
    }

    switch (ev.key) {
      case 'Escape':
        this.cancelDraft();
        this.selection = null;
        this.host.onChange();
        break;
      case 'Enter':
        if (this.typedLength() !== null && this.cursor) {
          this.draft.push(this.cursor);
          this.typed = '';
          if (this.tool === 'wall' && this.draft.length >= 2) this.flushWallChain();
          if (this.tool === 'scale' && this.draft.length === 2) this.commitScale();
          this.host.onRepaint();
        } else if (this.tool === 'room') {
          this.commitRoom();
        } else if (this.tool === 'wall') {
          this.cancelDraft();
        }
        break;
      case 'Backspace':
        if (this.draft.length) {
          this.draft.pop();
          this.host.onRepaint();
        } else if (this.selection) {
          this.deleteSelection();
        }
        break;
      case 'Delete':
        this.deleteSelection();
        break;
      case 'g':
        if (!ctrl) this.setTool('select');
        break;
      case 'm':
        if (!ctrl) this.setTool('wall');
        break;
      case 'p':
        if (!ctrl) this.setTool('room');
        break;
      case 'o':
        if (!ctrl) this.setTool('opening');
        break;
      case 'c':
        if (!ctrl) this.setTool('camera');
        break;
      default:
        return;
    }
  };

  private refreshTypedCursor(): void {
    const anchor = this.draft[this.draft.length - 1];
    const length = this.typedLength();
    if (anchor && length !== null && this.lastSnap) {
      this.cursor = pointAt(anchor, bearingOf(anchor, this.lastSnap.point), length);
    }
    this.host.onRepaint();
  }

  // ---- edits --------------------------------------------------------------

  cancelDraft(): void {
    this.draft = [];
    this.typed = '';
    this.cursor = null;
    this.host.onRepaint();
  }

  /**
   * Commits every finished segment of a wall chain immediately, keeping only
   * the last point as the anchor. Drawing a corridor therefore produces walls
   * you can see appearing rather than one deferred blob.
   */
  private flushWallChain(): void {
    const level = this.level;
    if (!level) return;
    level.walls = level.walls ?? [];
    this.history.capture();
    for (let i = 0; i < this.draft.length - 1; i++) {
      const a = this.draft[i];
      const b = this.draft[i + 1];
      if (dist(a, b) < 0.02) continue;
      level.walls.push({ id: uid('mur'), a, b, thickness: DEFAULT_THICKNESS });
    }
    this.draft = [this.draft[this.draft.length - 1]];
    this.host.onChange();
  }

  private commitRoom(): void {
    if (this.draft.length < 3) {
      this.cancelDraft();
      return;
    }
    const level = this.level;
    if (!level) return;
    this.history.capture();
    level.rooms = level.rooms ?? [];
    const room: Room = {
      id: uid('piece'),
      name: `Pièce ${level.rooms.length + 1}`,
      ring: this.draft,
    };
    level.rooms.push(room);
    this.draft = [];
    this.typed = '';
    this.cursor = null;
    this.selection = { kind: 'room', id: room.id };
    this.setTool('select');
    this.host.onChange();
  }

  /**
   * Surrounds a room with walls in one gesture.
   *
   * Tracing a room and then tracing its four walls on top is the single most
   * tedious thing about a plan editor, and doing it twice guarantees the two
   * disagree somewhere.
   */
  wallsAroundRoom(roomId: string): void {
    const level = this.level;
    const room = this.findRoom(roomId);
    if (!level || !room || room.ring.length < 3) return;
    this.history.capture();
    level.walls = level.walls ?? [];
    for (let i = 0; i < room.ring.length; i++) {
      const a = room.ring[i];
      const b = room.ring[(i + 1) % room.ring.length];
      if (dist(a, b) < 0.02) continue;
      const already = level.walls.some(
        (w) =>
          (dist(w.a, a) < 0.02 && dist(w.b, b) < 0.02) ||
          (dist(w.a, b) < 0.02 && dist(w.b, a) < 0.02),
      );
      if (!already) level.walls.push({ id: uid('mur'), a, b, thickness: DEFAULT_THICKNESS });
    }
    this.host.onChange();
  }

  private addCamera(position: Point): void {
    this.history.capture();
    const n = this.host.cameras.length + 1;
    const cam: CameraConfig = {
      name: `camera_${n}`,
      label: `Caméra ${n}`,
      position,
      level: this.host.activeLevel,
      height: 2.6,
      azimuth: Math.round(this.renderer.view.yaw),
      fov: 90,
      range: 8,
    };
    this.host.cameras.push(cam);
    this.selection = { kind: 'camera', id: cam.name };
    this.host.onChange();
  }

  private addOpeningAt(sx: number, sy: number): void {
    const world = this.renderer.view.unproject(sx, sy);
    const level = this.level;
    let best: { wall: Wall; t: number; d: number } | null = null;
    for (const wall of level?.walls ?? []) {
      const hit = projectOnSegment(world, wall.a, wall.b);
      if (!best || hit.distance < best.d) best = { wall, t: hit.t, d: hit.distance };
    }
    const tolerance = 18 * this.renderer.metresPerPixel;
    if (!best || best.d > tolerance) return;

    this.history.capture();
    const total = dist(best.wall.a, best.wall.b);
    const width = Math.min(DEFAULT_DOOR_WIDTH, total - 0.1);
    if (width <= 0.1) return;
    const at = Math.max(0, Math.min(total - width, best.t - width / 2));
    const opening: Opening = {
      id: uid('ouverture'),
      kind: 'door',
      at: this.free ? at : Math.round(at / 0.05) * 0.05,
      width,
      sill: 0,
      head: Math.min(2.1, wallHeight(best.wall, level)),
    };
    best.wall.openings = [...(best.wall.openings ?? []), opening];
    this.selection = { kind: 'opening', id: opening.id, wallId: best.wall.id };
    this.setTool('select');
    this.host.onChange();
  }

  /**
   * Uses a drawn line of known length to scale the tracing image, so a scanned
   * plan can be matched to reality by measuring one thing you know.
   */
  private commitScale(): void {
    const level = this.level;
    const under = level?.underlay;
    if (!under || this.draft.length < 2) {
      this.cancelDraft();
      return;
    }
    this.pendingScale = { a: this.draft[0], b: this.draft[1] };
    this.draft = [];
    this.cursor = null;
    this.host.onChange();
  }

  /** Set once a scale line is drawn; the card asks for the real length. */
  pendingScale: { a: Point; b: Point } | null = null;

  applyScale(realMetres: number): void {
    const level = this.level;
    const under = level?.underlay;
    const line = this.pendingScale;
    this.pendingScale = null;
    if (!under || !line || !(realMetres > 0)) return;
    const drawn = dist(line.a, line.b);
    if (drawn < 1e-6) return;
    this.history.capture();
    under.scale *= realMetres / drawn;
    this.setTool('select');
    this.host.onChange();
  }

  deleteSelection(): void {
    const sel = this.selection;
    if (!sel) return;
    this.history.capture();

    if (sel.kind === 'camera') {
      const i = this.host.cameras.findIndex((c) => c.name === sel.id);
      if (i >= 0) this.host.cameras.splice(i, 1);
    } else if (sel.kind === 'opening' && sel.wallId) {
      const wall = findWall(this.host.levels, sel.wallId);
      if (wall?.openings) wall.openings = wall.openings.filter((o) => o.id !== sel.id);
    } else {
      for (const level of this.host.levels) {
        if (sel.kind === 'wall' && level.walls) {
          level.walls = level.walls.filter((w) => w.id !== sel.id);
        }
        if (sel.kind === 'room' && level.rooms) {
          level.rooms = level.rooms.filter((r) => r.id !== sel.id);
        }
      }
    }
    this.selection = null;
    this.host.onChange();
  }

  rename(name: string): void {
    const sel = this.selection;
    if (!sel) return;
    this.history.capture();
    if (sel.kind === 'camera') {
      const cam = this.findCamera(sel.id);
      if (cam) cam.label = name;
    } else if (sel.kind === 'room') {
      const room = this.findRoom(sel.id);
      if (room) room.name = name;
    }
    this.host.onChange();
  }

  /** Numeric editing of whatever is selected, from the side panel. */
  setField(field: string, value: number | string): void {
    const sel = this.selection;
    if (!sel) return;
    this.history.capture();

    if (sel.kind === 'wall') {
      const wall = findWall(this.host.levels, sel.id);
      if (!wall) return;
      if (field === 'length' && typeof value === 'number' && value > 0) {
        wall.b = pointAt(wall.a, bearingOf(wall.a, wall.b), value);
      }
      if (field === 'thickness' && typeof value === 'number') wall.thickness = Math.max(0.02, value);
      if (field === 'height' && typeof value === 'number') wall.height = Math.max(0.1, value);
      if (field === 'transparent') wall.transparent = !wall.transparent;
    }

    if (sel.kind === 'opening' && sel.wallId) {
      const wall = findWall(this.host.levels, sel.wallId);
      const opening = wall?.openings?.find((o) => o.id === sel.id);
      if (!wall || !opening) return;
      if (field === 'width' && typeof value === 'number') {
        opening.width = Math.max(0.1, Math.min(dist(wall.a, wall.b) - opening.at, value));
      }
      if (field === 'sill' && typeof value === 'number') opening.sill = Math.max(0, value);
      if (field === 'head' && typeof value === 'number') opening.head = Math.max(0.2, value);
      if (field === 'kind' && typeof value === 'string') {
        opening.kind = value as Opening['kind'];
        // A window starts at sill height; a door reaches the floor. Setting
        // both together is what makes the type mean something.
        if (value === 'window' && !opening.sill) opening.sill = 1;
        if (value === 'door') opening.sill = 0;
      }
      if (field === 'blocksSight') opening.blocksSight = !opening.blocksSight;
    }

    if (sel.kind === 'camera') {
      const cam = this.findCamera(sel.id);
      if (!cam) return;
      if (typeof value === 'number') {
        if (field === 'azimuth') cam.azimuth = ((value % 360) + 360) % 360;
        if (field === 'fov') cam.fov = Math.min(340, Math.max(10, value));
        if (field === 'range') cam.range = Math.max(1, value);
        if (field === 'height') cam.height = Math.max(0, value);
        // Resolution is only ever read as a pair, but it is typed one box at a
        // time, so a half-filled pair has to stay legal until the second box.
        if (field === 'width' || field === 'height-px') {
          const [w, h] = cam.resolution ?? [1920, 1080];
          const px = Math.max(1, Math.round(value));
          cam.resolution = field === 'width' ? [px, h] : [w, px];
        }
      }
      if (typeof value === 'string') {
        if (field === 'name') {
          const next = value.trim();
          // A duplicate name would pass the editor and fail validation on the
          // way into Home Assistant, which is exactly the class of error this
          // editor exists to prevent.
          const taken = this.host.cameras.some((c) => c !== cam && c.name === next);
          if (next && !taken) {
            cam.name = next;
            this.selection = { kind: 'camera', id: next };
          }
        }
        if (field === 'entity') cam.entity = value.trim() || undefined;
        if (field === 'level' && this.host.levels.some((l) => l.id === value)) cam.level = value;
      }
    }

    this.host.onChange();
  }

  // ---- overlay ------------------------------------------------------------

  /** Draws everything that only exists while editing. */
  drawOverlay(): void {
    const z = this.levelZ;
    const level = this.level;
    if (!level) return;

    if (this.draft.length) {
      this.renderer.drawDraft(this.draft, this.cursor, z, this.tool === 'room');
      const anchor = this.draft[this.draft.length - 1];
      if (this.cursor) this.renderer.drawDimension(anchor, this.cursor, z, true);
    }

    for (const wall of level.walls ?? []) {
      const selected = this.selection?.kind === 'wall' && this.selection.id === wall.id;
      if (this.tool !== 'select' && !selected) continue;
      this.renderer.drawHandle(wall.a, z, CHART.sectorWhite, selected, 4);
      this.renderer.drawHandle(wall.b, z, CHART.sectorWhite, selected, 4);
      if (selected) this.renderer.drawDimension(wall.a, wall.b, z, true);
      for (const o of tidyOpenings(wall)) {
        const isSelected = this.selection?.kind === 'opening' && this.selection.id === o.id;
        this.renderer.drawHandle(pointAlong(wall, o.at + o.width / 2), z, CHART.sectorGreen, isSelected, 4);
      }
    }

    for (const room of level.rooms ?? []) {
      const selected = this.selection?.kind === 'room' && this.selection.id === room.id;
      if (!selected && this.tool !== 'select') continue;
      for (const p of room.ring) {
        this.renderer.drawHandle(p, z, CHART.parchment, selected, 4);
      }
    }

    if (this.lastSnap && this.cursor && this.tool !== 'select') {
      this.renderer.drawSnapHint(this.cursor, z, this.lastSnap.kind, this.lastSnap.angle);
    }

    if (this.pendingScale) {
      this.renderer.drawDimension(this.pendingScale.a, this.pendingScale.b, z, true);
    }
  }

  // ---- lookups ------------------------------------------------------------

  private findRoom(id: string): Room | undefined {
    for (const level of this.host.levels) {
      const room = level.rooms?.find((r) => r.id === id);
      if (room) return room;
    }
    return undefined;
  }

  private findCamera(name: string): CameraConfig | undefined {
    return this.host.cameras.find((c) => c.name === name);
  }
}

function bearingOf(a: Point, b: Point): number {
  return (((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI) + 360) % 360;
}

function pointAlong(wall: Wall, t: number): Point {
  const total = dist(wall.a, wall.b);
  if (total < 1e-9) return wall.a;
  const u: Point = [(wall.b[0] - wall.a[0]) / total, (wall.b[1] - wall.a[1]) / total];
  return [wall.a[0] + u[0] * t, wall.a[1] + u[1] * t];
}

function pointInRingLocal(p: Point, ring: Point[]): boolean {
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
