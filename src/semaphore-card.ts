import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { ref } from 'lit/directives/ref.js';
import type { CameraConfig, CameraState, Detection, SemaphoreConfig } from './types';
import { validateConfig } from './config';
import { Scene } from './plan/scene';
import { FrigateBridge } from './frigate';
import { STATE_STYLES } from './theme';
import { styles } from './semaphore-card-css';
import type { PlanEditor, Tool } from './plan/editor';
import { findWall } from './plan/geometry';
import { copyToClipboard, planYaml } from './plan/yaml';

const TICK_MS = 100;
const THUMB_REFRESH_MS = 10_000;

const TOOLS: Array<{ id: Tool; label: string; key: string; hint: string }> = [
  { id: 'select', label: 'Sélection', key: 'G', hint: 'Tirez un sommet, un mur ou une caméra. Suppr efface.' },
  { id: 'wall', label: 'Mur', key: 'M', hint: 'Cliquez chaque angle : chaque segment devient un mur. Tapez une longueur puis Entrée. Échap termine.' },
  { id: 'room', label: 'Pièce', key: 'P', hint: 'Cliquez le contour, double-clic ou Entrée pour fermer. La surface s’affiche au centre.' },
  { id: 'opening', label: 'Ouverture', key: 'O', hint: 'Cliquez sur un mur pour y percer une porte. Réglez ensuite largeur et type.' },
  { id: 'camera', label: 'Caméra', key: 'C', hint: 'Cliquez l’emplacement, puis tirez la poignée rouge (cap et portée) ou verte (ouverture).' },
];

@customElement('semaphore-card')
export class SemaphoreCard extends LitElement {
  static override styles = styles;

  @property({ attribute: false }) hass: any;
  @state() private config!: SemaphoreConfig;
  @state() private migrated = false;
  @state() private focused: string | null = null;
  @state() private activeLevel = '';
  @state() private exploded = false;
  @state() private editing = false;
  @state() private tool: Tool = 'select';
  @state() private showGrid = true;
  @state() private events: Detection[] = [];
  @state() private cursor: number | null = null;
  @state() private ready = false;
  @state() private error = '';
  @state() private copied = false;
  @state() private yamlFallback = '';
  /** Bumped to force a re-render after the editor mutates the document. */
  @state() private revision = 0;

  @query('.canvas') private canvasEl?: HTMLCanvasElement;
  @query('.stage') private stageEl?: HTMLElement;

