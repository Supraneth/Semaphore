import type {
  CameraConfig,
  LevelConfig,
  LngLat,
  RoomConfig,
  SemaphoreConfig,
} from './types';

/**
 * Config validation.
 *
 * A Lovelace card gets its configuration from a human typing YAML, so a field
 * will be missing, misspelled or the wrong shape sooner or later. Without this,
 * the first thing that touches the bad value throws — and what the user sees is
 * `Cannot read properties of undefined (reading '0')` above an empty map, which
 * names neither the camera nor the field at fault.
 *
 * Everything here therefore fails with a message that says which entry is wrong
 * and what was expected. Optional numbers get defaults instead of errors: a
 * camera with only a name and a position is a perfectly reasonable thing to
 * write, and should draw a sector.
 */

const DEFAULTS = {
  azimuth: 0,
  fov: 90,
  range: 20,
  height: 3,
  wallHeight: 2.6,
} as const;

export class ConfigError extends Error {}

const fail = (message: string): never => {
  throw new ConfigError(message);
};

/** A position is two finite numbers in `[lng, lat]` order, in that range. */
function coordinate(value: unknown, where: string): LngLat {
  if (!Array.isArray(value) || value.length < 2) {
    return fail(`${where} : attendu [longitude, latitude], reçu ${describe(value)}.`);
  }
  const [lng, lat] = value;
  if (typeof lng !== 'number' || typeof lat !== 'number' || !isFinite(lng) || !isFinite(lat)) {
    return fail(`${where} : longitude et latitude doivent être des nombres.`);
  }
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    return fail(
      `${where} : [${lng}, ${lat}] est hors du monde. ` +
        `L'ordre est [longitude, latitude] — l'inverse de ce qu'affiche Google Maps.`,
    );
  }
  return [lng, lat];
}

function describe(value: unknown): string {
  if (value === undefined) return 'rien';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `une liste de ${value.length} élément(s)`;
  return `${typeof value} (${JSON.stringify(value)})`;
}

function number(value: unknown, fallback: number, where: string, min?: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !isFinite(value)) {
    return fail(`${where} : attendu un nombre, reçu ${describe(value)}.`);
  }
  if (min !== undefined && value < min) {
    return fail(`${where} : doit être au moins ${min}, reçu ${value}.`);
  }
  return value;
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
        `C'est l'emplacement de la caméra : \`position: [longitude, latitude]\`. ` +
        `Le bouton « Plan » permet de la poser à la souris plutôt qu'à la main.`,
    );
  }

  const level = c.level;
  if (level !== undefined) {
    if (typeof level !== 'string') {
      return fail(`${where} : \`level\` doit être l'identifiant d'un niveau.`);
    }
    if (!levelIds.has(level)) {
      return fail(
        `${where} : le niveau « ${level} » n'existe pas. ` +
          `Niveaux déclarés : ${[...levelIds].join(', ') || 'aucun'}.`,
      );
    }
  }

  const resolution = c.resolution;
  if (resolution !== undefined) {
    if (
      !Array.isArray(resolution) ||
      resolution.length < 2 ||
      resolution.some((n) => typeof n !== 'number' || !(n > 0))
    ) {
      return fail(`${where} : \`resolution\` attend [largeur, hauteur] en pixels.`);
    }
  }

  const calibration = c.calibration as Record<string, unknown> | undefined;
  if (calibration !== undefined) {
    const image = calibration.image;
    const ground = calibration.ground;
    if (!Array.isArray(image) || image.length < 4 || !Array.isArray(ground) || ground.length < 4) {
      return fail(
        `${where} : \`calibration\` attend 4 points \`image\` et 4 points \`ground\`, ` +
          `dans le même ordre.`,
      );
    }
    image.slice(0, 4).forEach((p, i) => coordinateInImage(p, `${where}, calibration.image[${i}]`));
    ground.slice(0, 4).forEach((p, i) => coordinate(p, `${where}, calibration.ground[${i}]`));
  }

  return {
    ...(raw as CameraConfig),
    name,
    position: coordinate(c.position, `${where}, position`),
    azimuth: number(c.azimuth, DEFAULTS.azimuth, `${where}, azimuth`),
    fov: number(c.fov, DEFAULTS.fov, `${where}, fov`, 1),
    range: number(c.range, DEFAULTS.range, `${where}, range`, 1),
    height: number(c.height, DEFAULTS.height, `${where}, height`),
  };
}

/** Calibration image points are fractions of the frame, not degrees. */
function coordinateInImage(value: unknown, where: string): void {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.some((n) => typeof n !== 'number' || !isFinite(n))
  ) {
    fail(`${where} : attendu [x, y] en fractions de l'image, reçu ${describe(value)}.`);
  }
  const [x, y] = value as number[];
  if (x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5) {
    fail(
      `${where} : [${x}, ${y}] semble être en pixels. ` +
        `Ces points vont de 0 à 1 : divisez par la largeur et la hauteur de l'image.`,
    );
  }
}

