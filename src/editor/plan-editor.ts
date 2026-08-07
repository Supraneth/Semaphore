import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import type { CameraConfig, LngLat, LocalXY, RoomConfig, SemaphoreConfig } from '../types';
import { LocalFrame } from '../geo';
import { CHART } from '../theme';

export type EditorMode = 'off' | 'room' | 'camera' | 'adjust';

export interface Selection {
  kind: 'room' | 'camera';
  id: string;
}

const HANDLES = 'semaphore-handles';
const DRAFT = 'semaphore-draft';
/** Vertices closer than this snap together, so adjacent rooms share a wall. */
const SNAP_METRES = 0.45;

/**
 * The plan editor.
 *
 * It exists because nobody will type `position`, `azimuth` and `range` into
 * YAML by hand, and because a room outline is only trustworthy when it is
 * traced directly over the satellite image of the actual building. Everything
 * here edits a working copy; the card is responsible for handing the result
 * back as YAML.
 */
export class PlanEditor {
  mode: EditorMode = 'off';
  selection: Selection | null = null;
  activeLevel: string;

  private draft: LngLat[] = [];
  private dragging: {
    kind: string;
    roomId?: string;
    index?: number;
    camName?: string;
  } | null = null;
  private bound = false;

  constructor(
    private map: MlMap,
    private frame: LocalFrame,
    private config: SemaphoreConfig,
    private onChange: () => void,
  ) {
    this.activeLevel = config.levels[0].id;
  }

  // ---- lifecycle ----------------------------------------------------------

