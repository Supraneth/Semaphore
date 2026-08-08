import type {
  CameraConfig,
  CameraRuntime,
  CameraState,
  Detection,
  Level,
  Point,
  SemaphoreConfig,
} from '../types';
import { computeIsovist, type Segment } from '../fov';
import { STATE_STYLES } from '../theme';
import { Renderer } from './renderer';
import { View } from './view';
import { PlanEditor } from './editor';
import { allPoints, occludersFor } from './geometry';

/**
 * Orchestration: view, runtimes, isovists, and the render loop.
 *
 * Two rules carried over from the map version, and they still earn their keep:
 * geometry is recomputed only when something geometric changed, never per
 * frame; and the loop exists only while there is a reason for it to — an orbit,
 * a sweeping sector, or an interaction. At rest the card costs nothing.
 */

export interface SceneCallbacks {
  onFrame: () => void;
  onIdleChange: (idle: boolean) => void;
}

export class Scene {
  readonly view: View;
  readonly renderer: Renderer;
  editor?: PlanEditor;

  private runtimes = new Map<string, CameraRuntime>();
  private occluders = new Map<string, Segment[]>();
  private detections: Detection[] = [];

  private raf = 0;
  private paused = false;
  private dirtyFrame = true;
  private lastInteraction = performance.now();
  private orbiting = false;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  activeLevel: string;
  explode = 0;
  showGrid = true;
  focusCamera: string | null = null;
  /** Frozen scene time while the timeline is scrubbed. */
  frozenTime: number | null = null;

