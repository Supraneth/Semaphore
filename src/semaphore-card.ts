import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ref } from 'lit/directives/ref.js';
import type { CameraConfig, CameraState, Detection, SemaphoreConfig } from './types';
import { Engine } from './engine';
import { FrigateBridge } from './frigate';
import { STATE_STYLES } from './theme';
import { styles } from './semaphore-card-css';
import type { EditorMode, PlanEditor } from './editor/plan-editor';
import { copyToClipboard, planYaml } from './editor/yaml';

const TICK_MS = 100; // one coalesced update per 100 ms, never per HA event
const THUMB_REFRESH_MS = 10_000;

@customElement('semaphore-card')
export class SemaphoreCard extends LitElement {
  static override styles = styles;

  @property({ attribute: false }) hass: any;
  @state() private config!: SemaphoreConfig;
  @state() private focused: string | null = null;
  @state() private activeLevel = '';
  @state() private exploded = false;
  @state() private idle = false;
  @state() private events: Detection[] = [];
  @state() private cursor: number | null = null;
  @state() private ready = false;
  @state() private error = '';
  @state() private editMode: EditorMode = 'off';
  @state() private editing = false;
  @state() private copied = false;
  @state() private yamlFallback = '';

  private engine?: Engine;
  private bridge?: FrigateBridge;
  private tick = 0;
  private eventsVersion = -1;
  private thumbTimer = 0;
  private thumbNonce = 0;
  private chipEls = new Map<string, HTMLElement>();
  private io?: IntersectionObserver;
  private states = new Map<string, CameraState>();
  private editor?: PlanEditor;

  // ---- Home Assistant contract -------------------------------------------

  setConfig(config: SemaphoreConfig): void {
    // `demo` opts into the keyless basemap deliberately. Every other style
    // needs a key, and failing here — rather than showing a blank map — is what
    // tells the user which of the two mistakes they made.
    if (!config['maptiler-api-key'] && config['map-style'] !== 'demo') {
      throw new Error(
        'Ajoutez votre clé MapTiler dans `maptiler-api-key`, ' +
          'ou passez `map-style: demo` pour un aperçu sans clé.',
      );
    }
    if (!config.cameras?.length) {
      throw new Error('Add at least one camera under `cameras`.');
    }
    if (!config.levels?.length) {
      config = { ...config, levels: [{ id: 'ground', name: 'Extérieur', elevation: 0 }] };
    }
    this.config = config;
    this.activeLevel = config.levels[0].id;
  }

  getCardSize(): number {
    return 10;
  }

  static getStubConfig(): Partial<SemaphoreConfig> {
    return {
      'maptiler-api-key': '',
      levels: [{ id: 'ground', name: 'Extérieur', elevation: 0 }],
      cameras: [],
    };
  }

  // ---- lifecycle ----------------------------------------------------------

  override firstUpdated(): void {
    void this.boot();

    // Off-screen or hidden tab means no render loop, no streams, no polling.
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
    this.engine?.destroy();
  }

  private onVisibility = () => this.setActive(!document.hidden);

  private setActive(active: boolean): void {
    this.engine?.setPaused(!active);
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
    const container = this.renderRoot.querySelector<HTMLElement>('.map');
    if (!container) return;

    try {
      this.engine = new Engine(container, this.config, {
        onFrame: () => this.positionChips(),
        onCameraClick: (name) => this.focusCamera(name),
        onIdleChange: (idle) => (this.idle = idle),
      });
      await this.engine.init();

      this.bridge = new FrigateBridge(this.hass, this.config.cameras, {
        topicPrefix: this.config['topic-prefix'],
        instanceId: this.config['instance-id'],
        alertLabels: this.config['alert-labels'],
        boxFormat: this.config['box-format'],
        // A track must outlive its own sector, or the cone is still lit after
        // the blip that justified it has been pruned.
        retentionMs: (this.config['decay-seconds'] ?? 12) * 1000 + 4000,
      });
      await this.bridge.connect();

      this.tick = window.setInterval(() => this.update_(), TICK_MS);
      this.events = await this.bridge.fetchHistory(
        Date.now() - (this.config['timeline-hours'] ?? 24) * 3600_000,
      );
      this.ready = true;
    } catch (err) {
      this.error =
        err instanceof Error ? err.message : 'The map could not be initialised.';
    }
  }

