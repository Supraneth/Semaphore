/**
 * The Lovelace config schema and the runtime model.
 *
 * Config keys are kebab-case because that is what a user types in a YAML card
 * editor; runtime fields are camelCase. The two never mix in one object.
 */

/** `[longitude, latitude]`, the GeoJSON order — never lat/lng. */
export type LngLat = [number, number];

/** Metres east/north of the scene origin. See `LocalFrame`. */
export type LocalXY = [number, number];

/** Normalised image coordinates, `[0,1]` from the top-left of the frame. */
export type ImageXY = [number, number];

export type CameraState = 'nominal' | 'motion' | 'alert' | 'degraded' | 'offline';

/**
 * Four image points and the four ground points they land on.
 *
 * The order has to match between the two arrays, and the quad must not be
 * degenerate — three collinear points make the DLT singular. Anything roughly
 * rectangular on the ground works: a patio, a parking bay, a doormat and three
 * paving stones.
 */
export interface Calibration {
  image: ImageXY[];
  ground: LngLat[];
}

export interface CameraConfig {
  /** The Frigate camera name, exactly as it appears in `frigate/<name>/...`. */
  name: string;
  label?: string;
  position: LngLat;
  /** Which level the camera sits on. Defaults to the first level. */
  level?: string;
  /** Mount height in metres above the level. Only affects the chip anchor. */
  height?: number;
  /** Lens heading in degrees, 0 = north, clockwise. */
  azimuth: number;
  /** Horizontal field of view in degrees. */
  fov: number;
  /** Useful range in metres — where the sector fades out. */
  range: number;
  /** Sensor size in pixels. Lets absolute Frigate boxes be normalised. */
  resolution?: [number, number];
  calibration?: Calibration;
  /**
   * Overrides the guessed `camera.<name>` entity, for installs that renamed
   * their entities or run several Frigate instances.
   */
  entity?: string;
}

export interface RoomConfig {
  id: string;
  name: string;
  /** Closed ring, implicitly — do not repeat the first point. */
  ring: LngLat[];
  /** Wall height in metres. Falls back to the level's `wallHeight`. */
  height?: number;
  /** Wall thickness in metres. Default 0.16. */
  thickness?: number;
  /** `false` drops the floor slab, for a terrace or a courtyard. */
  floor?: boolean;
  /** Drawn but not raycast: glass walls, open-plan boundaries. */
  transparent?: boolean;
}

export interface PlanConfig {
  /** Any URL the browser can fetch — `/local/...` for HA's www folder. */
  url: string;
  /** Corners in TL, TR, BR, BL order, matching the image's own corners. */
  corners: LngLat[];
  opacity?: number;
}

export interface LevelConfig {
  id: string;
  name: string;
  /** Metres above ground. The outdoor level is 0. */
  elevation: number;
  wallHeight?: number;
  plan?: PlanConfig;
  rooms?: RoomConfig[];
  /**
   * Extra sight blockers that are not rooms — a hedge, a fence, a neighbour's
   * gable. Polygons only; their outer rings become segments.
   */
  occluders?: GeoJSON.FeatureCollection<GeoJSON.Polygon>;
}

/**
 * `demo` is MapLibre's keyless style: no imagery, no buildings, useless for
 * placing a camera, but it runs without an account. It exists so the dev bench
 * and a first look at the card do not require signing up for anything.
 */
export type MapStyle = 'hybrid' | 'streets' | 'topo' | 'demo';

/**
 * How to read Frigate's `box`. `auto` guesses; set it explicitly once you have
 * looked at one real payload. See `normaliseBox`.
 */
export type BoxFormat = 'auto' | 'xyxy' | 'xywh';

export interface SemaphoreConfig {
  type: string;
  'maptiler-api-key': string;
  'map-style'?: MapStyle;
  /** MQTT topic root, matching Frigate's `mqtt.topic_prefix`. */
  'topic-prefix'?: string;
  /** Set when several Frigate instances share one broker. */
  'instance-id'?: string;
  /** Labels that promote a detection to `alert`. Default: person, car. */
  'alert-labels'?: string[];
  /** Overrides the bounding-box heuristic when it guesses wrong. */
  'box-format'?: BoxFormat;
  'timeline-hours'?: number;
  /** How long a sector stays lit after its last detection. Default 12. */
  'decay-seconds'?: number;
  /** Idle orbit in degrees per second. 0 disables it. */
  'orbit-speed'?: number;
  /** Seconds of stillness before the orbit resumes. Default 6. */
  'orbit-resume'?: number;
  /** Isovist angular sampling in degrees. Lower is smoother and slower. */
  'fov-resolution'?: number;
  levels: LevelConfig[];
  cameras: CameraConfig[];
}

/** One sample of a tracked object's path. */
export interface TrailPoint {
  pos: LngLat;
  t: number;
}

/**
 * A tracked object.
 *
 * `id` is Frigate's event id, which is stable across the `new`/`update`/`end`
 * message sequence — that is what lets an update extend a trail rather than
 * start a second one.
 */
export interface Detection {
  id: string;
  camera: string;
  label: string;
  score: number;
  startTime: number;
  endTime?: number;
  trail: TrailPoint[];
  /** True once Frigate sent `type: end`. */
  ended: boolean;
  /** Frigate's snapshot/clip availability, for the timeline. */
  hasClip?: boolean;
  hasSnapshot?: boolean;
}

export interface CameraRuntime {
  config: CameraConfig;
  state: CameraState;
  intensity: number;
  /** Star-shaped polygon in local metres, apex first. */
  isovist: LocalXY[];
  /** Set when the isovist needs recomputing — never per frame. */
  dirty: boolean;
  lastSeen: number;
  lastEventAt: number;
}
