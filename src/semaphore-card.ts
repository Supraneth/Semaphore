import { LitElement, html, nothing, svg, type TemplateResult } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ref } from 'lit/directives/ref.js';
import type { CameraConfig, CameraState, Detection, Point, SemaphoreConfig } from './types';
import { validateConfig } from './config';
import { Scene } from './plan/scene';
import { FrigateBridge, type BridgeHealth } from './frigate';
import { STATE_STYLES, labelCss, labelName, withAlpha } from './theme';
import { styles } from './semaphore-card-css';
import { DEFAULT_VIEW, VIEW_PRESETS, presetOf, type ViewPreset } from './plan/view';
import { groupEvents, groupOf, type EventGroup } from './events';
import {
  actionsFor,
  codeIsNumeric,
  needsCode,
  readAlarm,
  type ArmAction,
} from './alarm';
import { agoLabel, clockLabel, durationLabel, hourLabel, spanOf } from './format';
import './semaphore-events';
import './semaphore-wall';

/**
 * The card.
 *
 * It shows a scene and it lets you turn it. That is the whole of it — drawing
 * the plan happens in the standalone editor, which has a window to do it in and
 * a document of its own. A dashboard card that also contained a CAD tool was
 * carrying tools nobody opens twice past the ones they use daily, and the cost
 * was paid on every load by every user.
 */

const TICK_MS = 100;
const THUMB_REFRESH_MS = 10_000;

/**
 * The four glyphs the chrome needs, inline.
 *
 * Not `ha-icon`: that pulls Home Assistant's whole icon set for four shapes, and
 * the standalone bench has no such element to render. Drawn on a 24-grid in
 * `currentColor`, so a button's own state colours its glyph.
 */
/** How far a chip may be pulled back onto the stage before it is simply gone. */
const CHIP_CLAMP_PX = 44;

/**
 * Steps that keep an axis reading in round numbers, in milliseconds.
 *
 * Minutes as well as hours, now that the window can be a quarter of an hour —
 * an hour ladder on a fifteen-minute span produces one mark, or none.
 */
const MINUTE = 60_000;
const STEPS_MS = [
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  60 * MINUTE,
  2 * 60 * MINUTE,
  3 * 60 * MINUTE,
  6 * 60 * MINUTE,
  12 * 60 * MINUTE,
  24 * 60 * MINUTE,
];

/** The four windows worth a button. */
const WINDOWS = [
  { label: '15 min', ms: 15 * MINUTE },
  { label: '1 h', ms: 60 * MINUTE },
  { label: '6 h', ms: 6 * 60 * MINUTE },
  { label: '24 h', ms: 24 * 60 * MINUTE },
];

/**
 * An axis mark.
 *
 * Driven by the *step*, never by the span: a six-hour window whose marks fall
 * every thirty minutes printed "07 h 07 h 08 h 08 h" when the label was chosen
 * from the span. Anything finer than an hour needs the minutes.
 */
const tickLabel = (t: number, step: number): string =>
  step < 60 * MINUTE ? clockLabel(t) : hourLabel(t);
/** Narrowest a labelled hour mark can sit next to the one before it. */
const TICK_MIN_PX = 64;
/** Room kept clear at the right for "maintenant". */
const NOW_LABEL_PX = 78;

const ICON = {
  /** Storeys pulled apart. */
  split: svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16M4 15h16M12 2v4m0 12v4M9.5 4.5 12 2l2.5 2.5M9.5 19.5 12 22l2.5-2.5"/></svg>`,
  /** Storeys back on top of each other. */
  stack: svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  /** Fit everything on screen: corner brackets. */
  frame: svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  close: svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
  /** The shortcut sheet. */
  keys: svg`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M7 10h.01M11 10h.01M15 10h2M7 14h10"/></svg>`,
} as const;

/**
 * The three things the card is for, one at a time.
 *
 * Not three cards, and not three panes side by side. Side by side is a layout
 * that only exists above about 900 px, so it would have to be designed twice
 * and the phone would get the worse half — and a phone is where a home
 * dashboard is actually read. One pane at a time is the same shape at every
 * width, and it is what lets each of the three have the whole card instead of a
 * third of it.
 */
const MODES = [
  { id: 'plan', label: 'Plan', key: 'p' },
  { id: 'live', label: 'Direct', key: 'l' },
  { id: 'events', label: 'Événements', key: 'e' },
] as const;

type Mode = (typeof MODES)[number]['id'];

/** What the keyboard does, and the sheet that says so. */
const SHORTCUTS: Array<[string, string]> = [
  ['P L E', 'Plan · Direct · Événements'],
  ['1 – 9', 'Ouvrir la caméra n°…'],
  ['← →', 'Caméra précédente / suivante'],
  ['Échap', "Revenir à la vue d'ensemble"],
  ['C', 'Tout cadrer'],
  ['N', 'Niveau suivant'],
  ['S', 'Séparer / empiler les niveaux'],
  ['?', 'Afficher ou masquer cette aide'],
];

/** Local state a reload should not throw away. Bumped if the shape changes. */
const STORE_PREFIX = 'semaphore-card/v1';
/** A drag fires dozens of view changes a second; the disk does not need them. */
const SAVE_DEBOUNCE_MS = 500;
/** Events that have been read, capped so the record cannot grow without end. */
const MAX_SEEN = 400;

interface SavedState {
  view?: { yaw: number; pitch: number; zoom: number; center: Point };
  level?: string;
  exploded?: boolean;
  mode?: Mode;
  seen?: string[];
}

@customElement('semaphore-card')
export class SemaphoreCard extends LitElement {
  static override styles = styles;

  @property({ attribute: false }) hass: any;
  @state() private config!: SemaphoreConfig;
  @state() private migrated = false;
  @state() private focused: string | null = null;
  @state() private activeLevel = '';
  @state() private exploded = false;
  /**
   * The reading the user asked for. Undefined once they have turned the scene
   * by hand: no preset button should claim credit for an angle they found.
   */
  @state() private preset: ViewPreset | undefined = DEFAULT_VIEW;
  @state() private events: Detection[] = [];
  /** Time under the pointer on the timeline, in ms. */
  @state() private cursor: number | null = null;
  /** The event whose details the focus panel is showing. */
  @state() private selected: Detection | null = null;
  /**
   * The right edge of the timeline, refreshed on the tick.
   *
   * Read once per render rather than from `Date.now()` at each of the dozen
   * places that need it, or the marks, the axis and the cursor each land on a
   * slightly different "now" and the whole thing shears.
   */
  private now = Date.now();
  @state() private ready = false;
  @state() private error = '';
  /** What the bridge is actually receiving. Drives the degradation notices. */
  @state() private health?: BridgeHealth;
  /** Ids of the openings a sensor reports open. */
  @state() private openIds: ReadonlySet<string> = new Set();
  @state() private showHelp = false;
  @state() private mode: Mode = 'plan';
  @state() private showArm = false;
  @state() private armCode = '';
  @state() private armError = '';
  /** Event groups already opened, so the feed can say what is new. */
  @state() private seen: ReadonlySet<string> = new Set();
  /** The group the feed and the panel agree is selected. */
  @state() private selectedGroup: string | null = null;

  @query('.canvas') private canvasEl?: HTMLCanvasElement;
  @query('.stage') private stageEl?: HTMLElement;

  private scene?: Scene;
  private bridge?: FrigateBridge;
  private tick = 0;
  private eventsVersion = -1;
  private thumbTimer = 0;
  private thumbNonce = 0;
  private chipEls = new Map<string, HTMLElement>();
  private io?: IntersectionObserver;
  private states = new Map<string, CameraState>();
  private saveTimer = 0;
  /** True while the card is on screen; combined with the mode to pause the loop. */
  private onScreen = true;

