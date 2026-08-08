import type { CameraConfig, Detection, Point } from './types';
import { GroundProjector, groundPoint, type BoxFormat } from './homography';

/**
 * Everything that talks to Home Assistant.
 *
 * The card subscribes to `frigate/events` over MQTT rather than watching the
 * integration's binary sensors, because the sensors only say *that* something
 * happened. Only the MQTT payload carries the bounding box, and without a box
 * there is no ground position and no blip.
 */

export interface BridgeOptions {
  topicPrefix?: string;
  instanceId?: string;
  alertLabels?: string[];
  boxFormat?: BoxFormat;
  /** How long an ended track stays on the map, in ms. */
  retentionMs?: number;
}

const DEFAULT_ALERT_LABELS = ['person', 'car', 'truck', 'motorcycle'];
/** Longer trails cost buffer space and read as smears rather than paths. */
const MAX_TRAIL = 40;
/** Below this the object has not really moved and the sample is sensor noise. */
const MIN_TRAIL_STEP_M = 0.25;
const MAX_HISTORY = 2000;

interface FrigateEventBody {
  id?: string;
  camera?: string;
  label?: string;
  score?: number;
  top_score?: number;
  start_time?: number;
  end_time?: number | null;
  box?: number[];
  has_clip?: boolean;
  has_snapshot?: boolean;
}

interface FrigateEvent {
  type?: 'new' | 'update' | 'end';
  before?: FrigateEventBody;
  after?: FrigateEventBody;
}

/** Frigate timestamps are unix seconds, often fractional. */
const toMs = (seconds: number | null | undefined): number | undefined =>
  typeof seconds === 'number' && isFinite(seconds) ? seconds * 1000 : undefined;

export class FrigateBridge {
  private projectors = new Map<string, GroundProjector | null>();
  private live = new Map<string, Detection>();
  private history: Detection[] = [];
  private unsubscribe: (() => void) | null = null;
  /**
   * Bumped when a track appears or finishes — never on a position update.
   * The card polls this instead of rebuilding the timeline every tick, which
   * would mean re-rendering a few hundred DOM nodes ten times a second.
   */
  private version = 0;
  private cameraByName = new Map<string, CameraConfig>();
  private alertLabels: Set<string>;
  private retentionMs: number;

  constructor(
    private hass: any,
    cameras: CameraConfig[],
    private options: BridgeOptions = {},
  ) {
    this.alertLabels = new Set(options.alertLabels ?? DEFAULT_ALERT_LABELS);
    this.retentionMs = options.retentionMs ?? 30_000;
    this.setCameras(cameras);
  }

  setCameras(cameras: CameraConfig[]): void {
    this.cameraByName = new Map(cameras.map((c) => [c.name, c]));
    this.projectors.clear();
    for (const cam of cameras) {
      this.projectors.set(
        cam.name,
        cam.calibration ? new GroundProjector(cam.calibration) : null,
      );
    }
  }

  setHass(hass: any): void {
    this.hass = hass;
  }

  // ---- transport ----------------------------------------------------------

  private get topic(): string {
    return `${this.options.topicPrefix ?? 'frigate'}/events`;
  }

  /**
   * Subscribes to the events topic.
   *
   * Failure here is not fatal: without MQTT the card still draws the scene and
   * still reads camera availability from the entities, it just never lights a
   * sector. Throwing would replace a working map with an error message.
   */
  async connect(): Promise<void> {
    const connection = this.hass?.connection;
    if (!connection?.subscribeMessage) return;
    try {
      this.unsubscribe = await connection.subscribeMessage(
        (msg: any) => this.onMessage(msg),
        { type: 'mqtt/subscribe', topic: this.topic },
      );
    } catch {
      this.unsubscribe = null;
    }
  }

  disconnect(): void {
    try {
      this.unsubscribe?.();
    } catch {
      /* the socket may already be gone */
    }
    this.unsubscribe = null;
  }

  private onMessage(message: any): void {
    let event: FrigateEvent | null = null;
    try {
      const payload = message?.payload ?? message;
      event = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      return;
    }
    if (event) this.ingest(event);
  }

  /** Exposed so the dev harness can feed synthetic events through one door. */
  ingest(event: FrigateEvent): void {
    const body = event.after ?? event.before;
    if (!body?.id || !body.camera) return;
    const camera = this.cameraByName.get(body.camera);
    if (!camera) return;

    const now = Date.now();
    const id = body.id;
    let detection = this.live.get(id);

    if (!detection) {
      detection = {
        id,
        camera: body.camera,
        label: body.label ?? 'object',
        score: body.top_score ?? body.score ?? 0,
        startTime: toMs(body.start_time) ?? now,
        trail: [],
        ended: false,
        hasClip: body.has_clip,
        hasSnapshot: body.has_snapshot,
      };
      this.live.set(id, detection);
      this.history.push(detection);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.version++;
    }

    detection.label = body.label ?? detection.label;
    detection.score = Math.max(detection.score, body.top_score ?? body.score ?? 0);
    detection.hasClip = body.has_clip ?? detection.hasClip;
    detection.hasSnapshot = body.has_snapshot ?? detection.hasSnapshot;

    if (body.box) {
      const pos = groundPoint(
        camera,
        body.box,
        this.projectors.get(camera.name) ?? null,
        this.options.boxFormat ?? 'auto',
      );
      if (pos) this.pushTrail(detection, pos, now);
    }

    if ((event.type === 'end' || body.end_time) && !detection.ended) {
      detection.ended = true;
      detection.endTime = toMs(body.end_time) ?? now;
      this.version++;
    }
  }

