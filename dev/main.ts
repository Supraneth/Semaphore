import '../src/semaphore-card';
import { createMockHass, registerCardStub, registerStreamStub } from './mock-hass';
import type { Point, SemaphoreConfig, Wall } from '../src/types';

registerCardStub();
registerStreamStub();

/**
 * A small house, in metres.
 *
 * Origin at the front-left corner, x to the right, y away from the street.
 * Everything below is the kind of thing the editor produces — the point of
 * writing it out by hand once is that it stays readable, which a list of
 * seven-decimal coordinates never was.
 */

let wallSeq = 0;
const wall = (a: Point, b: Point, openings?: Wall['openings']): Wall => ({
  id: `mur-${++wallSeq}`,
  a,
  b,
  thickness: 0.2,
  openings,
});

// 9 × 7 m footprint, split by a spine wall with a door in it.
const walls: Wall[] = [
  wall([0, 0], [9, 0], [{ id: 'porte-entree', kind: 'door', at: 3.6, width: 1, sill: 0, head: 2.1 }]),
  wall([9, 0], [9, 7]),
  wall([9, 7], [0, 7], [{ id: 'baie', kind: 'window', at: 2, width: 2.4, sill: 0.9, head: 2.2 }]),
  wall([0, 7], [0, 0]),
  wall([5, 0], [5, 7], [{ id: 'porte-salon', kind: 'door', at: 4.2, width: 0.9, sill: 0, head: 2.1 }]),
  wall([0, 4], [5, 4], [{ id: 'porte-cuisine', kind: 'pass', at: 1.4, width: 1.2, sill: 0, head: 2.1 }]),
];

const config: SemaphoreConfig = {
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
      walls,
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
        wall([4.5, 0], [4.5, 7], [{ id: 'porte-chambre', kind: 'door', at: 5.5, width: 0.9 }]),
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

const card = document.createElement('semaphore-card') as any;
card.setConfig(config);
card.hass = createMockHass({
  resolution: config.cameras[0].resolution,
  // Normalised image coordinates, inside the calibrated quad above.
  cameras: config.cameras.map((c, i) => ({
    name: c.name,
    path: Array.from({ length: 22 }, (_, k) => {
      const t = k / 21;
      return [0.12 + t * 0.76, 0.62 + Math.sin(t * Math.PI) * 0.26 + i * 0.01] as [
        number,
        number,
      ];
    }),
  })),
});

document.getElementById('app')!.appendChild(card);