  /**
   * Detections folded into the events a person would recognise.
   *
   * Recomputed whenever the flat list changes rather than on every render: it
   * is O(n log n) over a few hundred items and the card renders on a tick.
   */
  private groupCache: { source: Detection[]; groups: EventGroup[] } = {
    source: [],
    groups: [],
  };

  private get groups(): EventGroup[] {
    if (this.groupCache.source !== this.events) {
      this.groupCache = {
        source: this.events,
        groups: groupEvents(this.events, (this.config['group-gap-seconds'] ?? 120) * 1000),
      };
    }
    return this.groupCache.groups;
  }

  // ---- Home Assistant contract -------------------------------------------

  setConfig(config: SemaphoreConfig): void {
    const result = validateConfig(config);
    this.config = result.config;
    this.migrated = result.migrated;
    this.activeLevel = this.config.levels[0].id;
    const wanted = this.config['default-mode'];
    if (wanted && MODES.some((m) => m.id === wanted)) this.mode = wanted;
    const view = this.config.view;
    this.preset = view
      ? presetOf(view.yaw ?? DEFAULT_VIEW.yaw, view.pitch ?? DEFAULT_VIEW.pitch)
      : DEFAULT_VIEW;
  }

  getCardSize(): number {
    return 10;
  }

  /**
   * Sizing in the sections dashboard.
   *
   * Home Assistant sizes a card in a sections view from these, and writes the
   * user's drag back into the card's own config as `grid_options`. Declaring
   * them is what puts the resize handles on the card at all — without them a
   * scene is stuck at whatever width and height it decided for itself.
   */
  getGridOptions(): Record<string, unknown> {
    return {
      columns: 'full',
      rows: 8,
      min_columns: 6,
      min_rows: 4,
    };
  }

  /** The name this had before Home Assistant 2024.11. Same answer. */
  getLayoutOptions(): Record<string, unknown> {
    return this.getGridOptions();
  }

  /**
   * The scene's box.
   *
   * Three cases, in order. A dashboard that has given the card a row count owns
   * the height and the scene simply fills it — imposing an aspect ratio there
   * would leave a gap or overflow. An explicit `height` wins next. Otherwise the
   * card keeps its own shape and its own cap, so it never eats a phone screen.
   */
  private stageStyle(): string {
    const rows = (this.config as Record<string, any>).grid_options?.rows;
    // `flex` rather than `height:100%`: the card is a flex column, and the
    // timeline below has to keep its own height out of the share. The floor
    // matters — a dashboard that promises a row count and then gives the card
    // no definite height would otherwise collapse the scene to nothing.
    if (typeof rows === 'number') return 'flex:1 1 auto;min-height:200px;max-height:none';

    const cap = this.config['max-height'];
    const max = cap ? `${cap}px` : '74vh';
    if (this.config.height) return `height:${this.config.height}px;max-height:${max}`;
    if (this.config['aspect-ratio']) {
      return `aspect-ratio:${this.config['aspect-ratio']};max-height:${max}`;
    }
    // No shape asked for: the stylesheet picks one from the card's own width.
    // 16/10 on a phone-width card is a 240 px scene with a control bar at each
    // end, and the plan lives on what is left. Only a container query knows how
    // wide the card actually is, and an inline style cannot carry one.
    return `max-height:${max}`;
  }

  /** True when the shape of the scene is the stylesheet's call, not the config's. */
  private get autoAspect(): boolean {
    const rows = (this.config as Record<string, any>).grid_options?.rows;
    return (
      typeof rows !== 'number' && !this.config.height && !this.config['aspect-ratio']
    );
  }

  static getStubConfig(): Partial<SemaphoreConfig> {
    return {
      grid: 0.5,
      levels: [{ id: 'rdc', name: 'Rez-de-chaussée', elevation: 0, walls: [], rooms: [] }],
      cameras: [],
    };
  }

  // ---- lifecycle ----------------------------------------------------------

  override firstUpdated(): void {
    // Booting sets `ready`, and setting reactive state from inside the update
    // that has just finished is what makes Lit schedule a second one and warn
    // about it. One task is enough to be clear of the cycle, and the canvas is
    // already in the DOM by then.
    setTimeout(() => void this.boot(), 0);
    this.io = new IntersectionObserver(
      ([entry]) => this.setActive(entry.isIntersecting && !document.hidden),
      { threshold: 0.01 },
    );
    this.io.observe(this);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.io?.disconnect();
    this.timelineObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearInterval(this.tick);
    clearInterval(this.thumbTimer);
    clearTimeout(this.saveTimer);
    // A card removed mid-drag — a tab change, a dashboard edit — must not lose
    // the placement the debounce was still holding.
    this.saveNow();
    this.bridge?.disconnect();
    this.scene?.destroy();
  }

  private onVisibility = (): void => this.setActive(!document.hidden);

  private setActive(active: boolean): void {
    this.onScreen = active;
    this.syncPaused();
    if (active && !this.thumbTimer) {
      this.thumbTimer = window.setInterval(() => {
        this.thumbNonce = Date.now();
        this.requestUpdate();
      }, THUMB_REFRESH_MS);
    } else if (!active) {
      clearInterval(this.thumbTimer);
      this.thumbTimer = 0;
    }
  }

  private async boot(): Promise<void> {
    const canvas = this.canvasEl;
    const stage = this.stageEl;
    if (!canvas || !stage) return;

    try {
      this.scene = new Scene(canvas, this.config, {
        onFrame: () => this.positionChips(),
        onIdleChange: () => undefined,
        // Turning the scene by hand means no preset describes it any more.
        // Focusing a camera on another storey switches to it; the segmented
        // control has to say so, and the chips have to stop dimming.
        onLevelChange: (id: string) => {
          this.activeLevel = id;
        },
        onViewMoved: () => {
          this.saveSoon();
          if (this.preset) {
            this.preset = undefined;
            this.requestUpdate();
          }
        },
      });
      this.scene.init(stage);
      this.restore();
      this.ready = true;

      this.bridge = new FrigateBridge(this.hass, this.config.cameras, {
        topicPrefix: this.config['topic-prefix'],
        instanceId: this.config['instance-id'],
        alertLabels: this.config['alert-labels'],
        boxFormat: this.config['box-format'],
        retentionMs: (this.config['decay-seconds'] ?? 12) * 1000 + 4000,
      });
      await this.bridge.connect();
      this.health = { ...this.bridge.health };

      this.tick = window.setInterval(() => this.update_(), TICK_MS);
      this.events = await this.bridge.fetchHistory(
        Date.now() - (this.config['timeline-hours'] ?? 24) * 3600_000,
      );
      this.health = { ...this.bridge.health };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.error = `La scène n'a pas pu démarrer : ${detail}`;
      console.error('[semaphore] initialisation failed', err);
    }
  }

  override updated(): void {
    this.bridge?.setHass(this.hass);
    this.measureChips();
    // Chips are placed by the render loop, and the render loop deliberately does
    // not run at rest (invariant 7). Any Lit re-render between two paints — a
    // state change, a level switch, a new thumbnail — therefore handed back a
    // fresh element that had never been positioned, and an absolutely placed
    // element with no transform sits at the stage's top-left corner, on top of
    // the storey control. Placing them here as well costs nothing: the sizes
    // have just been measured and no layout is read back.
    this.positionChips();
  }

  // ---- the one tick -------------------------------------------------------

