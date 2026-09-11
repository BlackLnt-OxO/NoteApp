import type { PdfStroke } from './PdfTypes';

type Point = { x: number; y: number };
export interface PencilGrainMark {
  a: Point;
  b: Point;
  /** Arc distance at which the stroke has grown far enough past this mark. */
  readyAt: number;
}

/** A seeded, distance-spaced grain stream. Only the short unfinished tail is
 * retained; historical grain lives in coverage tiles. Previewing the raw tip
 * never advances this state, so pointer batching cannot change saved pixels. */
export class StreamingPencilGrain {
  readonly width: number;
  private readonly spacing: number;
  private readonly pad: number;
  private seed = 2166136261;
  private distance = 0;
  private next = 0;
  private pending: PencilGrainMark[] = [];
  readonly stats = { candidates: 0, lastCandidates: 0, pending: 0 };

  constructor(private readonly stroke: PdfStroke) {
    this.width = Math.max(0.35, stroke.size * 0.08);
    // Match the legacy grain's approximate density at middle pressure without
    // re-spacing old marks whenever the whole-stroke average pressure changes.
    this.spacing = Math.max(1, stroke.size * 0.196);
    this.pad = Math.max(3, stroke.size * 0.6);
    for (const c of stroke.id) this.seed = Math.imul(this.seed ^ c.charCodeAt(0), 16777619);
  }

  private random(index: number, channel: number): number {
    let n = this.seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  private segment(a: Point, b: Point) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const end = this.distance + length;
    let next = this.next;
    const marks: PencilGrainMark[] = [];
    if (length < 1e-8) return { end, next, marks };
    const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    for (;;) {
      const d = (next + 0.2 + this.random(next, 0) * 0.6) * this.spacing;
      if (d > end) break;
      const index = next++;
      if (d < this.pad || this.random(index, 1) > 0.45) continue;
      // Let a streak extend beyond one tiny input segment so slow sampling
      // does not turn graphite into dots. Bound its whole cap to size/2 around
      // the seed, keeping getStrokeBounds valid even at a sharp reversal.
      const reach = Math.max(0, (this.stroke.size - this.width) / 2);
      const offset = (this.random(index, 2) * 2 - 1) * Math.min(this.stroke.size * 0.25, reach);
      const maxLength = Math.sqrt(Math.max(0, reach * reach - offset * offset));
      const len = Math.min(this.stroke.size * (0.25 + this.random(index, 3) * 0.55), maxLength);
      if (len < 0.05) continue;
      const x = a.x + ux * (d - this.distance) - uy * offset;
      const y = a.y + uy * (d - this.distance) + ux * offset;
      marks.push({ a: { x, y }, b: { x: x + ux * len, y: y + uy * len }, readyAt: d + this.pad });
    }
    return { end, next, marks };
  }

  advance(a: Point, b: Point): PencilGrainMark[] {
    const segment = this.segment(a, b);
    this.stats.lastCandidates = segment.next - this.next;
    this.stats.candidates += this.stats.lastCandidates;
    this.distance = segment.end; this.next = segment.next;
    const ready: PencilGrainMark[] = [], pending: PencilGrainMark[] = [];
    for (const mark of this.pending.concat(segment.marks)) {
      (mark.readyAt <= this.distance ? ready : pending).push(mark);
    }
    this.pending = pending;
    this.stats.pending = pending.length;
    return ready;
  }

  preview(a: Point, b: Point): PencilGrainMark[] {
    const segment = this.segment(a, b);
    return this.pending.concat(segment.marks).filter(mark => mark.readyAt <= segment.end);
  }
}
