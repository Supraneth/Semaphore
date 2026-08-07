import '../src/semaphore-card';
import { createMockHass, registerCardStub, registerStreamStub } from './mock-hass';
import type { SemaphoreConfig } from '../src/types';

registerCardStub();
registerStreamStub();

/**
 * The scene. Move `HOME` to your own coordinates and the whole demo follows —
 * the basemap, the harvested building footprints, and the camera placements are
 * all relative to it.
 */
const HOME: [number, number] = [-2.75, 47.6602];

const off = (dx: number, dy: number): [number, number] => [
  HOME[0] + dx / (111320 * Math.cos((HOME[1] * Math.PI) / 180)),
  HOME[1] + dy / 110540,
];

const mapTilerKey =
  new URLSearchParams(location.search).get('key') ??
  localStorage.getItem('maptiler-key') ??
  '';

const config: SemaphoreConfig = {
  type: 'custom:semaphore-card',
  'maptiler-api-key': mapTilerKey,
  // No key means the keyless demo basemap rather than a refusal to start.
  'map-style': mapTilerKey ? 'hybrid' : 'demo',
  'timeline-hours': 6,
  'orbit-speed': 0.9,
  levels: [
    { id: 'exterieur', name: 'Extérieur', elevation: 0 },
    {
      id: 'rdc',
      name: 'Rez-de-chaussée',
      elevation: 0.2,
      // Any image works; swap in your own plan and adjust the corners.
      plan: {
        url: 'https://placehold.co/900x600/EFE7D4/0C2233?text=Plan+RDC',
        corners: [off(-18, 14), off(18, 14), off(18, -10), off(-18, -10)],
      },
      wallHeight: 2.6,
      rooms: [
        {
          id: 'rdc-salon',
          name: 'Salon',
          ring: [off(-14, 10), off(-1, 10), off(-1, -2), off(-14, -2)],
        },
        {
          id: 'rdc-cuisine',
          name: 'Cuisine',
          ring: [off(-1, 10), off(11, 10), off(11, -2), off(-1, -2)],
        },
        {
          id: 'rdc-entree',
          name: 'Entrée',
          ring: [off(-14, -2), off(-1, -2), off(-1, -9), off(-14, -9)],
        },
      ],
    },
  ],
  cameras: [
    { name: 'allee', label: 'Allée', position: off(-22, -18), azimuth: 38, fov: 96, range: 30, height: 3.2 },
    { name: 'jardin', label: 'Jardin', position: off(26, -14), azimuth: 305, fov: 88, range: 34, height: 3 },
    { name: 'terrasse', label: 'Terrasse', position: off(14, 12), azimuth: 200, fov: 110, range: 24, height: 2.8 },
    { name: 'portail', label: 'Portail', position: off(-26, 4), azimuth: 95, fov: 70, range: 28, height: 3.4 },
    {
      name: 'salon',
      label: 'Salon',
      position: off(-6, 2),
      level: 'rdc',
      azimuth: 45,
      fov: 110,
      range: 9,
      height: 2.4,
    },
  ],
};

// Calibrate one camera so the ground blips have something to project onto.
config.cameras[0].resolution = [1280, 720];
config.cameras[0].calibration = {
  image: [
    [0.08, 0.55],
    [0.92, 0.55],
    [0.98, 0.99],
    [0.02, 0.99],
  ],
  ground: [off(-30, -8), off(-14, -8), off(-16, -20), off(-28, -20)],
};

const card = document.createElement('semaphore-card') as any;
card.setConfig(config);
card.hass = createMockHass({
  resolution: config.cameras[0].resolution,
  // Paths are normalised image coordinates and stay inside the calibrated quad
  // above (u 0.02–0.98, v 0.55–0.99). A homography extrapolated past its own
  // correspondences is still valid arithmetic and still complete nonsense.
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

const mount = document.getElementById('app')!;

// Without a key the engine falls back to MapLibre's keyless demo style: no
// imagery and no buildings, so nothing can actually be placed, but the
// sectors, the blips and the whole card run. A banner says so rather than the
// bench refusing to start.
if (!mapTilerKey) {
  const note = document.createElement('p');
  note.style.cssText =
    'font:400 14px/1.6 system-ui;max-width:56ch;margin:0 auto 16px;color:#E2A23A';
  note.innerHTML =
    'Pas de clé MapTiler : fond de carte de démonstration, sans imagerie ni bâtiments. ' +
    'Ajoutez <code>?key=VOTRE_CLE</code> à l\'URL pour la vraie scène — ' +
    'la clé est gratuite sur maptiler.com/cloud.';
  mount.appendChild(note);
} else {
  localStorage.setItem('maptiler-key', mapTilerKey);
}
mount.appendChild(card);