  private update_(): void {
    if (!this.scene || !this.bridge) return;
    const now = Date.now();
    this.now = now;
    this.bridge.prune(now);

    const decay = (this.config['decay-seconds'] ?? 12) * 1000;
    let dirty = false;

    for (const cam of this.config.cameras) {
      const entity = this.bridge.cameraEntity(cam);
      const live = this.bridge.liveFor(cam.name);
      const alerting = live.some((d) => this.bridge!.isAlert(d));

      let next: CameraState;
      if (this.hass && (!entity || entity.state === 'unavailable')) next = 'offline';
      else if (alerting) next = 'alert';
      else if (live.length) next = 'motion';
      else next = 'nominal';

      const rt = this.scene.runtime(cam.name);
      if (rt && next !== 'nominal') rt.lastEventAt = now;
      // A cone that flickers off is a cone you stop trusting.
      if (rt && next === 'nominal' && now - rt.lastEventAt < decay) {
        next = this.states.get(cam.name) === 'alert' ? 'alert' : 'motion';
      }

      if (this.states.get(cam.name) !== next) {
        this.states.set(cam.name, next);
        this.scene.setCameraState(cam.name, next);
        dirty = true;
      }
    }

    this.scene.setDetections(this.bridge.liveDetections());

    if (this.refreshOpenings()) dirty = true;

    if (this.bridge.timelineVersion !== this.eventsVersion) {
      this.eventsVersion = this.bridge.timelineVersion;
      this.events = this.bridge.timeline(
        now - (this.config['timeline-hours'] ?? 24) * 3600_000,
      );
      dirty = true;
    }

    if (dirty) this.requestUpdate();
  }

  // ---- openings -----------------------------------------------------------

  /**
   * Which doors and windows are open, from their sensors.
   *
   * `on` is what a `binary_sensor` in the door or window class reports; `open`
   * covers a `cover` entity used for the same job. Anything else — including
   * `unavailable` — counts as shut, because drawing a red aperture for a sensor
   * that has simply lost its battery is a false alarm, and a security readout
   * that cries wolf stops being read.
   */
  private refreshOpenings(): boolean {
    const open = new Set<string>();
    for (const level of this.config.levels) {
      for (const wall of level.walls ?? []) {
        for (const o of wall.openings ?? []) {
          if (!o.entity) continue;
          const state = this.hass?.states?.[o.entity]?.state;
          if (state === 'on' || state === 'open') open.add(o.id);
        }
      }
    }

    if (open.size === this.openIds.size && [...open].every((id) => this.openIds.has(id))) {
      return false;
    }
    this.openIds = open;
    // A door that opens stops blocking sight, so the isovists have to follow it.
    this.scene?.setOpenOpenings(open);
    return true;
  }

  // ---- overlay ------------------------------------------------------------

  private bindChip(name: string, el: Element | undefined): void {
    if (el) this.chipEls.set(name, el as HTMLElement);
    else this.chipEls.delete(name);
  }

  /**
   * Chips follow the scene, and stay inside it.
   *
   * A camera near the edge of the plan used to have half its chip cut off by the
   * card — the label that says which camera it is being exactly the half that
   * left. Clamping keeps the whole chip on the stage; the mast drawn on the
   * canvas is what still ties it to its real place on the floor.
   *
   * Sizes come from the cache rather than from `offsetWidth` here: this runs on
   * every frame of an orbit, and reading layout back after writing a transform
   * is the classic way to make a smooth animation stutter.
   */
  private positionChips(): void {
    if (!this.scene) return;
    const stage = this.stageEl;
    const width = stage?.clientWidth ?? 0;
    const height = stage?.clientHeight ?? 0;

    for (const cam of this.config.cameras) {
      const el = this.chipEls.get(cam.name);
      if (!el) continue;
      const { x, y } = this.scene.project(cam);
      const size = this.chipSizes.get(cam.name);

      let px = x;
      let py = y;
      if (size && width && height) {
        const halfW = size.w / 2 + 4;
        const halfH = size.h / 2 + 4;
        // Only clamp when there is room to: on a card narrower than the chip,
        // centring beats pinning it to an edge it overflows in both directions.
        if (width > size.w + 8) px = Math.max(halfW, Math.min(width - halfW, x));
        if (height > size.h + 8) py = Math.max(halfH, Math.min(height - halfH, y));
      }

      // The focused camera already has the panel carrying its name and state,
      // and the flight puts its lens near the top of the stage where the chip
      // lands on the storey control. Two labels for one camera, one of them in
      // the way.
      if (this.focused === cam.name) {
        el.classList.add('off');
        continue;
      }

      const drift = Math.hypot(px - x, py - y);
      // Past the budget the camera is not near the edge, it is somewhere else
      // entirely — zoomed past, or behind the lens of a focus flight. Dragging
      // it back would stack every absent camera in the same corner, which is
      // how the overview turned into a pile of chips the moment one was
      // focused. Beyond the budget a chip is simply not on this view.
      const off = drift > CHIP_CLAMP_PX;
      el.classList.toggle('off', off);
      if (off) continue;

      el.style.transform = `translate3d(${Math.round(px)}px, ${Math.round(py)}px, 0) translate(-50%, -50%)`;
      // Pushed off its true spot, the chip is a legend entry rather than a pin,
      // and it should not claim the precision it no longer has.
      el.classList.toggle('adrift', drift > 1);
      const onLevel = (cam.level ?? this.config.levels[0].id) === this.activeLevel;
      el.classList.toggle('dim', !onLevel && !this.exploded);
    }
  }

  /** Chip footprints, remeasured only when the DOM that draws them changed. */
  private chipSizes = new Map<string, { w: number; h: number }>();

  private measureChips(): void {
    for (const [name, el] of this.chipEls) {
      this.chipSizes.set(name, { w: el.offsetWidth, h: el.offsetHeight });
    }
  }

  // ---- actions ------------------------------------------------------------

  private focusCamera(name: string): void {
    // Opening a camera is a request to see where it is, so it is also a request
    // for the plan — from the feed, from the wall, or from a digit key.
    this.setMode('plan');
    this.focused = name;
    // Focusing flies to the lens's own heading, which is no preset's angle.
    this.preset = undefined;
    this.scene?.focus(name);
  }

  private unfocus(): void {
    this.focused = null;
    this.selected = null;
    this.scene?.focus(null);
  }

  /**
   * The render loop runs for the plan, and only when the plan is on screen.
   *
   * A wall of streams or a list of thumbnails has no use for a canvas being
   * repainted behind it, and invariant 7 is about not painting without a
   * reason. Being on another tab of the same card is exactly that.
   */
  private syncPaused(): void {
    this.scene?.setPaused(!this.onScreen || this.mode !== 'plan');
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.syncPaused();
    this.saveSoon();
  }

  /**
   * One click, three answers.
   *
   * This is the whole reason the feed lives inside the card rather than beside
   * it: picking an event lights its camera's sector, puts the plan on the
   * storey it happened on, and opens the stream — and on a plan, unlike in any
   * other camera product, *where* is a thing that can be pointed at.
   */
  private selectGroup(group: EventGroup): void {
    this.selectedGroup = group.id;
    this.markSeen([group.id]);
    // The newest member carries the picture and the clip; the panel wants the
    // detection, not the fold.
    this.selected = group.members[0] ?? null;
    this.setMode('plan');
    this.focusCamera(group.camera);
  }

  private markSeen(ids: readonly string[]): void {
    const next = new Set(this.seen);
    for (const id of ids) next.add(id);
    if (next.size === this.seen.size) return;
    // Oldest first out: the record is a courtesy, not an archive.
    this.seen = next.size > MAX_SEEN ? new Set([...next].slice(-MAX_SEEN)) : next;
    this.saveSoon();
  }

  private selectLevel(id: string): void {
    this.activeLevel = id;
    this.scene?.setActiveLevel(id);
    this.saveSoon();
  }

  private toggleExplode(): void {
    this.exploded = !this.exploded;
    this.scene?.setExploded(this.exploded ? 3.2 : 0);
    this.saveSoon();
  }

  private applyPreset(preset: ViewPreset): void {
    this.preset = preset;
    this.scene?.applyPreset(preset);
    this.saveSoon();
    this.requestUpdate();
  }