  private scene?: Scene;
  private bridge?: FrigateBridge;
  private editor?: PlanEditor;
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
  }

  getCardSize(): number {
    return 10;
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
    this.scene?.focus(name);
  }

  private unfocus(): void {
    this.focused = null;
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

  private toggleGrid(): void {
    this.showGrid = !this.showGrid;
    if (this.scene) {
      this.scene.showGrid = this.showGrid;
      this.scene.invalidate();
    }
  }

  private toggleEditing(): void {
    this.editing = !this.editing;
    if (this.editing) {
      this.unfocus();
      // Tracing in a tilted view is guesswork. Editing starts flat, and the
      // user can tilt back with a right-drag whenever they want to check it.
      if (this.scene) {
        this.scene.view.pitch = 0;
        this.scene.view.refresh();
        // Flattening makes the same scene ~40% taller on screen, so it has to
        // be re-framed or it spills off the canvas.
        this.scene.frame();
      }
      this.editor = this.scene?.enableEditor(() => {
        this.revision++;
        this.requestUpdate();
      });
      this.setTool('select');
    } else {
      this.scene?.disableEditor();
      this.editor = undefined;
      if (this.scene) {
        this.scene.view.pitch = 45;
        this.scene.view.refresh();
        this.scene.frame();
      }
    }
    this.requestUpdate();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.editor?.setTool(tool);
    this.scene?.noteInteraction();
    this.requestUpdate();
  }

  private undo(): void {
    this.editor?.history.undo();
    this.scene?.rebuildOccluders();
    this.revision++;
    this.requestUpdate();
  }

  private redo(): void {
    this.editor?.history.redo();
    this.scene?.rebuildOccluders();
    this.revision++;
    this.requestUpdate();
  }

  private async copyPlan(): Promise<void> {
    const yaml = planYaml(this.config);
    const ok = await copyToClipboard(yaml);
    this.copied = ok;
    this.yamlFallback = ok ? '' : yaml;
    this.requestUpdate();
    if (ok) setTimeout(() => { this.copied = false; this.requestUpdate(); }, 2400);
  }

  private setGrid(value: number): void {
    this.config = { ...this.config, grid: value };
    this.scene?.invalidate();
  }

  private scrub(ev: PointerEvent): void {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const span = (this.config['timeline-hours'] ?? 24) * 3600_000;
    this.cursor = Date.now() - span * (1 - ratio);
    if (this.scene) this.scene.frozenTime = ratio * 60;
  }

  private endScrub(): void {
    this.cursor = null;
    if (this.scene) this.scene.frozenTime = null;
  }

  // ---- render -------------------------------------------------------------

  override render(): TemplateResult {
    if (!this.config) return html``;
    return html`
      <ha-card>
        ${this.migrated ? this.renderMigrationNotice() : nothing}
        <div class="stage">
          <canvas class="canvas"></canvas>
          <div class="overlay">
            ${this.renderRail()} ${this.renderStatus()}
            ${this.editing ? nothing : this.renderChips()}
            ${this.editing ? this.renderEditor() : this.renderPanel()}
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
        coordonnées sont maintenant en mètres. Ouvrez <strong>Plan</strong>,
        vérifiez, puis <strong>Copier le YAML</strong> pour figer la conversion.
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
        <button aria-pressed=${this.showGrid} @click=${this.toggleGrid} title="Grille">Grille</button>
        <button aria-pressed=${this.editing} @click=${this.toggleEditing}>Plan</button>
        <button @click=${() => this.scene?.frame()} title="Tout cadrer">Cadrer</button>
      </div>
    `;
  }

  private renderStatus(): TemplateResult {
    if (this.editing) {
      const v = this.scene?.view;
      return html`<div class="status">
        ${v ? `${Math.round(v.zoom)} px/m · ${Math.round(v.pitch)}°` : ''}
      </div>`;
    }
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
      </div>
    `;
  }

  // ---- editor UI ----------------------------------------------------------

  private renderEditor(): TemplateResult {
    const active = TOOLS.find((t) => t.id === this.tool);
    return html`
      <div class="editor">
        <div class="tools">
          ${TOOLS.map(
            (t) => html`<button
              aria-pressed=${this.tool === t.id}
              title="${t.label} (${t.key})"
              @click=${() => this.setTool(t.id)}
            >${t.label}<kbd>${t.key}</kbd></button>`,
          )}
        </div>

        <p class="tip">${active?.hint}</p>

        <div class="row">
          <label>Grille</label>
          ${[0.1, 0.25, 0.5, 1].map(
            (g) => html`<button
              class="chiplet"
              aria-pressed=${(this.config.grid ?? 0.5) === g}
              @click=${() => this.setGrid(g)}
            >${g < 1 ? `${g * 100} cm` : '1 m'}</button>`,
          )}
        </div>

        ${this.renderInspector()}

        <div class="tools">
          <button @click=${this.undo} ?disabled=${!this.editor?.history.canUndo} title="Ctrl+Z">Annuler</button>
          <button @click=${this.redo} ?disabled=${!this.editor?.history.canRedo} title="Ctrl+Y">Refaire</button>
          <button @click=${this.copyPlan}>${this.copied ? 'Copié' : 'Copier le YAML'}</button>
          <button @click=${this.toggleEditing}>Terminer</button>
        </div>

        <p class="tip muted">
          Molette : zoom · clic droit glissé : pivoter et incliner ·
          Alt ou clic milieu : déplacer · Maj : libérer l'accrochage
        </p>

        ${this.yamlFallback
          ? html`
              <p class="tip">Presse-papier indisponible (Home Assistant en HTTP simple).
                Sélectionnez le bloc et copiez-le.</p>
              <textarea class="yaml" readonly .value=${this.yamlFallback}></textarea>
            `
          : nothing}
      </div>
    `;
  }

  /** Numeric editing for whatever is selected. */
  private renderInspector(): TemplateResult | typeof nothing {
    const sel = this.editor?.selection;
    if (!sel) return nothing;
    void this.revision;

    const numberRow = (
      label: string,
      value: number | undefined,
      field: string,
      step = 0.05,
    ): TemplateResult => html`
      <div class="row">
        <label>${label}</label>
        <input
          type="number"
          step=${step}
          .value=${String(round2(value))}
          @change=${(e: Event) =>
            this.editor?.setField(field, parseFloat((e.target as HTMLInputElement).value))}
        />
      </div>
    `;

    if (sel.kind === 'wall') {
      const wall = findWall(this.config.levels, sel.id);
      if (!wall) return nothing;
      const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
      return html`
        <div class="inspector">
          <h4>Mur</h4>
          ${numberRow('Longueur (m)', length, 'length')}
          ${numberRow('Épaisseur (m)', wall.thickness, 'thickness', 0.01)}
          ${numberRow('Hauteur (m)', wall.height, 'height', 0.05)}
          <div class="row">
            <button class="chiplet" aria-pressed=${!!wall.transparent}
              @click=${() => this.editor?.setField('transparent', 1)}>Vitré</button>
            <button class="chiplet" @click=${() => this.editor?.deleteSelection()}>Supprimer</button>
          </div>
        </div>
      `;
    }

    if (sel.kind === 'opening' && sel.wallId) {
      const wall = findWall(this.config.levels, sel.wallId);
      const o = wall?.openings?.find((x) => x.id === sel.id);
      if (!o) return nothing;
      return html`
        <div class="inspector">
          <h4>Ouverture</h4>
          <div class="row">
            <label>Type</label>
            ${(['door', 'window', 'pass'] as const).map(
              (k) => html`<button class="chiplet" aria-pressed=${o.kind === k}
                @click=${() => this.editor?.setField('kind', k)}
              >${k === 'door' ? 'Porte' : k === 'window' ? 'Fenêtre' : 'Passage'}</button>`,
            )}
          </div>
          ${numberRow('Largeur (m)', o.width, 'width')}
          ${numberRow('Allège (m)', o.sill, 'sill')}
          ${numberRow('Linteau (m)', o.head, 'head')}
          <div class="row">
            <button class="chiplet" aria-pressed=${!!o.blocksSight}
              @click=${() => this.editor?.setField('blocksSight', 1)}
              title="Une ouverture laisse voir à travers par défaut">Opaque</button>
            <button class="chiplet" @click=${() => this.editor?.deleteSelection()}>Supprimer</button>
          </div>
        </div>
      `;
    }

    if (sel.kind === 'camera') {
      const cam = this.config.cameras.find((c) => c.name === sel.id);
      if (!cam) return nothing;
      return html`
        <div class="inspector">
          <h4>Caméra</h4>
          <div class="row">
            <label>Nom Frigate</label>
            <input type="text" .value=${cam.name}
              @change=${(e: Event) => this.editor?.setField('name', (e.target as HTMLInputElement).value)} />
          </div>
          <div class="row">
            <label>Libellé</label>
            <input type="text" .value=${cam.label ?? ''}
              @change=${(e: Event) => this.editor?.rename((e.target as HTMLInputElement).value)} />
          </div>
          ${numberRow('Cap (°)', cam.azimuth, 'azimuth', 1)}
          ${numberRow('Ouverture (°)', cam.fov, 'fov', 1)}
          ${numberRow('Portée (m)', cam.range, 'range', 0.5)}
          ${numberRow('Hauteur (m)', cam.height, 'height', 0.1)}
          <div class="row">
            <button class="chiplet" @click=${() => this.editor?.deleteSelection()}>Supprimer</button>
          </div>
        </div>
      `;
    }

    const room = this.config.levels.flatMap((l) => l.rooms ?? []).find((r) => r.id === sel.id);
    if (!room) return nothing;
    return html`
      <div class="inspector">
        <h4>Pièce</h4>
        <div class="row">
          <label>Nom</label>
          <input type="text" .value=${room.name}
            @change=${(e: Event) => this.editor?.rename((e.target as HTMLInputElement).value)} />
        </div>
        <div class="row">
          <button class="chiplet" @click=${() => this.editor?.wallsAroundRoom(room.id)}>
            Murs autour
          </button>
          <button class="chiplet" @click=${() => this.editor?.deleteSelection()}>Supprimer</button>
        </div>
      </div>
    `;
  }

  private renderTimeline(): TemplateResult | typeof nothing {
    if (this.editing) return nothing;
    if (!this.ready) return html`<div class="empty">Chargement de la scène…</div>`;
    if (!this.config.cameras.length) {
      return html`<div class="empty">
        Aucune caméra. Ouvrez <strong>Plan</strong> pour dessiner vos murs et en poser une.
      </div>`;
    }

    const span = (this.config['timeline-hours'] ?? 24) * 3600_000;
    const now = Date.now();
    return html`
      <div
        class="timeline"
        @pointerdown=${this.scrub}
        @pointermove=${(e: PointerEvent) => e.buttons && this.scrub(e)}
        @pointerup=${this.endScrub}
        @pointerleave=${this.endScrub}
      >
        <div class="lanes">
          ${this.config.cameras.map((cam) => {
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
            ? html`<div class="cursor" style="left:${((this.cursor - (now - span)) / span) * 100}%"></div>`
            : nothing}
        </div>
      </div>
    `;
  }
}

const round2 = (n: number | undefined): number => Math.round((n ?? 0) * 100) / 100;

(window as any).customCards = (window as any).customCards ?? [];
(window as any).customCards.push({
  type: 'semaphore-card',
  name: 'Sémaphore',
  description:
    'Le plan de votre maison en 2.5D : murs, pièces, portes, et la couverture réelle de vos caméras.',
  preview: true,
});
