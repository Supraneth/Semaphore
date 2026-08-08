import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { CameraConfig, Level, SemaphoreConfig } from '../src/types';
import { Scene } from '../src/plan/scene';
import { VIEW_PRESETS, presetOf, type ViewPreset } from '../src/plan/view';
import type { PlanEditor, Tool } from '../src/plan/editor';
import { area, dist, findWall } from '../src/plan/geometry';
import { formatArea, formatMetres } from '../src/plan/snap';
import { isovistCoverage } from '../src/fov';
import { cardYaml, copyToClipboard } from '../src/plan/yaml';
import { validateConfig } from '../src/config';
import {
  blankProject,
  checkProject,
  forgetProject,
  importYaml,
  restoreProject,
  sampleHouse,
  saveProject,
  type Check,
} from './project';
import { styles } from './studio-css';

/**
 * Sémaphore, standalone.
 *
 * Drawing a house inside a Lovelace card means drawing it in a box a few
 * hundred pixels tall, on a dashboard that reloads the card whenever the config
 * changes, with the plan and the YAML that describes it never visible at the
 * same time. This is the same editor — literally the same `PlanEditor` and the
 * same renderer, so what you see here is what the card will draw — given the
 * whole window, a document of its own, and an export that produces a config you
 * paste once and never hand-edit.
 */

const TOOLS: Array<{ id: Tool; label: string; key: string; hint: string }> = [
  {
    id: 'select',
    label: 'Sélection',
    key: 'G',
    hint: 'Tirez un sommet, un mur, une ouverture ou une caméra. Suppr efface la sélection.',
  },
  {
    id: 'wall',
    label: 'Mur',
    key: 'M',
    hint: 'Cliquez chaque angle : chaque segment devient un mur. Tapez une longueur (4,20) puis Entrée pour la poser exactement. Échap termine la chaîne.',
  },
  {
    id: 'room',
    label: 'Pièce',
    key: 'P',
    hint: 'Cliquez le contour, double-clic ou Entrée pour fermer. La surface s’affiche au centre. « Murs autour » entoure ensuite la pièce en un geste.',
  },
  {
    id: 'opening',
    label: 'Ouverture',
    key: 'O',
    hint: 'Cliquez sur un mur pour y percer une porte. Une ouverture laisse passer la vue : c’est ce qui fait qu’une caméra du couloir voit le salon.',
  },
  {
    id: 'camera',
    label: 'Caméra',
    key: 'C',
    hint: 'Cliquez l’emplacement, puis tirez la poignée rouge (cap et portée) ou verte (ouverture). Le nom doit être celui de Frigate.',
  },
];

const SNAP_LABELS: Record<string, string> = {
  vertex: 'sommet',
  edge: 'arête',
  angle: 'angle',
  grid: 'grille',
  free: 'libre',
};

const GRID_PRESETS = [0.1, 0.25, 0.5, 1];

@customElement('semaphore-studio')
export class SemaphoreStudio extends LitElement {
  static override styles = styles;

  @state() private config: SemaphoreConfig = blankProject();
  @state() private activeLevel = 'rdc';
  @state() private tool: Tool = 'select';
  @state() private showGrid = true;
  @state() private exploded = false;
  @state() private dialog: 'import' | 'export' | null = null;
  @state() private importText = '';
  @state() private problem = '';
  @state() private copied = false;
  @state() private savedAt = 0;
  /**
   * Recomputed on the save beat rather than per render.
   *
   * A drag reports a change on every pointer move; re-validating the whole
   * config that often would make dragging a wall across a large plan stutter
   * for a panel nobody is reading mid-gesture.
   */
  @state() private checks: Check[] = [];
  /** Bumped whenever the editor mutates the document, to force a re-render. */
  @state() private revision = 0;

  @query('.canvas') private canvasEl?: HTMLCanvasElement;
  @query('.stage') private stageEl?: HTMLElement;
  @query('.readout') private readoutEl?: HTMLElement;

  private scene?: Scene;
  private editor?: PlanEditor;
  private saveTimer = 0;

  // ---- lifecycle ----------------------------------------------------------

  override firstUpdated(): void {
    // Booting writes reactive state, so it waits for this first update to
    // finish rather than scheduling a second one from inside it.
    // A restored session beats an example, and an example beats an empty grid:
    // the first thing on screen should be something you can recognise.
    void this.updateComplete.then(() => this.boot(restoreProject() ?? sampleHouse()));
    window.addEventListener('beforeunload', this.flushSave);
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('drop', this.onDrop);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('beforeunload', this.flushSave);
    this.removeEventListener('dragover', this.onDragOver);
    this.removeEventListener('drop', this.onDrop);
    this.flushSave();
    this.scene?.destroy();
  }