function room(raw: unknown, levelId: string, index: number): RoomConfig {
  if (!raw || typeof raw !== 'object') {
    return fail(`niveau « ${levelId} », rooms[${index}] : attendu un bloc.`);
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id ? r.id : `${levelId}-${index + 1}`;
  const where = `niveau « ${levelId} », pièce « ${id} »`;

  if (!Array.isArray(r.ring) || r.ring.length < 3) {
    return fail(
      `${where} : \`ring\` doit contenir au moins 3 points. ` +
        `Ne répétez pas le premier point à la fin, le contour se ferme tout seul.`,
    );
  }

  return {
    ...(raw as RoomConfig),
    id,
    name: typeof r.name === 'string' && r.name ? r.name : `Pièce ${index + 1}`,
    ring: (r.ring as unknown[]).map((p, i) => coordinate(p, `${where}, ring[${i}]`)),
  };
}

function level(raw: unknown, index: number): LevelConfig {
  if (!raw || typeof raw !== 'object') {
    return fail(`levels[${index}] : attendu un bloc, reçu ${describe(raw)}.`);
  }
  const l = raw as Record<string, unknown>;
  const id = typeof l.id === 'string' && l.id ? l.id : `level-${index + 1}`;
  const where = `niveau « ${id} »`;

  const plan = l.plan as Record<string, unknown> | undefined;
  if (plan !== undefined) {
    if (typeof plan.url !== 'string' || !plan.url) {
      fail(`${where} : \`plan.url\` est requis dès qu'un \`plan\` est déclaré.`);
    }
    if (!Array.isArray(plan.corners) || plan.corners.length < 4) {
      fail(
        `${where} : \`plan.corners\` attend 4 coins, dans l'ordre ` +
          `haut-gauche, haut-droit, bas-droit, bas-gauche.`,
      );
    }
    (plan.corners as unknown[])
      .slice(0, 4)
      .forEach((p, i) => coordinate(p, `${where}, plan.corners[${i}]`));
  }

  return {
    ...(raw as LevelConfig),
    id,
    name: typeof l.name === 'string' && l.name ? l.name : id,
    elevation: number(l.elevation, 0, `${where}, elevation`),
    wallHeight: number(l.wallHeight, DEFAULTS.wallHeight, `${where}, wallHeight`, 0),
    rooms: Array.isArray(l.rooms) ? l.rooms.map((r, i) => room(r, id, i)) : undefined,
  };
}

/**
 * Validates and fills in a raw Lovelace config.
 *
 * Throws `ConfigError` with a message naming the offending entry. The card
 * shows that message instead of an empty map.
 */
export function validateConfig(raw: SemaphoreConfig): SemaphoreConfig {
  if (!raw || typeof raw !== 'object') {
    return fail('Configuration vide.');
  }

  const style = raw['map-style'] ?? 'hybrid';
  if (!['hybrid', 'streets', 'topo', 'demo'].includes(style)) {
    fail(`\`map-style\` : « ${style} » inconnu. Attendu hybrid, streets, topo ou demo.`);
  }
  if (!raw['maptiler-api-key'] && style !== 'demo') {
    fail(
      'Ajoutez votre clé MapTiler dans `maptiler-api-key` — elle est gratuite sur ' +
        'maptiler.com/cloud. Ou passez `map-style: demo` pour un aperçu sans clé, ' +
        'sans imagerie ni bâtiments.',
    );
  }

  const levels: LevelConfig[] = Array.isArray(raw.levels) && raw.levels.length
    ? raw.levels.map(level)
    : [{ id: 'ground', name: 'Extérieur', elevation: 0 }];

  const duplicate = levels.map((l) => l.id).find((id, i, all) => all.indexOf(id) !== i);
  if (duplicate) fail(`Deux niveaux portent l'identifiant « ${duplicate} ».`);

  if (!Array.isArray(raw.cameras) || !raw.cameras.length) {
    fail(
      'Ajoutez au moins une caméra sous `cameras`. ' +
        'Chacune a besoin au minimum de `name` et `position`.',
    );
  }

  const levelIds = new Set(levels.map((l) => l.id));
  const cameras = raw.cameras.map((c, i) => camera(c, i, levelIds));

  const clash = cameras.map((c) => c.name).find((n, i, all) => all.indexOf(n) !== i);
  if (clash) fail(`Deux caméras portent le nom « ${clash} ».`);

  return { ...raw, 'map-style': style, levels, cameras };
}
