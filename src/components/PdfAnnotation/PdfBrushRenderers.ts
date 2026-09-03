/**
 * PdfBrushRenderers — shared brush-style rasterizers for the annotation ink
 * pipeline (used by BOTH the infinite canvas and the PDF annotation canvas, so
 * strokes stay pixel-identical across the two surfaces).
 *
 * RENDERING MODEL (no dots): strokes are drawn with a **butt line cap** on a
 * per-segment basis — each pair of consecutive points is stroked as a segment at
 * that segment's width, but WITHOUT a round end-cap. Round end-caps were what
 * stacked into "dots"/circles at slow writing / low opacity; with butt caps
 * nothing overlaps, so there are no dots at any opacity or speed. Only the two
 * very ends of the whole stroke get a single round cap for a rounded tip.
 *
 * Widths are per-point (pressure for marker; pressure + writing speed for the
 * pen), then SMOOTHED so a sudden pressure/speed change can't create a "bump"
 * (a step between neighboring segment widths).
 *
 * `drawAnnotatedStroke` dispatches: eraser → PdfEngine.drawStrokePath (unchanged);
 * 'marker'/'fountain' → the butt-cap renderers; 'pencil' → its own renderer;
 * legacy/no-style → marker renderer (so the DEFAULT brush is always dot-free).
 */

import { drawStrokePath, applyOneEuro, smoothingToMinCutoff, strokeWidth } from './PdfEngine';
import type { PdfStroke } from './PdfTypes';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---- Shared butt-cap per-segment stroke ----------------------------------------

/**
 * Stroke consecutive points as round-JOINED segments but with **butt** line caps
 * (no round end-cap per segment), then add one round cap at each end of the
 * whole stroke for a rounded tip. Butt caps guarantee adjacent segments never
 * overlap, so no "dots"/circles appear at any opacity or writing speed.
 */
