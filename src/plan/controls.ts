import type { View } from './view';

/**
 * Turning the scene when nobody is editing it.
 *
 * The plan editor has always owned pan, orbit and zoom, which meant a dashboard
 * card could only ever be seen from the angle its config was written with: the
 * gestures existed and were unreachable without entering an edit mode that has
 * no business being on a dashboard. These are the same gestures, on their own,
 * with a touch story — a card is read on a phone at least as often as on a
 * desktop, and a right-drag does not exist there.
 *
 * Deliberately not a click handler. The camera chips are DOM elements floating
 * above the canvas, so selection is theirs and this file never has to guess
 * whether a press was a tap or the start of a drag.
 */

interface Spot {
  x: number;
  y: number;
}

export interface ControlCallbacks {
  /** The view moved. Repaint, and stop claiming a preset is active. */
  onChange: () => void;
}

/** Degrees of yaw per pixel dragged. Roughly a half-turn across a wide card. */
const YAW_PER_PIXEL = 0.4;
const PITCH_PER_PIXEL = 0.35;
const WHEEL_STEP = 1.12;

export class ViewControls {
  private pointers = new Map<number, Spot>();
  private mode: 'orbit' | 'pan' | 'pinch' | null = null;
  private last: Spot = { x: 0, y: 0 };
  private spread = 0;
  private bound = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private view: View,
    private cb: ControlCallbacks,
  ) {}

  attach(): void {
    if (this.bound) return;
    this.bound = true;
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    this.pointers.clear();
    this.mode = null;
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  private local(ev: PointerEvent | WheelEvent): Spot {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private centre(): Spot {
    let x = 0;
    let y = 0;
    for (const p of this.pointers.values()) {
      x += p.x;
      y += p.y;
    }
    const n = this.pointers.size || 1;
    return { x: x / n, y: y / n };
  }

  private distance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private onDown = (ev: PointerEvent): void => {
    this.canvas.setPointerCapture(ev.pointerId);
    this.pointers.set(ev.pointerId, this.local(ev));

    if (this.pointers.size >= 2) {
      // Two fingers do what two fingers do everywhere else: pinch to zoom,
      // slide to move. Orbiting on two fingers as well would make every pinch
      // spin the house.
      this.mode = 'pinch';
      this.spread = this.distance();
      this.last = this.centre();
      return;
    }

    this.mode =
      ev.button === 1 || ev.button === 2 || ev.altKey || ev.shiftKey ? 'pan' : 'orbit';
    this.last = this.local(ev);
  };

  private onMove = (ev: PointerEvent): void => {
    if (!this.pointers.has(ev.pointerId)) return;
    const p = this.local(ev);
    this.pointers.set(ev.pointerId, p);
    const view = this.view;

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const spread = this.distance();
      const centre = this.centre();
      if (this.spread > 0 && spread > 0) view.zoomAt(centre.x, centre.y, spread / this.spread);
      this.spread = spread;
      view.panBy(centre.x - this.last.x, centre.y - this.last.y);
      this.last = centre;
    } else if (this.mode === 'orbit') {
      view.yaw += (p.x - this.last.x) * YAW_PER_PIXEL;
      // `refresh` clamps the pitch short of edge-on, where the floor plane
      // collapses to a line and `unproject` would divide by zero.
      view.pitch -= (p.y - this.last.y) * PITCH_PER_PIXEL;
      view.refresh();
      this.last = p;
    } else if (this.mode === 'pan') {
      view.panBy(p.x - this.last.x, p.y - this.last.y);
      this.last = p;
    } else {
      return;
    }

    this.cb.onChange();
  };

  private onUp = (ev: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(ev.pointerId)) {
      this.canvas.releasePointerCapture(ev.pointerId);
    }
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size === 1) {
      // Lifting one finger of a pinch must not hand the remaining one a stale
      // anchor, or the scene jumps by the distance between the two.
      this.mode = 'orbit';
      this.last = this.centre();
    } else if (!this.pointers.size) {
      this.mode = null;
    }
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const p = this.local(ev);
    this.view.zoomAt(p.x, p.y, ev.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
    this.cb.onChange();
  };

  private onContextMenu = (ev: Event): void => ev.preventDefault();
}
