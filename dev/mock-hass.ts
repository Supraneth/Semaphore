/**
 * A Home Assistant just large enough to run the real card.
 *
 * It implements the three things Sémaphore actually touches — `states`,
 * `connection.subscribeMessage` and `callWS` — and nothing else. The value of
 * the bench is that the card is not modified or wrapped in any way: what runs
 * here is the same class the dashboard loads, so a bug seen here is a real bug.
 */

export interface MockCamera {
  name: string;
  /**
   * Where the object's feet are, in normalised image coordinates. Keep the
   * path inside the camera's calibrated quad — extrapolating a homography
   * towards the horizon is mathematically fine and visually nonsense.
   */
  path: Array<[number, number]>;
}

export interface MockOptions {
  cameras: MockCamera[];
  resolution?: [number, number];
  topic?: string;
  /** Door and window sensors the plan's openings point at. */
  openings?: string[];
}

const LABELS = ['person', 'car', 'dog'];
/** One update per tracked frame is what Frigate does; 400 ms is a calm stand-in. */
const STEP_MS = 400;
const GAP_MS = 3200;

type Subscriber = (message: unknown) => void;

let sequence = 0;

export function createMockHass(options: MockOptions): any {
  const topic = options.topic ?? 'frigate/events';
  const [rw, rh] = options.resolution ?? [1280, 720];
  const subscribers = new Set<Subscriber>();

  const publish = (event: unknown): void => {
    const message = { topic, payload: JSON.stringify(event), qos: 0, retain: false };
    for (const fn of subscribers) fn(message);
  };

  /**
   * Walks one object along a camera's path and publishes the
   * new → update… → end sequence Frigate emits, with the same event id
   * throughout so the card's trail logic is genuinely exercised.
   */
  const runTrack = (camera: MockCamera, label: string): void => {
    const id = `mock-${++sequence}`;
    const startTime = Date.now() / 1000;
    let step = 0;

    const box = (feet: [number, number]): number[] => {
      // Farther up the frame means farther away, so the object is smaller.
      const scale = 0.35 + feet[1] * 0.65;
      const w = 90 * scale;
      const h = 190 * scale;
      const [u, v] = feet;
      return [u * rw - w / 2, v * rh - h, u * rw + w / 2, v * rh];
    };

    const body = (type: 'new' | 'update' | 'end') => ({
      id,
      camera: camera.name,
      label,
      score: 0.72 + Math.random() * 0.2,
      top_score: 0.86,
      start_time: startTime,
      end_time: type === 'end' ? Date.now() / 1000 : null,
      box: box(camera.path[Math.min(step, camera.path.length - 1)]),
      has_clip: true,
      has_snapshot: true,
    });

    publish({ type: 'new', before: null, after: body('new') });

    const timer = setInterval(() => {
      step++;
      if (step >= camera.path.length) {
        clearInterval(timer);
        publish({ type: 'end', before: body('update'), after: body('end') });
        setTimeout(
          () => runTrack(camera, LABELS[Math.floor(Math.random() * LABELS.length)]),
          GAP_MS + Math.random() * GAP_MS,
        );
        return;
      }
      publish({ type: 'update', before: body('update'), after: body('update') });
    }, STEP_MS);
  };

  const states: Record<string, unknown> = {};
  options.cameras.forEach((camera, i) => {
    states[`camera.${camera.name}`] = {
      entity_id: `camera.${camera.name}`,
      // One camera off air, so the offline state is visible without waiting.
      state: i === options.cameras.length - 1 ? 'unavailable' : 'streaming',
      attributes: {
        friendly_name: camera.name,
        entity_picture: `https://placehold.co/160x100/0C2233/EFE7D4?text=${encodeURIComponent(
          camera.name,
        )}`,
      },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    };
  });

  /**
   * Doors and windows that open and shut on their own.
   *
   * Home Assistant replaces the whole `states` object on every update and the
   * card re-reads it on its own tick, so mutating in place is the honest stand-in
   * for what a real install does — and it exercises the isovist rebuild that a
   * solid door swinging open triggers.
   */
  for (const entity of options.openings ?? []) {
    states[entity] = {
      entity_id: entity,
      state: 'off',
      attributes: { device_class: entity.includes('porte') ? 'door' : 'window' },
    };
    const toggle = (): void => {
      const current = states[entity] as { state: string };
      states[entity] = { ...current, state: current.state === 'on' ? 'off' : 'on' };
      setTimeout(toggle, 6000 + Math.random() * 9000);
    };
    setTimeout(toggle, 3000 + Math.random() * 6000);
  }

  return {
    states,
    themes: { darkMode: true },
    locale: { language: 'fr' },
    connection: {
      async subscribeMessage(callback: Subscriber, message: any) {
        if (message?.type !== 'mqtt/subscribe' || message.topic !== topic) {
          return () => undefined;
        }
        subscribers.add(callback);
        options.cameras.forEach((camera, i) => {
          if (!camera.path.length) return;
          setTimeout(
            () => runTrack(camera, LABELS[i % LABELS.length]),
            600 + i * 1400,
          );
        });
        return () => subscribers.delete(callback);
      },
    },
    /**
     * Frigate's websocket command does not exist here, which is the point:
     * rejecting exercises the card's fall-back to its own local buffer, the
     * path a real install will also take if the command turns out not to be
     * real. See the open question in CLAUDE.md.
     */
    async callWS(): Promise<never> {
      throw new Error('unknown_command');
    },
    callService: async () => undefined,
  };
}

/** Lovelace's card shell. Outside HA it is a rounded surface and nothing more. */
export function registerCardStub(): void {
  if (customElements.get('ha-card')) return;
  customElements.define(
    'ha-card',
    class extends HTMLElement {
      connectedCallback(): void {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `
          <style>
            :host {
              display: block;
              border-radius: var(--ha-card-border-radius, 12px);
              background: var(--card-background-color, #10171d);
              color: var(--primary-text-color, #EFE7D4);
              box-shadow: 0 2px 14px rgba(0, 0, 0, 0.4);
              overflow: hidden;
            }
          </style>
          <slot></slot>`;
      }
    },
  );
}

/**
 * `ha-camera-stream` needs HA's auth and stream proxy, so the bench shows the
 * same snapshot the chip uses. This is the one thing the bench genuinely
 * cannot reproduce.
 */
export function registerStreamStub(): void {
  if (customElements.get('ha-camera-stream')) return;
  customElements.define(
    'ha-camera-stream',
    class extends HTMLElement {
      set stateObj(value: any) {
        const picture = value?.attributes?.entity_picture;
        this.innerHTML = picture
          ? `<img src="${picture}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" />`
          : '';
      }
      set hass(_value: unknown) {
        /* the real element needs it; the stub does not */
      }
    },
  );
}
