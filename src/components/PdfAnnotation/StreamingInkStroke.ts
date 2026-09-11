import type { PdfPoint, PdfStroke } from './PdfTypes';
import { smoothingToMinCutoff, type Bounds } from './PdfEngine';
import { clamp01, markerStrokeAlpha, pressureToWidth } from './InkMath';
import { drawVariableRibbon } from './InkRibbonRenderer';
import { StreamingPencilGrain, type PencilGrainMark } from './StreamingPencilGrain';

const CELL = 128;
const SCALE = 3;
const GUTTER = 3;
const PIXELS = (CELL + 2 * GUTTER) * SCALE;
/** Bytes per tile canvas — the unit the live cache below is budgeted in. */
const BYTES_PER_CANVAS = PIXELS * PIXELS * 4;
interface Sample { x: number; y: number; p: number; t: number; width: number; ema: number }
interface Tile { x: number; y: number; mask: HTMLCanvasElement; image: HTMLCanvasElement; grain?: HTMLCanvasElement; dirty: boolean }
const canvas = () => {
  const c = document.createElement('canvas');
  c.width = c.height = PIXELS;
  // Small masks are updated and filtered every frame. Keep these scratch
  // surfaces on the CPU to avoid GPU filter initialization/readback stalls;
  // the main canvas and committed document tiles retain normal acceleration.
  c.getContext('2d', { willReadFrequently: true });
  return c;
};

/** Version 2 marker/fountain/pencil raster. Work per update depends on NEW samples and
 * touched pixels, never on the length/number of retraces in the stroke prefix.
 * Opaque coverage is accumulated before opacity/feather are applied, so a 50%
 * marker stays 50% in its own intersections, however often the pen returns. */
export class StreamingInkStroke {
  private readonly grain: StreamingPencilGrain | null;
  private grainPreview = new Map<string, PencilGrainMark[]>();
  private tiles = new Map<string, Tile>();
  private scratch = canvas();
  private bytes = BYTES_PER_CANVAS; // scratch
  private processed = 0;
  private last: Sample | null = null;
  private tip: Sample | null = null;
  private count = -1;
  private pressureSum = 0;
  private widthSum = 0;
  private blur = -1;
  private alpha = 1;
  private oldTipTiles = new Set<string>();
  readonly stats = { processedPoints: 0, lastUpdatePoints: 0, refreshedTiles: 0, grainCandidates: 0 };

  /** Canvas bytes held by this stroke's streaming tiles. Drives the live-cache
   *  budget in `getStreamingInk`. */
  get memoryBytes(): number { return this.bytes; }

  /** Account a newly allocated tile canvas against the live-cache budget. */
  private grew(): void {
    accountLive(this.stroke);
    trimLive(this.stroke);
  }

  constructor(private readonly stroke: PdfStroke) {
    this.grain = stroke.style === 'pencil' ? new StreamingPencilGrain(stroke) : null;
  }

  private sample(raw: PdfPoint, tip: boolean): Sample {
    const prev = this.last;
    let x = Number.isFinite(raw.x) ? raw.x : prev?.x ?? 0;
    let y = Number.isFinite(raw.y) ? raw.y : prev?.y ?? 0;
    let p = Number.isFinite(raw.pressure) ? clamp01(raw.pressure) : 0.5;
    const t = Number.isFinite(raw.t) ? raw.t : prev?.t ?? 0;
    const dt = prev ? (t - prev.t) / 1000 : 0;
    if (prev && !tip && dt > 0 && dt <= 1) {
      const cutoff = smoothingToMinCutoff(this.stroke.smoothing) + 0.007 * Math.hypot(x - prev.x, y - prev.y) / dt;
      const a = 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
      x = prev.x + (x - prev.x) * a;
      y = prev.y + (y - prev.y) * a;
      p = prev.p + (p - prev.p) * a;
    }
    const ema = prev ? prev.ema + (p - prev.ema) * 0.42 : p;
    let width = pressureToWidth(ema, this.stroke.size);
    if (this.grain) width = Math.max(0.6, this.stroke.size * (0.28 + p * 0.42));
    if (this.stroke.style === 'fountain') {
      const speed = prev && dt > 0 ? Math.hypot(x - prev.x, y - prev.y) / (dt * 1000) : 0;
      width *= (0.5 + 0.5 * clamp01(this.stroke.inkSpeed ?? 0.5)) * (1 - clamp01(speed) * 0.42);
    }
    const floor = Math.max(0.15, this.stroke.size * 0.015);
    width = Math.max(floor, width);
    if (prev) width = Math.max(prev.width - Math.max(0.25, this.stroke.size * 0.11),
      Math.min(prev.width + Math.max(0.35, this.stroke.size * 0.16), width));
    return { x, y, p, t, width, ema };
  }

