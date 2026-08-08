import type {
  CameraConfig,
  Level,
  Opening,
  Point,
  Room,
  SemaphoreConfig,
  Wall,
} from './types';

/**
 * Config validation, and the one-way migration off geographic coordinates.
 *
 * A Lovelace card is configured by a human typing YAML, so a missing or
 * misshapen field is a normal event. Everything here fails with a message that
 * names the entry at fault, because the alternative — a TypeError above an
 * empty card — tells nobody anything.
 */

const DEFAULTS = {
  azimuth: 0,
  fov: 90,
  range: 8,
  height: 2.6,
  wallHeight: 2.5,
  thickness: 0.2,
  grid: 0.5,
} as const;

export class ConfigError extends Error {}

const fail = (message: string): never => {
  throw new ConfigError(message);
};

function describe(value: unknown): string {
  if (value === undefined) return 'rien';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `une liste de ${value.length} élément(s)`;
  return `${typeof value} (${JSON.stringify(value)})`;
}

/** A point is two finite numbers in metres. There is no valid range. */
function point(value: unknown, where: string): Point {
  if (!Array.isArray(value) || value.length < 2) {
    return fail(`${where} : attendu [x, y] en mètres, reçu ${describe(value)}.`);
  }
  const [x, y] = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
    return fail(`${where} : x et y doivent être des nombres, en mètres.`);
  }
  return [x, y];
}

function num(value: unknown, fallback: number, where: string, min?: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !isFinite(value)) {
    return fail(`${where} : attendu un nombre, reçu ${describe(value)}.`);
  }
  if (min !== undefined && value < min) {
    return fail(`${where} : doit être au moins ${min}, reçu ${value}.`);
  }
  return value;
}

let seq = 0;
const uid = (prefix: string): string => `${prefix}-${++seq}`;

// ---- migration ------------------------------------------------------------

/**
 * Detects a config written for the map version.
 *
 * `maptiler-api-key` is the reliable marker: it was required then and is
 * meaningless now. Guessing from the coordinate values alone is not safe —
 * `[3, -2]` is a perfectly good position in metres and a perfectly good one in
 * degrees.
 */
export function isGeographic(raw: Record<string, unknown>): boolean {
  if ('maptiler-api-key' in raw) return true;
  const levels = raw.levels;
  return (
    Array.isArray(levels) &&
    levels.some((l) => l && typeof l === 'object' && 'plan' in (l as object))
  );
}

const M_PER_DEG_LAT = 111_320;

/**
 * Converts a geographic config to metres, once.
 *
 * The origin is the first camera, so the scene lands near `[0, 0]` instead of
 * several million metres from it. Room rings become both a floor and its walls,
 * since the old model had no separate walls — that is the only part of the
 * migration that invents anything, and it is what the old renderer drew anyway.
 */
export function migrateFromGeographic(raw: Record<string, unknown>): Record<string, unknown> {
  const cameras = Array.isArray(raw.cameras) ? raw.cameras : [];
  const first = cameras.find(
    (c: any) => Array.isArray(c?.position) && typeof c.position[0] === 'number',
  ) as any;

  const origin: [number, number] = first?.position ?? [0, 0];
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin[1] * Math.PI) / 180);
  const toMetres = (p: unknown): Point => {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') return [0, 0];
    return [
      Math.round((p[0] - origin[0]) * mPerDegLng * 100) / 100,
      Math.round((p[1] - origin[1]) * M_PER_DEG_LAT * 100) / 100,
    ];
  };

  const levels = (Array.isArray(raw.levels) ? raw.levels : []).map((l: any) => {
    const rooms = (Array.isArray(l?.rooms) ? l.rooms : []).map((r: any) => ({
      id: r?.id,
      name: r?.name,
      ring: (Array.isArray(r?.ring) ? r.ring : []).map(toMetres),
    }));

    const walls: Wall[] = [];
    for (const room of rooms) {
      if (room.ring.length < 3) continue;
      for (let i = 0; i < room.ring.length; i++) {
        walls.push({
          id: uid('mur'),
          a: room.ring[i],
          b: room.ring[(i + 1) % room.ring.length],
          thickness: DEFAULTS.thickness,
        });
      }
    }

    return {
      id: l?.id,
      name: l?.name,
      elevation: l?.elevation,
      wallHeight: l?.wallHeight,
      rooms,
      walls,
    };
  });

  return {
    ...raw,
    'maptiler-api-key': undefined,
    'map-style': undefined,
    levels,
    cameras: cameras.map((c: any) => ({
      ...c,
      position: toMetres(c?.position),
      calibration: c?.calibration
        ? {
            image: c.calibration.image,
            ground: (c.calibration.ground ?? []).map(toMetres),
          }
        : undefined,
    })),
  };
}

