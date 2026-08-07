import type { LngLat, LocalXY, RoomConfig, LevelConfig } from './types';
import { LocalFrame } from './geo';
import { occludersFromPolygons, type Segment } from './fov';

/**
 * A room is traced once and used twice: extruded into walls for the 2.5D
 * reading, and flattened into edges for the isovist raycaster. Keeping one
 * source of geometry is what stops the picture and the coverage calculation
 * from ever disagreeing.
 */

const DEFAULT_THICKNESS = 0.16; // metres
const DEFAULT_HEIGHT = 2.6;

/** Float noise in extrusion heights shows up as z-fighting between storeys. */
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Turns a room ring into wall quads.
 *
 * Each edge becomes a rectangle offset perpendicular by half the thickness and
 * extended by half the thickness at both ends. The overlap closes the corners
 * without needing a proper miter offset, which is more than accurate enough at
 * 16 cm and far more robust on the concave rooms people actually draw.
 */
export function wallQuads(
  ring: LocalXY[],
  thickness = DEFAULT_THICKNESS,
): LocalXY[][] {
  const t = thickness / 2;
  const quads: LocalXY[][] = [];

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;

    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy * t;
    const ny = ux * t;
    const ax = a[0] - ux * t;
    const ay = a[1] - uy * t;
    const bx = b[0] + ux * t;
    const by = b[1] + uy * t;

    quads.push([
      [ax + nx, ay + ny],
      [bx + nx, by + ny],
      [bx - nx, by - ny],
      [ax - nx, ay - ny],
    ]);
  }
  return quads;
}

/** Signed area, used to tell a traced ring's winding so labels sit inside. */
export function ringCentroid(ring: LocalXY[]): LocalXY {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

export interface RoomGeometry {
  walls: GeoJSON.FeatureCollection;
  floors: GeoJSON.FeatureCollection;
  labels: GeoJSON.FeatureCollection;
}

/**
 * Builds every renderable feature for the whole stack.
 *
 * `explode` lifts each level by an extra amount so the storeys separate — the
 * classic 2.5D reading of a building, and the only way to see an upstairs
 * camera's coverage without hiding the ground floor.
 */
export function buildRoomGeometry(
  levels: LevelConfig[],
  frame: LocalFrame,
  explode = 0,
): RoomGeometry {
  const walls: GeoJSON.Feature[] = [];
  const floors: GeoJSON.Feature[] = [];
  const labels: GeoJSON.Feature[] = [];

  levels.forEach((level, index) => {
    const base = level.elevation + explode * index;
    for (const room of level.rooms ?? []) {
      if (room.ring.length < 3) continue;
      const local = room.ring.map((p) => frame.toLocal(p));
      const height = room.height ?? level.wallHeight ?? DEFAULT_HEIGHT;

      for (const quad of wallQuads(local, room.thickness)) {
        walls.push({
          type: 'Feature',
          properties: {
            level: level.id,
            room: room.id,
            base,
            top: round(base + height),
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[...quad, quad[0]].map((p) => frame.toLngLat(p))],
          },
        });
      }

      if (room.floor !== false) {
        floors.push({
          type: 'Feature',
          properties: {
            level: level.id,
            room: room.id,
            base,
            top: round(base + 0.04),
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[...room.ring, room.ring[0]]],
          },
        });
      }

      labels.push({
        type: 'Feature',
        properties: { level: level.id, name: room.name, base },
        geometry: { type: 'Point', coordinates: frame.toLngLat(ringCentroid(local)) },
      });
    }
  });

  const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features,
  });

  return { walls: fc(walls), floors: fc(floors), labels: fc(labels) };
}

/** The edges a camera on this level can be blocked by. */
export function occludersForLevel(level: LevelConfig, frame: LocalFrame): Segment[] {
  const rings: LocalXY[][] = [];

  for (const room of level.rooms ?? []) {
    if (room.ring.length < 3) continue;
    if (room.transparent) continue; // open-plan boundaries, glass walls
    rings.push(room.ring.map((p) => frame.toLocal(p)));
  }

  for (const f of level.occluders?.features ?? []) {
    for (const ring of f.geometry.coordinates) {
      rings.push(ring.map((c) => frame.toLocal(c as LngLat)));
    }
  }

  return occludersFromPolygons(rings);
}

export function emptyRoom(id: string, ring: LngLat[]): RoomConfig {
  return { id, name: 'Pièce', ring };
}
