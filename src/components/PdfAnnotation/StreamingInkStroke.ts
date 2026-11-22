import { finishInkWork } from '../InkCooperativeWork';
import { previewGeometry } from './InkPreviewGeometry';
import { createInkCanvas, inkPixelTransform } from '../InkCanvasSurface';
import type { PdfPoint, PdfStroke } from './PdfTypes';
import { inkPositionWeight, smoothingToMinCutoff, type Bounds } from './PdfEngine';
import { clamp01, isSingleLayerPencil, markerStrokeAlpha, pressureToWidth, resolveFeatherWorld } from './InkMath';
import { drawVariableRibbon } from './InkRibbonRenderer';
import { StreamingPencilGrain, type PencilGrainMark } from './StreamingPencilGrain';
import { applyPencilTexture, clearGraphitePaper, graphitePaper, graphitePaperBytes, pencilPaperPattern, type GraphitePaper } from './GraphitePaper';

const CELL = 128;
const SCALE = 3;
const GUTTER = 3;
const PIXELS = (CELL + 2 * GUTTER) * SCALE;
/** Bytes per tile canvas — the unit the live cache below is budgeted in. */
const BYTES_PER_CANVAS = PIXELS * PIXELS * 4;
interface Sample {
  x: number; y: number; p: number; t: number; width: number; ema: number;
  rawX?: number; rawY?: number; speed?: number; coreWidth?: number;
}

export function usesStreamingInk(stroke: PdfStroke): boolean {
  return stroke.renderVersion === 2 || stroke.renderVersion === 3 || stroke.renderVersion === 5 || isSingleLayerPencil(stroke);
}

export function usesOnePassInk(stroke: PdfStroke): boolean {
  return stroke.style === 'pencil' ? isSingleLayerPencil(stroke) : usesStreamingInk(stroke);
}

function colorCoverage(ctx: CanvasRenderingContext2D, stroke: PdfStroke, x: number, y: number, scale: number): void {
  if (stroke.style === 'pencil' && stroke.renderVersion === 5 && applyPencilTexture(ctx, stroke.color, x, y, scale)) return;
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = stroke.color;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = 'source-over';
}

/** Viewport CSS pixels per millisecond, independent of the document zoom. */
function fountainPace(stroke: PdfStroke, travel: number, elapsedMs: number, fallback: number): number {
  if (!(elapsedMs > 0 && elapsedMs <= 1000) || !Number.isFinite(travel)) return fallback;
  const zoom = stroke.inputZoom ?? 1;
  const distance = travel * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  return Math.min(4, distance / Math.max(1, elapsedMs));
}

/**
 * One sample of the stroke's own width/smoothing chain — the single source of
 * truth shared by the incremental raster (below) and the one-pass raster
 * (`renderStrokeOnce`), so a stroke's shape can never depend on which path
 * happened to draw it. `prev` is the previous FILTERED sample; `tip` marks the
 * replaceable live pen tip, which is never filtered.
 */