  /** "Cadrer" hands framing back to the card — here and after a reload. */
  private frameAll(): void {
    this.scene?.frame();
    this.saveSoon();
  }

  // ---- persistence --------------------------------------------------------

  /**
   * A key for this card, not for this dashboard.
   *
   * There is no card id in a Lovelace config, so the scene it describes is the
   * identity: the storeys and the cameras. Two Sémaphore cards showing the same
   * house share a placement, which is what you want; one showing the garage
   * keeps its own.
   */
  private get storeKey(): string {
    const seed = [
      this.config['instance-id'] ?? '',
      ...this.config.levels.map((l) => l.id),
      ...this.config.cameras.map((c) => c.name),
    ].join('|');
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${STORE_PREFIX}/${(hash >>> 0).toString(36)}`;
  }

  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
  }

  private saveNow(): void {
    if (!this.scene) return;
    try {
      const saved: SavedState = {
        // Only a view the user placed themselves is worth keeping. Storing a
        // fitted one would freeze the card at the size of the window it was
        // last framed in, and the automatic re-frame on resize — the whole of
        // invariant 16 — would never run again.
        //
        // `restingView`, not the current one: while a camera is open the view
        // is somewhere the card flew to, and remembering that would reopen the
        // card on one lens for good.
        view: this.scene.placedByUser ? this.scene.restingView : undefined,
        level: this.scene.restingLevel,
        exploded: this.exploded,
        mode: this.mode,
        seen: [...this.seen],
      };
      localStorage.setItem(this.storeKey, JSON.stringify(saved));
    } catch {
      /* private browsing, or a full quota. The card works, it just forgets. */
    }
  }

  /**
   * Puts back what the last visit left.
   *
   * The angle found by hand used to die with the page, which made turning the
   * scene feel like a toy rather than a setting. A stored view outranks the
   * one in the config: the config is where the card started, the stored view is
   * where its owner last put it.
   */
  private restore(): void {
    let saved: SavedState | null = null;
    try {
      const raw = localStorage.getItem(this.storeKey);
      saved = raw ? (JSON.parse(raw) as SavedState) : null;
    } catch {
      saved = null;
    }
    if (!saved || !this.scene) return;

    if (saved.level && this.config.levels.some((l) => l.id === saved.level)) {
      this.activeLevel = saved.level;
      this.scene.setActiveLevel(saved.level);
    }
    if (saved.exploded && this.config.levels.length > 1) {
      this.exploded = true;
      this.scene.setExploded(3.2);
    }
    if (saved.mode && MODES.some((m) => m.id === saved.mode)) {
      this.mode = saved.mode;
      this.syncPaused();
    }
    if (Array.isArray(saved.seen)) {
      this.seen = new Set(saved.seen.filter((id) => typeof id === 'string').slice(-MAX_SEEN));
    }

    const view = saved.view;
    if (
      view &&
      [view.yaw, view.pitch, view.zoom].every((n) => typeof n === 'number' && isFinite(n)) &&
      Array.isArray(view.center) &&
      view.center.every((n) => typeof n === 'number' && isFinite(n))
    ) {
      this.scene.restoreView(view);
      this.preset = presetOf(view.yaw, view.pitch);
    }
  }

  // ---- keyboard -----------------------------------------------------------

  /**
   * The card, from the keyboard.
   *
   * Scoped to the stage rather than to the window on purpose: a dashboard holds
   * a dozen cards, and one of them grabbing every digit key would break the
   * other eleven. The stage takes focus, and then it answers.
   */
  private onKey = (ev: KeyboardEvent): void => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;

    // Escape belongs to the card even from inside a control — it is how you
    // leave, and leaving must never depend on where focus landed.
    if (ev.key === 'Escape') {
      if (this.showArm) this.showArm = false;
      else if (this.showHelp) this.showHelp = false;
      else if (this.focused) this.unfocus();
      else return;
      ev.preventDefault();
      return;
    }

    // A button already owns Enter, Space and the arrows inside a segmented
    // control. Stealing them would break the controls to add a shortcut.
    const target = ev.composedPath()[0];
    if (target instanceof HTMLElement && target.closest('button')) return;

    const cameras = this.config.cameras;
    const key = ev.key;

    const mode = MODES.find((m) => m.key === key.toLowerCase());

    if (key === '?' || (key === '/' && ev.shiftKey)) {
      this.showHelp = !this.showHelp;
    } else if (mode) {
      this.setMode(mode.id);
    } else if (key >= '1' && key <= '9') {
      const cam = cameras[Number(key) - 1];
      if (!cam) return;
      this.focusCamera(cam.name);
    } else if (key === 'ArrowRight' || key === 'ArrowLeft') {
      if (!cameras.length) return;
      const step = key === 'ArrowRight' ? 1 : -1;
      const at = cameras.findIndex((c) => c.name === this.focused);
      // Nothing focused yet: right starts at the first camera, left at the last.
      const next = at < 0 ? (step > 0 ? 0 : cameras.length - 1) : at + step;
      this.focusCamera(cameras[(next + cameras.length) % cameras.length].name);
    } else if (key === 'c' || key === 'C') {
      this.frameAll();
    } else if (key === 'n' || key === 'N') {
      const levels = this.config.levels;
      if (levels.length < 2) return;
      const at = levels.findIndex((l) => l.id === this.activeLevel);
      this.selectLevel(levels[(at + 1) % levels.length].id);
    } else if (key === 's' || key === 'S') {
      if (this.config.levels.length < 2) return;
      this.toggleExplode();
    } else {
      return;
    }
    ev.preventDefault();
  };

  /**
   * The window the timeline is showing.
   *
   * `timeline-hours` used to be both the buffer's depth and the axis's width,
   * which meant the axis was an installation setting: a five-second event on a
   * six-hour span is 0.02 % of the width, and no amount of care in the drawing
   * fixes an axis that cannot be changed. The buffer keeps its config value;
   * the window is now something you hold in your hand.
   */
  @state() private windowSpan: number | null = null;
  /** Right edge of the window. Null means live — pinned to now. */
  @state() private windowEnd: number | null = null;

  private get span(): number {
    return this.windowSpan ?? (this.config['timeline-hours'] ?? 24) * 3600_000;
  }

  /** Right edge, in ms. Follows the tick while live. */
  private get until(): number {
    return this.windowEnd ?? this.now;
  }

  private get live(): boolean {
    return this.windowEnd === null;
  }

  /** How far back the buffer itself reaches; panning may not leave it. */
  private get horizon(): number {
    return (this.config['timeline-hours'] ?? 24) * 3600_000;
  }

  private setWindow(span: number, end: number | null): void {
    const oldest = this.now - this.horizon;
    this.windowSpan = Math.max(60_000, Math.min(this.horizon, span));
    if (end === null) {
      this.windowEnd = null;
      return;
    }
    // Never past now, never before the buffer starts: a window showing time the
    // card has no data for is a window that looks broken.
    this.windowEnd = Math.max(oldest + this.windowSpan, Math.min(this.now, end));
  }

  /** Follows the pointer across the tracks and reads the time under it. */
  private hover(ev: PointerEvent): void {
    const track = (ev.currentTarget as HTMLElement).querySelector('.tracks');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));

    if (this.panFrom !== null && ev.buttons) {
      // Dragging moves the window, not the cursor: a pixel is `span / width`
      // milliseconds, so the instant under the finger stays under the finger.
      const perPixel = this.span / Math.max(1, rect.width);
      const moved = (this.panFrom - ev.clientX) * perPixel;
      this.panFrom = ev.clientX;
      this.setWindow(this.span, this.until + moved);
      return;
    }
    this.cursor = this.until - this.span * (1 - ratio);
  }

  private startPan(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    // A mark is a button and owns its own click; panning from one would make
    // every event impossible to open.
    const target = ev.composedPath()[0];
    if (target instanceof HTMLElement && target.closest('button')) return;
    this.panFrom = ev.clientX;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  private endPan(ev: PointerEvent): void {
    this.panFrom = null;
    const el = ev.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
  }

  private panFrom: number | null = null;

  private endHover(): void {
    this.cursor = null;
  }

  /**
   * A mark on the timeline is a member of a group.
   *
   * Routed through the group so the feed, the panel and the timeline never
   * disagree about what is selected — three highlights pointing at three
   * different things is how a card stops being trusted.
   */
  private selectEvent(det: Detection): void {
    const group = groupOf(this.groups, det);
    if (group) {
      this.selectGroup(group);
      // The mark that was clicked is more specific than the fold's newest
      // member, and it is the one whose time the panel should show.
      this.selected = det;
      return;
    }
    this.selected = det;
    this.focusCamera(det.camera);
  }

  // ---- render -------------------------------------------------------------

  override render(): TemplateResult {
    if (!this.config) return html``;
    return html`
      <ha-card>
        <div class="verdict-row">${this.renderVerdict()}</div>
        ${this.migrated ? this.renderMigrationNotice() : nothing}
        ${this.renderHealthNotices()}
        ${this.renderModes()}
        <!-- The stage is never unmounted, only hidden: the canvas, the scene
             and the view live in it, and tearing them down to switch tab would
             throw away the angle the user is standing at. Hidden it measures
             0 x 0, which the guard in Scene.init already treats as "not now". -->
        <div
          class="stage ${this.focused ? 'focused' : ''} ${this.autoAspect ? 'auto-aspect' : ''}"
          style=${this.stageStyle()}
          ?hidden=${this.mode !== 'plan'}
          tabindex="0"
          aria-label="Plan de la maison. Tapez ? pour les raccourcis clavier."
          @keydown=${this.onKey}
        >
          <canvas class="canvas"></canvas>
          <div class="overlay">
            ${this.renderLevels()} ${this.renderChips()}
            ${this.renderViewControls()} ${this.renderPanel()} ${this.renderHelp()}
          </div>
        </div>
        ${this.mode === 'plan' ? this.renderTimeline() : this.renderPane()}
        ${this.error ? html`<div class="empty error">${this.error}</div>` : nothing}
        ${this.renderArmSheet()}
      </ha-card>
    `;
  }

  /**
   * The three tabs.
   *
   * Hidden when there is only ever going to be one answer: a config with no
   * cameras has no live view and no events, and a tab strip offering two empty
   * rooms is worse than no tab strip.
   */
  private renderModes(): TemplateResult | typeof nothing {
    if (!this.config.cameras.length) return nothing;
    if (this.config['show-modes'] === false) return nothing;

    const unseen = this.groups.filter((g) => !this.seen.has(g.id)).length;
    return html`
      <div class="modes" role="tablist" aria-label="Vue">
        <div class="segmented">
          ${MODES.map(
            (m) => html`<button
              role="tab"
              aria-selected=${this.mode === m.id}
              aria-pressed=${this.mode === m.id}
              title="${m.label} (${m.key.toUpperCase()})"
              @click=${() => this.setMode(m.id)}
            >
              ${m.label}${m.id === 'events' && unseen
                ? html`<span class="badge">${unseen > 99 ? '99+' : unseen}</span>`
                : nothing}
            </button>`,
          )}
        </div>
      </div>
    `;
  }

  /** Whichever of the two non-plan panes is showing. */
  private renderPane(): TemplateResult {
    const style = this.paneStyle();
    if (this.mode === 'events') {
      return html`
        <semaphore-events
          class="pane ${this.autoAspect ? 'auto-aspect' : ''}"
          style=${style}
          .groups=${this.groups}
          .cameras=${this.config.cameras}
          .thumb=${(id: string) => this.bridge?.eventThumbUrl(id)}
          .selected=${this.selectedGroup}
          .seen=${this.seen}
          .now=${this.now}
          .hours=${this.config['timeline-hours'] ?? 24}
          @event-select=${(ev: CustomEvent<EventGroup>) => this.selectGroup(ev.detail)}
          @events-seen=${(ev: CustomEvent<string[]>) => this.markSeen(ev.detail)}
        ></semaphore-events>
      `;
    }
    return html`
      <semaphore-wall
        class="pane ${this.autoAspect ? 'auto-aspect' : ''}"
        style=${style}
        .cameras=${this.config.cameras}
        .states=${this.states}
        .hass=${this.hass}
        .stamp=${this.thumbNonce}
        .preview=${(cam: CameraConfig) => this.bridge?.livePreviewUrl(cam)}
        .entityOf=${(cam: CameraConfig) => this.bridge?.cameraEntity(cam)}
      ></semaphore-wall>
    `;
  }

  /**
   * A pane takes the box the stage would have taken.
   *
   * Same three cases as `stageStyle`, so switching tab never changes the height
   * of the card — a dashboard whose rows reflow because you looked at a list is
   * a dashboard that feels broken.
   */
  private paneStyle(): string {
    const rows = (this.config as Record<string, any>).grid_options?.rows;
    if (typeof rows === 'number') return 'flex:1 1 auto;min-height:200px';
    const cap = this.config['max-height'];
    const max = cap ? `${cap}px` : '74vh';
    if (this.config.height) return `height:${this.config.height}px;max-height:${max}`;
    if (this.config['aspect-ratio']) {
      return `aspect-ratio:${this.config['aspect-ratio']};max-height:${max}`;
    }
    // No shape asked for: the stylesheet gives the pane the same shape it gives
    // the stage, from the card's own width. An inline aspect-ratio here would
    // pin 16/10 on a phone, where the stage is 4/3 — the card would change
    // height every time you switched tab.
    return `max-height:${max}`;
  }

  private renderMigrationNotice(): TemplateResult {
    return html`
      <div class="notice">
        Config convertie depuis l'ancienne version cartographique : les
        coordonnées sont maintenant en mètres. Vérifiez le plan dans l'éditeur
        Sémaphore, puis remplacez ce bloc par ce qu'il exporte — sinon la
        conversion sera refaite à chaque chargement.
      </div>
    `;
  }

  /**
   * Storeys, top left.
   *
   * A segmented control rather than a stack of pills: they are one choice with
   * one answer, and five separate lozenges down the left edge covered a third of
   * the scene on a phone.
   */
  private renderLevels(): TemplateResult | typeof nothing {
    const levels = this.config.levels;
    if (levels.length < 2) return nothing;
    return html`
      <div class="controls at-top">
        <div class="segmented">
          ${levels.map(
            (l) => html`<button
              aria-pressed=${l.id === this.activeLevel}
              @click=${() => this.selectLevel(l.id)}
            >${l.name}</button>`,
          )}
        </div>
        <button
          class="icon"
          aria-pressed=${this.exploded}
          title=${this.exploded ? 'Empiler les niveaux' : 'Séparer les niveaux'}
          aria-label=${this.exploded ? 'Empiler les niveaux' : 'Séparer les niveaux'}
          @click=${this.toggleExplode}
        >${this.exploded ? ICON.stack : ICON.split}</button>
      </div>
    `;
  }

  /** Readings and framing, bottom left — away from the panel and the chips. */
  private renderViewControls(): TemplateResult {
    return html`
      <div class="controls at-bottom">
        <div class="segmented">
          ${VIEW_PRESETS.map(
            (p) => html`<button
              aria-pressed=${this.preset?.id === p.id}
              title="${p.label} — ${p.pitch}° d'inclinaison"
              @click=${() => this.applyPreset(p)}
            >${p.label}</button>`,
          )}
        </div>
        <button
          class="icon"
          title="Tout cadrer (C)"
          aria-label="Tout cadrer"
          @click=${this.frameAll}
        >${ICON.frame}</button>
        <!-- A shortcut nobody can discover does not exist. Hidden on a touch
             screen, where there is no keyboard to describe. -->
        <button
          class="icon fine-pointer-only"
          aria-pressed=${this.showHelp}
          title="Raccourcis clavier (?)"
          aria-label="Raccourcis clavier"
          @click=${() => (this.showHelp = !this.showHelp)}
        >${ICON.keys}</button>
      </div>
    `;
  }

  /**
   * The verdict: what is happening, in a sentence, across the top of the card.
   *
   * This replaces a 12 px pill in the corner that read "2 détections" and could
   * not be clicked. That pill was the most important thing on the card and the
   * smallest thing on it — a count you had to finish reading before you knew
   * whether to care, next to no way of finding out what it counted. A phrase
   * you can read from across the room, in the colour of what it reports, and a
   * click that opens the event it is talking about.
   *
   * The colours stay the chart palette, so the bar is one more entry in the
   * legend rather than a decoration of its own (invariant 20).
   */
  private renderVerdict(): TemplateResult {
    const { tone, phrase } = this.verdict();
    const css = STATE_STYLES[tone].css;
    const wash = withAlpha(css, 0.13);
    const last = this.events[this.events.length - 1];

    const off = [...this.states.values()].filter((s) => s === 'offline').length;
    const open = this.openIds.size;

    return html`
      <button
        class="verdict ${tone}"
        style="color:${css};background-image:linear-gradient(${wash},${wash})"
        aria-live="polite"
        ?disabled=${!last}
        title=${last ? 'Ouvrir le dernier événement' : ''}
        @click=${() => last && this.selectEvent(last)}
      >
        <span class="pip"></span>
        <span class="phrase">${phrase}</span>
        <span class="tags">
          ${open
            ? html`<span class="tag" style="color:${STATE_STYLES.alert.css}"
                >${open} ouverte${open > 1 ? 's' : ''}</span
              >`
            : nothing}
          ${off && tone !== 'offline'
            ? html`<span class="tag" style="color:${STATE_STYLES.offline.css}"
                >${off} hors ligne</span
              >`
            : nothing}
        </span>
      </button>
      ${this.renderArmButton()}
    `;
  }

  // ---- arming -------------------------------------------------------------

  private get alarmEntity(): any {
    const id = this.config['alarm-entity'];
    return id ? this.hass?.states?.[id] : undefined;
  }

  /**
   * The arm control, docked to the right of the verdict.
   *
   * Its own button rather than a third tag on the verdict, because the verdict
   * is a readout and this is the one thing on the card that changes the state
   * of the house. Those must not be the same control.
   */
  private renderArmButton(): TemplateResult | typeof nothing {
    const reading = readAlarm(this.alarmEntity);
    if (!reading) return nothing;
    const css = STATE_STYLES[reading.tone].css;
    return html`
      <button
        class="arm ${reading.tone}"
        style="color:${css}"
        title="Alarme — ${reading.label}"
        aria-label="Alarme — ${reading.label}. Ouvrir les commandes."
        aria-expanded=${this.showArm}
        @click=${() => this.openArm()}
      >
        <span class="pip"></span>
        <span class="what">${reading.label}</span>
      </button>
    `;
  }

  private openArm(): void {
    this.armCode = '';
    this.armError = '';
    this.showArm = !this.showArm;
  }

  /**
   * What would be wrong with arming right now.
   *
   * The whole reason a plan beats a list: "2 ouvertures" is a number, and the
   * red apertures behind this sheet are the answer. Open doors and dead cameras
   * are the two things that turn an armed house into a false alarm at 3 a.m.
   */
  private vulnerabilities(): Array<{ text: string; tone: CameraState }> {
    const out: Array<{ text: string; tone: CameraState }> = [];
    for (const level of this.config.levels) {
      for (const wall of level.walls ?? []) {
        for (const o of wall.openings ?? []) {
          if (!o.entity || !this.openIds.has(o.id)) continue;
          const friendly = this.hass?.states?.[o.entity]?.attributes?.friendly_name;
          out.push({ text: `${friendly ?? o.entity} — ouverte`, tone: 'alert' });
        }
      }
    }
    for (const cam of this.config.cameras) {
      if (this.states.get(cam.name) !== 'offline') continue;
      out.push({ text: `${cam.label ?? cam.name} — hors ligne`, tone: 'offline' });
    }
    return out;
  }

  private async runArm(action: ArmAction): Promise<void> {
    const id = this.config['alarm-entity'];
    if (!id || !this.hass?.callService) return;
    const stateObj = this.alarmEntity;
    if (needsCode(stateObj, action) && !this.armCode) {
      this.armError = 'Cette centrale demande un code.';
      return;
    }
    try {
      await this.hass.callService('alarm_control_panel', action.service, {
        entity_id: id,
        ...(this.armCode ? { code: this.armCode } : {}),
      });
      this.showArm = false;
      this.armCode = '';
      this.armError = '';
    } catch (err) {
      // Home Assistant rejects a wrong code with an error rather than a state
      // change, so without this the sheet just sits there looking ignored.
      this.armError =
        err instanceof Error ? err.message : "La centrale a refusé la commande.";
    }
  }

  private renderArmSheet(): TemplateResult | typeof nothing {
    const stateObj = this.alarmEntity;
    const reading = readAlarm(stateObj);
    if (!this.showArm || !reading) return nothing;

    const actions = actionsFor(stateObj);
    const risks = this.vulnerabilities();
    const numeric = codeIsNumeric(stateObj);
    const wantsCode = actions.some((a) => needsCode(stateObj, a));

    return html`
      <div class="sheet-scrim" @click=${() => (this.showArm = false)}>
        <div
          class="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Commandes de l'alarme"
          @click=${(ev: Event) => ev.stopPropagation()}
        >
          <header>
            <span class="pip" style="color:${STATE_STYLES[reading.tone].css}"></span>
            <span class="title">${reading.label}</span>
            <button
              class="icon"
              title="Fermer"
              aria-label="Fermer"
              @click=${() => (this.showArm = false)}
            >${ICON.close}</button>
          </header>

          ${risks.length
            ? html`<ul class="risks">
                ${risks.map(
                  (r) => html`<li style="color:${STATE_STYLES[r.tone].css}">
                    <span class="pip"></span><span>${r.text}</span>
                  </li>`,
                )}
              </ul>`
            : html`<p class="ok">Tout est fermé et toutes les caméras répondent.</p>`}

          ${wantsCode
            ? html`<input
                class="code"
                type="password"
                inputmode=${numeric ? 'numeric' : 'text'}
                autocomplete="off"
                placeholder="Code"
                aria-label="Code de la centrale"
                .value=${this.armCode}
                @input=${(ev: Event) => (this.armCode = (ev.target as HTMLInputElement).value)}
              />`
            : nothing}

          ${this.armError ? html`<p class="err">${this.armError}</p>` : nothing}

          <div class="actions">
            ${actions.map(
              (a) => html`<button
                class="act ${a.id === 'disarm' ? 'off' : ''}"
                ?disabled=${reading.busy}
                @click=${() => this.runArm(a)}
              >${a.label}</button>`,
            )}
          </div>
          ${reading.busy
            ? html`<p class="ok">Changement d'état en cours…</p>`
            : nothing}
        </div>
      </div>
    `;
  }

  /**
   * The state of the house, ranked.
   *
   * A classified object outranks bare movement, which outranks a camera that
   * has stopped answering, which outranks quiet. Open doors are deliberately
   * not in this ranking: with no arming state to compare them against, an open
   * window at four in the afternoon is a fact, not an alarm. It gets a tag.
   */
  private verdict(): { tone: CameraState; phrase: string } {
    if (!this.ready) return { tone: 'nominal', phrase: 'Démarrage de la scène…' };

    const off = [...this.states.values()].filter((s) => s === 'offline').length;
    const live = this.bridge?.liveDetections() ?? [];
    const alerting = live.filter((d) => !d.ended && this.bridge?.isAlert(d));
    const moving = live.filter((d) => !d.ended);

    const newest = (list: Detection[]): Detection | undefined =>
      list.reduce<Detection | undefined>(
        (best, d) => (!best || d.startTime > best.startTime ? d : best),
        undefined,
      );

    const said = (d: Detection, fallback: string): string => {
      const cam = this.config.cameras.find((c) => c.name === d.camera);
      const where = cam?.label ?? cam?.name ?? d.camera;
      return `${fallback} — ${where}, ${agoLabel(d.startTime, this.now)}`;
    };

    const alert = newest(alerting);
    if (alert) return { tone: 'alert', phrase: said(alert, labelName(alert.label)) };

    const motion = newest(moving);
    if (motion) return { tone: 'motion', phrase: said(motion, 'Mouvement') };

    if (off) {
      return {
        tone: 'offline',
        phrase: `${off} caméra${off > 1 ? 's' : ''} hors ligne`,
      };
    }

    // Quiet — and how long it has been quiet is the useful half of that.
    const last = this.events[this.events.length - 1];
    const since = last ? (last.endTime ?? last.startTime) : undefined;
    return {
      tone: 'nominal',
      phrase:
        since !== undefined && this.now > since
          ? `Rien à signaler depuis ${durationLabel(this.now - since)}`
          : 'Rien à signaler',
    };
  }

  /**
   * What the card is not receiving.
   *
   * Only MQTT. Without it the scene still draws and simply never lights a
   * sector, which is a card that looks like it works and will never report
   * anything — worse than one that says so, and a symptom ("nothing ever
   * happens at my house") that does not lead back to its cause on its own.
   *
   * A missing event history is deliberately *not* reported. Neither route to it
   * is a documented Home Assistant contract, so on a normal install the fall
   * back to the local buffer is the ordinary case rather than a fault — and a
   * banner that is always there, that nobody can act on, is a banner people
   * stop seeing. `bridge.health.history` still records it for anyone debugging.
   */
  private renderHealthNotices(): TemplateResult | typeof nothing {
    const health = this.health;
    if (!health) return nothing;

    const notices: string[] = [];
    if (health.mqtt === 'unavailable') {
      notices.push(
        "Le module MQTT de Home Assistant n'est pas joignable : le plan s'affiche, " +
          "mais aucun secteur ne s'allumera. Vérifiez l'intégration MQTT.",
      );
    } else if (health.mqtt === 'failed') {
      notices.push(
        `L'abonnement à « ${this.config['topic-prefix'] ?? 'frigate'}/events » a échoué : ` +
          "le plan s'affiche, mais aucun secteur ne s'allumera.",
      );
    }
    if (!notices.length) return nothing;

    return html`${notices.map((text) => html`<div class="notice">${text}</div>`)}`;
  }

  /** The shortcut sheet. Opened by `?`, and by the button that says so. */
  private renderHelp(): TemplateResult | typeof nothing {
    if (!this.showHelp) return nothing;
    return html`
      <div class="help" @click=${() => (this.showHelp = false)}>
        <div class="sheet" @click=${(ev: Event) => ev.stopPropagation()}>
          <header>
            <span class="title">Raccourcis clavier</span>
            <button
              class="icon"
              title="Fermer"
              aria-label="Fermer l'aide"
              @click=${() => (this.showHelp = false)}
            >${ICON.close}</button>
          </header>
          <dl>
            ${SHORTCUTS.map(
              ([keys, what]) => html`<dt><kbd>${keys}</kbd></dt>
                <dd>${what}</dd>`,
            )}
          </dl>
          <p class="hint">
            Glissez pour pivoter, molette ou pincement pour zoomer.
          </p>
        </div>
      </div>
    `;
  }

  private renderChips(): TemplateResult {
    return html`${repeat(this.config.cameras, (c) => c.name, (cam) => this.renderChip(cam))}`;
  }

  /**
   * Cameras whose preview will not load.
   *
   * Outside Home Assistant — and inside it for any camera without a snapshot —
   * `entity_picture` resolves to nothing, and the broken-image placeholder
   * Chrome draws for it is a grey box with the entity id in it, sitting on the
   * plan. Four of those were the ugliest thing on the card. One failure is
   * enough to stop asking.
   */
  @state() private noThumb = new Set<string>();

  private thumbFailed(name: string): void {
    if (this.noThumb.has(name)) return;
    this.noThumb = new Set(this.noThumb).add(name);
  }

  private renderChip(cam: CameraConfig): TemplateResult {
    const state = this.states.get(cam.name) ?? 'nominal';
    const style = STATE_STYLES[state];
    // At rest a camera wears its own colour, so four quiet cones stay telling
    // apart; the moment it has something to report the legend takes over.
    const css = state === 'nominal' && cam.color ? cam.color : style.css;
    const label = cam.label ?? cam.name;
    const thumb = this.noThumb.has(cam.name) ? undefined : this.bridge?.livePreviewUrl(cam);
    return html`
      <button
        class="chip ${state} ${thumb ? 'has-thumb' : ''}"
        style="color:${css}"
        title="${label} — ${style.caption}"
        aria-label="${label} — ${style.caption}"
        ${ref((el) => this.bindChip(cam.name, el))}
        @click=${() => this.focusCamera(cam.name)}
      >
        ${thumb
          ? html`<img
              class="thumb"
              src="${thumb}&_=${this.thumbNonce}"
              alt=""
              decoding="async"
              loading="lazy"
              @error=${() => this.thumbFailed(cam.name)}
            />`
          : nothing}
        <span class="pip"></span>
        <span class="name">${label}</span>
      </button>
    `;
  }

  private renderPanel(): TemplateResult | typeof nothing {
    if (!this.focused) return nothing;
    const cam = this.config.cameras.find((c) => c.name === this.focused);
    if (!cam) return nothing;
    const stateObj = this.bridge?.cameraEntity(cam);
    const state = this.states.get(cam.name) ?? 'nominal';
    return html`
      <div class="panel">
        <header>
          <span class="pip" style="color:${STATE_STYLES[state].css}"></span>
          <span class="title">${cam.label ?? cam.name}</span>
          <button
            class="icon"
            title="Revenir à la vue d'ensemble"
            aria-label="Revenir à la vue d'ensemble"
            @click=${this.unfocus}
          >${ICON.close}</button>
        </header>
        ${stateObj
          ? html`<ha-camera-stream class="stream" .hass=${this.hass} .stateObj=${stateObj} allow-exoplayer muted></ha-camera-stream>`
          : html`<div class="empty">Ce flux est indisponible.</div>`}
        <div class="meta">
          <span>${STATE_STYLES[state].caption}</span>
          <span>${cam.fov}° · ${cam.range} m</span>
          <span>Cap ${Math.round(cam.azimuth)}°</span>
        </div>
        ${this.selected && this.selected.camera === cam.name
          ? html`<div class="event">
              <i style="background:${labelCss(this.selected.label)}"></i>
              <strong>${this.selected.label}</strong>
              <span>${clockLabel(this.selected.startTime)}</span>
              <span>${durationLabel(spanOf(this.selected))}</span>
              ${this.selected.score
                ? html`<span>${Math.round(this.selected.score * 100)} %</span>`
                : nothing}
            </div>`
          : nothing}
      </div>
    `;
  }

  /**
   * The timeline.
   *
   * The previous one drew a lane per camera, unlabelled, and a cursor that
   * highlighted nothing — no time under it, no way to tell which of the marks
   * you were looking at, and a scrub that quietly froze the sweep animation and
   * did nothing else. It answered none of the three questions anyone asks of a
   * timeline: what happened, when, and on which camera.
   *
   * So: named tracks, hour marks along the top, a mark per event coloured by
   * what was seen, a cursor that reads out its own time, and a click that opens
   * the event. `show-timeline: false` removes it entirely.
   */
  private renderTimeline(): TemplateResult | typeof nothing {
    if (!this.ready) return html`<div class="empty">Chargement de la scène…</div>`;
    if (!this.config.cameras.length) {
      return html`<div class="empty">
        Aucune caméra. Dessinez votre plan dans l'éditeur Sémaphore, puis collez
        ici ce qu'il exporte.
      </div>`;
    }
    if (this.config['show-timeline'] === false) return nothing;

    const span = this.span;
    const from = this.until - span;
    const place = (t: number): number => ((t - from) / span) * 100;
    const { step, marks } = this.ticks();

    return html`
      <div
        class="timeline"
        @pointermove=${this.hover}
        @pointerdown=${this.startPan}
        @pointerup=${this.endPan}
        @pointercancel=${this.endPan}
        @pointerleave=${this.endHover}
      >
        ${this.renderWindows()}
        <div class="plot">
        <div class="axis">
          <span class="track-label"></span>
          <div class="tracks" ${ref((el) => this.watchTimeline(el))}>
            ${marks.map(
              (t) => html`<span class="tick" style="left:${place(t)}%">${tickLabel(t, step)}</span>`,
            )}
            ${this.live
              ? html`<span class="tick now" style="left:100%">maintenant</span>`
              : nothing}
          </div>
        </div>

        ${this.config.cameras.map((cam) => this.renderTrack(cam, place))}

        ${this.cursor !== null
          ? html`<div
              class="scrub"
              style="left:calc(var(--track-left) + (100% - var(--track-left) - var(--pad)) * ${place(this.cursor) / 100})"
            >
              <span class="time">${clockLabel(this.cursor)}</span>
            </div>`
          : nothing}

        </div>
        ${this.renderLegend()}
      </div>
    `;
  }

  private renderTrack(cam: CameraConfig, place: (t: number) => number): TemplateResult {
    const marks = this.events.filter((e) => e.camera === cam.name);
    return html`
      <div class="track">
        <span class="track-label" title=${cam.label ?? cam.name}>${cam.label ?? cam.name}</span>
        <div class="tracks">
          <div class="lane"></div>
          ${marks.map((m) => {
            const start = place(m.startTime);
            const end = place(m.endTime ?? this.until);
            if (end < 0 || start > 100) return nothing;
            const left = Math.max(0, start);
            return html`<button
              class="mark ${this.selected?.id === m.id ? 'on' : ''}"
              style="left:${left}%;width:${Math.max(0.5, Math.min(100, end) - left)}%;background:${labelCss(m.label)}"
              title="${labelName(m.label)} · ${clockLabel(m.startTime)} · ${durationLabel(spanOf(m))}"
              aria-label="${labelName(m.label)} sur ${cam.label ?? cam.name} à ${clockLabel(m.startTime)}, ${durationLabel(spanOf(m))}"
              @click=${() => this.selectEvent(m)}
            ></button>`;
          })}
        </div>
      </div>
    `;
  }

  /**
   * What is in the window, and what it was.
   *
   * Counted over the window rather than over the buffer: panning back to a
   * quiet quarter of an hour used to leave four empty lanes and a legend
   * cheerfully reporting the day's totals, which reads as a card that has
   * stopped working.
   */
  private renderLegend(): TemplateResult {
    const from = this.until - this.span;
    const inWindow = this.events.filter(
      (e) => (e.endTime ?? this.until) >= from && e.startTime <= this.until,
    );

    if (!inWindow.length) {
      return html`<p class="legend quiet">
        ${this.events.length
          ? 'Rien sur cette fenêtre.'
          : `Aucun événement sur les ${this.config['timeline-hours'] ?? 24} dernières heures.`}
      </p>`;
    }
    const counts = new Map<string, number>();
    for (const e of inWindow) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
    return html`
      <p class="legend">
        ${[...counts].map(
          ([label, n]) => html`<span class="key">
            <i style="background:${labelCss(label)}"></i>${labelName(label)} × ${n}
          </span>`,
        )}
      </p>
    `;
  }

  /**
   * Round hour marks, thinned to the width there actually is.
   *
   * The step used to be a ladder off `timeline-hours` alone and the last mark
   * was dropped if it fell inside a fixed 6 % of the span. Both are guesses
   * about width, and on a phone both were wrong: `14 h` printed straight
   * through `maintenant`, and six labels fought over 240 px. Pixels are the
   * thing being run out of, so pixels are what the step is chosen from — the
   * measured track, an hour ladder that keeps the marks round, and a right-hand
   * margin wide enough for the word that sits there.
   */
  private ticks(): { step: number; marks: number[] } {
    const track = this.trackWidth;
    const room = Math.max(1, Math.floor(track / TICK_MIN_PX));
    const span = this.span;
    // Minutes matter now that the window can be a quarter of an hour: an hour
    // ladder on a 15-minute window produces one mark, or none.
    const step =
      STEPS_MS.find((s) => span / s <= room) ?? STEPS_MS[STEPS_MS.length - 1];

    // "maintenant" is anchored to the right edge; anything under it reads as a
    // second label for the same instant. Only while live — panned back, the
    // right edge is an ordinary time and deserves its own mark.
    const reserved = this.live ? span * (NOW_LABEL_PX / track) : 0;

    const until = this.until;
    const marks: number[] = [];
    // Round down to the step so marks land on round times whatever the window.
    for (let t = Math.floor(until / step) * step; t > until - span; t -= step) {
      if (until - t > reserved) marks.push(t);
    }
    return { step, marks };
  }

  /**
   * The window presets, plus the way back to live.
   *
   * Four spans and a "maintenant": a slider would be more expressive and would
   * mean nobody ever lands on a round number. Anything finer is what the wheel
   * and the drag are for.
   */
  private renderWindows(): TemplateResult {
    return html`
      <div class="windows">
        <div class="segmented">
          ${WINDOWS.map(
            (w) => html`<button
              aria-pressed=${Math.abs(this.span - w.ms) < 1000}
              @click=${() => this.setWindow(w.ms, null)}
            >${w.label}</button>`,
          )}
        </div>
        ${!this.live
          ? html`<button class="back" @click=${() => this.setWindow(this.span, null)}>
              Revenir à maintenant
            </button>`
          : nothing}
      </div>
    `;
  }

  /**
   * Width of the track area, in pixels.
   *
   * Measured rather than assumed: the same card is 1000 px wide in a panel view
   * and 320 px in a masonry column on a phone, and the axis has to be right in
   * both without the dashboard telling it which it is.
   */
  private trackWidth = 600;

  private timelineObserver?: ResizeObserver;
  private trackEl?: Element;

  private watchTimeline(el: Element | undefined): void {
    // `ref` runs on every render; re-observing the same element each time would
    // tear the observer down and rebuild it a few times a second.
    if (el === this.trackEl) return;
    this.trackEl = el;
    this.timelineObserver?.disconnect();
    if (!el) return;

    this.timelineObserver = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      // A pixel either way changes no label. Re-rendering the timeline on every
      // sub-pixel reflow would, and the first measurement always lands inside
      // the update that created the element — which is what Lit warns about.
      if (!w || Math.abs(w - this.trackWidth) < 8) return;
      this.trackWidth = w;
      setTimeout(() => this.requestUpdate(), 0);
    });
    this.timelineObserver.observe(el);
  }
}

(window as any).customCards = (window as any).customCards ?? [];
(window as any).customCards.push({
  type: 'semaphore-card',
  name: 'Sémaphore',
  description:
    'Le plan de votre maison en 2.5D : murs, pièces, portes, et la couverture réelle de vos caméras.',
  preview: true,
});
