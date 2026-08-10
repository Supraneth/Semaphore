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
import { MOTION, STATE_STYLES } from '../theme';
import { Renderer } from './renderer';
import { DEFAULT_VIEW, View, type ViewPreset } from './view';
import { ViewControls } from './controls';
import {
  DEFAULT_MOUNT_HEIGHT,
  DEFAULT_WALL_HEIGHT,
  allPoints,
  occludersFor,
} from './geometry';

/** Focus tilts to a reading that shows the cone as a solid. */
const FOCUS_PITCH = 62;
/**
 * Breathing room around the coverage, in **pixels**.
 *
 * Metres are the right unit for a margin around a building, whose size on screen
 * is what is being decided. Here the zoom is the outcome, so the only meaningful
 * statement of "not glued to the edge" is a number of pixels.
 */
const FOCUS_MARGIN_PX = 34;
/** How far a focus heading must sit from a grid axis to read as a volume. */
const FOCUS_MIN_OFF_AXIS = 15;

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
  /** The scene changed storey on its own — focusing a camera on another one. */
  onLevelChange?: (id: string) => void;
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
        // A hand on the scene outranks a flight it is in the middle of.
        this.cutFlight();
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
    this.cutFlight();
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
    // Fitting places the view outright; a flight still running would drag it
    // back off the building over the next half second.
    this.cutFlight();
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

  /**
   * Switches storey without reframing — the caller is about to place the view
   * itself. `setActiveLevel` is the user-facing door and reframes; this is the
   * one a focus goes through, and it tells the card so its control agrees.
   */
  private showLevel(id: string): void {
    if (!id || this.activeLevel === id) return;
    if (!this.config.levels.some((l) => l.id === id)) return;
    this.activeLevel = id;
    this.cb.onLevelChange?.(id);
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
  private beforeFocus?: Snapshot;
  /** And which storey was on, since focusing can change it. */
  private beforeFocusLevel?: string;

  focus(name: string | null): void {
    // Only the first focus records a return point: hopping straight from one
    // camera to another must still come back to the overview, not to the
    // previous camera's flight.
    if (name && !this.focusCamera) {
      this.beforeFocus = this.view.snapshot();
      this.beforeFocusLevel = this.activeLevel;
    }
    this.focusCamera = name;

    if (name) {
      const rt = this.runtimes.get(name);
      if (rt) {
        // Stacked, only the active storey is drawn — so opening a camera on
        // another one framed a floor that was not being painted, and left an
        // empty grid with the real storey pushed off the bottom. It was already
        // meaningless before the framing changed: `placedCameras` skips a camera
        // whose storey is hidden, so there was no cone to look at either.
        this.showLevel(rt.config.level ?? this.config.levels[0]?.id ?? this.activeLevel);
        // The isovist is the thing being framed, so it has to exist first.
        this.refreshIsovists();
        this.flyTo(this.focusView(rt));
      }
    } else if (this.beforeFocus) {
      if (this.beforeFocusLevel) this.showLevel(this.beforeFocusLevel);
      this.beforeFocusLevel = undefined;
      // Leaving focus put the user wherever the last camera happened to point.
      // The overview they came from is the one thing they asked for.
      this.flyTo(this.beforeFocus);
      this.beforeFocus = undefined;
    }
    this.noteInteraction();
  }

  /**
   * Where a focus should land.
   *
   * Not "put the camera at the centre of the canvas". That drops the canvas
   * centre on the lens's *feet*, and at a 62° pitch everything painted stands
   * above its ground position: the storey's own elevation, plus 2.5 m of wall,
   * plus the mast. The building was pushed up and out of the frame, and a
   * camera sitting on an outside wall — where cameras sit — put half the view
   * on the empty ground outside the house. Invariant 15 applies here exactly as
   * it does to `frame()`: fit what is painted, over the height range it is
   * painted at, measured on the screen's axes and not the world's.
   *
   * What a focus is *about* is the coverage, so the isovist is what gets
   * fitted — and it already carries the lens as its apex. Unlike `frame()` the
   * range runs up to the mast: there the mast is an annotation on a building
   * and would drag the building off the bottom, here it is the subject.
   *
   * Fitted on a scratch `View` so the live one is untouched — we are flying to
   * this, not jumping to it, and `View.fit` mutates whatever it is given.
   */
  private focusView(rt: CameraRuntime): Snapshot {
    const cam = rt.config;
    const level = this.levelOf(cam);
    const index = Math.max(0, this.config.levels.indexOf(level));
    const base = (level?.elevation ?? 0) + this.explode * index;
    const mount = cam.height ?? DEFAULT_MOUNT_HEIGHT;

    const yaw = offAxis(cam.azimuth, FOCUS_MIN_OFF_AXIS);
    const probe = new View({ yaw, pitch: FOCUS_PITCH });
    probe.resize(this.view.width, this.view.height);

    // Before the canvas has been measured `fit` is a silent no-op, so there is
    // nothing better to do than point at the camera and keep the zoom.
    if (!this.view.width || !this.view.height) {
      return { yaw, pitch: FOCUS_PITCH, zoom: this.view.zoom, center: [...cam.position] as Point };
    }

    // What is painted during a focus is the whole storey *and* the cone, so
    // that is what gets framed. Fitting the coverage alone guaranteed the rest
    // of the plan left the frame — which is the complaint restated, not fixed.
    const coverage: Point[] =
      rt.isovist.length >= 3
        ? rt.isovist
        : // No coverage to speak of: a box the size of the camera's reach, so
          // the fit has something with an extent rather than a single point.
          [
            [cam.position[0] - cam.range, cam.position[1] - cam.range],
            [cam.position[0] + cam.range, cam.position[1] + cam.range],
          ];
    const points = allPoints([level], coverage);

    const top = base + Math.max(level?.wallHeight ?? DEFAULT_WALL_HEIGHT, mount);
    probe.fit(points, 0.5, base, top);
    // `fit` centres the world-space bounding box, which is the projected centre
    // only for a shape symmetric about it — true enough of a rectangular house,
    // false of an isovist, which is a fan. Cuisine landed 84 px off. Measuring
    // the projected box and correcting on it costs two passes and is exact:
    // orthographic, so scaling the zoom scales that box about the view centre
    // and a pan moves it by the same number of pixels.
    fitProjected(probe, points, base, top, FOCUS_MARGIN_PX);
    return probe.snapshot();
  }

  /**
   * The view the card should remember — the overview, even mid-flight.
   *
   * A focus is a place the card took you, not a place you chose, and it must
   * never end up as the remembered view: the card would reopen on one camera's
   * lens, `restoreView` would mark it user-placed so it never re-fits, and the
   * overview would be gone for good. Both ordinary triggers hit this — the card
   * being torn down while focused (a dashboard tab change, an edit), and a save
   * still pending from a drag when a camera is opened.
   */
  get restingView(): Snapshot {
    // Focused: the view it will come back to. Unfocused but still flying home:
    // the destination, not the frame it happens to be passing through.
    const resting = this.beforeFocus ?? this.flight?.to ?? this.view.snapshot();
    return { ...resting, center: [...resting.center] as Point };
  }

  /**
   * The storey the card should remember, for the same reason as `restingView`.
   *
   * Focusing a camera upstairs switches storey, and that switch belongs to the
   * focus, not to the user. Stored, the card reopened on a floor nobody asked
   * for.
   */
  get restingLevel(): string {
    return this.beforeFocusLevel ?? this.activeLevel;
  }

  // ---- flights ------------------------------------------------------------

  private flight?: { from: Snapshot; to: Snapshot; started: number };

  /**
   * Moves the camera there over `MOTION.flight`, rather than teleporting.
   *
   * Focus used to assign the view outright. From an overview at yaw 20 to a lens
   * at 330 that is a 310-degree discontinuity in one frame — indistinguishable
   * from the scene being scrambled, and it took the viewer's sense of which way
   * the house faces with it. Interpolated, and turning the short way, the same
   * change reads as the camera swinging round to look.
   */
  private flyTo(to: Snapshot): void {
    // Anyone who asked the OS to stop motion gets the destination, not a ride.
    if (this.reducedMotion) {
      this.flight = undefined;
      this.applyView(to);
      this.invalidate();
      return;
    }
    this.flight = { from: this.view.snapshot(), to, started: performance.now() };
    this.invalidate();
  }

  private applyView(v: Snapshot): void {
    this.view.yaw = v.yaw;
    this.view.pitch = v.pitch;
    this.view.zoom = v.zoom;
    this.view.center = [...v.center] as Point;
    this.view.refresh();
  }

  /** Abandons a flight in progress. Anything that places the view calls this. */
  private cutFlight(): void {
    this.flight = undefined;
  }

  private advanceFlight(now: number): void {
    const flight = this.flight;
    if (!flight) return;
    const { from, to } = flight;
    const t = Math.min(1, (now - flight.started) / MOTION.flight);
    // `MOTION.ease` is cubic-bezier(0.22, 1, 0.36, 1), which is easeOutQuint —
    // exactly this curve. One easing for the DOM and the canvas, so a panel
    // arriving and the camera it belongs to land together.
    const k = 1 - (1 - t) ** 5;

    // The short way round: 20 to 330 is a 50-degree turn left, not 310 right.
    const turn = (((to.yaw - from.yaw) % 360) + 540) % 360 - 180;
    this.view.yaw = from.yaw + turn * k;
    this.view.pitch = from.pitch + (to.pitch - from.pitch) * k;
    // Zoom multiplies rather than adds: a linear ramp from 18 to 90 px/m spends
    // most of its time close-up and arrives as a lurch.
    this.view.zoom = from.zoom * (to.zoom / from.zoom) ** k;
    this.view.center = [
      from.center[0] + (to.center[0] - from.center[0]) * k,
      from.center[1] + (to.center[1] - from.center[1]) * k,
    ];
    this.view.refresh();

    if (t >= 1) {
      // Land on the asked-for numbers, not on the last interpolated ones: the
      // return from focus has to be the exact view it left, to the pixel.
      this.applyView(to);
      this.flight = undefined;
    }
    this.dirtyFrame = true;
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

      this.advanceFlight(now);

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
    // A flight is the one animation that must run even under reduced motion's
    // usual exclusions — except it never starts there, `flyTo` snaps instead.
    if (this.flight) return true;
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
  restoreView(saved: Snapshot): void {
    this.cutFlight();
    this.applyView(saved);
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

type Snapshot = ReturnType<View['snapshot']>;

/**
 * Nudges a heading off the grid axes, by the smallest amount that works.
 *
 * Invariant 17, applied to focus. At a yaw that is a multiple of 90 every wall
 * parallel to it is seen exactly edge-on, and a rectangular storey at a 62°
 * pitch collapses into a flat elevation — the height is drawn and none of it is
 * visible. Cameras get mounted square to walls, so their azimuths land on those
 * axes constantly: the sample house's landing camera looks due south, and its
 * focus read as a blank wall.
 *
 * A heading already clear of the axes is returned untouched — the point of
 * matching the lens is that you look along it, and that should be given up by
 * as few degrees as possible.
 */
function offAxis(yaw: number, minimum: number): number {
  const off = ((yaw % 90) + 90) % 90;
  if (off >= minimum && off <= 90 - minimum) return yaw;
  // Whichever side of the axis is nearer, so the lens heading is barely moved.
  return off < minimum ? yaw + (minimum - off) : yaw - (off - (90 - minimum));
}

/**
 * Sizes and centres a view on the screen box its points actually occupy.
 *
 * `View.fit` reasons in world space and corrects for height analytically, which
 * is right for a building and approximate for anything whose extremes are not
 * symmetric about its bounding box — an isovist fan under yaw, most of all.
 * This measures instead. Two passes and no iteration: the projection is
 * orthographic, so scaling the zoom scales the projected box about the view
 * centre exactly, and panning translates it pixel for pixel.
 */
function fitProjected(
  view: View,
  points: Point[],
  zMin: number,
  zMax: number,
  marginPx: number,
): void {
  const measure = (): { minX: number; maxX: number; minY: number; maxY: number } => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      for (const z of [zMin, zMax]) {
        const [x, y] = view.projectPoint(p, z);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, maxX, minY, maxY };
  };

  const first = measure();
  if (!Number.isFinite(first.minX)) return;

  const room = (span: number, box: number): number => Math.max(1, span - marginPx * 2) / Math.max(1, box);
  view.zoom *= Math.min(
    room(view.width, first.maxX - first.minX),
    room(view.height, first.maxY - first.minY),
  );
  view.refresh();

  const scaled = measure();
  view.panBy(
    view.width / 2 - (scaled.minX + scaled.maxX) / 2,
    view.height / 2 - (scaled.minY + scaled.maxY) / 2,
  );
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
