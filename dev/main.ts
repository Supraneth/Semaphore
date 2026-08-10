import '../src/semaphore-card';
import { createMockHass, registerCardStub, registerStreamStub } from './mock-hass';
import { sampleHouse } from '../studio/project';

/**
 * The card, running against a fake Home Assistant.
 *
 * The house it draws is the same one the editor opens with — one description,
 * so a change to the example shows up in both places. Draw your own in the
 * editor at `/` and import the YAML here if you want the card to render it.
 */

registerCardStub();
registerStreamStub();

const config = sampleHouse();

const card = document.createElement('semaphore-card') as any;
card.setConfig(config);
card.hass = createMockHass({
  resolution: config.cameras[0].resolution,
  // Every opening in the plan that names a sensor gets one that answers.
  openings: config.levels.flatMap(
    (l) =>
      l.walls?.flatMap((w) => (w.openings ?? []).map((o) => o.entity ?? '')) ?? [],
  ).filter(Boolean),
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
