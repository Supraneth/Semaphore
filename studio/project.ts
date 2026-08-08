import type { Point, SemaphoreConfig, Wall } from '../src/types';
import { validateConfig, ConfigError } from '../src/config';
import { parseYaml, YamlError } from './yaml-parse';
import { dist } from '../src/plan/geometry';

/**
 * What the standalone editor works on: a whole card configuration, plus the
 * plumbing to start one, save one, and read one back.
 *
 * The card gets its config from Home Assistant and never has to invent one.
 * Here the config *is* the document, so this module owns the blank page, the
 * worked example, the browser-local save, and the checks that catch the
 * mistakes Home Assistant would otherwise report as a card that will not load.
 */

const STORAGE_KEY = 'semaphore-studio/v1';

export function blankProject(): SemaphoreConfig {
  return {
    type: 'custom:semaphore-card',
    grid: 0.5,
    levels: [
      { id: 'rdc', name: 'Rez-de-chaussée', elevation: 0, wallHeight: 2.5, walls: [], rooms: [] },
    ],
    cameras: [],
  };
}

/**
 * A worked example: 9 × 7 m on two storeys, in metres.
 *
 * Origin at the front-left corner, x to the right, y away from the street. It
 * exists so the first thing the editor shows is a house rather than an empty
 * grid — the difference between "what am I looking at" and "ah, like that".
 */
export function sampleHouse(): SemaphoreConfig {
  let seq = 0;
  const wall = (a: Point, b: Point, openings?: Wall['openings']): Wall => ({
    id: `mur-${++seq}`,
    a,
    b,
    thickness: 0.2,
    openings,
  });

  return {
    type: 'custom:semaphore-card',
    grid: 0.5,
    'timeline-hours': 6,
    'orbit-speed': 0,
    levels: [
      {
        id: 'rdc',
        name: 'Rez-de-chaussée',
        elevation: 0,
        wallHeight: 2.5,
        walls: [
          wall([0, 0], [9, 0], [
            { id: 'porte-entree', kind: 'door', at: 3.6, width: 1, sill: 0, head: 2.1 },
          ]),
          wall([9, 0], [9, 7]),
          wall([9, 7], [0, 7], [
            { id: 'baie', kind: 'window', at: 2, width: 2.4, sill: 0.9, head: 2.2 },
          ]),
          wall([0, 7], [0, 0]),
          wall([5, 0], [5, 7], [
            { id: 'porte-salon', kind: 'door', at: 4.2, width: 0.9, sill: 0, head: 2.1 },
          ]),
          wall([0, 4], [5, 4], [
            { id: 'porte-cuisine', kind: 'pass', at: 1.4, width: 1.2, sill: 0, head: 2.1 },
          ]),
        ],
        rooms: [
          { id: 'salon', name: 'Salon', ring: [[5, 0], [9, 0], [9, 7], [5, 7]] },
          { id: 'cuisine', name: 'Cuisine', ring: [[0, 4], [5, 4], [5, 7], [0, 7]] },
          { id: 'entree', name: 'Entrée', ring: [[0, 0], [5, 0], [5, 4], [0, 4]] },
        ],
      },
      {
        id: 'etage',
        name: 'Étage',
        elevation: 2.7,
        wallHeight: 2.4,
        walls: [
          wall([0, 0], [9, 0]),
          wall([9, 0], [9, 7]),
          wall([9, 7], [0, 7]),
          wall([0, 7], [0, 0]),
          wall([4.5, 0], [4.5, 7], [
            { id: 'porte-chambre', kind: 'door', at: 5.5, width: 0.9 },
          ]),
        ],
        rooms: [
          { id: 'chambre', name: 'Chambre', ring: [[0, 0], [4.5, 0], [4.5, 7], [0, 7]] },
          { id: 'bureau', name: 'Bureau', ring: [[4.5, 0], [9, 0], [9, 7], [4.5, 7]] },
        ],
      },
    ],
    cameras: [
      {
        name: 'entree',
        label: 'Entrée',
        position: [2.4, 0.4],
        level: 'rdc',
        height: 2.3,
        azimuth: 20,
        fov: 100,
        range: 9,
        resolution: [1280, 720],
        // Four points on the entrance floor, so the blips have somewhere to land.
        calibration: {
          image: [
            [0.08, 0.55],
            [0.92, 0.55],
            [0.98, 0.99],
            [0.02, 0.99],
          ],
          ground: [
            [0.6, 3.6],
            [4.4, 3.6],
            [3.6, 1.0],
            [1.4, 1.0],
          ],
        },
      },
      { name: 'salon', label: 'Salon', position: [8.6, 0.5], level: 'rdc', height: 2.3, azimuth: 330, fov: 95, range: 8 },
      { name: 'cuisine', label: 'Cuisine', position: [0.4, 6.6], level: 'rdc', height: 2.3, azimuth: 135, fov: 90, range: 6 },
      { name: 'palier', label: 'Palier', position: [4.5, 3.5], level: 'etage', height: 2.2, azimuth: 180, fov: 110, range: 7 },
    ],
  };
}