function samplePoint(stroke: PdfStroke, raw: PdfPoint, prev: Sample | null, tip: boolean, grainy: boolean, next?: PdfPoint): Sample {
  let x = Number.isFinite(raw.x) ? raw.x : prev?.x ?? 0;
  let y = Number.isFinite(raw.y) ? raw.y : prev?.y ?? 0;
  const rawX = x, rawY = y;
  let p = Number.isFinite(raw.pressure) ? clamp01(raw.pressure) : 0.5;
  const t = Number.isFinite(raw.t) ? raw.t : prev?.t ?? 0;
  const dt = prev ? (t - prev.t) / 1000 : 0;
  if (prev && !tip && dt > 0 && dt <= 1) {
    const a = inkPositionWeight(smoothingToMinCutoff(stroke.smoothing), x - prev.x, y - prev.y, dt);
    x = prev.x + (x - prev.x) * a;
    y = prev.y + (y - prev.y) * a;
    p = prev.p + (p - prev.p) * a;
  }
  const fountain = stroke.style === 'fountain' && (stroke.renderVersion === 3 || stroke.renderVersion === 5);
  if (fountain || isSingleLayerPencil(stroke) || (stroke.style === 'pencil' && stroke.renderVersion === 3)) {
    const travel = prev ? Math.hypot(rawX - (prev.rawX ?? prev.x), rawY - (prev.rawY ?? prev.y)) : 0;
    const blend = travel / (travel + Math.max(0.9, stroke.size * 0.21));
    const ema = prev ? prev.ema + (p - prev.ema) * blend : p;
    if (stroke.style === 'pencil' && stroke.renderVersion === 3) {
      const width = Math.max(0.2, stroke.size * (0.14 + Math.pow(ema, 0.85) * 0.69));
      const contact = clamp01((ema - 0.16) / 0.84);
      const coreWidth = width * 0.84 * contact * contact * (3 - 2 * contact);
      return { x, y, p, t, width, ema, rawX, rawY, coreWidth };
    }
    let speed: number | undefined;
    let width = pressureToWidth(ema, stroke.size);
    if (fountain && stroke.renderVersion === 5) {
      const lastPace = prev?.speed ?? 0.45;
      // Seed the first cap from the first leg once that leg arrives. A fast
      // stroke doesn't start with a thick dot left by the pen-down preview.
      speed = prev
        ? lastPace + (fountainPace(stroke, travel, dt * 1000, lastPace) - lastPace) * Math.min(0.65, blend)
        : next ? fountainPace(stroke, Math.hypot(next.x - rawX, next.y - rawY), next.t - t, lastPace) : lastPace;
      const flow = clamp01(stroke.inkSpeed ?? 0.5);
      const relativePace = speed / (0.33 + 0.60 * flow);
      // A finite ink supply narrows fast strokes while retaining a solid line.
      const deposit = 0.27 + 0.73 / (1 + relativePace * relativePace);
      width *= (0.66 + 0.34 * flow) * deposit;
    } else if (fountain) {
      const previousSpeed = prev?.speed ?? 0.45;
      const targetSpeed = dt > 0 && dt <= 1 ? clamp01(travel / (dt * 1000)) : previousSpeed;
      speed = prev ? previousSpeed + (targetSpeed - previousSpeed) * blend : previousSpeed;
      const flow = 0.5 + 0.5 * clamp01(stroke.inkSpeed ?? 0.5);
      width = width * flow * (1 - 0.28 * speed);
    }
    width = Math.max(0.15, width);
    if (prev) {
      // Limit width change per distance, so a cluster of samples near a pause
      // or pen-up cannot swell into a cap wider than the neighboring line.
      const advance = Math.min(travel, Math.hypot(x - prev.x, y - prev.y));
      width = Math.max(prev.width - advance * 0.22, Math.min(prev.width + advance * 0.15, width));
    }
    return { x, y, p, t, width, ema, rawX, rawY, speed };
  }
  const ema = prev ? prev.ema + (p - prev.ema) * 0.42 : p;
  let width = pressureToWidth(ema, stroke.size);
  if (grainy) width = Math.max(0.6, stroke.size * (0.28 + p * 0.42));
  if (stroke.style === 'fountain') {
    const speed = prev && dt > 0 ? Math.hypot(x - prev.x, y - prev.y) / (dt * 1000) : 0;
    width *= (0.5 + 0.5 * clamp01(stroke.inkSpeed ?? 0.5)) * (1 - clamp01(speed) * 0.42);
  }
  const floor = Math.max(0.15, stroke.size * 0.015);
  width = Math.max(floor, width);
  if (prev) width = Math.max(prev.width - Math.max(0.25, stroke.size * 0.11),
    Math.min(prev.width + Math.max(0.35, stroke.size * 0.16), width));
  return { x, y, p, t, width, ema };
}

/**
 * Rasterize a stroke's ENTIRE coverage in one pass, returning a `scale`-times
 * raster of exactly the world rect [minX..maxX]×[minY..maxY] (or null when the
 * stroke cannot reach it).
 *
 * The incremental raster below exists so that drawing a stroke costs only its
 * NEW samples each frame. A stroke restored from storage has no new samples —
 * it is drawn once, whole — and the per-cell mask/image canvases it allocates
 * (2 CPU surfaces of ~640 KiB per cell, plus a per-cell blur) cost ~7× the time
 * and ~12× the memory of painting the same ribbon in a single fill. Opening a
 * dense canvas builds every stroke that way, which is what made it take tens of
 * seconds.
 *
 * The steps are deliberately the SAME as the incremental compositor's, in the
 * same order, so the result is the same pixels and not merely a similar look:
 * opaque coverage → `source-in` the stroke colour → blur + alpha at IDENTITY
 * transform. The blur must not be applied under the bake transform — `ctx.filter`
 * lengths are scaled by the current transform in some engines and not others, so
 * only an identity transform makes the radius mean one thing everywhere.
 *
 * Earlier layered pencils keep the incremental raster for their grain.
 */