function strokeSegmentsButt(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  widths: number[],
  color: string,
  alpha: number,
  composite: PdfStroke['compositeOperation'],
  dx: number,
  dy: number,
): void {
  const n = pts.length;
  if (n === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = composite;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  if (n === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x + dx, pts[0].y + dy, Math.max(0.5, widths[0]) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Body: per-segment butt-cap strokes (no cap overlap → no dots).
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    ctx.lineWidth = Math.max(0.5, (widths[i - 1] + widths[i]) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x + dx, a.y + dy);
    ctx.lineTo(b.x + dx, b.y + dy);
    ctx.stroke();
  }

  // Rounded tips: one round cap on each end of the whole stroke.
  ctx.lineCap = 'round';
  const r0 = Math.max(0.5, widths[0]) / 2;
  ctx.beginPath();
  ctx.arc(pts[0].x + dx, pts[0].y + dy, r0, 0, Math.PI * 2);
  ctx.fill();
  const rl = Math.max(0.5, widths[n - 1]) / 2;
  ctx.beginPath();
  ctx.arc(pts[n - 1].x + dx, pts[n - 1].y + dy, rl, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Smooth a width array (2 passes of a 3-point average + neighbor clamp) so a
 *  pressure/speed spike can't make adjacent segment widths jump — this removes
 *  the "bumps"/bumpy edges at fast corners and pen starts. */
function smoothWidths(widths: number[]): number[] {
  const n = widths.length;
  const out = widths.slice();
  for (let pass = 0; pass < 2; pass++) {
    const src = out.slice();
    for (let i = 0; i < n; i++) {
      const a = src[Math.max(0, i - 1)];
      const b = src[i];
      const c = src[Math.min(n - 1, i + 1)];
      let v = (a + b + c) / 3;
      const lo = Math.min(a, c) * 0.7;
      const hi = Math.max(a, c) * 1.4;
      out[i] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}

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
      // 'marker' and any legacy/no-style stroke use the dot-free marker renderer
      // (the DEFAULT brush is never drawn via the old dot-prone drawStrokePath).
      return drawMarker(ctx, stroke, dx, dy);
  }
}

// ---- Fountain pen --------------------------------------------------------------

/** Pressure → width curve (thin at low pressure, approaching `size` at full). */
function fountainWidth(pressure: number, baseSize: number): number {
  return Math.max(0.4, baseSize * (0.08 + 0.92 * Math.pow(clamp01(pressure), 1.6)));
}

/** Reference speed (~world units/ms) at which fast writing counts as "full thin". */
const INK_SPEED_VREF = 1.0;

function drawFountain(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const raw = stroke.points;
  if (raw.length === 0) return;

  const pts = applyOneEuro(raw, smoothingToMinCutoff(stroke.smoothing));
  const n = pts.length;
  if (n === 0) return;

  // applyOneEuro emits one output per input point, so pts[i] aligns with raw[i].
  const ws = stroke.inkSpeed ?? 0.5;
  const gain = 0.5 + 0.5 * ws; // 0.5 (ws=0) → 1.0 (ws=1): ws=100 is thicker

  const widths = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let w = fountainWidth(pts[i].p, stroke.size) * gain;
    // Average adjacent segment speeds at this point → smooth taper.
    let v = 0, cnt = 0;
    if (i > 0) { const dt = raw[i].t - raw[i - 1].t; if (dt > 0) { v += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / dt; cnt++; } }
    if (i < n - 1) { const dt = raw[i + 1].t - raw[i].t; if (dt > 0) { v += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) / dt; cnt++; } }
    if (cnt > 0) {
      const sf = 1 - clamp01((v / cnt) / INK_SPEED_VREF);
      w *= Math.max(0.45, 1 - 0.55 * (1 - sf)); // fast → thinner (min 0.45×)
    }
    widths[i] = Math.max(0.4, w);
  }

  strokeSegmentsButt(ctx, pts, smoothWidths(widths), stroke.color, stroke.opacity, stroke.compositeOperation, dx, dy);
}

// ---- Marker (default brush) ----------------------------------------------------

/**
 * Default brush: per-point width from pressure, constant opacity, butt-cap
 * per-segment (no dots), width smoothed (no bumps). Rounded tips via end caps.
 */
function drawMarker(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const raw = stroke.points;
  if (raw.length === 0) return;

  const pts = applyOneEuro(raw, smoothingToMinCutoff(stroke.smoothing));
  const n = pts.length;
  if (n === 0) return;

  const widths = new Array<number>(n);
  for (let i = 0; i < n; i++) widths[i] = Math.max(0.5, strokeWidth(pts[i].p, stroke.size, false));

  strokeSegmentsButt(ctx, pts, smoothWidths(widths), stroke.color, stroke.opacity, stroke.compositeOperation, dx, dy);
}

// ---- Pencil (hard lead core + deterministic grain) ------------------------------

/**
 * Hard-tip pencil: a thin, constant-width lead core (single path, no joins
 * stacking) plus sparse grain dots scattered along the stroke. Grain is seeded
 * by `stroke.id`, so re-stamping reproduces identical pixels; offsets stay within
 * size*0.35 (inside getStrokeBounds size/2) so tiles aren't clipped.
 */
function drawPencil(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const raw = stroke.points;
  if (raw.length === 0) return;

  const pts = applyOneEuro(raw, smoothingToMinCutoff(stroke.smoothing));
  const rng = mulberry32(hashStr(stroke.id));
  const coreW = Math.max(0.6, stroke.size * 0.5);
  const grainR = stroke.size * 0.32;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = stroke.compositeOperation;

  // 1) Lead core — single constant-width path (no round-cap stacking).
  ctx.globalAlpha = stroke.opacity * 0.9;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = coreW;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x + dx, pts[0].y + dy, coreW / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x + dx, pts[0].y + dy);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + dx, pts[i].y + dy);
    ctx.stroke();
  }

  // 2) Grain dots — scattered along the polyline; one batched fill.
  ctx.globalAlpha = stroke.opacity * 0.28;
  ctx.fillStyle = stroke.color;
  ctx.beginPath();
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dxSeg = b.x - a.x;
    const dySeg = b.y - a.y;
    const len = Math.hypot(dxSeg, dySeg);
    if (len < 0.01) continue;
    const nx = -dySeg / len;
    const ny = dxSeg / len;
    const count = Math.max(1, Math.floor(len / 3));
    for (let k = 0; k < count; k++) {
      if (rng() > 0.55) continue;
      const t = rng();
      const px = a.x + dx + t * dxSeg + nx * (rng() * 2 - 1) * grainR;
      const py = a.y + dy + t * dySeg + ny * (rng() * 2 - 1) * grainR;
      const r = 0.4 + rng() * 0.8;
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();

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