  private boot(config: SemaphoreConfig): void {
    this.scene?.destroy();
    const canvas = this.canvasEl;
    const stage = this.stageEl;
    if (!canvas || !stage) return;

    // Everything reaching this point goes through validation first, so the
    // editor only ever holds a document the card would also accept — defaults
    // filled in, arrays present, ids unique.
    const checked = validateConfig(config).config;
    this.config = checked;
    this.activeLevel = checked.levels[0].id;

    const scene = new Scene(canvas, checked, {
      onFrame: () => this.paintReadout(),
      onIdleChange: () => undefined,
    });
    // Tracing in a tilted view is guesswork and tracing off-axis is worse, so a
    // project with no remembered view opens in plan. One that has a view opens
    // the way it was left.
    if (!config.view) {
      scene.view.yaw = VIEW_PRESETS[0].yaw;
      scene.view.pitch = VIEW_PRESETS[0].pitch;
      scene.view.refresh();
    }
    scene.activeLevel = this.activeLevel;
    scene.showGrid = this.showGrid;
    scene.init(stage);

    this.scene = scene;
    this.editor = scene.enableEditor(() => this.changed());
    this.editor.setTool(this.tool);
    this.problem = '';
    // Queued, not flushed: the first boot runs inside `firstUpdated`, and
    // writing reactive state from there schedules a second update on top of
    // the one still finishing.
    this.queueSave();
  }

  /** One place for "the document changed": re-render, and remember it. */
  private changed(): void {
    this.revision++;
    this.queueSave();
    this.requestUpdate();
  }

