/** Shared deterministic ink rendering for infinite canvas and PDF.
 * New marker/fountain/pencil strokes use version 2 incremental coverage masks.
 * Legacy strokes keep the single-fill, resampled ribbon renderer below;
 * free-eraser rendering also retains its existing path.
 * The version is persisted so reopening ink cannot silently change its shape.
 */

import { drawStrokePath, applyOneEuro, smoothingToMinCutoff } from './PdfEngine';
import type { PdfStroke } from './PdfTypes';
import { getStreamingInk } from './StreamingInkStroke';

import { clamp01, sanitizePoints, averagePressure, markerStrokeAlpha, computeMarkerWidths, computeFountainWidths, computePencilCoreWidths, resampleSpacing, resampleForRibbon, smoothWidths, resolveFeatherWorld } from './InkMath';
import type { ResamplePoint, ResampleOut } from './InkMath';
import { drawVariableRibbon } from './InkRibbonRenderer';
export * from './InkMath';
export { drawVariableRibbon } from './InkRibbonRenderer';

// ---- Dispatcher ----------------------------------------------------------------

/**
 * Draw a stroke onto a context already in WORLD coordinates (main canvas under
 * the camera transform, or a tile under a bakeScale transform). `dx/dy` shift
 * the whole stroke (live drag).
 */
export function drawAnnotatedStroke(
  ctx: CanvasRenderingContext2D,
  stroke: PdfStroke,
  dx = 0,
  dy = 0,
): void {
  if (stroke.renderVersion === 2 && stroke.compositeOperation !== 'destination-out') {
    getStreamingInk(stroke).draw(ctx, dx, dy);
    return;
  }
  if (stroke.compositeOperation === 'destination-out') {
    return drawStrokePath(ctx, stroke, dx, dy);
  }
  switch (stroke.style) {
    case 'fountain':
      return drawFountain(ctx, stroke, dx, dy);
    case 'pencil':
      return drawPencil(ctx, stroke, dx, dy);
    case 'marker':
    default:
      // 'marker' and any legacy/no-style stroke use the marker renderer
      // (the DEFAULT brush is always ribbon-drawn).
      return drawMarker(ctx, stroke, dx, dy);
  }
}

// ---- Shared prepare pipeline ----------------------------------------------------

type FilteredPoint = { x: number; y: number; p: number; t: number };

/** 1€-smooth raw samples, then attach each sample's original timestamp (applyOneEuro
 *  returns one output per input, so pts[i] aligns with raw[i].t). */
function preparePoints(stroke: PdfStroke): FilteredPoint[] {
  const raw = sanitizePoints(stroke.points);
  if (raw.length === 0) return [];
  const sm = applyOneEuro(raw, smoothingToMinCutoff(stroke.smoothing));
  const n = sm.length;
  const out: FilteredPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ri = Math.min(i, raw.length - 1);
    out[i] = { x: sm[i].x, y: sm[i].y, p: sm[i].p, t: raw[ri].t };
  }
  return out;
}

/** Compute per-point widths on the real (filtered) samples, resample the
 *  centerline + widths, smooth the widths, and return ready-to-fill data. */
function buildRibbonData(
  pts: FilteredPoint[],
  widthFn: (pts: FilteredPoint[]) => number[],
): ResampleOut {
  const widths = widthFn(pts);
  const spacing = resampleSpacing(widths);
  const resampled = resampleForRibbon(pts, widths, spacing);
  return { points: resampled.points, widths: smoothWidths(resampled.widths) };
}

// ---- Tile-stamping helper ---------------------------------------------------------

export interface InkRibbon {
  points: ResamplePoint[];
  widths: number[];
  color: string;
  alpha: number;
  composite: PdfStroke['compositeOperation'];
  /** soft-edge feather flag captured at draw time (defaults to ON). */
  edge: boolean;
  /**
   * Feather radius in WORLD px, resolved ONCE for the whole stroke.
   *
   * Every tile must use this same number. Deriving it from a tile's slice instead
   * is what made one stroke's edge soften by different amounts along its length.
   */
  feather: number;
  /** world margin around a tile: half of the widest local width (+ small slack). */
  pad: number;
}

