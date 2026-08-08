import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ref } from 'lit/directives/ref.js';
import type { CameraConfig, CameraState, Detection, SemaphoreConfig } from './types';
import { validateConfig } from './config';
import { Scene } from './plan/scene';
import { FrigateBridge } from './frigate';
import { STATE_STYLES, labelCss } from './theme';
import { styles } from './semaphore-card-css';
import { DEFAULT_VIEW, VIEW_PRESETS, presetOf, type ViewPreset } from './plan/view';

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

  // ---- Home Assistant contract -------------------------------------------

  setConfig(config: SemaphoreConfig): void {
    const result = validateConfig(config);
    this.config = result.config;
    this.migrated = result.migrated;
    this.activeLevel = this.config.levels[0].id;
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
    return `aspect-ratio:${this.config['aspect-ratio'] ?? '16 / 10'};max-height:${max}`;
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
    void this.boot();
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
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearInterval(this.tick);
    clearInterval(this.thumbTimer);
    this.bridge?.disconnect();
    this.scene?.destroy();
  }

  private onVisibility = (): void => this.setActive(!document.hidden);

  private setActive(active: boolean): void {
    this.scene?.setPaused(!active);
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
        onViewMoved: () => {
          if (this.preset) {
            this.preset = undefined;
            this.requestUpdate();
          }
        },
      });
      this.scene.init(stage);
      this.ready = true;

      this.bridge = new FrigateBridge(this.hass, this.config.cameras, {
        topicPrefix: this.config['topic-prefix'],
        instanceId: this.config['instance-id'],
        alertLabels: this.config['alert-labels'],
        boxFormat: this.config['box-format'],
        retentionMs: (this.config['decay-seconds'] ?? 12) * 1000 + 4000,
      });
      await this.bridge.connect();

      this.tick = window.setInterval(() => this.update_(), TICK_MS);
      this.events = await this.bridge.fetchHistory(
        Date.now() - (this.config['timeline-hours'] ?? 24) * 3600_000,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.error = `La scène n'a pas pu démarrer : ${detail}`;
      console.error('[semaphore] initialisation failed', err);
    }
  }

  override updated(): void {
    this.bridge?.setHass(this.hass);
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

    if (this.bridge.timelineVersion !== this.eventsVersion) {
      this.eventsVersion = this.bridge.timelineVersion;
      this.events = this.bridge.timeline(
        now - (this.config['timeline-hours'] ?? 24) * 3600_000,
      );
      dirty = true;
    }

    if (dirty) this.requestUpdate();
  }

  // ---- overlay ------------------------------------------------------------

  private bindChip(name: string, el: Element | undefined): void {
    if (el) this.chipEls.set(name, el as HTMLElement);
    else this.chipEls.delete(name);
  }

  private positionChips(): void {
    if (!this.scene) return;
    for (const cam of this.config.cameras) {
      const el = this.chipEls.get(cam.name);
      if (!el) continue;
      const { x, y } = this.scene.project(cam);
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
      const onLevel = (cam.level ?? this.config.levels[0].id) === this.activeLevel;
      el.classList.toggle('dim', !onLevel && !this.exploded);
    }
  }

  // ---- actions ------------------------------------------------------------

  private focusCamera(name: string): void {
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

  private selectLevel(id: string): void {
    this.activeLevel = id;
    this.scene?.setActiveLevel(id);
  }

  private toggleExplode(): void {
    this.exploded = !this.exploded;
    this.scene?.setExploded(this.exploded ? 3.2 : 0);
  }

  private applyPreset(preset: ViewPreset): void {
    this.preset = preset;
    this.scene?.applyPreset(preset);
    this.requestUpdate();
  }

  private get span(): number {
    return (this.config['timeline-hours'] ?? 24) * 3600_000;
  }

  /** Follows the pointer across the tracks and reads the time under it. */
  private hover(ev: PointerEvent): void {
    const track = (ev.currentTarget as HTMLElement).querySelector('.tracks');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    this.cursor = this.now - this.span * (1 - ratio);
  }

  private endHover(): void {
    this.cursor = null;
  }

  private selectEvent(det: Detection): void {
    this.selected = det;
    this.focusCamera(det.camera);
  }

  // ---- render -------------------------------------------------------------

  override render(): TemplateResult {
    if (!this.config) return html``;
    return html`
      <ha-card>
        ${this.migrated ? this.renderMigrationNotice() : nothing}
        <div class="stage" style=${this.stageStyle()}>
          <canvas class="canvas"></canvas>
          <div class="overlay">
            ${this.renderRail()} ${this.renderStatus()} ${this.renderChips()}
            ${this.renderPanel()}
          </div>
        </div>
        ${this.renderTimeline()}
        ${this.error ? html`<div class="empty error">${this.error}</div>` : nothing}
      </ha-card>
    `;
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

  private renderRail(): TemplateResult {
    const levels = this.config.levels;
    return html`
      <div class="rail">
        ${levels.length > 1
          ? levels.map(
              (l) => html`<button
                aria-pressed=${l.id === this.activeLevel}
                @click=${() => this.selectLevel(l.id)}
              >${l.name}</button>`,
            )
          : nothing}
        ${levels.length > 1
          ? html`<button aria-pressed=${this.exploded} @click=${this.toggleExplode}>
              ${this.exploded ? 'Empiler' : 'Séparer'}
            </button>`
          : nothing}
        <div class="group">
          ${VIEW_PRESETS.map(
            (p) => html`<button
              aria-pressed=${this.preset?.id === p.id}
              title="${p.label} — ${p.pitch}° d'inclinaison"
              @click=${() => this.applyPreset(p)}
            >${p.label}</button>`,
          )}
        </div>
        <button @click=${() => this.scene?.frame()} title="Tout cadrer">Cadrer</button>
      </div>
    `;
  }

  private renderStatus(): TemplateResult {
    const alerts = [...this.states.values()].filter((s) => s === 'alert').length;
    const off = [...this.states.values()].filter((s) => s === 'offline').length;
    const text = alerts
      ? `${alerts} détection${alerts > 1 ? 's' : ''}`
      : off
        ? `${off} hors ligne`
        : 'Tout est calme';
    return html`<div class="status">${text}</div>`;
  }

  private renderChips(): TemplateResult {
    return html`${repeat(this.config.cameras, (c) => c.name, (cam) => this.renderChip(cam))}`;
  }

  private renderChip(cam: CameraConfig): TemplateResult {
    const state = this.states.get(cam.name) ?? 'nominal';
    const style = STATE_STYLES[state];
    // At rest a camera wears its own colour, so four quiet cones stay telling
    // apart; the moment it has something to report the legend takes over.
    const css = state === 'nominal' && cam.color ? cam.color : style.css;
    const thumb = this.bridge?.livePreviewUrl(cam);
    return html`
      <button
        class="chip ${state}"
        style="color:${css}"
        title=${style.caption}
        ${ref((el) => this.bindChip(cam.name, el))}
        @click=${() => this.focusCamera(cam.name)}
      >
        ${thumb
          ? html`<img class="thumb" src="${thumb}&_=${this.thumbNonce}" alt="" decoding="async" loading="lazy" />`
          : nothing}
        <span class="pip"></span>
        <span class="name">${cam.label ?? cam.name}</span>
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
          <span>${cam.label ?? cam.name}</span>
          <button @click=${this.unfocus}>Vue d'ensemble</button>
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
              <span>${durationLabel(this.selected)}</span>
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
    const now = this.now;
    const from = now - span;
    const place = (t: number): number => ((t - from) / span) * 100;

    return html`
      <div
        class="timeline"
        @pointermove=${this.hover}
        @pointerleave=${this.endHover}
      >
        <div class="axis">
          <span class="track-label"></span>
          <div class="tracks">
            ${this.ticks().map(
              (t) => html`<span class="tick" style="left:${place(t)}%">${hourLabel(t)}</span>`,
            )}
            <span class="tick now" style="left:100%">maintenant</span>
          </div>
        </div>

        ${this.config.cameras.map((cam) => this.renderTrack(cam, place))}

        ${this.cursor !== null
          ? html`<div
              class="scrub"
              style="left:calc(var(--label-w) + (100% - var(--label-w) - 24px) * ${place(this.cursor) / 100})"
            >
              <span class="time">${clockLabel(this.cursor)}</span>
            </div>`
          : nothing}

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
          <div class="rail"></div>
          ${marks.map((m) => {
            const start = place(m.startTime);
            const end = place(m.endTime ?? this.now);
            if (end < 0 || start > 100) return nothing;
            const left = Math.max(0, start);
            return html`<button
              class="mark ${this.selected?.id === m.id ? 'on' : ''}"
              style="left:${left}%;width:${Math.max(0.5, Math.min(100, end) - left)}%;background:${labelCss(m.label)}"
              title="${m.label} · ${clockLabel(m.startTime)} · ${durationLabel(m)}"
              @click=${() => this.selectEvent(m)}
            ></button>`;
          })}
        </div>
      </div>
    `;
  }

  /** What is in the window, and what it was. Empty is worth saying out loud. */
  private renderLegend(): TemplateResult {
    if (!this.events.length) {
      return html`<p class="legend quiet">
        Aucun événement sur les ${this.config['timeline-hours'] ?? 24} dernières heures.
      </p>`;
    }
    const counts = new Map<string, number>();
    for (const e of this.events) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
    return html`
      <p class="legend">
        ${[...counts].map(
          ([label, n]) => html`<span class="key">
            <i style="background:${labelCss(label)}"></i>${label} × ${n}
          </span>`,
        )}
      </p>
    `;
  }

  /** Round hour marks, thinned so the labels never collide. */
  private ticks(): number[] {
    const hours = this.config['timeline-hours'] ?? 24;
    const step = hours <= 3 ? 1 : hours <= 8 ? 2 : hours <= 16 ? 4 : 6;
    const out: number[] = [];
    const top = new Date(this.now);
    top.setMinutes(0, 0, 0);
    for (let t = top.getTime(); t > this.now - this.span; t -= step * 3600_000) {
      // The last tick would sit under "maintenant" and read as a second label.
      if (this.now - t > this.span * 0.06) out.push(t);
    }
    return out;
  }
}

const two = (n: number): string => String(n).padStart(2, '0');
const clockLabel = (t: number): string => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const hourLabel = (t: number): string => `${two(new Date(t).getHours())} h`;

function durationLabel(det: Detection): string {
  const seconds = Math.max(1, Math.round(((det.endTime ?? Date.now()) - det.startTime) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

(window as any).customCards = (window as any).customCards ?? [];
(window as any).customCards.push({
  type: 'semaphore-card',
  name: 'Sémaphore',
  description:
    'Le plan de votre maison en 2.5D : murs, pièces, portes, et la couverture réelle de vos caméras.',
  preview: true,
});