  private tile(tx: number, ty: number): Tile {
    const key = `${tx}:${ty}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = { x: tx * CELL, y: ty * CELL, mask: canvas(), image: canvas(), dirty: true };
      this.tiles.set(key, tile);
      this.bytes += 2 * BYTES_PER_CANVAS;
      this.grew();
    }
    return tile;
  }

  private visit(a: Sample, b: Sample, write: boolean): Set<string> {
    const pad = Math.max(a.width, b.width) / 2 + GUTTER;
    const keys = new Set<string>();
    for (let ty = Math.floor((Math.min(a.y, b.y) - pad) / CELL); ty <= Math.floor((Math.max(a.y, b.y) + pad) / CELL); ty++) {
      for (let tx = Math.floor((Math.min(a.x, b.x) - pad) / CELL); tx <= Math.floor((Math.max(a.x, b.x) + pad) / CELL); tx++) {
        const key = `${tx}:${ty}`;
        const tile = this.tile(tx, ty);
        tile.dirty = true;
        keys.add(key);
        if (write) this.segment(tile.mask.getContext('2d')!, tile, a, b);
      }
    }
    return keys;
  }

  private segment(ctx: CanvasRenderingContext2D, tile: Tile, a: Sample, b: Sample): void {
    ctx.setTransform(SCALE, 0, 0, SCALE, (GUTTER - tile.x) * SCALE, (GUTTER - tile.y) * SCALE);
    // Each raw segment has bounded geometry (one quad + two caps). Inserting
    // hundreds of 1px discs along an already straight segment adds no detail.
    drawVariableRibbon(ctx, [a, b], [a.width, b.width], '#000000', 1, 'source-over', 0, 0, false);
  }

  private drawGrain(ctx: CanvasRenderingContext2D, tile: Tile, marks: PencilGrainMark[]): void {
    ctx.setTransform(SCALE, 0, 0, SCALE, (GUTTER - tile.x) * SCALE, (GUTTER - tile.y) * SCALE);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = '#000000'; ctx.lineWidth = this.grain!.width;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const mark of marks) { ctx.moveTo(mark.a.x, mark.a.y); ctx.lineTo(mark.b.x, mark.b.y); }
    ctx.stroke();
  }

  private visitGrain(marks: PencilGrainMark[], write: boolean): void {
    const buckets = write ? new Map<string, PencilGrainMark[]>() : this.grainPreview;
    const pad = this.grain!.width / 2 + GUTTER;
    for (const mark of marks) {
      for (let ty = Math.floor((Math.min(mark.a.y, mark.b.y) - pad) / CELL); ty <= Math.floor((Math.max(mark.a.y, mark.b.y) + pad) / CELL); ty++) {
        for (let tx = Math.floor((Math.min(mark.a.x, mark.b.x) - pad) / CELL); tx <= Math.floor((Math.max(mark.a.x, mark.b.x) + pad) / CELL); tx++) {
          const key = `${tx}:${ty}`;
          this.tile(tx, ty).dirty = true;
          let list = buckets.get(key);
          if (!list) { list = []; buckets.set(key, list); }
          list.push(mark);
        }
      }
    }
    if (write) for (const [key, list] of buckets) {
      const tile = this.tiles.get(key)!;
      if (!tile.grain) { tile.grain = canvas(); this.bytes += BYTES_PER_CANVAS; this.grew(); }
      this.drawGrain(tile.grain.getContext('2d')!, tile, list);
    }
  }

  update(): void {
    const points = this.stroke.points;
    if (points.length === this.count) return;
    this.stats.lastUpdatePoints = 0;
    this.stats.refreshedTiles = 0;
    for (const key of this.grainPreview.keys()) this.tiles.get(key)!.dirty = true;
    this.grainPreview.clear();
    for (const key of this.oldTipTiles) this.tiles.get(key)!.dirty = true;
    // The final raw sample is a replaceable tip, not part of the stable mask.
    // On the next event it goes through the filter before being baked once.
    while (this.processed < Math.max(0, points.length - 1)) {
      const next = this.sample(points[this.processed], false);
      this.visit(this.last ?? next, next, true);
      if (this.grain) this.visitGrain(this.grain.advance(this.last ?? next, next), true);
      this.last = next;
      this.pressureSum += next.p;
      this.widthSum += next.width;
      this.processed++;
      this.stats.processedPoints++;
      this.stats.lastUpdatePoints++;
    }
    this.tip = points.length ? this.sample(points[points.length - 1], true) : null;
    this.oldTipTiles = this.tip ? this.visit(this.last ?? this.tip, this.tip, false) : new Set();
    if (this.grain && this.tip) this.visitGrain(this.grain.preview(this.last ?? this.tip, this.tip), false);
    this.stats.grainCandidates = this.grain?.stats.candidates ?? 0;
    const avgWidth = (this.widthSum + (this.tip?.width ?? 0)) / Math.max(1, points.length);
    const blur = this.stroke.edgeFeather === false ? 0 : Math.round(Math.min(0.6, avgWidth * 0.25) * SCALE * 16) / 16;
    if (blur !== this.blur) for (const tile of this.tiles.values()) tile.dirty = true;
    this.blur = blur;
    this.alpha = this.grain ? 1 : markerStrokeAlpha(this.stroke.opacity,
      (this.pressureSum + (this.tip?.p ?? 0.5)) / Math.max(1, points.length), this.stroke.pressureOpacity === true);
    const tmp = this.scratch.getContext('2d')!;
    for (const [key, tile] of this.tiles) {
      if (!tile.dirty) continue;
      tmp.setTransform(1, 0, 0, 1, 0, 0);
      tmp.globalCompositeOperation = 'source-over';
      tmp.clearRect(0, 0, PIXELS, PIXELS);
      tmp.drawImage(tile.mask, 0, 0);
      if (this.tip && this.oldTipTiles.has(key)) this.segment(tmp, tile, this.last ?? this.tip, this.tip);
      tmp.setTransform(1, 0, 0, 1, 0, 0);
      tmp.globalCompositeOperation = 'source-in';
      tmp.fillStyle = this.stroke.color;
      tmp.fillRect(0, 0, PIXELS, PIXELS);
      tmp.globalCompositeOperation = 'source-over';
      const out = tile.image.getContext('2d')!;
      out.clearRect(0, 0, PIXELS, PIXELS);
      out.save();
      if (this.grain) out.globalAlpha = clamp01(this.stroke.opacity * 0.85);
      if (blur > 0.15) out.filter = `blur(${blur}px)`;
      out.drawImage(this.scratch, 0, 0);
      out.restore();
      if (this.grain && (tile.grain || this.grainPreview.has(key))) {
        tmp.setTransform(1, 0, 0, 1, 0, 0);
        tmp.clearRect(0, 0, PIXELS, PIXELS);
        if (tile.grain) tmp.drawImage(tile.grain, 0, 0);
        const preview = this.grainPreview.get(key);
        if (preview) this.drawGrain(tmp, tile, preview);
        tmp.setTransform(1, 0, 0, 1, 0, 0);
        tmp.globalCompositeOperation = 'source-in';
        tmp.fillRect(0, 0, PIXELS, PIXELS);
        tmp.globalCompositeOperation = 'source-over';
        out.save(); out.globalAlpha = clamp01(this.stroke.opacity * 0.16);
        out.drawImage(this.scratch, 0, 0); out.restore();
      }
      tile.dirty = false;
      this.stats.refreshedTiles++;
    }
    this.count = points.length;
  }

  draw(ctx: CanvasRenderingContext2D, dx = 0, dy = 0, bounds?: Bounds): void {
    this.update();
    ctx.save();
    ctx.globalCompositeOperation = this.stroke.compositeOperation;
    ctx.globalAlpha = this.alpha;
    for (const tile of this.tiles.values()) {
      if (bounds && (tile.x + CELL < bounds.minX || tile.x > bounds.maxX || tile.y + CELL < bounds.minY || tile.y > bounds.maxY)) continue;
      ctx.drawImage(tile.image, GUTTER * SCALE, GUTTER * SCALE, CELL * SCALE, CELL * SCALE,
        tile.x + dx, tile.y + dy, CELL, CELL);
    }
    ctx.restore();
  }

  dispose(): void {
    for (const tile of this.tiles.values()) { tile.mask.width = 0; tile.image.width = 0; if (tile.grain) tile.grain.width = 0; }
    this.tiles.clear();
    this.grainPreview.clear();
    this.scratch.width = 0;
    this.bytes = 0;
  }
}

interface LiveEntry { value: StreamingInkStroke; bytes: number }

/** Least-recently-used streaming ink, most-recently-used LAST. */
const live = new Map<PdfStroke, LiveEntry>();
let liveBytes = 0;

/** Retained streaming ink, in bytes. A committed stroke keeps its coverage tiles
 *  so that a raster-cache miss can be RE-COMPOSITED from them (~1ms) instead of
 *  re-processed from the raw point list (~70ms for a long stroke). Both caches
 *  are regenerable, so evicting here only trades memory for repair latency. */
const LIVE_LIMIT = 96 * 1024 * 1024;

/** Re-account an entry after its stroke allocated more tiles. */
function accountLive(stroke: PdfStroke): void {
  const entry = live.get(stroke);
  if (!entry) return;
  const now = entry.value.memoryBytes;
  liveBytes += now - entry.bytes;
  entry.bytes = now;
}

/** Dispose least-recently-used streaming ink until the budget is met. `keep` —
 *  the stroke being drawn right now — is never evicted, so a single long stroke
 *  can always finish growing rather than evicting itself and restarting. */
function trimLive(keep: PdfStroke | null): void {
  if (liveBytes <= LIVE_LIMIT) return;
  for (const [stroke, entry] of live) {
    if (liveBytes <= LIVE_LIMIT) break;
    if (stroke === keep) continue;
    liveBytes -= entry.bytes;
    entry.value.dispose();
    live.delete(stroke);
  }
}

export function streamingInkStats() { return { bytes: liveBytes, limit: LIVE_LIMIT, entries: live.size }; }

export function getStreamingInk(stroke: PdfStroke): StreamingInkStroke {
  const entry = live.get(stroke);
  if (entry) {
    // Touch: a stroke we are drawing or repairing is the last to be evicted.
    live.delete(stroke);
    live.set(stroke, entry);
    return entry.value;
  }
  const value = new StreamingInkStroke(stroke);
  live.set(stroke, { value, bytes: value.memoryBytes });
  liveBytes += value.memoryBytes;
  trimLive(null);
  return value;
}
export function releaseStreamingInk(stroke: PdfStroke): void {
  const entry = live.get(stroke);
  if (!entry) return;
  liveBytes -= entry.bytes;
  live.delete(stroke);
  entry.value.dispose();
}
/** Drop every retained entry (tests, or closing a document). */
export function clearStreamingInk(): void {
  for (const entry of live.values()) entry.value.dispose();
  live.clear();
  liveBytes = 0;
}