  attach(): void {
    if (this.bound) return;
    this.bound = true;

    this.map.addSource(HANDLES, { type: 'geojson', data: emptyFC() });
    this.map.addSource(DRAFT, { type: 'geojson', data: emptyFC() });

    this.map.addLayer({
      id: `${DRAFT}-line`,
      type: 'line',
      source: DRAFT,
      paint: {
        'line-color': CHART.sectorWhite,
        'line-width': 2,
        'line-dasharray': [2, 1.5],
      },
    });
    this.map.addLayer({
      id: `${HANDLES}-halo`,
      type: 'circle',
      source: HANDLES,
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 13, 9],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.22,
      },
    });
    this.map.addLayer({
      id: HANDLES,
      type: 'circle',
      source: HANDLES,
      paint: {
        'circle-radius': ['match', ['get', 'kind'], 'vertex', 5, 7],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': CHART.ink,
        'circle-stroke-width': 1.5,
      },
    });

    this.map.on('click', this.onClick);
    this.map.on('dblclick', this.onDoubleClick);
    this.map.on('mousedown', HANDLES, this.onHandleDown);
    this.map.on('mouseenter', HANDLES, this.setGrab);
    this.map.on('mouseleave', HANDLES, this.clearGrab);
    window.addEventListener('keydown', this.onKey);
    this.refresh();
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    this.map.off('click', this.onClick);
    this.map.off('dblclick', this.onDoubleClick);
    this.map.off('mousedown', HANDLES, this.onHandleDown);
    this.map.off('mouseenter', HANDLES, this.setGrab);
    this.map.off('mouseleave', HANDLES, this.clearGrab);
    window.removeEventListener('keydown', this.onKey);
    for (const id of [`${HANDLES}-halo`, HANDLES, `${DRAFT}-line`]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    for (const id of [HANDLES, DRAFT]) {
      if (this.map.getSource(id)) this.map.removeSource(id);
    }
  }

  setMode(mode: EditorMode): void {
    if (mode !== 'room') this.draft = [];
    this.mode = mode;
    this.map.getCanvas().style.cursor = mode === 'off' ? '' : 'crosshair';
    this.map.doubleClickZoom[mode === 'room' ? 'disable' : 'enable']();
    this.refresh();
  }

  // ---- pointer handling ---------------------------------------------------

  private onClick = (e: MapMouseEvent) => {
    if (this.mode === 'room') {
      this.draft.push(this.snap([e.lngLat.lng, e.lngLat.lat]));
      this.refresh();
      return;
    }
    if (this.mode === 'camera') {
      this.addCamera([e.lngLat.lng, e.lngLat.lat]);
      this.setMode('adjust');
      return;
    }
    if (this.mode === 'adjust') {
      const hit = this.map.queryRenderedFeatures(e.point, { layers: [HANDLES] })[0];
      if (!hit) this.selection = null;
      this.refresh();
    }
  };

  private onDoubleClick = () => {
    if (this.mode === 'room') this.commitRoom();
  };

  private onHandleDown = (e: any) => {
    if (this.mode === 'off') return;
    const p = e.features?.[0]?.properties;
    if (!p) return;
    e.preventDefault();
    this.dragging = {
      kind: p.kind,
      roomId: p.roomId || undefined,
      index: p.index ?? undefined,
      camName: p.camName || undefined,
    };
    this.selection = p.camName
      ? { kind: 'camera', id: p.camName }
      : p.roomId
        ? { kind: 'room', id: p.roomId }
        : null;
    this.map.dragPan.disable();
    this.map.on('mousemove', this.onDragMove);
    this.map.once('mouseup', this.onDragEnd);
  };

  private onDragMove = (e: MapMouseEvent) => {
    const d = this.dragging;
    if (!d) return;
    const at: LngLat = [e.lngLat.lng, e.lngLat.lat];

    if (d.kind === 'vertex' && d.roomId && d.index !== undefined) {
      const room = this.findRoom(d.roomId);
      if (room) room.ring[d.index] = this.snap(at, room.id, d.index);
    } else if (d.kind === 'camera' && d.camName) {
      const cam = this.findCamera(d.camName);
      if (cam) cam.position = at;
    } else if (d.camName) {
      const cam = this.findCamera(d.camName);
      if (cam) this.aim(cam, at, d.kind);
    }
    this.refresh();
    this.onChange();
  };

  private onDragEnd = () => {
    this.dragging = null;
    this.map.off('mousemove', this.onDragMove);
    this.map.dragPan.enable();
  };

  private onKey = (ev: KeyboardEvent) => {
    if (this.mode === 'off') return;
    if (ev.key === 'Enter' && this.mode === 'room') this.commitRoom();
    if (ev.key === 'Escape') {
      this.draft = [];
      this.selection = null;
      this.refresh();
    }
    if (ev.key === 'Backspace' && this.mode === 'room' && this.draft.length) {
      this.draft.pop();
      this.refresh();
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.selection) {
      this.remove(this.selection);
      this.selection = null;
      this.refresh();
      this.onChange();
    }
  };

  private setGrab = () => (this.map.getCanvas().style.cursor = 'grab');
  private clearGrab = () =>
    (this.map.getCanvas().style.cursor = this.mode === 'off' ? '' : 'crosshair');

  // ---- edits --------------------------------------------------------------

  /**
   * Dragging the aim handle sets bearing and range together; dragging the
   * spread handle opens or closes the angle. Two handles cover all three
   * numbers, which is one fewer control than it sounds like it needs.
   */
  private aim(cam: CameraConfig, at: LngLat, kind: string): void {
    const o = this.frame.toLocal(cam.position);
    const p = this.frame.toLocal(at);
    const bearing = (Math.atan2(p[0] - o[0], p[1] - o[1]) * 180) / Math.PI;
    const dist = Math.hypot(p[0] - o[0], p[1] - o[1]);

    if (kind === 'aim') {
      cam.azimuth = (bearing + 360) % 360;
      cam.range = Math.max(3, Math.round(dist / 0.7));
    } else {
      let delta = ((bearing - cam.azimuth + 540) % 360) - 180;
      cam.fov = Math.min(340, Math.max(10, Math.round(Math.abs(delta) * 2)));
    }
  }

  private commitRoom(): void {
    if (this.draft.length < 3) return;
    const level = this.config.levels.find((l) => l.id === this.activeLevel);
    if (!level) return;
    level.rooms = level.rooms ?? [];
    const n = level.rooms.length + 1;
    const room: RoomConfig = {
      id: `${level.id}-${n}`,
      name: `Pièce ${n}`,
      ring: this.draft,
    };
    level.rooms.push(room);
    this.draft = [];
    this.selection = { kind: 'room', id: room.id };
    this.refresh();
    this.onChange();
  }

  private addCamera(at: LngLat): void {
    const n = this.config.cameras.length + 1;
    const cam: CameraConfig = {
      name: `camera_${n}`,
      label: `Caméra ${n}`,
      position: at,
      level: this.activeLevel,
      height: 2.8,
      azimuth: (this.map.getBearing() + 360) % 360,
      fov: 90,
      range: 20,
    };
    this.config.cameras.push(cam);
    this.selection = { kind: 'camera', id: cam.name };
    this.refresh();
    this.onChange();
  }

  private remove(sel: Selection): void {
    if (sel.kind === 'camera') {
      const i = this.config.cameras.findIndex((c) => c.name === sel.id);
      if (i >= 0) this.config.cameras.splice(i, 1);
      return;
    }
    for (const level of this.config.levels) {
      const i = level.rooms?.findIndex((r) => r.id === sel.id) ?? -1;
      if (i >= 0) level.rooms!.splice(i, 1);
    }
  }

  rename(sel: Selection, name: string): void {
    if (sel.kind === 'camera') {
      const cam = this.findCamera(sel.id);
      if (cam) cam.label = name;
    } else {
      const room = this.findRoom(sel.id);
      if (room) room.name = name;
    }
    this.onChange();
  }

  /** Pulls a point onto a nearby existing vertex so rooms share their walls. */
  private snap(at: LngLat, skipRoom?: string, skipIndex?: number): LngLat {
    const target = this.frame.toLocal(at);
    let best: LngLat | null = null;
    let bestDist = SNAP_METRES;

    for (const level of this.config.levels) {
      for (const room of level.rooms ?? []) {
        room.ring.forEach((p, i) => {
          if (room.id === skipRoom && i === skipIndex) return;
          const q = this.frame.toLocal(p);
          const d = Math.hypot(q[0] - target[0], q[1] - target[1]);
          if (d < bestDist) {
            bestDist = d;
            best = p;
          }
        });
      }
    }
    for (const p of this.draft) {
      const q = this.frame.toLocal(p);
      const d = Math.hypot(q[0] - target[0], q[1] - target[1]);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best ?? at;
  }

  private findRoom(id: string): RoomConfig | undefined {
    for (const level of this.config.levels) {
      const room = level.rooms?.find((r) => r.id === id);
      if (room) return room;
    }
    return undefined;
  }

  private findCamera(name: string): CameraConfig | undefined {
    return this.config.cameras.find((c) => c.name === name);
  }

  // ---- rendering ----------------------------------------------------------

  private refresh(): void {
    const handles: GeoJSON.Feature[] = [];

    if (this.mode !== 'off') {
      for (const level of this.config.levels) {
        if (level.id !== this.activeLevel) continue;
        for (const room of level.rooms ?? []) {
          room.ring.forEach((p, i) => {
            handles.push(
              point(p, {
                kind: 'vertex',
                roomId: room.id,
                index: i,
                color: CHART.sectorWhite,
                selected: this.selection?.id === room.id,
              }),
            );
          });
        }
      }

      for (const cam of this.config.cameras) {
        if ((cam.level ?? this.config.levels[0].id) !== this.activeLevel) continue;
        const selected = this.selection?.id === cam.name;
        handles.push(
          point(cam.position, {
            kind: 'camera',
            camName: cam.name,
            color: CHART.buoyYellow,
            selected,
          }),
        );
        handles.push(
          point(this.offset(cam, cam.azimuth, cam.range * 0.7), {
            kind: 'aim',
            camName: cam.name,
            color: CHART.sectorRed,
            selected,
          }),
        );
        handles.push(
          point(this.offset(cam, cam.azimuth + cam.fov / 2, cam.range * 0.7), {
            kind: 'fov',
            camName: cam.name,
            color: CHART.sectorGreen,
            selected,
          }),
        );
      }
    }

    (this.map.getSource(HANDLES) as any)?.setData({
      type: 'FeatureCollection',
      features: handles,
    });

    const line = this.draft.length > 1 ? [...this.draft] : [];
    (this.map.getSource(DRAFT) as any)?.setData({
      type: 'FeatureCollection',
      features: line.length
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: line },
            } as GeoJSON.Feature,
          ]
        : [],
    });
  }

  private offset(cam: CameraConfig, bearing: number, dist: number): LngLat {
    const o = this.frame.toLocal(cam.position);
    const t = (bearing * Math.PI) / 180;
    const p: LocalXY = [o[0] + Math.sin(t) * dist, o[1] + Math.cos(t) * dist];
    return this.frame.toLngLat(p);
  }

  get draftLength(): number {
    return this.draft.length;
  }
}

const emptyFC = (): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: [],
});

const point = (
  coordinates: LngLat,
  properties: Record<string, unknown>,
): GeoJSON.Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates },
});