  override updated(): void {
    this.bridge?.setHass(this.hass);
  }

  // ---- the one tick -------------------------------------------------------

  /**
   * Everything that could change the picture is folded into a single 10 Hz
   * pass. Home Assistant emits state changes in bursts and Frigate emits an
   * MQTT update per tracked frame; reacting to each one individually is the
   * fastest way to make a card feel heavy.
   */
  private update_(): void {
    if (!this.engine || !this.bridge) return;
    const now = Date.now();
    this.bridge.prune(now);

    const decay = (this.config['decay-seconds'] ?? 12) * 1000;
    let dirty = false;

    for (const cam of this.config.cameras) {
      const entity = this.bridge.cameraEntity(cam);
      const live = this.bridge.liveFor(cam.name);
      const alerting = live.some((d) => this.bridge!.isAlert(d));

      let next: CameraState;
      if (!entity || entity.state === 'unavailable') next = 'offline';
      else if (alerting) next = 'alert';
      else if (live.length) next = 'motion';
      else next = 'nominal';

      const rt = this.engine.runtime(cam.name);
      if (rt && next !== 'nominal') rt.lastEventAt = now;
      // Cones do not snap back to idle the instant a track ends — a sector that
      // flickers off is a sector you stop trusting.
      if (rt && next === 'nominal' && now - rt.lastEventAt < decay) {
        next = this.states.get(cam.name) === 'alert' ? 'alert' : 'motion';
      }

      if (this.states.get(cam.name) !== next) {
        this.states.set(cam.name, next);
        this.engine.setCameraState(cam.name, next);
        dirty = true;
      }
    }

    this.engine.setDetections(this.bridge.liveDetections(), now);

    // The timeline only changes when a track starts or ends, which is far
    // rarer than the 10 Hz tick. Rebuilding it on a version bump keeps a few
    // hundred DOM nodes out of every frame.
    if (this.bridge.timelineVersion !== this.eventsVersion) {
      this.eventsVersion = this.bridge.timelineVersion;
      this.events = this.bridge.timeline(
        now - (this.config['timeline-hours'] ?? 24) * 3600_000,
      );
      dirty = true;
    }

    if (dirty) this.requestUpdate();
  }

  // ---- overlay positioning ------------------------------------------------

  /**
   * Chips are DOM, not WebGL, because they hold text and images. They are moved
   * with a single transform per frame and nothing else — no layout, no reflow.
   */
  private bindChip(name: string, el: Element | undefined): void {
    if (el) this.chipEls.set(name, el as HTMLElement);
    else this.chipEls.delete(name);
  }

  private positionChips(): void {
    if (!this.engine) return;
    for (const cam of this.config.cameras) {
      const el = this.chipEls.get(cam.name);
      if (!el) continue;
      const { x, y, behind } = this.engine.project(cam);
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
      el.classList.toggle('behind', behind);
      const onLevel = (cam.level ?? this.config.levels[0].id) === this.activeLevel;
      el.classList.toggle('dim', !onLevel && !this.exploded);
    }
  }

  // ---- actions ------------------------------------------------------------

  private focusCamera(name: string): void {
    this.focused = name;
    this.engine?.focus(name);
  }

  private unfocus(): void {
    this.focused = null;
    this.engine?.clearFocus();
  }

  private selectLevel(id: string): void {
    this.activeLevel = id;
    void this.engine?.setActiveLevel(id);
  }

  private toggleExplode(): void {
    this.exploded = !this.exploded;
    void this.engine?.setExploded(this.exploded ? 6 : 0);
  }

  /**
   * Edit mode pauses the ambient behaviour: an orbiting map is unusable for
   * tracing, and a sector that keeps re-lighting hides the geometry you are
   * trying to place.
   */
  private toggleEditing(): void {
    this.editing = !this.editing;
    if (this.editing) {
      this.editor = this.engine?.enableEditor(this.config, () => this.requestUpdate());
      this.setEditMode('adjust');
    } else {
      this.engine?.disableEditor();
      this.editor = undefined;
      this.editMode = 'off';
    }
    this.requestUpdate();
  }