/** Rasterize a pen stroke's final ribbon ONCE (smoothing + width + resample) so
 *  tiles can be stamped from slices instead of re-processing + re-filling the WHOLE
 *  stroke into every tile it touches.
 *
 *  Eraser carves (destination-out, uniform width) are ribbonized TOO: when the
 *  whole-stroke eraser clears a tile and re-stamps the strokes overlapping it,
 *  drawing a carve's whole path into every tile is what made a dense page hitch
 *  (~36ms per erase). A uniform-width ribbon makes carves sliceable like marker/
 *  fountain. Legacy pencil grain is not sliceable, so old pencil ink stays on the whole-stroke
 *  path. */
export function prepareInkRibbon(stroke: PdfStroke): InkRibbon | null {
  if (stroke.renderVersion === 2 || stroke.style === 'pencil') return null;

  const pts = preparePoints(stroke);
  if (pts.length === 0) return null;

  let ribbon: ResampleOut;
  let alpha: number;
  if (stroke.compositeOperation === 'destination-out') {
    // Uniform width == eraser radius (matches PdfEngine.drawStrokePath's eraser
    // width = stroke.size). Constant widths → smoothing is a no-op.
    const widths = new Array<number>(pts.length).fill(stroke.size);
    const resampled = resampleForRibbon(pts, widths, resampleSpacing(widths));
    ribbon = { points: resampled.points, widths: smoothWidths(resampled.widths) };
    alpha = stroke.opacity; // eraser carves commit with opacity 1
  } else if (stroke.style === 'fountain') {
    const inkSpeed = stroke.inkSpeed ?? 0.5;
    ribbon = buildRibbonData(pts, (fp) => computeFountainWidths(fp, stroke.size, inkSpeed));
    alpha = markerStrokeAlpha(stroke.opacity, averagePressure(pts), stroke.pressureOpacity === true);
  } else {
    ribbon = buildRibbonData(pts, (fp) => computeMarkerWidths(fp, stroke.size));
    alpha = markerStrokeAlpha(stroke.opacity, averagePressure(pts), stroke.pressureOpacity === true);
  }
  if (ribbon.points.length === 0) return null;

  let maxW = 0;
  for (const w of ribbon.widths) if (Number.isFinite(w) && w > maxW) maxW = w;
  return {
    points: ribbon.points,
    widths: ribbon.widths,
    color: stroke.color,
    alpha,
    composite: stroke.compositeOperation,
    edge: stroke.edgeFeather !== false,
    feather: resolveFeatherWorld(stroke, ribbon.widths),
    pad: maxW * 0.5 + 2, // ≥ widest half width + small safety margin
  };
}

/**
 * Stamp a prepared ribbon into a context already in world coordinates, drawing
 * ONLY the contiguous point range whose envelope can reach the world rect
 * [minX..maxX]×[minY..maxY] (points/widths are already final, so a slice renders
 * pixel-identical to the full ribbon inside the rect — no re-smoothing, no seams
 * — while per-tile raster cost scales with the tile, not the whole stroke). */
export function drawInkRibbonSlice(
  ctx: CanvasRenderingContext2D,
  ribbon: InkRibbon,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  const { points, widths } = ribbon;
  const n = points.length;
  if (n === 0) return;
  const p = ribbon.pad;

  let lo = -1;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const q = points[i];
    if (q.x >= minX - p && q.x <= maxX + p && q.y >= minY - p && q.y <= maxY + p) {
      if (lo === -1) lo = i;
      hi = i;
    }
  }
  if (lo === -1) return;

  const slicePoints = lo === 0 && hi === n - 1 ? points : points.slice(lo, hi + 1);
  const sliceWidths = lo === 0 && hi === n - 1 ? widths : widths.slice(lo, hi + 1);
  drawVariableRibbon(ctx, slicePoints, sliceWidths, ribbon.color, ribbon.alpha, ribbon.composite, 0, 0, ribbon.feather);
}

// ---- Marker (default brush) ----------------------------------------------------

function drawMarker(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const pts = preparePoints(stroke);
  if (pts.length === 0) return;

  const ribbon = buildRibbonData(pts, (fp) => computeMarkerWidths(fp, stroke.size));

  // Whole-stroke alpha: with "pressure opacity" ON, alpha swings with AVERAGE
  // pressure inside a narrow band around the opacity slider (±10 percentage
  // points, clamped to 0..1) — it can never exceed the slider's bounds.
  const alpha = markerStrokeAlpha(stroke.opacity, averagePressure(pts), stroke.pressureOpacity === true);

  drawVariableRibbon(ctx, ribbon.points, ribbon.widths, stroke.color, alpha, stroke.compositeOperation, dx, dy, resolveFeatherWorld(stroke, ribbon.widths));
}