// ---- validation -----------------------------------------------------------

function opening(raw: unknown, wallId: string, index: number, wallLength: number): Opening {
  if (!raw || typeof raw !== 'object') {
    return fail(`mur « ${wallId} », openings[${index}] : attendu un bloc.`);
  }
  const o = raw as Record<string, unknown>;
  const where = `mur « ${wallId} », ouverture ${index + 1}`;
  const kind = o.kind ?? 'door';
  if (!['door', 'window', 'pass'].includes(kind as string)) {
    fail(`${where} : \`kind\` attend door, window ou pass.`);
  }
  const at = num(o.at, 0, `${where}, at`, 0);
  if (at > wallLength) {
    fail(`${where} : \`at\` (${at} m) dépasse la longueur du mur (${wallLength.toFixed(2)} m).`);
  }
  return {
    ...(raw as Opening),
    id: typeof o.id === 'string' && o.id ? o.id : uid('ouverture'),
    kind: kind as Opening['kind'],
    at,
    width: num(o.width, 0.9, `${where}, width`, 0.05),
  };
}

function wall(raw: unknown, levelId: string, index: number): Wall {
  if (!raw || typeof raw !== 'object') {
    return fail(`niveau « ${levelId} », walls[${index}] : attendu un bloc, reçu ${describe(raw)}.`);
  }
  const w = raw as Record<string, unknown>;
  const id = typeof w.id === 'string' && w.id ? w.id : uid('mur');
  const where = `niveau « ${levelId} », mur « ${id} »`;

  const a = point(w.a, `${where}, a`);
  const b = point(w.b, `${where}, b`);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.01) {
    fail(`${where} : les deux extrémités sont au même endroit.`);
  }

  return {
    ...(raw as Wall),
    id,
    a,
    b,
    thickness: num(w.thickness, DEFAULTS.thickness, `${where}, thickness`, 0.01),
    openings: Array.isArray(w.openings)
      ? w.openings.map((o, i) => opening(o, id, i, length))
      : undefined,
  };
}

