/**
 * PdfBrushRenderers — shared brush-style rasterizers for the annotation ink
 * pipeline (used by BOTH the infinite canvas and the PDF annotation canvas, so
 * the new brush styles stay pixel-identical across the two surfaces).
 *
 * `drawAnnotatedStroke` is a thin dispatcher built on top of PdfEngine's
 * `drawStrokePath`: the classic marker (and any legacy stroke without a `style`,
 * plus erasers) is passed straight through unchanged, so the existing writing
 * core never changes behavior. Fountain / pencil get their own renderer.
 *
 * Everything here must be DETERMINISTIC from the persisted vector
 * (points + params): tiles are rebuilt from scratch on undo / redo / move /
 * clear / load, so re-stamping a stroke must reproduce identical pixels.
 * Fountain has no randomness; pencil derives its grain from a stable hash of
 * stroke.id (mulberry32 PRNG).
 */

import { drawStrokePath, applyOneEuro, smoothingToMinCutoff, strokeWidth } from './PdfEngine';
import type { PdfStroke } from './PdfTypes';

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

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---- Dispatcher ----------------------------------------------------------------

/**
 * Draw a stroke onto a context already in WORLD coordinates (main canvas under
 * the camera transform, or a tile under a bakeScale transform). `dx/dy` shift
 * the whole stroke (live drag). Dispatches on `stroke.style`:
 *   - eraser (destination-out)  → PdfEngine.drawStrokePath (unchanged)
 *   - 'fountain' / 'pencil'     → dedicated renderer
 *   - marker / legacy (no style) → PdfEngine.drawStrokePath (unchanged)
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
      // Only a marker stroke drawn with the pressure→opacity toggle ON uses the
      // pressure-alpha renderer. Legacy/no-style strokes and the toggle OFF fall
      // through to drawStrokePath (constant alpha), preserving existing behavior.
      if (stroke.pressureOpacity === true) return drawMarkerPressureAlpha(ctx, stroke, dx, dy);
      return drawStrokePath(ctx, stroke, dx, dy);
    default:
      return drawStrokePath(ctx, stroke, dx, dy);
  }
}

// ---- Fountain pen (pressure → ink width, constant alpha) ------------------------

/**
 * Pressure-sensitive width: very thin at low pressure, approaching `size` at
 * full pressure — a more realistic "capillary" response than the marker's
 * linear mapping. Alpha is held constant (the marker's approach) so per-segment
 * stroking never stacks darker at the round-cap joints.
 */
function fountainWidth(pressure: number, baseSize: number): number {
  return Math.max(0.4, baseSize * (0.08 + 0.92 * Math.pow(clamp01(pressure), 1.6)));
}

function drawFountain(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const raw = stroke.points;
  if (raw.length === 0) return;

  const pts = applyOneEuro(raw, smoothingToMinCutoff(stroke.smoothing));
  // applyOneEuro emits one output per input point, so pts[i] aligns with raw[i].
  // Ink-speed sensitivity: fast strokes run thin (ink lags), slow strokes lay
  // down full ink. ws = 0 → pure pressure; ws = 1 → fast writing thins to 0.15×.
  const ws = stroke.inkSpeed ?? 0.5;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = stroke.compositeOperation;
  ctx.globalAlpha = stroke.opacity;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  if (pts.length === 1) {
    const w = fountainWidth(pts[0].p, stroke.size);
    ctx.beginPath();
    ctx.arc(pts[0].x + dx, pts[0].y + dy, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    let w = (fountainWidth(a.p, stroke.size) + fountainWidth(b.p, stroke.size)) / 2;
    if (ws > 0) {
      const dt = raw[i].t - raw[i - 1].t;
      if (dt > 0) {
        const v = Math.hypot(b.x - a.x, b.y - a.y) / dt; // world units / ms
        const speedFactor = 1 - clamp01(v / INK_SPEED_VREF);
        w *= Math.max(0.15, 1 - ws * (1 - speedFactor));
      }
    }
    ctx.lineWidth = Math.max(0.4, w);
    ctx.beginPath();
    ctx.moveTo(a.x + dx, a.y + dy);
    ctx.lineTo(b.x + dx, b.y + dy);
    ctx.stroke();
  }

  ctx.restore();
}

/** Reference speed (~world units/ms) at which fast writing counts as "full thin". */
const INK_SPEED_VREF = 1.0;

// ---- Marker (pressure → opacity, optional) --------------------------------------

/**
 * Default brush with the "pressure opacity" toggle ON: per-segment alpha rises
 * with pressure (light ink at low pressure, full ink at high pressure). Same
 * marker width curve (strokeWidth) as drawStrokePath. Per-segment round-caps do
 * stack slightly at joints — the intended "ink depth" watermark effect.
 */
function drawMarkerPressureAlpha(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const raw = stroke.points;
  if (raw.length === 0) return;

  const pts = applyOneEuro(raw, smoothingToMinCutoff(stroke.smoothing));

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = stroke.compositeOperation;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  if (pts.length === 1) {
    const p = pts[0].p;
    const alpha = stroke.opacity * (0.15 + 0.85 * clamp01(p));
    const w = strokeWidth(p, stroke.size, false);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(pts[0].x + dx, pts[0].y + dy, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const p = (a.p + b.p) / 2;
    ctx.globalAlpha = stroke.opacity * (0.15 + 0.85 * clamp01(p));
    ctx.lineWidth = strokeWidth(p, stroke.size, false);
    ctx.beginPath();
    ctx.moveTo(a.x + dx, a.y + dy);
    ctx.lineTo(b.x + dx, b.y + dy);
    ctx.stroke();
  }

  ctx.restore();
}

// ---- Pencil (hard lead core + deterministic grain) ------------------------------

/**
 * Hard-tip pencil: a thin, constant-width lead core (drawn as a single path so
 * it never joints-shades) plus sparse grain dots scattered along the stroke.
 * The grain is seeded by `stroke.id`, so re-stamping produces identical pixels.
 * Grain offset stays within size*0.35 — comfortably inside getStrokeBounds's
 * size/2 — so tiles aren't clipped at their edges.
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
    // Samples proportional to length so dot density is uniform everywhere.
    const count = Math.max(1, Math.floor(len / 3));
    for (let k = 0; k < count; k++) {
      if (rng() > 0.55) continue; // sparse grain
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