  private setEditMode(mode: EditorMode): void {
    this.editMode = mode;
    this.editor?.setMode(mode);
    this.engine?.noteInteraction();
    this.requestUpdate();
  }

  /**
   * Both clipboard routes can fail — an insecure context with a browser that
   * also refuses `execCommand`. Losing a traced plan to a silent failure is
   * the worst outcome here, so the block is shown for manual selection instead.
   */
  private async copyPlan(): Promise<void> {
    const yaml = planYaml(this.config);
    const ok = await copyToClipboard(yaml);
    this.copied = ok;
    this.yamlFallback = ok ? '' : yaml;
    this.requestUpdate();
    if (ok) {
      setTimeout(() => {
        this.copied = false;
        this.requestUpdate();
      }, 2400);
    }
  }

  private renameSelection(ev: Event): void {
    const sel = this.editor?.selection;
    if (sel) this.editor?.rename(sel, (ev.target as HTMLInputElement).value);
  }

  private scrub(ev: PointerEvent): void {
    const rail = ev.currentTarget as HTMLElement;
    const rect = rail.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const span = (this.config['timeline-hours'] ?? 24) * 3600_000;
    this.cursor = Date.now() - span * (1 - ratio);
    if (this.engine) this.engine.sceneLayer.frozenTime = ratio * 60;
  }

  private endScrub(): void {
    this.cursor = null;
    if (this.engine) this.engine.sceneLayer.frozenTime = null;
  }

  // ---- render -------------------------------------------------------------

  override render(): TemplateResult {
    if (!this.config) return html``;
    return html`
      <ha-card>
        <div class="stage">
          <div class="map"></div>
          <div class="overlay">
            ${this.renderRail()} ${this.renderStatus()}
            ${this.editing ? nothing : this.renderChips()}
            ${this.editing ? this.renderEditor() : this.renderPanel()}
          </div>
        </div>
        ${this.renderTimeline()}
        ${this.error ? html`<div class="empty">${this.error}</div>` : nothing}
      </ha-card>
    `;
  }

  private renderRail(): TemplateResult {
    const levels = this.config.levels;
    return html`
      <div class="rail">
        ${(levels.length > 1 ? levels : []).map(
          (l) => html`
            <button
              aria-pressed=${l.id === this.activeLevel}
              @click=${() => this.selectLevel(l.id)}
            >
              ${l.name}
            </button>
          `,
        )}
        ${levels.length > 1
          ? html`<button aria-pressed=${this.exploded} @click=${this.toggleExplode}>
              ${this.exploded ? 'Empiler' : 'Séparer'}
            </button>`
          : nothing}
        <button aria-pressed=${this.editing} @click=${this.toggleEditing}>
          Plan
        </button>
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
        : this.idle
          ? 'Veille'
          : 'Tout est calme';
    return html`<div class="status">${text}</div>`;
  }

  private renderChips(): TemplateResult {
    return html`${repeat(
      this.config.cameras,
      (c) => c.name,
      (cam) => this.renderChip(cam),
    )}`;
  }

  private renderChip(cam: CameraConfig): TemplateResult {
    const state = this.states.get(cam.name) ?? 'nominal';
    const style = STATE_STYLES[state];
    const thumb = this.bridge?.livePreviewUrl(cam);
    return html`
      <button
        class="chip ${state}"
        style="color:${style.css}"
        title=${style.caption}
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
            />`
          : html`<span class="pip"></span>`}
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
          ? html`<ha-camera-stream
              class="stream"
              .hass=${this.hass}
              .stateObj=${stateObj}
              allow-exoplayer
              muted
            ></ha-camera-stream>`
          : html`<div class="empty">Ce flux est indisponible.</div>`}
        <div class="meta">
          <span>${STATE_STYLES[state].caption}</span>
          <span>${cam.fov}° · ${cam.range} m</span>
          <span>Cap ${Math.round(cam.azimuth)}°</span>
        </div>
      </div>
    `;
  }