function room(raw: unknown, levelId: string, index: number): Room {
  if (!raw || typeof raw !== 'object') {
    return fail(`niveau « ${levelId} », rooms[${index}] : attendu un bloc.`);
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id ? r.id : uid('piece');
  const where = `niveau « ${levelId} », pièce « ${id} »`;

  if (!Array.isArray(r.ring) || r.ring.length < 3) {
    return fail(
      `${where} : \`ring\` doit contenir au moins 3 points. ` +
        `Ne répétez pas le premier point à la fin, le contour se ferme tout seul.`,
    );
  }

  return {
    ...(raw as Room),
    id,
    name: typeof r.name === 'string' && r.name ? r.name : `Pièce ${index + 1}`,
    ring: (r.ring as unknown[]).map((p, i) => point(p, `${where}, ring[${i}]`)),
  };
}

function level(raw: unknown, index: number): Level {
  if (!raw || typeof raw !== 'object') {
    return fail(`levels[${index}] : attendu un bloc, reçu ${describe(raw)}.`);
  }
  const l = raw as Record<string, unknown>;
  const id = typeof l.id === 'string' && l.id ? l.id : `niveau-${index + 1}`;
  const where = `niveau « ${id} »`;

  const under = l.underlay as Record<string, unknown> | undefined;
  if (under !== undefined) {
    if (typeof under.url !== 'string' || !under.url) {
      fail(`${where} : \`underlay.url\` est requis dès qu'un calque est déclaré.`);
    }
    num(under.scale, 0.02, `${where}, underlay.scale`, 1e-6);
    if (under.origin !== undefined) point(under.origin, `${where}, underlay.origin`);
  }

  return {
    ...(raw as Level),
    id,
    name: typeof l.name === 'string' && l.name ? l.name : id,
    elevation: num(l.elevation, 0, `${where}, elevation`),
    wallHeight: num(l.wallHeight, DEFAULTS.wallHeight, `${where}, wallHeight`, 0.1),
    walls: Array.isArray(l.walls) ? l.walls.map((w, i) => wall(w, id, i)) : [],
    rooms: Array.isArray(l.rooms) ? l.rooms.map((r, i) => room(r, id, i)) : [],
    underlay: under
      ? {
          url: under.url as string,
          origin: (under.origin ? point(under.origin, `${where}, underlay.origin`) : [0, 0]) as Point,
          scale: num(under.scale, 0.02, `${where}, underlay.scale`, 1e-6),
          rotation: num(under.rotation, 0, `${where}, underlay.rotation`),
          opacity: num(under.opacity, 0.45, `${where}, underlay.opacity`, 0),
        }
      : undefined,
  };
}

function camera(raw: unknown, index: number, levelIds: Set<string>): CameraConfig {
  if (!raw || typeof raw !== 'object') {
    return fail(`cameras[${index}] : attendu un bloc, reçu ${describe(raw)}.`);
  }
  const c = raw as Record<string, unknown>;
  const name = c.name;
  if (typeof name !== 'string' || !name.trim()) {
    return fail(
      `cameras[${index}] : il manque \`name\`. ` +
        `C'est le nom Frigate de la caméra, tel qu'il apparaît dans \`frigate/<nom>/…\`.`,
    );
  }
  const where = `caméra « ${name} »`;

  if (c.position === undefined) {
    return fail(
      `${where} : il manque \`position\`. ` +
        `C'est l'emplacement de la caméra sur le plan, en mètres : \`position: [x, y]\`. ` +
        `Le mode Plan permet de la poser à la souris.`,
    );
  }

  const lvl = c.level;
  if (lvl !== undefined) {
    if (typeof lvl !== 'string') fail(`${where} : \`level\` doit être l'identifiant d'un niveau.`);
    else if (!levelIds.has(lvl)) {
      fail(
        `${where} : le niveau « ${lvl} » n'existe pas. ` +
          `Niveaux déclarés : ${[...levelIds].join(', ') || 'aucun'}.`,
      );
    }
  }

  const cal = c.calibration as Record<string, unknown> | undefined;
  if (cal !== undefined) {
    if (!Array.isArray(cal.image) || cal.image.length < 4) {
      fail(`${where} : \`calibration.image\` attend 4 points en fractions de l'image.`);
    }
    if (!Array.isArray(cal.ground) || cal.ground.length < 4) {
      fail(`${where} : \`calibration.ground\` attend 4 points du plan, en mètres.`);
    }
    (cal.image as unknown[]).slice(0, 4).forEach((p, i) => {
      const q = point(p, `${where}, calibration.image[${i}]`);
      if (q[0] < -0.5 || q[0] > 1.5 || q[1] < -0.5 || q[1] > 1.5) {
        fail(
          `${where}, calibration.image[${i}] : [${q}] semble être en pixels. ` +
            `Ces points vont de 0 à 1 : divisez par la largeur et la hauteur de l'image.`,
        );
      }
    });
    (cal.ground as unknown[]).slice(0, 4).forEach((p, i) =>
      point(p, `${where}, calibration.ground[${i}]`),
    );
  }

  return {
    ...(raw as CameraConfig),
    name,
    position: point(c.position, `${where}, position`),
    azimuth: num(c.azimuth, DEFAULTS.azimuth, `${where}, azimuth`),
    fov: num(c.fov, DEFAULTS.fov, `${where}, fov`, 1),
    range: num(c.range, DEFAULTS.range, `${where}, range`, 0.5),
    height: num(c.height, DEFAULTS.height, `${where}, height`),
  };
}

export interface ValidationResult {
  config: SemaphoreConfig;
  /** True when the input was a map-era config that has just been converted. */
  migrated: boolean;
}

export function validateConfig(input: SemaphoreConfig): ValidationResult {
  if (!input || typeof input !== 'object') return fail('Configuration vide.');

  const rawInput = input as unknown as Record<string, unknown>;
  const migrated = isGeographic(rawInput);
  const raw = (migrated ? migrateFromGeographic(rawInput) : rawInput) as unknown as SemaphoreConfig;

  const levels: Level[] = Array.isArray(raw.levels) && raw.levels.length
    ? raw.levels.map(level)
    : [{ id: 'rdc', name: 'Rez-de-chaussée', elevation: 0, walls: [], rooms: [] }];

  const clashLevel = levels.map((l) => l.id).find((id, i, all) => all.indexOf(id) !== i);
  if (clashLevel) fail(`Deux niveaux portent l'identifiant « ${clashLevel} ».`);

  const levelIds = new Set(levels.map((l) => l.id));
  // An empty scene is legitimate now: you add the card, then draw. Refusing to
  // start until a camera exists would make the editor unreachable.
  const cameras = Array.isArray(raw.cameras)
    ? raw.cameras.map((c, i) => camera(c, i, levelIds))
    : [];

  const clashCam = cameras.map((c) => c.name).find((n, i, all) => all.indexOf(n) !== i);
  if (clashCam) fail(`Deux caméras portent le nom « ${clashCam} ».`);

  return {
    migrated,
    config: {
      ...raw,
      grid: num(raw.grid, DEFAULTS.grid, '`grid`', 0),
      levels,
      cameras,
    },
  };
}
