import maplibregl, { Map as MlMap } from 'maplibre-gl';
import type {
  CameraConfig,
  CameraRuntime,
  CameraState,
  Detection,
  LevelConfig,
  LngLat,
  LocalXY,
  SemaphoreConfig,
} from './types';
import { LocalFrame, bearingDelta, centroid } from './geo';
import { computeIsovist, occludersFromPolygons, type Segment } from './fov';
import { buildRoomGeometry, occludersForLevel } from './rooms';
import { PlanEditor } from './editor/plan-editor';
import { SceneLayer, type BlipInput, type SectorInput } from './gl/scene-layer';
import { PlanLayer } from './gl/plan-layer';
import { CHART, MOTION, STATE_STYLES, labelRgb } from './theme';

const STYLE_URL: Record<string, string> = {
  hybrid: 'https://api.maptiler.com/maps/hybrid/style.json',
  streets: 'https://api.maptiler.com/maps/streets-v2/style.json',
  topo: 'https://api.maptiler.com/maps/topo-v2/style.json',
};

/**
 * MapLibre's own keyless style. It has no building source and no imagery, so
 * it is useless for placing cameras — but it lets the scene, the sectors and
 * the blips run without an account, which is the difference between the dev
 * bench working out of the box and not.
 */
const KEYLESS_STYLE = 'https://demotiles.maplibre.org/style.json';

function styleUrl(config: SemaphoreConfig): string {
  const style = config['map-style'] ?? 'hybrid';
  const key = config['maptiler-api-key'];
  if (style === 'demo' || !key) return KEYLESS_STYLE;
  return `${STYLE_URL[style] ?? STYLE_URL.hybrid}?key=${key}`;
}

/** How long a trail point takes to fade out completely. */
const TRAIL_FADE_MS = 8000;

export interface EngineCallbacks {
  onFrame: () => void;
  onCameraClick: (name: string) => void;
  onIdleChange: (idle: boolean) => void;
}

export class Engine {
  map!: MlMap;
  private scene = new SceneLayer();
  private plans = new PlanLayer();
  private frame: LocalFrame;
  private runtimes = new Map<string, CameraRuntime>();
  private occluders = new Map<string, Segment[]>(); // by level id
  private levels: LevelConfig[];
  private activeLevel: string;
  private explode = 0;

  private raf = 0;
  private lastInteraction = performance.now();
  private orbiting = false;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private paused = false;

  focused: string | null = null;
  editor?: PlanEditor;