  private started = performance.now();
  private resizeObserver?: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    private config: SemaphoreConfig,
    private cb: SceneCallbacks,
  ) {
    this.view = new View({
      yaw: config.view?.yaw ?? 0,
      pitch: config.view?.pitch ?? 45,
      zoom: config.view?.zoom ?? 34,
      center: config.view?.center ?? [0, 0],
    });
    this.renderer = new Renderer(canvas, this.view);
    this.renderer.onImageLoad = () => this.invalidate();
    this.activeLevel = config.levels[0]?.id ?? 'rdc';

    for (const cam of config.cameras) this.addRuntime(cam);
  }

  private addRuntime(cam: CameraConfig): void {
    this.runtimes.set(cam.name, {
      config: cam,
      state: 'nominal',
      intensity: STATE_STYLES.nominal.intensity,
      isovist: [],
      dirty: true,
      lastSeen: 0,
      lastEventAt: 0,
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  init(host: HTMLElement): void {
    const measure = (): void => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.renderer.resize(rect.width, rect.height);
      this.invalidate();
    };
    measure();

    this.resizeObserver = new ResizeObserver(measure);
    this.resizeObserver.observe(host);

    // Nothing was ever framed, so the first view is fitted to the scene rather
    // than dropped at an arbitrary zoom over an empty grid.
    if (!this.config.view?.center) this.frame();
    this.rebuildOccluders();
    this.start();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.editor?.detach();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) cancelAnimationFrame(this.raf);
    else this.start();
  }

  /** Frames everything the scene contains. */
  frame(): void {
    const points = allPoints(
      this.config.levels,
      this.config.cameras.map((c) => c.position),
    );
    const tallest = Math.max(
      0,
      ...this.config.levels.map(
        (l, i) => l.elevation + this.explode * i + (l.wallHeight ?? 2.5),
      ),
    );
    if (points.length) this.view.fit(points, 1.5, tallest);
    else this.view.fit([[-6, -6], [6, 6]], 2, tallest);
    this.invalidate();
  }

  // ---- geometry -----------------------------------------------------------

  /** Recomputes sight blockers. Cheap, and only on a geometric change. */
  rebuildOccluders(): void {
    for (const level of this.config.levels) {
      this.occluders.set(level.id, occludersFor(level));
    }
    for (const rt of this.runtimes.values()) rt.dirty = true;
    this.invalidate();
  }

  private levelOf(cam: CameraConfig): Level {
    return (
      this.config.levels.find((l) => l.id === (cam.level ?? this.config.levels[0]?.id)) ??
      this.config.levels[0]
    );
  }

  private refreshIsovists(): void {
    const resolution = this.config['fov-resolution'] ?? 1.5;
    for (const rt of this.runtimes.values()) {
      if (!rt.dirty && rt.isovist.length) continue;
      const level = this.levelOf(rt.config);
      rt.isovist = computeIsovist({
        origin: rt.config.position,
        azimuth: rt.config.azimuth,
        fov: rt.config.fov,
        range: rt.config.range,
        occluders: this.occluders.get(level?.id ?? '') ?? [],
        resolution,
      });
      rt.dirty = false;
    }
  }

  /** Picks up cameras added or removed by the editor. */
  syncCameras(): void {
    for (const cam of this.config.cameras) {
      const existing = this.runtimes.get(cam.name);
      if (!existing) this.addRuntime(cam);
      else existing.config = cam;
    }
    const live = new Set(this.config.cameras.map((c) => c.name));
    for (const name of [...this.runtimes.keys()]) {
      if (!live.has(name)) this.runtimes.delete(name);
    }
    for (const rt of this.runtimes.values()) rt.dirty = true;
    this.invalidate();
  }

  // ---- state --------------------------------------------------------------

  setCameraState(name: string, state: CameraState): void {
    const rt = this.runtimes.get(name);
    if (!rt || rt.state === state) return;
    rt.state = state;
    rt.intensity = STATE_STYLES[state].intensity;
    this.invalidate();
  }

  runtime(name: string): CameraRuntime | undefined {
    return this.runtimes.get(name);
  }

  setDetections(detections: Detection[]): void {
    this.detections = detections;
    this.invalidate();
  }

  setActiveLevel(id: string): void {
    if (this.activeLevel === id) return;
    this.activeLevel = id;
    this.noteInteraction();
  }

  setExploded(metres: number): void {
    this.explode = metres;
    // Separating storeys makes the scene several metres taller; without a
    // re-frame the upper floor simply leaves the canvas.
    this.frame();
  }

  focus(name: string | null): void {
    this.focusCamera = name;
    if (name) {
      const rt = this.runtimes.get(name);
      if (rt) {
        // Look along the lens: the map's heading matches the camera's, which
        // is the cheapest way to make "what am I looking at" obvious.
        this.view.yaw = rt.config.azimuth;
        this.view.pitch = 62;
        this.view.center = [...rt.config.position] as Point;
        this.view.zoom = Math.max(18, Math.min(90, 420 / Math.max(4, rt.config.range)));
        this.view.refresh();
      }
    }
    this.noteInteraction();
  }

  noteInteraction(): void {
    this.lastInteraction = performance.now();
    if (this.orbiting) {
      this.orbiting = false;
      this.cb.onIdleChange(false);
    }
    this.invalidate();
  }

  invalidate(): void {
    this.dirtyFrame = true;
  }

  // ---- editor -------------------------------------------------------------

  enableEditor(onChange: () => void): PlanEditor {
    if (this.editor) return this.editor;

    const scene = this;
    // `activeLevel` and `grid` are read live rather than copied, so switching
    // storey or grid size while the editor is open takes effect at once.
    const host = {
      levels: this.config.levels,
      cameras: this.config.cameras,
      get activeLevel(): string {
        return scene.activeLevel;
      },
      get grid(): number {
        return scene.config.grid ?? 0.5;
      },
      onChange: (): void => {
        this.rebuildOccluders();
        this.syncCameras();
        onChange();
      },
      onRepaint: (): void => this.invalidate(),
    };

    this.editor = new PlanEditor(this.canvas, this.renderer, host);
    this.editor.attach();
    return this.editor;
  }

  disableEditor(): void {
    this.editor?.detach();
    this.editor = undefined;
    this.invalidate();
  }

  get editing(): boolean {
    return !!this.editor;
  }

  // ---- render loop --------------------------------------------------------

  private start(): void {
    cancelAnimationFrame(this.raf);
    const step = (): void => {
      if (this.paused) return;
      const now = performance.now();

      const idleFor = now - this.lastInteraction;
      const resume = (this.config['orbit-resume'] ?? 6) * 1000;
      const speed = this.reducedMotion || this.editing ? 0 : this.config['orbit-speed'] ?? 0;

      if (!this.focusCamera && speed > 0 && idleFor > resume) {
        if (!this.orbiting) {
          this.orbiting = true;
          this.cb.onIdleChange(true);
        }
        this.view.yaw += speed / 60;
        this.view.refresh();
        this.dirtyFrame = true;
      }

      if (this.dirtyFrame || this.animating) {
        this.dirtyFrame = false;
        this.draw();
        this.cb.onFrame();
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /** The only reasons to keep painting once nothing has changed. */
  private get animating(): boolean {
    if (this.orbiting) return true;
    if (this.reducedMotion) return false;
    if (this.frozenTime !== null) return false;
    for (const rt of this.runtimes.values()) {
      if (STATE_STYLES[rt.state].sweep > 0) return true;
    }
    return this.detections.some((d) => d.trail.length > 0);
  }

  private draw(): void {
    this.refreshIsovists();
    this.renderer.render({
      levels: this.config.levels,
      activeLevel: this.activeLevel,
      runtimes: [...this.runtimes.values()],
      detections: this.detections,
      time: this.frozenTime ?? (performance.now() - this.started) / 1000,
      grid: this.config.grid ?? 0.5,
      focusCamera: this.focusCamera,
      showGrid: this.showGrid,
      reducedMotion: this.reducedMotion,
      explode: this.explode,
      editing: this.editing,
    });

    if (this.editor) {
      this.editor.drawOverlay();
      const selection = this.editor.selection;
      for (const rt of this.runtimes.values()) {
        if ((rt.config.level ?? this.config.levels[0]?.id) !== this.activeLevel) continue;
        const z = this.levelOf(rt.config)?.elevation ?? 0;
        this.renderer.drawCameraGizmo(
          rt,
          z,
          selection?.kind === 'camera' && selection.id === rt.config.name,
        );
      }
    }
  }

  /** Screen position of a camera, for the DOM chip overlay. */
  project(cam: CameraConfig): { x: number; y: number } {
    const level = this.levelOf(cam);
    const index = this.config.levels.indexOf(level);
    const z = (level?.elevation ?? 0) + this.explode * Math.max(0, index) + (cam.height ?? 2.6);
    const [x, y] = this.renderer.toScreen(cam.position, z);
    return { x, y };
  }
}
