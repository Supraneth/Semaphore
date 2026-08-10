import { LitElement, html, css, unsafeCSS, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { CameraConfig, CameraState } from './types';
import { CHART, STATE_STYLES, withAlpha } from './theme';
import { chrome, glassEdge } from './chrome-css';

/**
 * The video wall.
 *
 * The default view of every surveillance system ever built, and Sémaphore had
 * no version of it: one stream, in a 340 px corner panel, reachable only by
 * hitting a chip on the plan. "Show me everything" was not a thing the card
 * could do.
 *
 * Tiles are still pictures until you ask for one. `ha-camera-stream` opens a
 * real connection per tile — six of those is six transcodes on whatever box
 * Home Assistant runs on, and a dashboard that melts a Raspberry Pi when a tab
 * opens is a dashboard people remove. The snapshot each tile shows is the one
 * the chips already poll, so the wall costs nothing until it is used.
 */

@customElement('semaphore-wall')
export class SemaphoreWall extends LitElement {
  @property({ attribute: false }) cameras: CameraConfig[] = [];
  @property({ attribute: false }) states = new Map<string, CameraState>();
  @property({ attribute: false }) hass: any;
  /** Still image for a camera, refreshed by the card's own nonce. */
  @property({ attribute: false }) preview?: (cam: CameraConfig) => string | undefined;
  @property({ attribute: false }) entityOf?: (cam: CameraConfig) => any;
  @property({ attribute: false }) stamp = 0;

  /** The one tile currently carrying a live stream, if any. */
  @state() private playing: string | null = null;
  @state() private broken = new Set<string>();

  static override styles = [
    chrome,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        background: var(--semaphore-ink);
        color: var(--semaphore-parchment);
      }

      .grid {
        display: grid;
        gap: 6px;
        padding: 6px;
        height: 100%;
        box-sizing: border-box;
        overflow-y: auto;
        /* Tiles size themselves to the container, so the same wall works in a
           panel view and in a masonry column without being told which. */
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
        /* Deliberately *not* stretched to fill the pane. A tile is a camera
           frame, and a 16:9 frame pulled into a portrait box is a cropped,
           misleading picture — the one thing a security view may not be. Rows
           take the height the aspect ratio asks for and the wall centres in
           whatever is left. */
        align-content: center;
      }

      .tile {
        position: relative;
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        padding: 0;
        border: 1px solid ${glassEdge};
        border-radius: 8px;
        overflow: hidden;
        background: ${unsafeCSS(withAlpha(CHART.slate, 0.22))};
        color: inherit;
        cursor: pointer;
      }
      .tile:focus-visible {
        outline: 2px solid ${unsafeCSS(CHART.sectorWhite)};
        outline-offset: 2px;
      }
      /* Something to report: the frame itself carries it, so a wall of six
         reads from across the room without anyone hunting for a dot. */
      .tile.alert,
      .tile.motion {
        border-color: currentColor;
        box-shadow: 0 0 0 1px currentColor;
      }
      .tile.offline {
        opacity: 0.55;
      }

      .tile img,
      .tile ha-camera-stream {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        background: #000;
      }

      .none {
        display: grid;
        place-items: center;
        height: 100%;
        font-size: 11px;
        color: ${unsafeCSS(CHART.slateText)};
      }

      .caption {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        font-size: 11px;
        letter-spacing: 0.02em;
        color: var(--semaphore-parchment);
        background: linear-gradient(transparent, ${unsafeCSS(withAlpha(CHART.ink, 0.85))});
      }
      .caption .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .caption .state {
        margin-left: auto;
        flex: none;
        opacity: 0.75;
      }
      .tile.alert .pip,
      .tile.motion .pip {
        animation: pulse 1.6s ease infinite;
      }

      .empty {
        padding: 28px 18px;
        text-align: center;
        font-size: 13px;
        color: ${unsafeCSS(CHART.slateText)};
      }
    `,
  ];

  private failed(name: string): void {
    if (this.broken.has(name)) return;
    this.broken = new Set(this.broken).add(name);
  }

  private toggle(cam: CameraConfig): void {
    // One live tile at a time. Clicking the playing one hands the stream back.
    this.playing = this.playing === cam.name ? null : cam.name;
  }

  override render(): TemplateResult {
    if (!this.cameras.length) {
      return html`<p class="empty">Aucune caméra dans cette configuration.</p>`;
    }
    return html`
      <div class="grid">
        ${repeat(this.cameras, (c) => c.name, (cam) => this.renderTile(cam))}
      </div>
    `;
  }

  private renderTile(cam: CameraConfig): TemplateResult {
    const state = this.states.get(cam.name) ?? 'nominal';
    const style = STATE_STYLES[state];
    const colour = state === 'nominal' && cam.color ? cam.color : style.css;
    const label = cam.label ?? cam.name;
    const live = this.playing === cam.name;
    const entity = live ? this.entityOf?.(cam) : undefined;
    const still = this.broken.has(cam.name) ? undefined : this.preview?.(cam);

    return html`
      <button
        class="tile ${state}"
        style="color:${colour}"
        title="${label} — ${live ? 'flux en direct' : style.caption}"
        aria-label="${label} — ${live ? 'flux en direct' : style.caption}"
        aria-pressed=${live}
        @click=${() => this.toggle(cam)}
      >
        ${live && entity
          ? html`<ha-camera-stream
              .hass=${this.hass}
              .stateObj=${entity}
              allow-exoplayer
              muted
            ></ha-camera-stream>`
          : still
            ? html`<img
                src="${still}&_=${this.stamp}"
                alt=""
                loading="lazy"
                decoding="async"
                @error=${() => this.failed(cam.name)}
              />`
            : html`<span class="none">Pas d'aperçu</span>`}
        <span class="caption">
          <span class="pip"></span>
          <span class="name">${label}</span>
          <span class="state">${live ? 'direct' : style.caption}</span>
        </span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'semaphore-wall': SemaphoreWall;
  }
}
