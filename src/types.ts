/**
 * The scene model, in metres.
 *
 * There is no map and no geography here. The origin is wherever the user
 * decided the corner of their house is, x runs east, y runs north, and every
 * number is a metre. That single choice is what makes a grid a grid, snapping
 * exact, and a wall length something you can type.
 */

/** Metres. `[x, y]` on the floor plane, `[x, y, z]` when height matters. */
export type Point = [number, number];
export type Point3 = [number, number, number];

/** Normalised image coordinates, `[0,1]` from the top-left of the frame. */
export type ImageXY = [number, number];

export type CameraState = 'nominal' | 'motion' | 'alert' | 'degraded' | 'offline';

export type BoxFormat = 'auto' | 'xyxy' | 'xywh';

/**
 * A hole in a wall.
 *
 * `at` is measured along the wall from its `a` end, so moving a wall's endpoint
 * drags its doors with it instead of stranding them in space.
 */
export interface Opening {
  id: string;
  kind: 'door' | 'window' | 'pass';
  /** Metres from the wall's `a` end to the opening's near edge. */
  at: number;
  width: number;
  /** Height of the sill above the floor. A door is 0. */
  sill?: number;
  /** Height of the head above the floor. Defaults to the wall height. */
  head?: number;
  /**
   * Glazed but opaque to a camera — frosted glass, a solid door. By default an
   * opening is a gap in the sight line as well as in the wall, which is the
   * whole reason a camera in the hall can watch the living room.
   */
  blocksSight?: boolean;
}

/**
 * A wall segment.
 *
 * First-class rather than derived from a room outline: that is what lets a
 * garden fence, a partition that stops halfway, or a free-standing hedge exist
 * without pretending to enclose anything.
 */
export interface Wall {
  id: string;
  a: Point;
  b: Point;
  /** Metres. Default 0.2. */
  thickness?: number;
  /** Metres. Falls back to the level's `wallHeight`. */
  height?: number;
  openings?: Opening[];
  /** Drawn, but sight passes through: a glass partition, a railing. */
  transparent?: boolean;
}

/**
 * A floor area.
 *
 * Rooms no longer carry the walls — they are the slab, the label and the area
 * readout. Sight blocking lives entirely in `Wall`, so there is exactly one
 * place a wall can come from.
 */
export interface Room {
  id: string;
  name: string;
  /** Closed implicitly; do not repeat the first point. */
  ring: Point[];
  /** Overrides the level's floor colour. */
  color?: string;
}

/** A scanned plan pinned to the world, to trace over. */
export interface Underlay {
  url: string;
  /** World position of the image's top-left corner. */
  origin: Point;
  /** Metres per image pixel — set by drawing a line of known length. */
  scale: number;
  /** Degrees clockwise. */
  rotation?: number;
  opacity?: number;
}

export interface Level {
  id: string;
  name: string;
  /** Metres above the ground floor. */
  elevation: number;
  /** Default height for walls on this level. */
  wallHeight?: number;
  walls?: Wall[];
  rooms?: Room[];
  underlay?: Underlay;
}

export interface Calibration {
  image: ImageXY[];
  /** The same four points on the floor, in metres. */
  ground: Point[];
}

export interface CameraConfig {
  name: string;
  label?: string;
  position: Point;
  level?: string;
  /** Mount height above the level's floor. */
  height?: number;
  /** Lens heading in degrees, 0 = +y (north on the plan), clockwise. */
  azimuth: number;
  fov: number;
  range: number;
  resolution?: [number, number];
  calibration?: Calibration;
  entity?: string;
  /**
   * Colour of this camera's resting sector, `#RRGGBB`.
   *
   * Only the resting sector. Movement, detection, degraded and offline keep the
   * chart palette, because those colours are the legend — a red sector has to
   * mean "something is in there" on every camera or it means nothing anywhere.
   * What this buys is telling four quiet cameras apart at a glance.
   */
  color?: string;
}

export interface ViewConfig {
  /** Degrees. 0 looks along +y. */
  yaw?: number;
  /** Degrees. 0 is a flat plan view, 60 is the 2.5D reading. */
  pitch?: number;
  /** Pixels per metre. */
  zoom?: number;
  /** World point held at the centre of the canvas. */
  center?: Point;
}

export interface SemaphoreConfig {
  type: string;
  /** Grid spacing in metres. Default 0.5. */
  grid?: number;
  /** Draw the floor grid at all. Default true. */
  'show-grid'?: boolean;
  /** Draw room names and areas. Default true. */
  'show-labels'?: boolean;
  /** Opacity of the floor slabs, 0 to 1. Default 0.1. */
  'floor-opacity'?: number;
  /** Height of the scene in pixels. Overrides `aspect-ratio` when set. */
  height?: number;
  /** Shape of the scene when no height is given. `"16/10"`, `"4/3"`, `1.6`. */
  'aspect-ratio'?: string | number;
  /** Cap on the scene's height in pixels. Default: 74 % of the viewport. */
  'max-height'?: number;
  /** Show the detection timeline under the scene. Default true. */
  'show-timeline'?: boolean;
  view?: ViewConfig;
  'topic-prefix'?: string;
  'instance-id'?: string;
  'alert-labels'?: string[];
  'box-format'?: BoxFormat;
  'timeline-hours'?: number;
  /** How long a sector stays lit after its last detection. Default 12. */
  'decay-seconds'?: number;
  /** Idle orbit in degrees per second. 0 disables it. */
  'orbit-speed'?: number;
  /** Seconds of stillness before the orbit resumes. Default 6. */
  'orbit-resume'?: number;
  /** Isovist angular sampling in degrees. Default 1.5. */
  'fov-resolution'?: number;
  levels: Level[];
  cameras: CameraConfig[];
}

export interface TrailPoint {
  pos: Point;
  t: number;
}

export interface Detection {
  id: string;
  camera: string;
  label: string;
  score: number;
  startTime: number;
  endTime?: number;
  trail: TrailPoint[];
  ended: boolean;
  hasClip?: boolean;
  hasSnapshot?: boolean;
}

export interface CameraRuntime {
  config: CameraConfig;
  state: CameraState;
  intensity: number;
  /** Star-shaped polygon in metres, apex first. */
  isovist: Point[];
  dirty: boolean;
  lastSeen: number;
  lastEventAt: number;
}
