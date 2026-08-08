import type { Level } from '../types';

/**
 * Undo and redo.
 *
 * Whole-document snapshots rather than inverse commands. A floor plan is a few
 * kilobytes of plain data, so a hundred snapshots cost less than one texture —
 * and the alternative, an undo method per edit, is where editors accumulate the
 * bugs nobody can reproduce.
 *
 * `capture()` is called immediately *before* a mutation and pushes the state as
 * it is right now. That ordering is the whole contract: the stack holds states
 * you can return to, and the live document is never in it. An earlier version
 * also cached "the last captured state" and compared against that, which made
 * the cache lag one mutation behind and sent the first undo two steps back.
 */

const LIMIT = 120;

export class History {
  private past: string[] = [];
  private future: string[] = [];

  constructor(private read: () => Level[], private write: (levels: Level[]) => void) {}

  private serialise(): string {
    return JSON.stringify(this.read());
  }

  /**
   * Records a restore point. Call before mutating.
   *
   * A drag calls this once at pointer-down rather than on every move, which is
   * what makes one gesture equal one undo.
   */
  capture(): void {
    const now = this.serialise();
    // Two captures with nothing between them are one restore point.
    if (this.past[this.past.length - 1] === now) return;
    this.past.push(now);
    if (this.past.length > LIMIT) this.past.shift();
    this.future.length = 0;
  }

  /**
   * Drops the most recent restore point if the document has come back to it —
   * a drag that ended where it started should leave no trace in the stack.
   */
  settle(): void {
    if (this.past.length && this.past[this.past.length - 1] === this.serialise()) {
      this.past.pop();
    }
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (previous === undefined) return false;
    this.future.push(this.serialise());
    this.write(JSON.parse(previous) as Level[]);
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.serialise());
    this.write(JSON.parse(next) as Level[]);
    return true;
  }

  reset(): void {
    this.past.length = 0;
    this.future.length = 0;
  }
}