// ---- browser-local persistence --------------------------------------------

/**
 * Saves to `localStorage`.
 *
 * The editor has no server and no file handle. A reload that lost an evening's
 * tracing would make the tool unusable, so every change is written straight
 * back; the document is a few kilobytes of JSON, which is nothing.
 */
export function saveProject(config: SemaphoreConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* private browsing, or a full quota: the session still works, it just
       will not survive a reload. Nothing here is worth interrupting for. */
  }
}

export function restoreProject(): SemaphoreConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return validateConfig(JSON.parse(raw) as SemaphoreConfig).config;
  } catch {
    // A snapshot from an older shape is not worth a crash on boot.
    return null;
  }
}

export function forgetProject(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to forget */
  }
}

// ---- import ---------------------------------------------------------------

/**
 * Reads pasted YAML into a validated config.
 *
 * Accepts the whole card block, and also a bare `levels:` / `cameras:` block,
 * because that is what the in-card "Copier le YAML" button produces and it
 * would be perverse not to accept our own output.
 */
export function importYaml(text: string): SemaphoreConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError) throw new Error(`YAML illisible, ${err.message}`);
    throw err;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error("Ce YAML ne décrit pas une carte : attendu un bloc « type: … » ou « levels: … ».");
  }

  const record = raw as Record<string, unknown>;
  // A dashboard view pasted whole: dig out the first Sémaphore card in it.
  const source = findCard(record) ?? record;

  // Tested before the merge with the blank project, or the blank project's own
  // empty `levels` would make any YAML at all look like a plan.
  if (!Array.isArray(source.levels) && !Array.isArray(source.cameras)) {
    throw new Error(
      'Ce YAML ne contient ni « levels » ni « cameras ». ' +
        'Copiez le bloc de la carte Sémaphore, pas le tableau de bord entier.',
    );
  }

  const config = { ...blankProject(), ...source } as SemaphoreConfig;
  config.type = 'custom:semaphore-card';
  return validateConfig(config).config;
}

function findCard(record: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof record.type === 'string' && record.type.includes('semaphore')) return record;
  const cards = record.cards;
  if (!Array.isArray(cards)) return null;
  for (const card of cards) {
    if (card && typeof card === 'object') {
      const found = findCard(card as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}

// ---- checks ---------------------------------------------------------------

export type CheckLevel = 'error' | 'warning' | 'info';

export interface Check {
  level: CheckLevel;
  text: string;
}

/**
 * Everything that is legal but will disappoint.
 *
 * `validateConfig` refuses configs Home Assistant cannot load. These are the
 * other half: configs that load fine and then do nothing useful, which is the
 * failure that is hardest to diagnose from inside Home Assistant because there
 * is no error to read — just a card that sits there.
 */
export function checkProject(config: SemaphoreConfig): Check[] {
  const out: Check[] = [];

  try {
    validateConfig(structuredClone(config));
  } catch (err) {
    out.push({
      level: 'error',
      text: err instanceof ConfigError ? err.message : String(err),
    });
  }

  if (!config.cameras.length) {
    out.push({ level: 'warning', text: "Aucune caméra : la carte n'affichera que le plan." });
  }

  for (const cam of config.cameras) {
    if (!/^[a-z0-9_-]+$/.test(cam.name)) {
      out.push({
        level: 'warning',
        text: `Caméra « ${cam.name} » : le nom doit être celui de Frigate, tel qu'il apparaît dans « frigate/<nom>/… » — minuscules, chiffres, tiret ou souligné.`,
      });
    }
    if (!cam.calibration) {
      out.push({
        level: 'info',
        text: `Caméra « ${cam.name} » : sans calibration, le secteur s'allume mais les détections ne sont pas posées au sol.`,
      });
    }
  }

  for (const level of config.levels) {
    const walls = level.walls ?? [];
    const rooms = level.rooms ?? [];
    if (rooms.length && !walls.length) {
      out.push({
        level: 'warning',
        text: `Niveau « ${level.name} » : des pièces mais aucun mur. Rien ne bloquera la vue des caméras — utilisez « Murs autour » sur chaque pièce.`,
      });
    }
    for (const wall of walls) {
      const total = dist(wall.a, wall.b);
      for (const o of wall.openings ?? []) {
        if (o.at + o.width > total + 1e-6) {
          out.push({
            level: 'warning',
            text: `Niveau « ${level.name} », mur « ${wall.id} » : l'ouverture déborde du mur (${(o.at + o.width).toFixed(2)} m pour ${total.toFixed(2)} m) et sera rognée.`,
          });
        }
      }
    }
  }

  const orphans = config.cameras.filter(
    (c) => c.level && !config.levels.some((l) => l.id === c.level),
  );
  for (const cam of orphans) {
    out.push({ level: 'error', text: `Caméra « ${cam.name} » : le niveau « ${cam.level} » n'existe pas.` });
  }

  return out;
}