  private queueSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 500);
  }

  private flushSave = (): void => {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    saveProject(this.config);
    this.savedAt = Date.now();
    this.checks = checkProject(this.config);
    this.requestUpdate();
  };

  // ---- readout ------------------------------------------------------------

  /**
   * Written straight to the DOM rather than through a render.
   *
   * This runs on every painted frame; routing it through Lit would re-render
   * the whole panel column sixty times a second to change six characters.
   */
  private paintReadout(): void {
    const el = this.readoutEl;
    const scene = this.scene;
    if (!el || !scene) return;
    const cursor = this.editor?.cursor ?? this.editor?.lastSnap?.point;
    const snap = this.editor?.lastSnap?.kind;
    el.textContent = [
      cursor ? `x ${cursor[0].toFixed(2)} · y ${cursor[1].toFixed(2)} m` : '—',
      `${Math.round(scene.view.zoom)} px/m`,
      `lacet ${Math.round(scene.view.yaw)}° · inclinaison ${Math.round(scene.view.pitch)}°`,
      snap ? `accrochage : ${SNAP_LABELS[snap] ?? snap}` : '',
    ]
      .filter(Boolean)
      .join('   ·   ');
  }

  // ---- document actions ---------------------------------------------------

  private newProject(): void {
    if (!confirm('Effacer le plan en cours et repartir d’une page blanche ?')) return;
    forgetProject();
    this.boot(blankProject());
  }

  private loadSample(): void {
    if (!confirm('Remplacer le plan en cours par la maison d’exemple ?')) return;
    this.boot(sampleHouse());
  }

  private applyImport(): void {
    try {
      this.boot(importYaml(this.importText));
      this.dialog = null;
      this.importText = '';
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
    }
  }

  private async readFile(file: File): Promise<void> {
    this.importText = await file.text();
    this.dialog = 'import';
    this.problem = '';
    this.requestUpdate();
  }

  private onDragOver = (ev: DragEvent): void => {
    if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault();
  };

  private onDrop = (ev: DragEvent): void => {
    const file = ev.dataTransfer?.files?.[0];
    if (!file) return;
    ev.preventDefault();
    void this.readFile(file);
  };

  private get yaml(): string {
    return cardYaml(this.config);
  }

  private async copyYaml(): Promise<void> {
    this.copied = await copyToClipboard(this.yaml);
    this.requestUpdate();
    if (this.copied) {
      setTimeout(() => {
        this.copied = false;
        this.requestUpdate();
      }, 2400);
    }
  }

  private downloadYaml(): void {
    const blob = new Blob([this.yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'semaphore-card.yaml';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- view ---------------------------------------------------------------

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.editor?.setTool(tool);
    this.requestUpdate();
  }

  private applyPreset(preset: ViewPreset): void {
    this.scene?.applyPreset(preset);
    this.requestUpdate();
  }

  private selectLevel(id: string): void {
    this.activeLevel = id;
    this.scene?.setActiveLevel(id);
  }

  /**
   * Shows every storey at once, pulled apart vertically.
   *
   * Only the active level is drawn otherwise, which makes tracing an upper
   * floor a matter of remembering where the walls below were.
   */
  private toggleExplode(): void {
    this.exploded = !this.exploded;
    this.scene?.setExploded(this.exploded ? 3.2 : 0);
    this.requestUpdate();
  }

  private toggleGrid(): void {
    this.showGrid = !this.showGrid;
    if (this.scene) {
      this.scene.showGrid = this.showGrid;
      this.scene.invalidate();
    }
  }

  private setGrid(value: number): void {
    if (!(value > 0)) return;
    this.config = { ...this.config, grid: value };
    this.scene?.invalidate();
    this.queueSave();
  }

  /** Freezes the current camera as the card's opening view. */
  private rememberView(): void {
    const view = this.scene?.view;
    if (!view) return;
    const shot = view.snapshot();
    this.config = {
      ...this.config,
      view: { yaw: shot.yaw, pitch: shot.pitch, zoom: shot.zoom, center: shot.center },
    };
    this.queueSave();
    this.requestUpdate();
  }

  private forgetView(): void {
    const { view: _dropped, ...rest } = this.config;
    this.config = rest as SemaphoreConfig;
    this.queueSave();
    this.requestUpdate();
  }

  // ---- levels -------------------------------------------------------------

  private get level(): Level {
    return this.config.levels.find((l) => l.id === this.activeLevel) ?? this.config.levels[0];
  }

  private editLevel(field: 'name' | 'elevation' | 'wallHeight', value: string | number): void {
    const level = this.level;
    this.editor?.edit(() => {
      if (field === 'name' && typeof value === 'string' && value.trim()) level.name = value.trim();
      if (field === 'elevation' && typeof value === 'number' && isFinite(value)) {
        level.elevation = value;
      }
      if (field === 'wallHeight' && typeof value === 'number' && value > 0.1) {
        level.wallHeight = value;
      }
    });
  }

  private addLevel(): void {
    const levels = this.config.levels;
    const below = levels[levels.length - 1];
    const id = uniqueId(levels.map((l) => l.id), 'niveau');
    this.editor?.edit(() => {
      levels.push({
        id,
        name: `Niveau ${levels.length + 1}`,
        // Stacked directly on the storey below, which is what a storey is.
        elevation: round2(below.elevation + (below.wallHeight ?? 2.5) + 0.2),
        wallHeight: 2.5,
        walls: [],
        rooms: [],
      });
    });
    this.selectLevel(id);
  }

  /**
   * Copies the active storey.
   *
   * Every id is regenerated: `findWall` looks a wall up by id across all
   * levels, so two walls sharing one would make selecting either of them edit
   * whichever came first.
   */
  private duplicateLevel(): void {
    const source = this.level;
    const id = uniqueId(this.config.levels.map((l) => l.id), `${source.id}-copie`);
    const copy: Level = structuredClone(source);
    copy.id = id;
    copy.name = `${source.name} (copie)`;
    copy.elevation = round2(source.elevation + (source.wallHeight ?? 2.5) + 0.2);
    let seq = 0;
    for (const wall of copy.walls ?? []) {
      wall.id = `${id}-mur-${++seq}`;
      let hole = 0;
      for (const opening of wall.openings ?? []) opening.id = `${wall.id}-ouv-${++hole}`;
    }
    let room = 0;
    for (const r of copy.rooms ?? []) r.id = `${id}-piece-${++room}`;

    this.editor?.edit(() => this.config.levels.push(copy));
    this.selectLevel(id);
  }

  private deleteLevel(): void {
    if (this.config.levels.length < 2) return;
    const doomed = this.level;
    const survivors = this.config.levels.filter((l) => l.id !== doomed.id);
    const stranded = this.config.cameras.filter((c) => c.level === doomed.id);
    const warning = stranded.length
      ? `Supprimer « ${doomed.name} » ? Ses ${stranded.length} caméra(s) passeront au niveau « ${survivors[0].name} ».`
      : `Supprimer « ${doomed.name} » et tout ce qu'il contient ?`;
    if (!confirm(warning)) return;

    this.editor?.edit(() => {
      const levels = this.config.levels;
      levels.splice(levels.indexOf(doomed), 1);
      for (const cam of stranded) cam.level = survivors[0].id;
    });
    this.selectLevel(survivors[0].id);
  }

  // ---- selection ----------------------------------------------------------

  private selectCamera(name: string): void {
    if (!this.editor) return;
    const cam = this.config.cameras.find((c) => c.name === name);
    if (cam?.level && cam.level !== this.activeLevel) this.selectLevel(cam.level);
    this.editor.selection = { kind: 'camera', id: name };
    this.setTool('select');
    this.scene?.invalidate();
  }

  private set(field: string, value: number | string): void {
    this.editor?.setField(field, value);
  }

  // ---- render -------------------------------------------------------------

  override render(): TemplateResult {
    return html`
      ${this.renderBar()}
      <main>
        ${this.renderTools()}
        <div class="stage">
          <canvas class="canvas"></canvas>
          <p class="tip">${TOOLS.find((t) => t.id === this.tool)?.hint}</p>
        </div>
        ${this.renderSide()}
      </main>
      ${this.renderStatus()} ${this.renderDialog()}
    `;
  }

  private renderBar(): TemplateResult {
    return html`
      <header class="bar">
        <div class="brand">Sémaphore<span>éditeur de plan</span></div>
        <button @click=${this.newProject}>Nouveau</button>
        <button @click=${this.loadSample}>Exemple</button>
        <button @click=${() => { this.dialog = 'import'; this.problem = ''; }}>Importer…</button>
        <button class="primary" @click=${() => { this.flushSave(); this.dialog = 'export'; }}>
          Exporter le YAML
        </button>
        <div class="spacer"></div>
        <span class="saved">
          ${this.savedAt
            ? `Enregistré dans ce navigateur à ${new Date(this.savedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
            : 'Enregistrement automatique'}
        </span>
      </header>
    `;
  }

  private renderTools(): TemplateResult {
    const history = this.editor?.history;
    void this.revision;
    return html`
      <aside class="tools">
        ${TOOLS.map(
          (t) => html`<button
            aria-pressed=${this.tool === t.id}
            title=${t.label}
            @click=${() => this.setTool(t.id)}
          >${t.label}<kbd>${t.key}</kbd></button>`,
        )}
        <hr />
        <button ?disabled=${!history?.canUndo} @click=${() => this.undo()}>
          Annuler<kbd>⌃Z</kbd>
        </button>
        <button ?disabled=${!history?.canRedo} @click=${() => this.redo()}>
          Refaire<kbd>⌃Y</kbd>
        </button>
        <hr />
        <button @click=${() => this.scene?.frame()}>Tout cadrer</button>
        <button aria-pressed=${this.showGrid} @click=${this.toggleGrid}>Grille</button>
      </aside>
    `;
  }

  private undo(): void {
    this.editor?.history.undo();
    this.changed();
  }

  private redo(): void {
    this.editor?.history.redo();
    this.changed();
  }

  private renderSide(): TemplateResult {
    return html`
      <aside class="side">
        ${this.renderInspector()} ${this.renderLevels()} ${this.renderCameras()}
        ${this.renderViewCard()} ${this.renderCardOptions()} ${this.renderChecks()}
      </aside>
    `;
  }

  // ---- inspector ----------------------------------------------------------

  private numberRow(
    label: string,
    value: number | undefined,
    field: string,
    step = 0.05,
  ): TemplateResult {
    return html`
      <div class="row">
        <label>${label}</label>
        <input
          type="number"
          step=${step}
          .value=${String(round2(value ?? 0))}
          @change=${(e: Event) => {
            const n = parseFloat((e.target as HTMLInputElement).value.replace(',', '.'));
            if (isFinite(n)) this.set(field, n);
          }}
        />
      </div>
    `;
  }

  private renderInspector(): TemplateResult {
    void this.revision;
    const sel = this.editor?.selection;
    if (!sel) {
      return html`
        <section class="card">
          <h2>Inspecteur</h2>
          <p class="note">
            Rien de sélectionné. Prenez l’outil Sélection et cliquez un mur, une
            ouverture, une pièce ou une caméra pour en régler les cotes au clavier.
          </p>
        </section>
      `;
    }
    if (sel.kind === 'wall') return this.renderWall(sel.id);
    if (sel.kind === 'opening') return this.renderOpening(sel.id, sel.wallId);
    if (sel.kind === 'camera') return this.renderCamera(sel.id);
    return this.renderRoom(sel.id);
  }

  private renderWall(id: string): TemplateResult {
    const wall = findWall(this.config.levels, id);
    if (!wall) return html`<section class="card"><h2>Mur</h2></section>`;
    return html`
      <section class="card">
        <h2>Mur · ${formatMetres(dist(wall.a, wall.b))}</h2>
        ${this.numberRow('Longueur (m)', dist(wall.a, wall.b), 'length')}
        ${this.numberRow('Épaisseur (m)', wall.thickness ?? 0.2, 'thickness', 0.01)}
        ${this.numberRow('Hauteur (m)', wall.height ?? this.level.wallHeight ?? 2.5, 'height')}
        <div class="chips">
          <button
            aria-pressed=${!!wall.transparent}
            title="Dessiné, mais la vue passe au travers : une verrière, un garde-corps."
            @click=${() => this.set('transparent', 1)}
          >Vitré</button>
          <button class="danger" @click=${() => this.deleteSelection()}>Supprimer</button>
        </div>
      </section>
    `;
  }

  private renderOpening(id: string, wallId?: string): TemplateResult {
    const wall = wallId ? findWall(this.config.levels, wallId) : undefined;
    const opening = wall?.openings?.find((o) => o.id === id);
    if (!opening) return html`<section class="card"><h2>Ouverture</h2></section>`;
    const kinds = [
      ['door', 'Porte'],
      ['window', 'Fenêtre'],
      ['pass', 'Passage'],
    ] as const;
    return html`
      <section class="card">
        <h2>Ouverture</h2>
        <div class="chips">
          ${kinds.map(
            ([k, label]) => html`<button
              aria-pressed=${opening.kind === k}
              @click=${() => this.set('kind', k)}
            >${label}</button>`,
          )}
        </div>
        ${this.numberRow('Largeur (m)', opening.width, 'width')}
        ${this.numberRow('Allège (m)', opening.sill ?? 0, 'sill')}
        ${this.numberRow('Linteau (m)', opening.head ?? 2.1, 'head')}
        <div class="chips">
          <button
            aria-pressed=${!!opening.blocksSight}
            title="Par défaut on voit à travers une ouverture. Cochez pour un vantail plein ou un verre dépoli."
            @click=${() => this.set('blocksSight', 1)}
          >Opaque</button>
          <button class="danger" @click=${() => this.deleteSelection()}>Supprimer</button>
        </div>
      </section>
    `;
  }

  private renderRoom(id: string): TemplateResult {
    const room = this.config.levels.flatMap((l) => l.rooms ?? []).find((r) => r.id === id);
    if (!room) return html`<section class="card"><h2>Pièce</h2></section>`;
    return html`
      <section class="card">
        <h2>Pièce · ${formatArea(area(room.ring))}</h2>
        <div class="row wide">
          <label>Nom</label>
          <input
            type="text"
            .value=${room.name}
            @change=${(e: Event) => this.editor?.rename((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="chips">
          <button
            title="Pose un mur sur chaque côté du contour, sans doublon."
            @click=${() => this.editor?.wallsAroundRoom(room.id)}
          >Murs autour</button>
          <button class="danger" @click=${() => this.deleteSelection()}>Supprimer</button>
        </div>
      </section>
    `;
  }

  private renderCamera(name: string): TemplateResult {
    const cam = this.config.cameras.find((c) => c.name === name);
    if (!cam) return html`<section class="card"><h2>Caméra</h2></section>`;
    const rt = this.scene?.runtime(cam.name);
    const coverage = rt?.isovist.length
      ? Math.round(isovistCoverage(rt.isovist, cam.range, cam.fov) * 100)
      : null;
    const [w, h] = cam.resolution ?? [1920, 1080];

    return html`
      <section class="card">
        <h2>Caméra</h2>
        <div class="row wide">
          <label>Nom Frigate — celui de « frigate/&lt;nom&gt;/… »</label>
          <input
            type="text"
            .value=${cam.name}
            @change=${(e: Event) => this.renameCamera(cam, (e.target as HTMLInputElement))}
          />
        </div>
        <div class="row wide">
          <label>Libellé affiché</label>
          <input
            type="text"
            .value=${cam.label ?? ''}
            @change=${(e: Event) => this.editor?.rename((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="row wide">
          <label>Entité Home Assistant (vide = camera.${cam.name})</label>
          <input
            type="text"
            placeholder=${`camera.${cam.name}`}
            .value=${cam.entity ?? ''}
            @change=${(e: Event) => this.set('entity', (e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="row">
          <label>Niveau</label>
          <select
            @change=${(e: Event) => this.set('level', (e.target as HTMLSelectElement).value)}
          >
            ${this.config.levels.map(
              (l) => html`<option value=${l.id} ?selected=${(cam.level ?? this.config.levels[0].id) === l.id}>
                ${l.name}
              </option>`,
            )}
          </select>
        </div>
        ${this.numberRow('Cap (°)', cam.azimuth, 'azimuth', 1)}
        ${this.numberRow('Ouverture (°)', cam.fov, 'fov', 1)}
        ${this.numberRow('Portée (m)', cam.range, 'range', 0.5)}
        ${this.numberRow('Hauteur de pose (m)', cam.height ?? 2.6, 'height', 0.1)}
        <div class="row wide">
          <label>Définition du flux (largeur × hauteur, px)</label>
          <span class="pair">
            <input
              type="number"
              step="1"
              .value=${String(w)}
              @change=${(e: Event) => this.set('width', +(e.target as HTMLInputElement).value)}
            />
            <input
              type="number"
              step="1"
              .value=${String(h)}
              @change=${(e: Event) => this.set('height-px', +(e.target as HTMLInputElement).value)}
            />
          </span>
        </div>
        <p class="note">
          ${coverage === null
            ? nothing
            : html`Couverture réelle : <strong>${coverage} %</strong> du secteur théorique —
                le reste est derrière un mur.`}
        </p>
        ${this.problem ? html`<p class="problem">${this.problem}</p>` : nothing}
        <div class="chips">
          <button class="danger" @click=${() => this.deleteSelection()}>Supprimer</button>
        </div>
      </section>
    `;
  }

  private renameCamera(cam: CameraConfig, input: HTMLInputElement): void {
    const next = input.value.trim();
    if (next === cam.name) return;
    if (this.config.cameras.some((c) => c !== cam && c.name === next)) {
      this.problem = `Une autre caméra s'appelle déjà « ${next} ».`;
      input.value = cam.name;
      this.requestUpdate();
      return;
    }
    this.problem = '';
    this.set('name', next);
  }

  private deleteSelection(): void {
    this.editor?.deleteSelection();
  }

  // ---- panels -------------------------------------------------------------

  private renderLevels(): TemplateResult {
    void this.revision;
    const level = this.level;
    return html`
      <section class="card">
        <h2>Niveaux</h2>
        <div class="list">
          ${repeat(
            this.config.levels,
            (l) => l.id,
            (l) => html`
              <div class="entry">
                <button aria-pressed=${l.id === this.activeLevel} @click=${() => this.selectLevel(l.id)}>
                  ${l.name}
                </button>
                <small>${l.elevation} m</small>
              </div>
            `,
          )}
        </div>
        <div class="row wide" style="margin-top:8px">
          <label>Nom du niveau actif</label>
          <input
            type="text"
            .value=${level.name}
            @change=${(e: Event) => this.editLevel('name', (e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="row">
          <label>Altitude du sol (m)</label>
          <input
            type="number"
            step="0.1"
            .value=${String(level.elevation)}
            @change=${(e: Event) => this.editLevel('elevation', +(e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="row">
          <label>Hauteur sous plafond (m)</label>
          <input
            type="number"
            step="0.05"
            .value=${String(level.wallHeight ?? 2.5)}
            @change=${(e: Event) => this.editLevel('wallHeight', +(e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="chips">
          <button @click=${this.addLevel}>Ajouter</button>
          <button @click=${this.duplicateLevel}>Dupliquer</button>
          <button
            class="danger"
            ?disabled=${this.config.levels.length < 2}
            @click=${this.deleteLevel}
          >Supprimer</button>
        </div>
      </section>
    `;
  }

  private renderCameras(): TemplateResult {
    void this.revision;
    const selected = this.editor?.selection;
    return html`
      <section class="card">
        <h2>Caméras · ${this.config.cameras.length}</h2>
        ${this.config.cameras.length
          ? html`<div class="list">
              ${repeat(
                this.config.cameras,
                (c) => c.name,
                (c) => html`
                  <div class="entry">
                    <button
                      aria-pressed=${selected?.kind === 'camera' && selected.id === c.name}
                      @click=${() => this.selectCamera(c.name)}
                    >${c.label ?? c.name}</button>
                    <small>${Math.round(c.fov)}° · ${c.range} m</small>
                  </div>
                `,
              )}
            </div>`
          : html`<p class="note">
              Aucune caméra. Outil <strong>Caméra</strong> (C), puis cliquez son emplacement
              sur le plan.
            </p>`}
      </section>
    `;
  }

  private renderViewCard(): TemplateResult {
    const view = this.scene?.view;
    const active = view ? presetOf(view.yaw, view.pitch) : undefined;
    const grid = this.config.grid ?? 0.5;
    return html`
      <section class="card">
        <h2>Vue et grille</h2>
        <div class="chips">
          ${VIEW_PRESETS.map(
            (p) => html`<button
              aria-pressed=${active?.id === p.id}
              title="${p.pitch}° d’inclinaison, ${p.yaw}° de lacet"
              @click=${() => this.applyPreset(p)}
            >${p.label}</button>`,
          )}
          ${this.config.levels.length > 1
            ? html`<button
                aria-pressed=${this.exploded}
                title="Écarte les niveaux pour les voir tous à la fois. Seul le niveau actif reste modifiable."
                @click=${this.toggleExplode}
              >Séparer</button>`
            : nothing}
        </div>
        <div class="row" style="margin-top:8px">
          <label>Pas de la grille</label>
          <input
            type="number"
            step="0.05"
            min="0.05"
            .value=${String(grid)}
            @change=${(e: Event) => this.setGrid(+(e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="chips">
          ${GRID_PRESETS.map(
            (g) => html`<button aria-pressed=${grid === g} @click=${() => this.setGrid(g)}>
              ${g < 1 ? `${g * 100} cm` : '1 m'}
            </button>`,
          )}
        </div>
        <div class="chips" style="margin-top:8px">
          <button @click=${this.rememberView}>Mémoriser cette vue</button>
          <button ?disabled=${!this.config.view} @click=${this.forgetView}>Oublier</button>
        </div>
        <p class="note">
          ${!this.config.view
            ? 'Sans vue mémorisée, la carte cadre le bâtiment toute seule et s’ouvre en 2.5D.'
            : (this.config.view.pitch ?? 45) < 10
              ? 'Vue mémorisée à plat : la carte s’ouvrira en plan, sans relief. Passez en 2.5D avant de mémoriser si ce n’est pas ce que vous voulez.'
              : 'La carte s’ouvrira sur cette orientation dans Home Assistant.'}
        </p>
      </section>
    `;
  }

  private option(
    label: string,
    key: keyof SemaphoreConfig,
    placeholder: string,
    type: 'text' | 'number' = 'text',
    step = 1,
  ): TemplateResult {
    const value = this.config[key];
    return html`
      <div class="row wide">
        <label>${label}</label>
        <input
          type=${type}
          step=${step}
          placeholder=${placeholder}
          .value=${value === undefined || value === null ? '' : String(value)}
          @change=${(e: Event) => this.setOption(key, (e.target as HTMLInputElement).value, type)}
        />
      </div>
    `;
  }

  private setOption(key: keyof SemaphoreConfig, raw: string, type: 'text' | 'number'): void {
    const text = raw.trim();
    const next = { ...this.config } as Record<string, unknown>;
    // An emptied field means "use the default", not "set it to zero".
    if (!text) delete next[key];
    else if (type === 'number') {
      const n = parseFloat(text.replace(',', '.'));
      if (!isFinite(n)) return;
      next[key] = n;
    } else next[key] = text;
    this.config = next as unknown as SemaphoreConfig;
    this.queueSave();
    this.requestUpdate();
  }

  private renderCardOptions(): TemplateResult {
    const labels = (this.config['alert-labels'] ?? []).join(', ');
    const format = this.config['box-format'] ?? 'auto';
    return html`
      <section class="card">
        <h2>Options de la carte</h2>
        ${this.option('Préfixe des topics MQTT', 'topic-prefix', 'frigate')}
        ${this.option('Identifiant d’instance Frigate', 'instance-id', 'aucun')}
        ${this.option('Fenêtre de la timeline (h)', 'timeline-hours', '24', 'number')}
        ${this.option('Décroissance d’un secteur (s)', 'decay-seconds', '12', 'number')}
        ${this.option('Orbite au repos (°/s)', 'orbit-speed', '0', 'number', 0.5)}
        ${this.option('Finesse de l’isovist (°)', 'fov-resolution', '1.5', 'number', 0.5)}
        <div class="row wide">
          <label>Étiquettes qui déclenchent une alerte</label>
          <input
            type="text"
            placeholder="person, car"
            .value=${labels}
            @change=${(e: Event) => this.setAlertLabels((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="row">
          <label>Format des box Frigate</label>
          <select @change=${(e: Event) => this.setBoxFormat((e.target as HTMLSelectElement).value)}>
            ${(['auto', 'xyxy', 'xywh'] as const).map(
              (f) => html`<option value=${f} ?selected=${format === f}>${f}</option>`,
            )}
          </select>
        </div>
        <p class="note">
          Laissez « auto » tant qu’un vrai payload n’a pas été observé. Le symptôme
          d’un mauvais choix est une détection très loin de sa caméra.
        </p>
      </section>
    `;
  }

  private setAlertLabels(raw: string): void {
    const labels = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const next = { ...this.config } as Record<string, unknown>;
    if (labels.length) next['alert-labels'] = labels;
    else delete next['alert-labels'];
    this.config = next as unknown as SemaphoreConfig;
    this.queueSave();
    this.requestUpdate();
  }

  private setBoxFormat(value: string): void {
    this.config = { ...this.config, 'box-format': value as SemaphoreConfig['box-format'] };
    this.queueSave();
    this.requestUpdate();
  }

  private renderChecks(): TemplateResult {
    return html`
      <section class="card">
        <h2>Contrôles</h2>
        <ul class="checks">
          ${this.checks.length
            ? this.checks.map((c: Check) => html`<li class=${c.level}>${c.text}</li>`)
            : html`<li class="pass">Rien à signaler : la config passera la validation de la carte.</li>`}
        </ul>
      </section>
    `;
  }

  private renderStatus(): TemplateResult {
    return html`
      <footer class="status">
        <span class="readout">—</span>
        <span class="keys">
          Molette : zoom · clic droit glissé : pivoter et incliner · Alt ou clic
          milieu : déplacer · Maj : libérer l’accrochage
        </span>
      </footer>
    `;
  }

  // ---- dialogs ------------------------------------------------------------

  private renderDialog(): TemplateResult | typeof nothing {
    if (this.dialog === 'import') return this.renderImport();
    if (this.dialog === 'export') return this.renderExport();
    return nothing;
  }

  private close(): void {
    this.dialog = null;
    this.problem = '';
  }

  private renderImport(): TemplateResult {
    return html`
      <div class="veil" @click=${(e: Event) => e.target === e.currentTarget && this.close()}>
        <div class="dialog">
          <header>
            <h2>Importer un YAML</h2>
            <div class="spacer"></div>
            <button @click=${this.close}>Fermer</button>
          </header>
          <p class="note">
            Collez la configuration de votre carte Sémaphore telle qu’elle est dans
            Home Assistant, ou déposez un fichier <code>.yaml</code> n’importe où sur
            cette page. Le plan en cours sera remplacé.
          </p>
          <textarea
            .value=${this.importText}
            spellcheck="false"
            placeholder="type: custom:semaphore-card&#10;levels:&#10;  - id: rdc&#10;    …"
            @input=${(e: Event) => { this.importText = (e.target as HTMLTextAreaElement).value; }}
          ></textarea>
          ${this.problem ? html`<p class="problem">${this.problem}</p>` : nothing}
          <div class="actions">
            <input
              type="file"
              accept=".yaml,.yml,.txt"
              @change=${(e: Event) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) void this.readFile(file);
              }}
            />
            <div class="spacer"></div>
            <button class="primary" ?disabled=${!this.importText.trim()} @click=${this.applyImport}>
              Charger ce plan
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderExport(): TemplateResult {
    const yaml = this.yaml;
    const blocking = this.checks.filter((c) => c.level === 'error');
    return html`
      <div class="veil" @click=${(e: Event) => e.target === e.currentTarget && this.close()}>
        <div class="dialog">
          <header>
            <h2>Configuration de la carte</h2>
            <div class="spacer"></div>
            <button @click=${this.close}>Fermer</button>
          </header>
          <p class="note">
            Dans Home Assistant : <strong>Modifier le tableau de bord</strong> →
            <strong>Ajouter une carte</strong> → <strong>Manuel</strong>, puis
            remplacez tout le contenu par ce bloc.
          </p>
          <textarea readonly spellcheck="false" .value=${yaml}></textarea>
          ${blocking.length
            ? html`<p class="problem">${blocking.map((c) => c.text).join(' ')}</p>`
            : nothing}
          <div class="actions">
            <button class="primary" @click=${this.copyYaml}>
              ${this.copied ? 'Copié' : 'Copier'}
            </button>
            <button @click=${this.downloadYaml}>Télécharger .yaml</button>
            <div class="spacer"></div>
            <span class="saved">${yaml.split('\n').length} lignes</span>
          </div>
        </div>
      </div>
    `;
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function uniqueId(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

declare global {
  interface HTMLElementTagNameMap {
    'semaphore-studio': SemaphoreStudio;
  }
}