  private renderEditor(): TemplateResult {
    const sel = this.editor?.selection;
    const modes: Array<[EditorMode, string, string]> = [
      ['adjust', 'ti-pointer', 'Ajuster'],
      ['room', 'ti-vector', 'Tracer une pièce'],
      ['camera', 'ti-device-cctv', 'Poser une caméra'],
    ];
    return html`
      <div class="editor">
        <div class="tools">
          ${modes.map(
            ([m, , label]) => html`
              <button
                aria-pressed=${this.editMode === m}
                @click=${() => this.setEditMode(m)}
              >
                ${label}
              </button>
            `,
          )}
        </div>
        <p class="tip">
          ${this.editMode === 'room'
            ? html`Cliquez chaque angle, double-cliquez pour fermer. Les sommets
              proches s'aimantent, donc deux pièces partagent leur mur.`
            : this.editMode === 'camera'
              ? html`Cliquez l'emplacement, puis tirez la poignée rouge pour le cap
                et la portée, la verte pour l'ouverture.`
              : html`Tirez un sommet pour redresser un mur. Suppr efface la
                sélection.`}
        </p>
        ${sel
          ? html`<input
              type="text"
              .value=${this.selectionName(sel.id)}
              @change=${this.renameSelection}
              placeholder="Nom"
            />`
          : nothing}
        <div class="tools">
          <button @click=${this.copyPlan}>
            ${this.copied ? 'Copié' : 'Copier le YAML'}
          </button>
          <button @click=${this.toggleEditing}>Terminer</button>
        </div>
        ${this.yamlFallback
          ? html`
              <p class="tip">
                Le presse-papier est indisponible — Home Assistant en HTTP simple
                le bloque. Sélectionnez le bloc ci-dessous et copiez-le.
              </p>
              <textarea class="yaml" readonly .value=${this.yamlFallback}></textarea>
            `
          : nothing}
      </div>
    `;
  }

  private selectionName(id: string): string {
    const cam = this.config.cameras.find((c) => c.name === id);
    if (cam) return cam.label ?? cam.name;
    for (const l of this.config.levels) {
      const room = l.rooms?.find((r) => r.id === id);
      if (room) return room.name;
    }
    return '';
  }

  private renderTimeline(): TemplateResult {
    const span = (this.config['timeline-hours'] ?? 24) * 3600_000;
    const now = Date.now();
    const cams = this.config.cameras;
    if (!this.ready) return html`<div class="empty">Chargement de la scène…</div>`;
    return html`
      <div
        class="timeline"
        @pointerdown=${this.scrub}
        @pointermove=${(e: PointerEvent) => e.buttons && this.scrub(e)}
        @pointerup=${this.endScrub}
        @pointerleave=${this.endScrub}
      >
        <div class="lanes">
          ${cams.map((cam) => {
            const marks = this.events.filter((e) => e.camera === cam.name);
            return html`
              <div class="lane" title=${cam.label ?? cam.name}>
                ${marks.map((m) => {
                  const start = ((m.startTime - (now - span)) / span) * 100;
                  const end = (((m.endTime ?? now) - (now - span)) / span) * 100;
                  if (end < 0 || start > 100) return nothing;
                  return html`<span
                    class="mark"
                    style="left:${Math.max(0, start)}%;width:${Math.max(
                      0.4,
                      Math.min(100, end) - Math.max(0, start),
                    )}%;background:${STATE_STYLES.alert.css}"
                    title=${m.label}
                    @click=${() => this.focusCamera(cam.name)}
                  ></span>`;
                })}
              </div>
            `;
          })}
          ${this.cursor
            ? html`<div
                class="cursor"
                style="left:${((this.cursor - (now - span)) / span) * 100}%"
              ></div>`
            : nothing}
        </div>
      </div>
    `;
  }
}

// Register the card with the Lovelace picker.
(window as any).customCards = (window as any).customCards ?? [];
(window as any).customCards.push({
  type: 'semaphore-card',
  name: 'Sémaphore',
  description:
    'Vos caméras en 2.5D : secteurs de vision, détections au sol et rejeu, sur une seule carte.',
  preview: true,
});