  constructor(
    private container: HTMLElement,
    private config: SemaphoreConfig,
    private cb: EngineCallbacks,
  ) {
    this.levels = config.levels;
    this.activeLevel = config.levels[0]?.id ?? 'ground';
    this.frame = new LocalFrame(centroid(config.cameras.map((c) => c.position)));
    for (const cam of config.cameras) {
      this.runtimes.set(cam.name, {
        config: cam,
        state: 'nominal',
        intensity: STATE_STYLES.nominal.intensity,
        isovist: [],
        dirty: true,
        lastSeen: 0,
        lastEventAt: 0,
      });
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  async init(): Promise<void> {
    this.map = new maplibregl.Map({
      container: this.container,
      style: styleUrl(this.config),
      center: this.frame.origin,
      zoom: 18.5,
      pitch: 55,
      bearing: 0,
      attributionControl: { compact: true },
      // The card owns its own render loop; MapLibre should only repaint when
      // something actually changed.
      refreshExpiredTiles: false,
    });

    await new Promise<void>((res) => this.map.once('load', () => res()));

    this.addBuildings();
    this.addRoomLayers();
    this.map.addLayer(this.plans);
    this.map.addLayer(this.scene);

    await this.plans.setLevels(this.levels, 0);
    this.harvestOccluders();
    this.rebuildSectors();

    for (const evt of ['mousedown', 'touchstart', 'wheel', 'dragstart'] as const) {
      this.map.on(evt, () => this.noteInteraction());
    }
    this.map.on('sourcedata', (e) => {
      if (e.isSourceLoaded && e.sourceId?.includes('openmaptiles')) {
        this.harvestOccluders();
      }
    });

    this.start();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.map?.remove();
  }

  /** Called by the card when the element leaves the viewport or the tab hides. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) cancelAnimationFrame(this.raf);
    else this.start();
  }

  // ---- geometry -----------------------------------------------------------

  /**
   * Basemap massing, when the style provides it.
   *
   * Not every style carries an `openmaptiles` source — the keyless demo style
   * the dev bench falls back to does not, and MapTiler is free to rename
   * things. Adding a layer against a missing source throws and takes the whole
   * map down with it, so this is a guard rather than an optimisation.
   */
  private addBuildings(): void {
    if (!this.map.getSource('openmaptiles')) return;
    const first3d = this.map.getStyle().layers?.find((l) => l.type === 'symbol');
    this.map.addLayer(
      {
        id: 'semaphore-buildings',
        source: 'openmaptiles',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 15,
        paint: {
          'fill-extrusion-color': CHART.massing,
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.55,
        },
      },
      first3d?.id,
    );
  }

  /**
   * Rooms are rendered natively rather than in the custom layer: MapLibre's
   * fill-extrusion already supports `fill-extrusion-base`, which is all a
   * raised storey needs. Reaching for WebGL here would buy nothing.
   */
  private addRoomLayers(): void {
    this.map.addSource('semaphore-walls', { type: 'geojson', data: emptyFC() });
    this.map.addSource('semaphore-floors', { type: 'geojson', data: emptyFC() });
    this.map.addSource('semaphore-labels', { type: 'geojson', data: emptyFC() });

    this.map.addLayer({
      id: 'semaphore-floors',
      type: 'fill-extrusion',
      source: 'semaphore-floors',
      paint: {
        'fill-extrusion-color': CHART.parchment,
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-opacity': 0.18,
      },
    });
    this.map.addLayer({
      id: 'semaphore-walls',
      type: 'fill-extrusion',
      source: 'semaphore-walls',
      paint: {
        'fill-extrusion-color': CHART.parchmentShade,
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-opacity': 0.72,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    this.map.addLayer({
      id: 'semaphore-room-labels',
      type: 'symbol',
      source: 'semaphore-labels',
      minzoom: 18,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-letter-spacing': 0.06,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': CHART.parchment,
        'text-halo-color': CHART.ink,
        'text-halo-width': 1.2,
      },
    });
  }

  /** Rebuilds every room feature. Cheap: a house is a few hundred quads. */
  refreshRooms(): void {
    const geom = buildRoomGeometry(this.levels, this.frame, this.explode);
    (this.map.getSource('semaphore-walls') as any)?.setData(geom.walls);
    (this.map.getSource('semaphore-floors') as any)?.setData(geom.floors);
    (this.map.getSource('semaphore-labels') as any)?.setData(geom.labels);
  }

  /**
   * Occluders come from two places: explicit walls in the level config for
   * indoor levels, and building footprints harvested from the vector basemap
   * for the outdoor level. Harvesting is cheap because it only reads what the
   * renderer already parsed — but it does depend on the tiles being loaded,
   * hence the re-run on `sourcedata`.
   */
  private harvestOccluders(): void {
    let changed = false;

    for (const level of this.levels) {
      if (level.rooms?.length || level.occluders) {
        this.occluders.set(level.id, occludersForLevel(level, this.frame));
        changed = true;
        continue;
      }
      if (!this.map.getLayer('semaphore-buildings')) continue;
      const feats = this.map.querySourceFeatures('openmaptiles', {
        sourceLayer: 'building',
      });
      if (!feats.length) continue;

      const rings: LocalXY[][] = [];
      for (const f of feats) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        for (const poly of polys) {
          rings.push((poly[0] as number[][]).map((c) => this.frame.toLocal(c as LngLat)));
        }
      }
      const segs = occludersFromPolygons(rings);
      const prev = this.occluders.get(level.id)?.length ?? 0;
      if (segs.length !== prev) {
        this.occluders.set(level.id, segs);
        changed = true;
      }
    }

    if (changed) {
      for (const rt of this.runtimes.values()) rt.dirty = true;
      this.rebuildSectors();
    }
  }

  private levelOf(cam: CameraConfig): LevelConfig {
    return this.levels.find((l) => l.id === (cam.level ?? this.levels[0]?.id)) ?? this.levels[0];
  }

  private levelAltitude(level: LevelConfig): number {
    const idx = this.levels.indexOf(level);
    return level.elevation + this.explode * Math.max(0, idx);
  }

  /**
   * Recomputes any dirty isovist and uploads the whole sector buffer.
   *
   * Note what is *not* here: nothing is recomputed because a camera changed
   * state. State only feeds colour and sweep, and those ride in the same
   * upload. Geometry work happens on config change, level change, or when new
   * building tiles arrive — a handful of times per session.
   */
  rebuildSectors(): void {
    const sectors: SectorInput[] = [];
    const res = this.config['fov-resolution'] ?? 1.5;
    let index = 0;

    for (const rt of this.runtimes.values()) {
      const cam = rt.config;
      const level = this.levelOf(cam);
      const style = STATE_STYLES[rt.state];

      if (rt.dirty || !rt.isovist.length) {
        rt.isovist = computeIsovist({
          origin: this.frame.toLocal(cam.position),
          azimuth: cam.azimuth,
          fov: cam.fov,
          range: cam.range,
          occluders: this.occluders.get(level.id) ?? [],
          resolution: res,
        });
        rt.dirty = false;
      }

      const alt = this.levelAltitude(level) + 0.06;
      const apex = rt.isovist[0];
      const vertices: Array<[number, number, number]> = [];
      const radii: number[] = [];

      for (const p of rt.isovist) {
        const ll = this.frame.toLngLat(p);
        const m = maplibregl.MercatorCoordinate.fromLngLat(
          { lng: ll[0], lat: ll[1] },
          alt,
        );
        vertices.push([m.x, m.y, m.z ?? 0]);
        const d = Math.hypot(p[0] - apex[0], p[1] - apex[1]);
        radii.push(Math.min(1, d / cam.range));
      }

      const visible = level.id === this.activeLevel || this.explode > 0;
      sectors.push({
        vertices,
        radii,
        color: style.rgb,
        intensity: visible ? rt.intensity : rt.intensity * 0.15,
        sweep: this.reducedMotion ? 0 : style.sweep,
        cameraIndex: index,
      });
      index++;
    }

    this.scene.setSectors(sectors);
  }

  // ---- state --------------------------------------------------------------

  setCameraState(name: string, state: CameraState, intensity?: number): void {
    const rt = this.runtimes.get(name);
    if (!rt) return;
    if (rt.state === state && intensity === undefined) return;
    rt.state = state;
    rt.intensity = intensity ?? STATE_STYLES[state].intensity;
    this.rebuildSectors();
  }

  cameraIndex(name: string): number {
    return [...this.runtimes.keys()].indexOf(name);
  }

  runtime(name: string): CameraRuntime | undefined {
    return this.runtimes.get(name);
  }

  /** Uploads live blips and their fading trails. Called from the coalesced tick. */
  setDetections(detections: Detection[], now = Date.now()): void {
    const blips: BlipInput[] = [];
    for (const det of detections) {
      const cam = this.runtimes.get(det.camera)?.config;
      if (!cam) continue;
      const alt = this.levelAltitude(this.levelOf(cam)) + 0.3;
      const rgb = labelRgb(det.label);
      const trail = det.trail;
      for (let i = 0; i < trail.length; i++) {
        // Age is wall-clock, not position in the array: an object that stopped
        // for ten seconds should show a fading trail, not a fresh one that
        // happens to be short.
        const age = Math.min(0.95, (now - trail[i].t) / TRAIL_FADE_MS);
        const m = maplibregl.MercatorCoordinate.fromLngLat(
          { lng: trail[i].pos[0], lat: trail[i].pos[1] },
          alt,
        );
        blips.push({
          position: [m.x, m.y, m.z ?? 0],
          color: rgb,
          age,
          size: i === trail.length - 1 ? 18 : 7,
        });
      }
    }
    this.scene.setBlips(blips);
  }

  // ---- levels -------------------------------------------------------------

  async setActiveLevel(id: string): Promise<void> {
    if (this.activeLevel === id) return;
    this.activeLevel = id;
    const vis: Record<string, number> = {};
    for (const l of this.levels) {
      vis[l.id] = l.id === id ? (l.plan?.opacity ?? 0.9) : 0.12;
    }
    this.plans.setVisibility(vis);
    this.rebuildSectors();
    this.noteInteraction();
  }

  /** Separates the storeys vertically. The classic 2.5D reading of a building. */
  async setExploded(metres: number): Promise<void> {
    this.explode = metres;
    await this.plans.setLevels(this.levels, metres);
    this.refreshRooms();
    const vis: Record<string, number> = {};
    for (const l of this.levels) vis[l.id] = l.plan?.opacity ?? 0.9;
    this.plans.setVisibility(metres > 0 ? vis : { [this.activeLevel]: 0.9 });
    this.rebuildSectors();
  }

  // ---- camera work --------------------------------------------------------

  /**
   * The shoulder view: places the virtual camera behind the physical one, so
   * the map's heading matches the lens heading. It is the cheapest possible
   * way to make "what am I looking at" obvious, and it costs one easeTo.
   */
  focus(name: string): void {
    const rt = this.runtimes.get(name);
    if (!rt) return;
    this.focused = name;
    this.scene.focusIndex = this.cameraIndex(name);

    const cam = rt.config;
    const level = this.levelOf(cam);
    const back = 0.55 * cam.range;
    const theta = ((cam.azimuth + 180) * Math.PI) / 180;
    const local = this.frame.toLocal(cam.position);
    const eye = this.frame.toLngLat([
      local[0] + Math.sin(theta) * back,
      local[1] + Math.cos(theta) * back,
    ]);

    this.map.easeTo({
      center: eye,
      bearing: cam.azimuth,
      pitch: 68,
      zoom: 19.2 - Math.log2(Math.max(1, cam.range / 25)),
      duration: this.reducedMotion ? 0 : MOTION.flight,
      easing: easeOutQuint,
    });
    if (level.id !== this.activeLevel) void this.setActiveLevel(level.id);
    this.noteInteraction();
    this.rebuildSectors();
  }

  clearFocus(): void {
    if (!this.focused) return;
    this.focused = null;
    this.scene.focusIndex = -1;
    this.map.easeTo({
      center: this.frame.origin,
      pitch: 55,
      zoom: 18.5,
      duration: this.reducedMotion ? 0 : MOTION.flight,
      easing: easeOutQuint,
    });
    this.rebuildSectors();
  }

  /** Screen position of a camera, for the DOM chip overlay. */
  project(cam: CameraConfig): { x: number; y: number; behind: boolean } {
    const level = this.levelOf(cam);
    const alt = this.levelAltitude(level) + (cam.height ?? 3);
    const m = maplibregl.MercatorCoordinate.fromLngLat(
      { lng: cam.position[0], lat: cam.position[1] },
      alt,
    );
    const ll = m.toLngLat();
    const p = this.map.project(ll);
    // A chip whose camera is more than 90° off the current bearing is behind
    // the viewer at high pitch; the card fades those instead of stacking them.
    const bearingToCam = this.map.getBearing();
    const behind = Math.abs(bearingDelta(bearingToCam, cam.azimuth)) > 150;
    return { x: p.x, y: p.y - altitudeOffset(this.map, alt), behind };
  }

  noteInteraction(): void {
    this.lastInteraction = performance.now();
    if (this.orbiting) {
      this.orbiting = false;
      this.cb.onIdleChange(false);
    }
  }

  // ---- render loop --------------------------------------------------------

  /**
   * One loop for the whole card. It exists only while there is a reason:
   * an orbit in progress, a plan fading, or an active sector sweeping. When
   * everything settles the loop stops and the tab goes to 0% CPU.
   */
  private start(): void {
    const step = () => {
      if (this.paused) return;
      const now = performance.now();

      const idleFor = now - this.lastInteraction;
      const resume = (this.config['orbit-resume'] ?? 6) * 1000;
      const speed = this.reducedMotion ? 0 : this.config['orbit-speed'] ?? 0.9;

      if (!this.focused && speed > 0 && idleFor > resume) {
        if (!this.orbiting) {
          this.orbiting = true;
          this.cb.onIdleChange(true);
        }
        this.map.setBearing(this.map.getBearing() + speed / 60);
      }

      this.cb.onFrame();

      if (this.needsFrame()) this.raf = requestAnimationFrame(step);
      else this.raf = requestAnimationFrame(() => this.start());
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(step);
  }

  private needsFrame(): boolean {
    if (this.orbiting) return true;
    if (this.plans.animating) return true;
    if (this.map?.isMoving()) return true;
    for (const rt of this.runtimes.values()) {
      if (STATE_STYLES[rt.state].sweep > 0) return true;
    }
    return false;
  }

  /** Turns the plan editor on, creating it lazily. */
  enableEditor(config: SemaphoreConfig, onChange: () => void): PlanEditor {
    if (!this.editor) {
      this.editor = new PlanEditor(this.map, this.frame, config, () => {
        for (const rt of this.runtimes.values()) rt.dirty = true;
        this.harvestOccluders();
        this.refreshRooms();
        this.syncCameras(config);
        onChange();
      });
      this.editor.attach();
    }
    return this.editor;
  }

  disableEditor(): void {
    this.editor?.detach();
    this.editor = undefined;
  }

  /** Picks up cameras added or removed by the editor without a full reload. */
  syncCameras(config: SemaphoreConfig): void {
    for (const cam of config.cameras) {
      if (!this.runtimes.has(cam.name)) {
        this.runtimes.set(cam.name, {
          config: cam, state: 'nominal',
          intensity: STATE_STYLES.nominal.intensity,
          isovist: [], dirty: true, lastSeen: 0, lastEventAt: 0,
        });
      }
    }
    const live = new Set(config.cameras.map((c) => c.name));
    for (const name of [...this.runtimes.keys()]) {
      if (!live.has(name)) this.runtimes.delete(name);
    }
    this.rebuildSectors();
  }

  get sceneLayer(): SceneLayer {
    return this.scene;
  }
}

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

/**
 * MapLibre's `project` ignores altitude, so a chip pinned to a 3 m mount would
 * sit on the ground. This converts metres of altitude into screen pixels at the
 * current zoom and pitch.
 */
function altitudeOffset(map: MlMap, metres: number): number {
  const lat = map.getCenter().lat;
  const metresPerPixel =
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
  const pitchRad = (map.getPitch() * Math.PI) / 180;
  return (metres / metresPerPixel) * Math.cos(pitchRad);
}