// ---- Fountain pen --------------------------------------------------------------

function drawFountain(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const pts = preparePoints(stroke);
  if (pts.length === 0) return;

  const inkSpeed = stroke.inkSpeed ?? 0.5;
  const ribbon = buildRibbonData(pts, (fp) => computeFountainWidths(fp, stroke.size, inkSpeed));

  // Fountain supports the same pressure→opacity band (±10pp around the slider)
  // as marker when the toggle is ON.
  const alpha = markerStrokeAlpha(stroke.opacity, averagePressure(pts), stroke.pressureOpacity === true);
  drawVariableRibbon(ctx, ribbon.points, ribbon.widths, stroke.color, alpha, stroke.compositeOperation, dx, dy, resolveFeatherWorld(stroke, ribbon.widths));
}

// ---- Pencil (hard lead core + deterministic grain) ------------------------------

/**
 * Hard-tip pencil: the lead core is a narrow pressure-varying ribbon (single
 * fill), plus a SPARSE deterministic grain of short lead streaks scattered along
 * the centerline. Grain is seeded by `stroke.id`, so re-stamping reproduces
 * identical pixels. All streaks are batched into ONE path and stroked once — no
 * per-streak alpha stacking, no visible dot chain, no hollow round tips (grain
 * is kept away from both ends). Offsets stay inside getStrokeBounds's size/2 so
 * tiles are never clipped.
 */
function drawPencil(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const pts = preparePoints(stroke);
  if (pts.length === 0) return;

  const core = buildRibbonData(pts, (fp) => computePencilCoreWidths(fp, stroke.size));
  drawVariableRibbon(ctx, core.points, core.widths, stroke.color, clamp01(stroke.opacity * 0.85), stroke.compositeOperation, dx, dy, resolveFeatherWorld(stroke, core.widths));

  drawPencilGrain(ctx, core.points, stroke, dx, dy);
}

/** Short deterministic lead streaks. Runs after the core fill (separate save/
 *  restore), one batched stroke() call. */
function drawPencilGrain(
  ctx: CanvasRenderingContext2D,
  points: ResamplePoint[],
  stroke: PdfStroke,
  dx: number,
  dy: number,
): void {
  const m = points.length;
  if (m < 2) return;

  const size = stroke.size;
  const grainW = Math.max(0.35, size * 0.08);
  const grainAlpha = Math.min(1, stroke.opacity * 0.16);
  const seedGap = Math.max(3, size * 0.6);
  const offR = size * 0.25;
  const pad = Math.max(size * 0.6, seedGap); // keep streaks off both tips

  // Cumulative arc length along the (resampled) centerline.
  const cum = new Array<number>(m);
  cum[0] = 0;
  let total = 0;
  for (let i = 1; i < m; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    cum[i] = total;
  }
  if (total < 1e-5) return;

  const rng = mulberry32(hashStr(stroke.id));

  ctx.save();
  ctx.globalCompositeOperation = stroke.compositeOperation;
  ctx.globalAlpha = grainAlpha;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = grainW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  for (let i = 1; i < m; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = cum[i] - cum[i - 1];
    if (segLen < 1e-5) continue;
    // Skip segments entirely inside the tip pads.
    if (cum[i - 1] > total - pad || cum[i] < pad) continue;

    const ux = (b.x - a.x) / segLen;
    const uy = (b.y - a.y) / segLen;
    const nx = -uy;
    const ny = ux;

    const count = Math.max(1, Math.floor(segLen / seedGap));
    for (let j = 0; j < count; j++) {
      if (rng() > 0.45) continue; // ~45% of candidates become a streak
      const s = (j + rng()) / count; // 0..1 inside [a..b]
      const d = cum[i - 1] + s * segLen;
      if (d < pad || d > total - pad) continue;

      const px = a.x + (b.x - a.x) * s + nx * (rng() * 2 - 1) * offR;
      const py = a.y + (b.y - a.y) * s + ny * (rng() * 2 - 1) * offR;
      const len = size * (0.25 + rng() * 0.55);

      ctx.moveTo(px + dx, py + dy);
      ctx.lineTo(px + dx + ux * len, py + dy + uy * len);
    }
  }
  ctx.stroke();
  ctx.restore();
}

// ---- Deterministic helpers -----------------------------------------------------

function hashStr(s: string): number {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
