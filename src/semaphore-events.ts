import { LitElement, html, css, nothing, svg, unsafeCSS, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { CameraConfig } from './types';
import { CHART, labelCss, labelName, withAlpha } from './theme';
import { chrome, glassEdge, glassEdgeLit } from './chrome-css';
import { PEOPLE, VEHICLES, filterGroups, type EventGroup } from './events';
import { agoLabel, clockLabel, dayLabel, durationLabel } from './format';

/**
 * The feed.
 *
 * A timeline of coloured marks answers *when*. It never answers what the thing
 * looked like, which is the only question anyone actually has, and it is why
 * every camera product people keep using is a list of pictures newest-first.
 * Frigate has published `has_snapshot` on every event since forever; the card
 * stored the flag and never once asked for the picture.
 *
 * Separate element rather than more markup in the card: it has its own filters,
 * its own scroll position and its own selection, none of which the plan cares
 * about, and this is the shape that lets it become a card of its own later
 * without a second implementation.
 */

const ICON = {
  clip: svg`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="14" height="12" rx="2.5"/><path d="m16.5 13 5 3V8l-5 3z"/></svg>`,
  check: svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg>`,
} as const;

@customElement('semaphore-events')
export class SemaphoreEvents extends LitElement {
  @property({ attribute: false }) groups: EventGroup[] = [];
  @property({ attribute: false }) cameras: CameraConfig[] = [];
  /** Builds a thumbnail URL for an event id, or nothing if there is no route. */
  @property({ attribute: false }) thumb?: (id: string) => string | undefined;
  @property({ attribute: false }) selected: string | null = null;
  @property({ attribute: false }) seen: ReadonlySet<string> = new Set();
  @property({ attribute: false }) now = Date.now();
  /** How far back the feed claims to reach, for the empty state. */
  @property({ attribute: false }) hours = 24;

  @state() private labels: ReadonlySet<string> = new Set();
  @state() private camera: string | null = null;
  /** Event ids whose picture failed to load; asking again just fails again. */
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

      .wrap {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
      }

      /* ---- filters ------------------------------------------------------ */

      .filters {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px;
        flex: none;
        border-bottom: 1px solid ${glassEdge};
        overflow-x: auto;
        scrollbar-width: none;
      }
      .filters::-webkit-scrollbar {
        display: none;
      }

      select {
        font: inherit;
        font-size: 12px;
        color: var(--semaphore-parchment);
        background: ${unsafeCSS(withAlpha(CHART.ink, 0.72))};
        border: 1px solid ${glassEdge};
        border-radius: 999px;
        padding: 6px 10px;
        max-width: 42%;
        cursor: pointer;
      }
      select:focus-visible {
        outline: 2px solid ${unsafeCSS(CHART.sectorWhite)};
        outline-offset: 2px;
      }

      .spacer {
        flex: 1;
      }

      /* ---- list --------------------------------------------------------- */

      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 4px 0 10px;
      }

      .day {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 8px 12px 5px;
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: ${unsafeCSS(CHART.slateText)};
        background: var(--semaphore-ink);
      }

      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 12px;
        font: inherit;
        text-align: left;
        color: inherit;
        background: transparent;
        border: none;
        border-left: 3px solid transparent;
        cursor: pointer;
        transition: background 180ms ease;
      }
      .row:hover {
        background: ${glassEdge};
      }
      .row[aria-current='true'] {
        background: ${glassEdgeLit};
        border-left-color: currentColor;
      }
      .row:focus-visible {
        outline: 2px solid ${unsafeCSS(CHART.sectorWhite)};
        outline-offset: -2px;
      }

      /* 16:9 at 64 px wide. A picture is the whole reason the row exists, so it
         keeps its aspect rather than being squeezed into a square. */
      .shot {
        position: relative;
        flex: none;
        width: 64px;
        height: 36px;
        border-radius: 4px;
        overflow: hidden;
        background: ${unsafeCSS(withAlpha(CHART.slate, 0.28))};
        display: grid;
        place-items: center;
      }
      .shot img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      /* No picture: the label's own colour, so the row still reads as a kind of
         thing at a glance rather than as a grey hole. */
      .shot .none {
        width: 12px;
        height: 12px;
        border-radius: 3px;
      }

      .body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .headline {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .headline .what {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .count {
        flex: none;
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid currentColor;
      }
      .sub {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: ${unsafeCSS(CHART.slateText)};
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .sub .dot::before {
        content: '·';
        margin: 0 1px;
      }

      /* Not yet opened. The one piece of state a feed has to carry, or it turns
         back into a wall of everything that ever happened. */
      .unseen {
        flex: none;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: currentColor;
        align-self: center;
      }
      .row .live {
        animation: pulse 1.6s ease infinite;
      }
      .clip {
        flex: none;
        width: 14px;
        height: 14px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.6;
        opacity: 0.55;
      }

      .empty {
        padding: 28px 18px;
        text-align: center;
        font-size: 13px;
        line-height: 1.55;
        color: ${unsafeCSS(CHART.slateText)};
      }
    `,
  ];

  private get shown(): EventGroup[] {
    return filterGroups(this.groups, { labels: this.labels, camera: this.camera });
  }

  private setLabels(next: ReadonlySet<string>): void {
    // Tapping the active filter clears it — a filter you cannot turn off with
    // the control that turned it on is a trap.
    this.labels = sameSet(this.labels, next) ? new Set() : next;
  }

  private pick(group: EventGroup): void {
    this.dispatchEvent(
      new CustomEvent('event-select', { detail: group, bubbles: true, composed: true }),
    );
  }

  private markAllSeen(): void {
    this.dispatchEvent(
      new CustomEvent('events-seen', {
        detail: this.shown.map((g) => g.id),
        bubbles: true,
        composed: true,
      }),
    );
  }

  private failed(id: string): void {
    if (this.broken.has(id)) return;
    this.broken = new Set(this.broken).add(id);
  }

  override render(): TemplateResult {
    const shown = this.shown;
    const unseen = shown.filter((g) => !this.seen.has(g.id)).length;

    return html`
      <div class="wrap">
        <div class="filters">
          <div class="segmented" role="group" aria-label="Filtrer par type">
            <button
              aria-pressed=${sameSet(this.labels, PEOPLE)}
              @click=${() => this.setLabels(PEOPLE)}
            >Personnes</button>
            <button
              aria-pressed=${sameSet(this.labels, VEHICLES)}
              @click=${() => this.setLabels(VEHICLES)}
            >Véhicules</button>
          </div>

          ${this.cameras.length > 1
            ? html`<select
                aria-label="Filtrer par caméra"
                @change=${(ev: Event) => {
                  const value = (ev.target as HTMLSelectElement).value;
                  this.camera = value || null;
                }}
              >
                <option value="">Toutes les caméras</option>
                ${this.cameras.map(
                  (c) => html`<option value=${c.name} ?selected=${this.camera === c.name}>
                    ${c.label ?? c.name}
                  </option>`,
                )}
              </select>`
            : nothing}

          <span class="spacer"></span>

          ${unseen
            ? html`<button
                class="icon"
                title="Tout marquer comme vu"
                aria-label="Tout marquer comme vu"
                @click=${this.markAllSeen}
              >${ICON.check}</button>`
            : nothing}
        </div>

        <div class="list" role="feed" aria-label="Événements">
          ${shown.length ? this.renderRows(shown) : this.renderEmpty()}
        </div>
      </div>
    `;
  }

  private renderEmpty(): TemplateResult {
    const filtered = this.labels.size || this.camera;
    return html`<p class="empty">
      ${filtered
        ? "Rien ne correspond à ce filtre sur la période affichée."
        : `Aucun événement sur les ${this.hours} dernières heures.`}
    </p>`;
  }

  private renderRows(shown: EventGroup[]): TemplateResult {
    // Day headings are computed here rather than by grouping the list again:
    // the list is already in order, so a heading is simply a change of day.
    let previous = '';
    const rows: TemplateResult[] = [];
    for (const group of shown) {
      const day = dayLabel(group.start, this.now);
      if (day !== previous) {
        previous = day;
        rows.push(html`<p class="day">${day}</p>`);
      }
      rows.push(this.renderRow(group));
    }
    return html`${repeat(rows, (_, i) => i, (row) => row)}`;
  }

  private renderRow(group: EventGroup): TemplateResult {
    const colour = labelCss(group.label);
    const cam = this.cameras.find((c) => c.name === group.camera);
    const where = cam?.label ?? cam?.name ?? group.camera;
    const url = this.broken.has(group.id) ? undefined : this.thumb?.(group.id);
    const unseen = !this.seen.has(group.id);
    const span = group.end === undefined ? undefined : group.end - group.start;

    return html`
      <button
        class="row"
        style="color:${colour}"
        aria-current=${this.selected === group.id}
        @click=${() => this.pick(group)}
      >
        <span class="shot">
          ${url
            ? html`<img
                src=${url}
                alt=""
                loading="lazy"
                decoding="async"
                @error=${() => this.failed(group.id)}
              />`
            : html`<i class="none" style="background:${colour}"></i>`}
        </span>

        <span class="body">
          <span class="headline">
            <span class="what" style="color:var(--semaphore-parchment)"
              >${labelName(group.label)}</span
            >
            ${group.count > 1 ? html`<span class="count">×${group.count}</span>` : nothing}
            ${group.hasClip ? html`<svg class="clip" viewBox="0 0 24 24">${ICON.clip}</svg>` : nothing}
          </span>
          <span class="sub">
            <span>${where}</span>
            <span class="dot"></span>
            <span>${group.live ? 'en cours' : agoLabel(group.start, this.now)}</span>
            <span class="dot"></span>
            <span>${clockLabel(group.start)}</span>
            ${span !== undefined
              ? html`<span class="dot"></span><span>${durationLabel(span)}</span>`
              : nothing}
          </span>
        </span>

        ${group.live
          ? html`<span class="unseen live"></span>`
          : unseen
            ? html`<span class="unseen"></span>`
            : nothing}
      </button>
    `;
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

declare global {
  interface HTMLElementTagNameMap {
    'semaphore-events': SemaphoreEvents;
  }
}