// Pooled scratch canvases for the one-pass renderer's INTERMEDIATES. A dense
// tile renders hundreds of strokes and each call used to allocate 2–3 canvases
// plus contexts, which dominated a raster's fixed cost (measured ~0.9 ms/stroke
// on a 135-stroke tile, nearly independent of bake scale — i.e. overhead, not
// pixels). Checkout is EXCLUSIVE: a checked-out canvas is out of the pool until
// returned, so two same-sized intermediates can never alias one canvas — the
// coverage and blur steps of one call would otherwise be the same surface, and
// the blur step would composite it onto itself. Only the canvas RETURNED to the
// raster cache is ever fresh; pooled ones are reset to a pristine state on
// checkout, because the renderer leaves transform/composite/filter/alpha dirty.
const scratchPool = new Map<string, HTMLCanvasElement>();
const SCRATCH_POOL_MAX = 32;
function scratchCheckout(width: number, height: number): HTMLCanvasElement {
  const key = `${width}:${height}`;
  let c = scratchPool.get(key);
  if (c) scratchPool.delete(key);
  else {
    c = createInkCanvas();
    c.width = width; c.height = height;
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.clearRect(0, 0, width, height);
  return c;
}
export function scratchInkBytes(): number {
  let bytes = graphitePaperBytes();
  for (const canvas of scratchPool.values()) bytes += canvas.width * canvas.height * 4;
  return bytes;
}
export function clearInkScratch(): void { for (const canvas of scratchPool.values()) canvas.width = 0; scratchPool.clear(); }
function scratchReturn(c: HTMLCanvasElement): void {
  const key = c.width + ':' + c.height;
  const size = c.width * c.height * 4;
  if (scratchPool.has(key) || size > 16 * 1024 * 1024) { c.width = 0; return; }
  while (scratchPool.size && (scratchPool.size >= SCRATCH_POOL_MAX || scratchInkBytes() + size > 16 * 1024 * 1024)) {
    const oldest = scratchPool.keys().next().value!;
    scratchPool.get(oldest)!.width = 0; scratchPool.delete(oldest);
  }
  scratchPool.set(key, c);
}
function freshCanvas(width: number, height: number): HTMLCanvasElement {
  const c = createInkCanvas();
  c.width = width; c.height = height;
  return c;
}
function scratchCanvas(width: number, height: number): HTMLCanvasElement {
  const key = `${width}:${height}`;
  let c = scratchPool.get(key);
  if (c) scratchPool.delete(key);
  else {
    c = createInkCanvas();
    c.width = width; c.height = height;
    if (scratchPool.size >= SCRATCH_POOL_MAX) {
      const oldest = scratchPool.keys().next().value!; scratchPool.get(oldest)!.width = 0; scratchPool.delete(oldest);
    }
  }
  scratchPool.set(key, c);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.clearRect(0, 0, width, height);
  return c;
}

interface StrokeSamples { samples: Sample[]; pressureSum: number; widthSum: number; maxWidth: number }
// Sampling a stroke depends only on the stroke, but renderStrokeOnce runs per
// (stroke, tile) — a long stroke crossing several tiles was re-sampled whole for
// each of them. Cache on stroke identity (strokes are replaced, never mutated).
const sampleCache = new WeakMap<PdfStroke, StrokeSamples>();
function strokeSamples(stroke: PdfStroke): StrokeSamples { return finishInkWork(strokeSamplesWork(stroke)); }

/** The selection already has a raster surface, so draw each preview as one
 * fill on it instead of allocating a separate raster for every stroke. */
export function drawStreamingPreview(ctx: CanvasRenderingContext2D, stroke: PdfStroke, scale: number): void {
  const { samples, pressureSum, widthSum } = strokeSamples(stroke);
  const tip = samples[samples.length - 1];
  if (!tip) return;
  const { points, widths } = previewGeometry(samples, samples.map(s => s.width), scale);
  const alpha = markerStrokeAlpha(stroke.opacity, (pressureSum + tip.p) / samples.length,
    stroke.pressureOpacity === true && !isSingleLayerPencil(stroke));
  const feather = resolveFeatherWorld(stroke, [(widthSum + tip.width) / samples.length]);
  const color = stroke.style === 'pencil' && stroke.renderVersion === 5
    ? pencilPaperPattern(ctx, stroke.color, 0, 0, 1) ?? stroke.color : stroke.color;
  drawVariableRibbon(ctx, points, widths, color, alpha, stroke.compositeOperation, 0, 0, feather);
}

function* strokeSamplesWork(stroke: PdfStroke): Generator<void, StrokeSamples, unknown> {
    const cached = sampleCache.get(stroke);
    if (cached)
        return cached;
    const pts = stroke.points;
    const n = pts.length;
    const samples: Sample[] = new Array(n);
    let prev: Sample | null = null;
    let pressureSum = 0, widthSum = 0, maxWidth = 0;
    for (let i = 0; i < n; i++) {
        yield;
        const s = samplePoint(stroke, pts[i], prev, i === n - 1, false, i === 0 ? pts[1] : undefined);
        samples[i] = s;
        if (i < n - 1) {
            pressureSum += s.p;
            widthSum += s.width;
        }
        if (s.width > maxWidth)
            maxWidth = s.width;
        prev = s;
    }
    const record = { samples, pressureSum, widthSum, maxWidth };
    sampleCache.set(stroke, record);
    return record;
}

export interface StrokeOnceBuild {
  stroke: PdfStroke;
  /** World rect the raster covers (padded past the tile edge by the feather's
   *  3σ footprint — see InkRasterCache, which owns the crop maths). */
  minX: number; minY: number; maxX: number; maxY: number;
  width: number;
  height: number;
  scale: number;
  coverage: HTMLCanvasElement;
  cctx: CanvasRenderingContext2D;
  pts: { x: number; y: number }[];
  widths: number[];
  /** Next sample of the run to draw; 0 = the seed disc is still pending. */
  next: number;
  count: number;
  blurPx: number;
  alpha: number;
}

/** Decide everything about a one-pass rasterization EXCEPT the segments:
 *  sampling (cached per stroke), the reachable run, the crop canvas, the blur
 *  radius and the whole-stroke alpha. Returns null when the stroke cannot reach
 *  the rect — nothing to build. The returned build is resumable: its segments
 *  are drawn by pumpStrokeOnceBuild, possibly across frames. */
export function startStrokeOnceBuild(
  stroke: PdfStroke,
  scale: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): StrokeOnceBuild | null { return finishInkWork(startStrokeOnceBuildWork(stroke, scale, minX, minY, maxX, maxY)); }

export function* startStrokeOnceBuildWork(
  stroke: PdfStroke,
  scale: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Generator<void, StrokeOnceBuild | null, unknown> {
    const n = stroke.points.length;
    if (n === 0)
        return null;
    const { samples, pressureSum, widthSum, maxWidth } = (yield* strokeSamplesWork(stroke));
    const reach = maxWidth / 2 + 2;
    const near = (a: {
        x: number;
        y: number;
    }, b: {
        x: number;
        y: number;
    }) => Math.min(a.x, b.x) - reach <= maxX && Math.max(a.x, b.x) + reach >= minX &&
        Math.min(a.y, b.y) - reach <= maxY && Math.max(a.y, b.y) + reach >= minY;
    let lo = -1, hi = -1; // first / last SEGMENT index that can reach the rect
    for (let i = 0; i + 1 < n; i++) {
        yield;
        if (!near(samples[i], samples[i + 1]))
            continue;
        if (lo === -1)
            lo = i;
        hi = i;
    }
    if (lo === -1) {
        // No segment reaches the rect — a lone sample (a dot, or a run of coincident
        // samples) still can.
        for (let i = 0; i < samples.length; i++) {
            yield;
            const s = samples[i];
            if (s.x >= minX - reach && s.x <= maxX + reach && s.y >= minY - reach && s.y <= maxY + reach) { hi = i; break; }
        }
        if (hi === -1)
            return null;
        lo = hi;
    }
    else {
        // Draw one segment past the run: the LAST sample of a run is also the start
        // of the next segment, and the incremental compositor paints that disc twice
        // (once per segment it joins). Stopping at the run would leave that one disc
        // a level lighter than the same ink drawn live.
        hi = Math.min(n - 1, hi + 2);
    }
    const count = hi - lo + 1;
    const pts = new Array<{
        x: number;
        y: number;
    }>(count);
    const widths = new Array<number>(count);
    for (let i = 0; i < count; i++) {
        yield;
        const s = samples[lo + i];
        pts[i] = { x: s.x, y: s.y };
        widths[i] = s.width;
    }
    const width = Math.max(1, Math.round((maxX - minX) * scale));
    const height = Math.max(1, Math.round((maxY - minY) * scale));
    // Held by the build across passes — it cannot come from the scratch pool,
    // which resets a canvas on every checkout.
    const coverage = createInkCanvas();
    coverage.width = width;
    coverage.height = height;
    const cctx = coverage.getContext('2d')!;
    cctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
    const avgWidth = (widthSum + samples[n - 1].width) / n;
    const blurPx = Math.round(resolveFeatherWorld(stroke, [avgWidth]) * scale * 16) / 16;
    const alpha = markerStrokeAlpha(stroke.opacity, (pressureSum + samples[n - 1].p) / n,
      stroke.pressureOpacity === true && !isSingleLayerPencil(stroke));
    return { stroke, minX, minY, maxX, maxY, width, height, scale, coverage, cctx, pts, widths, next: 0, count, blurPx, alpha };
}

/** Draw a build's next segments — at most `maxPoints` points' worth, seed disc
 *  included. Each segment is an independent composite onto the same canvas in
 *  the incremental compositor's exact order and multiplicity, so pausing between
 *  them cannot change a single pixel. Returns whether the coverage is COMPLETE. */
export function pumpStrokeOnceBuild(b: StrokeOnceBuild, maxPoints: number): { done: boolean; drawn: number } {
  let drawn = 0;
  if (b.next === 0) {
    drawVariableRibbon(b.cctx, [b.pts[0], b.pts[0]], [b.widths[0], b.widths[0]],
      '#000000', 1, 'source-over', 0, 0, false);
    b.next = 1;
    drawn++;
  }
  while (b.next < b.count && drawn < maxPoints) {
    const i = b.next;
    drawVariableRibbon(b.cctx, [b.pts[i - 1], b.pts[i]], [b.widths[i - 1], b.widths[i]],
      '#000000', 1, 'source-over', 0, 0, false);
    b.next++;
    drawn++;
  }
  return { done: b.next >= b.count, drawn };
}

/** Composite the finished coverage: colour in, feather, whole-stroke alpha. This
 *  is the only part of a raster that cannot be sliced — the blur is one operation
 *  over the whole canvas — everything before it pauses freely between segments. */
export function finishStrokeOnceBuild(b: StrokeOnceBuild): HTMLCanvasElement {
  const cctx = b.cctx;
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  colorCoverage(cctx, b.stroke, b.minX, b.minY, b.scale);

  const blurred = b.alpha >= 1 ? freshCanvas(b.width, b.height) : scratchCheckout(b.width, b.height);
  const bctx = blurred.getContext('2d')!;
  // 1/64 px, not 1/16: a thin stroke's width-derived feather is ~0.04 world px,
  // which is 0.12 px at a 3x bake but only 0.04 px at 1x. A coarse threshold
  // would silently drop the feather from committed hairlines exactly when the
  // tile is baked at the display's density.
  if (b.blurPx >= 1 / 64) bctx.filter = `blur(${b.blurPx}px)`;
  bctx.drawImage(b.coverage, 0, 0);
  scratchReturn(b.coverage);
  if (b.alpha >= 1) return blurred;

  const out = freshCanvas(b.width, b.height);
  out.width = b.width; out.height = b.height;
  const octx = out.getContext('2d')!;
  octx.globalAlpha = b.alpha;
  octx.drawImage(blurred, 0, 0);
  scratchReturn(blurred);
  return out;
}
/** Coarse historical preview: one opaque union instead of one fill per sample.
 * Geometry, pressure, feather and stroke alpha are retained; final quality uses
 * the original incremental coverage multiplicity for pixel-exact handoff. */
export function renderStrokePreview(stroke: PdfStroke, scale: number, minX: number, minY: number, maxX: number, maxY: number): HTMLCanvasElement | null {
  const build = startStrokeOnceBuild(stroke, scale, minX, minY, maxX, maxY);
  if (!build) return null;
  const geometry = previewGeometry(build.pts, build.widths, scale);
  drawVariableRibbon(build.cctx, geometry.points, geometry.widths, '#000', 1, 'source-over', 0, 0, false);
  return finishStrokeOnceBuild(build);
}

/** The synchronous form: start, pump to the end, finish. The sliced path used by
 *  the tile builder is this same code with pauses, so both produce the same
 *  pixels by construction. */
export function renderStrokeOnce(
  stroke: PdfStroke,
  scale: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): HTMLCanvasElement | null {
  const b = startStrokeOnceBuild(stroke, scale, minX, minY, maxX, maxY);
  if (!b) return null;
  pumpStrokeOnceBuild(b, Infinity);
  return finishStrokeOnceBuild(b);
}
interface Tile { x: number; y: number; mask: HTMLCanvasElement; image: HTMLCanvasElement; grain?: HTMLCanvasElement; dirty: boolean }
const canvas = () => {
  const c = createInkCanvas();
  c.width = c.height = PIXELS;
  // Small masks are updated and filtered every frame. Keep these scratch
  // surfaces on the CPU to avoid GPU filter initialization/readback stalls;
  // the main canvas and committed document tiles retain normal acceleration.
  c.getContext('2d', { willReadFrequently: true });
  return c;
};

/** Streaming marker/fountain/pencil raster. Work per update depends on NEW samples and
 * touched pixels, never on the length/number of retraces in the stroke prefix.
 * Opaque coverage is accumulated before opacity/feather are applied, so a 50%
 * marker stays 50% in its own intersections, however often the pen returns. */
export class StreamingInkStroke {
  private readonly grain: StreamingPencilGrain | null;
  private readonly graphite: boolean;
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
    if (!this.clipBounds) { accountLive(this.stroke); trimLive(this.stroke); }
  }

  constructor(private readonly stroke: PdfStroke, private readonly clipBounds?: Bounds) {
    this.graphite = stroke.renderVersion === 3 && stroke.style === 'pencil';
    this.grain = stroke.style === 'pencil' && !this.graphite && !isSingleLayerPencil(stroke) ? new StreamingPencilGrain(stroke) : null;
  }

  private sample(raw: PdfPoint, tip: boolean): Sample {
    return samplePoint(this.stroke, raw, this.last, tip, this.grain !== null, this.last ? undefined : this.stroke.points[1]);
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
    const coreA = a.coreWidth ?? 0, coreB = b.coreWidth ?? 0;
    const hasCore = this.graphite && Math.max(coreA, coreB) >= 0.15;
    const keys = new Set<string>();
    for (let ty = Math.floor((Math.min(a.y, b.y) - pad) / CELL); ty <= Math.floor((Math.max(a.y, b.y) + pad) / CELL); ty++) {
      for (let tx = Math.floor((Math.min(a.x, b.x) - pad) / CELL); tx <= Math.floor((Math.max(a.x, b.x) + pad) / CELL); tx++) {
        if (!this.cellNeeded(tx, ty)) continue;
        const key = `${tx}:${ty}`;
        const tile = this.tile(tx, ty);
        tile.dirty = true;
        keys.add(key);
        if (write) {
          this.segment(tile.mask.getContext('2d')!, tile, a, b);
          if (hasCore) this.segment(this.grainMask(tile), tile, a, b, coreA, coreB);
        }
      }
    }
    return keys;
  }

  private segment(ctx: CanvasRenderingContext2D, tile: Tile, a: Sample, b: Sample, widthA = a.width, widthB = b.width): void {
    ctx.setTransform(SCALE, 0, 0, SCALE, (GUTTER - tile.x) * SCALE, (GUTTER - tile.y) * SCALE);
    // Each raw segment has bounded geometry (one quad + two caps). Inserting
    // hundreds of 1px discs along an already straight segment adds no detail.
    drawVariableRibbon(ctx, [a, b], [widthA, widthB], '#000000', 1, 'source-over', 0, 0, false);
  }
  private cellNeeded(tx: number, ty: number): boolean {
    const bounds = this.clipBounds;
    return !bounds || ((tx + 1) * CELL >= bounds.minX && tx * CELL <= bounds.maxX
      && (ty + 1) * CELL >= bounds.minY && ty * CELL <= bounds.maxY);
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

  private grainMask(tile: Tile): CanvasRenderingContext2D {
    if (!tile.grain) {
      tile.grain = canvas();
      this.bytes += BYTES_PER_CANVAS;
      this.grew();
    }
    return tile.grain.getContext('2d')!;
  }

  private visitGrain(marks: PencilGrainMark[], write: boolean): void {
    const buckets = write ? new Map<string, PencilGrainMark[]>() : this.grainPreview;
    const pad = this.grain!.width / 2 + GUTTER;
    for (const mark of marks) {
      for (let ty = Math.floor((Math.min(mark.a.y, mark.b.y) - pad) / CELL); ty <= Math.floor((Math.max(mark.a.y, mark.b.y) + pad) / CELL); ty++) {
        for (let tx = Math.floor((Math.min(mark.a.x, mark.b.x) - pad) / CELL); tx <= Math.floor((Math.max(mark.a.x, mark.b.x) + pad) / CELL); tx++) {
          if (!this.cellNeeded(tx, ty)) continue;
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
      this.drawGrain(this.grainMask(tile), tile, list);
    }
  }

  private refreshGraphite(tile: Tile, tmp: CanvasRenderingContext2D, tip: Sample | null, blur: number, paper: GraphitePaper): void {
    const out = tile.image.getContext('2d')!;
    tmp.setTransform(1, 0, 0, 1, 0, 0);
    tmp.clearRect(0, 0, PIXELS, PIXELS);
    tmp.drawImage(tile.mask, 0, 0);
    if (tip) this.segment(tmp, tile, this.last ?? tip, tip);

    out.clearRect(0, 0, PIXELS, PIXELS);
    out.save();
    // Feather the silhouette before adding the paper texture.
    if (blur >= 1 / 64) out.filter = `blur(${blur}px)`;
    out.drawImage(this.scratch, 0, 0);
    out.restore();
    out.globalCompositeOperation = 'source-in';
    out.drawImage(paper.light, 0, 0);
    out.globalCompositeOperation = 'source-over';

    const coreA = this.last?.coreWidth ?? tip?.coreWidth ?? 0;
    const coreB = tip?.coreWidth ?? 0;
    const liveCore = tip && Math.max(coreA, coreB) >= 0.15;
    if (tile.grain || liveCore) {
      tmp.setTransform(1, 0, 0, 1, 0, 0);
      tmp.clearRect(0, 0, PIXELS, PIXELS);
      if (tile.grain) tmp.drawImage(tile.grain, 0, 0);
      if (liveCore) this.segment(tmp, tile, this.last ?? tip, tip, coreA, coreB);
      tmp.setTransform(1, 0, 0, 1, 0, 0);
      tmp.globalCompositeOperation = 'source-in';
      tmp.drawImage(paper.dense, 0, 0);
      tmp.globalCompositeOperation = 'source-over';
      out.drawImage(this.scratch, 0, 0);
    }
  }

  update(maxPoints = Infinity, deferRefresh = false): void {
    const points = this.stroke.points;
    if (points.length === this.count) return;
    this.stats.lastUpdatePoints = 0;
    this.stats.refreshedTiles = 0;
    for (const key of this.grainPreview.keys()) this.tiles.get(key)!.dirty = true;
    this.grainPreview.clear();
    for (const key of this.oldTipTiles) this.tiles.get(key)!.dirty = true;
    // The final raw sample is a replaceable tip, not part of the stable mask.
    // On the next event it goes through the filter before being baked once.
    const limit = Math.min(Math.max(0, points.length - 1), this.processed + maxPoints);
    while (this.processed < limit) {
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
    if (deferRefresh && this.processed < Math.max(0, points.length - 1)) { this.count = this.processed + 1; return; }
    this.tip = points.length ? this.sample(points[this.processed], true) : null;
    this.oldTipTiles = this.tip ? this.visit(this.last ?? this.tip, this.tip, false) : new Set();
    if (this.grain && this.tip) this.visitGrain(this.grain.preview(this.last ?? this.tip, this.tip), false);
    this.stats.grainCandidates = this.grain?.stats.candidates ?? 0;
    // One radius for the whole stroke, from the same resolver the legacy ribbon
    // path uses — a stroke must not look softer in one place than another.
    const avgWidth = (this.widthSum + (this.tip?.width ?? 0)) / Math.max(1, points.length);
    const blur = Math.round(resolveFeatherWorld(this.stroke, [avgWidth]) * SCALE * 16) / 16;
    if (blur !== this.blur) for (const tile of this.tiles.values()) tile.dirty = true;
    this.blur = blur;
    this.alpha = this.graphite ? clamp01(this.stroke.opacity) : this.grain ? 1 : markerStrokeAlpha(this.stroke.opacity,
      (this.pressureSum + (this.tip?.p ?? 0.5)) / Math.max(1, points.length),
      this.stroke.pressureOpacity === true && !isSingleLayerPencil(this.stroke));
    const tmp = this.scratch.getContext('2d')!;
    const paper = this.graphite && this.tiles.size ? graphitePaper(this.stroke.color, PIXELS, GUTTER * SCALE) : null;
    for (const [key, tile] of this.tiles) {
      if (!tile.dirty) continue;
      if (paper) {
        this.refreshGraphite(tile, tmp, this.oldTipTiles.has(key) ? this.tip : null, blur, paper);
        tile.dirty = false;
        this.stats.refreshedTiles++;
        continue;
      }
      tmp.setTransform(1, 0, 0, 1, 0, 0);
      tmp.globalCompositeOperation = 'source-over';
      tmp.clearRect(0, 0, PIXELS, PIXELS);
      tmp.drawImage(tile.mask, 0, 0);
      if (this.tip && this.oldTipTiles.has(key)) this.segment(tmp, tile, this.last ?? this.tip, this.tip);
      tmp.setTransform(1, 0, 0, 1, 0, 0);
      colorCoverage(tmp, this.stroke, tile.x - GUTTER, tile.y - GUTTER, SCALE);
      const out = tile.image.getContext('2d')!;
      out.clearRect(0, 0, PIXELS, PIXELS);
      out.save();
      if (this.grain) out.globalAlpha = clamp01(this.stroke.opacity * 0.85);
      if (blur >= 1 / 64) out.filter = `blur(${blur}px)`;
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
    this.count = Math.min(points.length, this.processed + 1);
  }

  get prepared(): boolean { return this.count === this.stroke.points.length; }

  draw(ctx: CanvasRenderingContext2D, dx = 0, dy = 0, bounds?: Bounds, alignLiveCells = false): void {
    this.update();
    ctx.save();
    ctx.globalCompositeOperation = this.stroke.compositeOperation;
    ctx.globalAlpha = this.alpha;
    const transform = alignLiveCells ? inkPixelTransform(ctx) : null;
    const inverseX = transform ? 1 / transform.a : 1;
    const inverseY = transform ? 1 / transform.d : 1;
    for (const tile of this.tiles.values()) {
      if (bounds && (tile.x + CELL < bounds.minX || tile.x > bounds.maxX || tile.y + CELL < bounds.minY || tile.y > bounds.maxY)) continue;
      let x = tile.x + dx, y = tile.y + dy, width = CELL, height = CELL;
      if (transform) {
        // Round the shared edge, not each cell's width, so translucent
        // neighbors meet without a gap or compositing twice.
        const right = Math.round((tile.x + CELL + dx) * transform.a + transform.e);
        const bottom = Math.round((tile.y + CELL + dy) * transform.d + transform.f);
        const left = Math.round(x * transform.a + transform.e);
        const top = Math.round(y * transform.d + transform.f);
        x = (left - transform.e) * inverseX;
        y = (top - transform.f) * inverseY;
        width = (right - left) * inverseX;
        height = (bottom - top) * inverseY;
      }
      if (width && height) ctx.drawImage(tile.image, GUTTER * SCALE, GUTTER * SCALE, CELL * SCALE, CELL * SCALE, x, y, width, height);
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
const LIVE_LIMIT = (typeof document === 'undefined' ? 8 : 96) * 1024 * 1024;

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
  clearInkScratch();
  clearGraphitePaper();
  for (const entry of live.values()) entry.value.dispose();
  live.clear();
  liveBytes = 0;
}