  /**
   * A track only gains a point when it actually moved. Frigate publishes an
   * update per tracked frame; a stationary car would otherwise pile forty
   * identical samples onto the same pixel and push the real path out of the
   * trail window.
   */
  private pushTrail(detection: Detection, pos: Point, t: number): void {
    const last = detection.trail[detection.trail.length - 1];
    // Positions are metres now, so the step test is a plain distance rather
    // than a degrees-to-metres conversion that had to know the latitude.
    if (last && Math.hypot(pos[0] - last.pos[0], pos[1] - last.pos[1]) < MIN_TRAIL_STEP_M) {
      last.t = t;
      return;
    }
    detection.trail.push({ pos, t });
    if (detection.trail.length > MAX_TRAIL) detection.trail.shift();
  }

  // ---- queries ------------------------------------------------------------

  /**
   * Retires ended tracks. Called from the card's single tick, never from the
   * message handler — pruning per MQTT message would be O(n) per frame of every
   * tracked object.
   */
  prune(now: number): void {
    for (const [id, detection] of this.live) {
      const finished = detection.endTime ?? detection.trail[detection.trail.length - 1]?.t;
      if (detection.ended && finished !== undefined && now - finished > this.retentionMs) {
        this.live.delete(id);
      }
    }
  }

  liveDetections(): Detection[] {
    return [...this.live.values()];
  }

  liveFor(camera: string): Detection[] {
    const out: Detection[] = [];
    for (const d of this.live.values()) {
      if (d.camera === camera && !d.ended) out.push(d);
    }
    return out;
  }

  isAlert(detection: Detection): boolean {
    return this.alertLabels.has(detection.label);
  }

  cameraEntity(camera: CameraConfig): any {
    const id = camera.entity ?? `camera.${camera.name}`;
    return this.hass?.states?.[id];
  }

  /**
   * A still frame for the chip.
   *
   * `entity_picture` carries a signed path that HA rotates, so it cannot be
   * built by hand. The card appends a cache-buster with `&`, so the URL is
   * guaranteed to already carry a query string.
   */
  livePreviewUrl(camera: CameraConfig): string | undefined {
    const picture = this.cameraEntity(camera)?.attributes?.entity_picture;
    if (typeof picture !== 'string' || !picture) return undefined;
    return picture.includes('?') ? picture : `${picture}?v=1`;
  }

  // ---- history ------------------------------------------------------------

  /**
   * Past events for the timeline.
   *
   * Frigate's own event list is the only complete source — the card has only
   * been running since the dashboard loaded. Neither route below is a
   * documented Home Assistant contract, so both are attempted and both may
   * fail; the local buffer is what makes that survivable rather than fatal.
   */
  async fetchHistory(since: number): Promise<Detection[]> {
    const remote = (await this.fetchViaWebsocket(since)) ?? (await this.fetchViaProxy(since));

    if (remote?.length) {
      // Merge into the one buffer rather than returning a parallel list, so
      // `timeline()` afterwards has a single source. Anything currently live is
      // more accurate in memory than in the API, which has not seen its `end`.
      const known = new Set(this.history.map((d) => d.id));
      for (const d of remote) {
        if (!known.has(d.id) && !this.live.has(d.id)) this.history.push(d);
      }
      if (this.history.length > MAX_HISTORY) {
        this.history = this.history.slice(-MAX_HISTORY);
      }
      this.version++;
    }

    return this.timeline(since);
  }

  /** Everything worth drawing on the timeline, oldest first. */
  timeline(since: number): Detection[] {
    return this.history
      .filter((d) => (d.endTime ?? Date.now()) >= since)
      .sort((a, b) => a.startTime - b.startTime);
  }

  /** Changes only when a track starts or ends. See `version`. */
  get timelineVersion(): number {
    return this.version;
  }

  private async fetchViaWebsocket(since: number): Promise<Detection[] | null> {
    if (!this.hass?.callWS) return null;
    try {
      const rows = await this.hass.callWS({
        type: 'frigate/events/get',
        instance_id: this.options.instanceId,
        after: Math.floor(since / 1000),
        limit: 500,
      });
      return Array.isArray(rows) ? this.adopt(rows) : null;
    } catch {
      return null;
    }
  }

  /**
   * The Frigate integration mounts the upstream HTTP API under
   * `/api/frigate/<instance>/`. It needs the user's own bearer token, which
   * `hass.auth` holds.
   */
  private async fetchViaProxy(since: number): Promise<Detection[] | null> {
    const token = this.hass?.auth?.data?.access_token;
    if (!token) return null;
    const instance = this.options.instanceId ?? 'frigate';
    const url = `/api/frigate/${instance}/events?after=${Math.floor(since / 1000)}&limit=500`;
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const rows = await res.json();
      return Array.isArray(rows) ? this.adopt(rows) : null;
    } catch {
      return null;
    }
  }

  /**
   * Turns API rows into detections.
   *
   * These have no trail: the API returns one box per event, not the path. They
   * exist to fill the timeline, not to be replayed — replay is still to come.
   */
  private adopt(rows: FrigateEventBody[]): Detection[] {
    const out: Detection[] = [];
    for (const row of rows) {
      if (!row?.id || !row.camera || !this.cameraByName.has(row.camera)) continue;
      const start = toMs(row.start_time);
      if (start === undefined) continue;
      out.push({
        id: row.id,
        camera: row.camera,
        label: row.label ?? 'object',
        score: row.top_score ?? row.score ?? 0,
        startTime: start,
        endTime: toMs(row.end_time),
        trail: [],
        ended: row.end_time != null,
        hasClip: row.has_clip,
        hasSnapshot: row.has_snapshot,
      });
    }
    return out;
  }
}
