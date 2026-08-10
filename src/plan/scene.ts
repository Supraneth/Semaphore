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
import { DEFAULT_VIEW, View, type ViewPreset } from './view';
import { ViewControls } from './controls';
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
  /** The user turned or zoomed the scene themselves. */
  onViewMoved?: () => void;
}

export class Scene {
  readonly view: View;
  readonly renderer: Renderer;

  /**
   * True while something outside owns the canvas — the standalone editor.
   *
   * The editor is deliberately not built here. A card on a dashboard should not
   * carry a drawing tool it never opens, and keeping `PlanEditor` out of this
   * file is what lets it fall out of the card's bundle entirely.
   */
  editing = false;
  /** Painted after the scene each frame, by whoever is editing. */
  overlay?: () => void;

  private controls?: ViewControls;
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
    readonly canvas: HTMLCanvasElement,
    private config: SemaphoreConfig,
    private cb: SceneCallbacks,
  ) {
    this.view = new View({
      // Not yaw 0: that is the one angle at which a tilted view of a
      // rectangular house shows no height at all. See `VIEW_PRESETS`.
      yaw: config.view?.yaw ?? DEFAULT_VIEW.yaw,
      pitch: config.view?.pitch ?? DEFAULT_VIEW.pitch,
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
      const resized = rect.width !== this.view.width || rect.height !== this.view.height;
      this.renderer.resize(rect.width, rect.height);
      // Home Assistant lays a card out *after* creating it — a dashboard view
      // that is not the active tab, a masonry column that sizes on the next
      // frame, the card editor's preview pane. Framing against a zero-sized
      // canvas is a silent no-op (`View.fit` cannot divide by no pixels), so
      // the scene stayed at the default zoom over the origin and the house sat
      // off-screen. The first measurement that yields real pixels is therefore
      // where framing has to happen, not construction time.
      if (!this.framed && !this.config.view?.center) this.frame();
      // And every measurement after it, because a zoom is pixels per metre
      // against a box that has just changed: a phone turning on its side, a
      // masonry column reflowing, the sections grid's own resize handles. The
      // house left the canvas on every one of those. Framing a view the user
      // placed themselves would be worse than the crop, so their angle wins —
      // until they press "Cadrer", which is the request to have it back.
      //
      // `editing` is excluded outright: the standalone editor drives the view
      // through `Renderer.view` and never through `ViewControls`, so nothing
      // here can tell that someone has spent a minute positioning the plan they
      // are drawing. Re-fitting the window they just resized would throw it
      // away. The editor has its own "Tout cadrer" for when it is wanted.
      else if (resized && !this.userFramed && !this.focusCamera && !this.editing) {
        this.frame();
      }
      this.invalidate();
    };
    measure();

    this.resizeObserver = new ResizeObserver(measure);
    this.resizeObserver.observe(host);

    this.controls = new ViewControls(this.canvas, this.view, {
      onChange: () => {
        this.userFramed = true;
        this.noteInteraction();
        this.cb.onViewMoved?.();
      },
    });
    if (!this.editing) this.controls.attach();

    this.rebuildOccluders();
    this.start();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.controls?.detach();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) cancelAnimationFrame(this.raf);
    else this.start();
  }

  /**
   * Snaps the camera to one of the three readings.
   *
   * Both the card and the standalone editor go through here, so "2.5D" means
   * the same thing in both — and the re-frame that a pitch change requires
   * cannot be forgotten by one of them.
   */
  applyPreset(preset: ViewPreset): void {
    this.view.yaw = preset.yaw;
    this.view.pitch = preset.pitch;
    this.view.refresh();
    this.frame();
    this.noteInteraction();
  }

  /** True once the scene has been fitted against a canvas with real pixels. */
  private framed = false;
  /**
   * The user placed this view by hand, so the card must stop re-fitting it on
   * every resize. Cleared by `frame()` — asking to frame is asking for the
   * automatic behaviour back.
   */
  private userFramed = false;

  /**
   * Frames what the scene will actually paint.
   *
   * Not what the document contains: stacked, only the active storey is drawn
   * (see `Renderer.render`), so fitting against every level sizes the view
   * around walls nobody can see. And the mass does not start at the ground —
   * a storey carries its own `elevation`, so the height range handed to `fit`
   * runs from the lowest floor drawn to the top of the walls standing on it.
   *
   * Deliberately not up to the lenses. A camera on a 3.2 m mast over a 2.5 m
   * storey would drag the framed mass above the building and push the building
   * itself down and off the bottom edge — to keep a dashed line and a chip in
   * view, when the chip is clamped onto the stage anyway. The building is the
   * subject; the mast is an annotation on it.
   */
  frame(): void {
    if (!this.view.width || !this.view.height) return;
    this.framed = true;
    this.userFramed = false;

    const shown = this.config.levels
      .map((level, index) => ({ level, index }))
      .filter(({ level }) => this.explode > 0 || level.id === this.activeLevel);
    // An active level that no longer exists must not frame against nothing.
    const drawn = shown.length
      ? shown
      : this.config.levels.map((level, index) => ({ level, index }));

    const ids = new Set(drawn.map(({ level }) => level.id));
    const fallback = this.config.levels[0]?.id;
    const cameras = this.config.cameras.filter((c) => ids.has(c.level ?? fallback));

    let low = Infinity;
    let high = -Infinity;
    for (const { level, index } of drawn) {
      const base = level.elevation + this.explode * index;
      low = Math.min(low, base);
      high = Math.max(high, base + (level.wallHeight ?? 2.5));
    }
    if (!Number.isFinite(low)) {
      low = 0;
      high = 0;
    }

    const points = allPoints(
      drawn.map(({ level }) => level),
      cameras.map((c) => c.position),
    );
    if (points.length) this.view.fit(points, 1.5, low, high);
    else this.view.fit([[-6, -6], [6, 6]], 2, low, high);
    this.invalidate();
  }

  // ---- geometry -----------------------------------------------------------

  /** Recomputes sight blockers. Cheap, and only on a geometric change. */
  rebuildOccluders(): void {
    for (const level of this.config.levels) {
      this.occluders.set(level.id, occludersFor(level, this.openOpenings));
    }
    for (const rt of this.runtimes.values()) rt.dirty = true;
    this.invalidate();
  }

  /** Openings a sensor reports open, by id. */
  private openOpenings: ReadonlySet<string> = new Set();

  /**
   * Which openings are currently open.
   *
   * A door swinging changes what the cameras can see, so this is a geometric
   * change and goes through `rebuildOccluders` — but only when the set actually
   * differs. The card calls this on every tick; recomputing isovists ten times a
   * second because nothing moved is exactly what invariant 6 exists to prevent.
   */
  setOpenOpenings(ids: ReadonlySet<string>): void {
    if (sameSet(this.openOpenings, ids)) return;
    this.openOpenings = new Set(ids);
    this.rebuildOccluders();
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
    // Stacked, changing storey changes the whole of what is painted — and it
    // moves vertically by the difference between the two elevations, which is
    // a metre in most houses and can be five. Framing is per-storey now, so
    // without this the storey you just asked for is drawn wherever the last
    // one happened to be framed, low or off the canvas entirely. A view the
    // user placed by hand is still theirs.
    if (!this.explode && !this.userFramed) this.frame();
    this.noteInteraction();
  }

  setExploded(metres: number): void {
    this.explode = metres;
    // Separating storeys makes the scene several metres taller; without a
    // re-frame the upper floor simply leaves the canvas.
    this.frame();
  }

  /** Where the view stood before a focus flight, so leaving can undo it. */
  private beforeFocus?: ReturnType<View['snapshot']>;

  focus(name: string | null): void {
    // Only the first focus records a return point: hopping straight from one
    // camera to another must still come back to the overview, not to the
    // previous camera's flight.
    if (name && !this.focusCamera) this.beforeFocus = this.view.snapshot();
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
    } else if (this.beforeFocus) {
      // Leaving focus put the user wherever the last camera happened to point.
      // The overview they came from is the one thing they asked for.
      Object.assign(this.view, this.beforeFocus, {
        center: [...this.beforeFocus.center] as Point,
      });
      this.view.refresh();
      this.beforeFocus = undefined;
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

  // ---- editing ------------------------------------------------------------

  /** Hands the canvas to an external editor, or takes it back. */
  setEditing(editing: boolean): void {
    this.editing = editing;
    if (editing) this.controls?.detach();
    else this.controls?.attach();
    this.invalidate();
  }

  /** Height of the floor a camera hangs over, exploded storeys included. */
  floorZ(cam: CameraConfig): number {
    const level = this.levelOf(cam);
    return (level?.elevation ?? 0) + this.explode * Math.max(0, this.config.levels.indexOf(level));
  }

  /** Called by the editor once it has changed the document. */
  documentChanged(): void {
    this.rebuildOccluders();
    this.syncCameras();
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
      showGrid: this.showGrid && this.config['show-grid'] !== false,
      showLabels: this.config['show-labels'] !== false,
      floorOpacity: this.config['floor-opacity'] ?? 0.1,
      reducedMotion: this.reducedMotion,
      explode: this.explode,
      openOpenings: this.openOpenings,
      editing: this.editing,
    });

    if (this.editing) this.overlay?.();
  }

  /** Every runtime, for an editor that needs to draw its own gizmos. */
  runtimes_(): CameraRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * Puts the view back where a previous session left it.
   *
   * Counts as the user having placed it themselves — because they did, one
   * reload ago. That is what stops the next resize from re-fitting it away, and
   * it stays theirs until they press "Cadrer".
   */
  restoreView(saved: ReturnType<View['snapshot']>): void {
    this.view.yaw = saved.yaw;
    this.view.pitch = saved.pitch;
    this.view.zoom = saved.zoom;
    this.view.center = [...saved.center] as Point;
    this.view.refresh();
    this.framed = true;
    this.userFramed = true;
    this.invalidate();
  }

  /** True while the view is one the user placed, rather than a fitted one. */
  get placedByUser(): boolean {
    return this.userFramed;
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

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
