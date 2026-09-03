/**
 * PdfBrushRenderers — shared brush-style rasterizers for the annotation ink
 * pipeline (used by BOTH the infinite canvas and the PDF annotation canvas, so
 * strokes stay pixel-identical across the two surfaces).
 *
 * RENDERING MODEL (continuous ribbon, single fill): each brush stroke is turned
 * into ONE fill — the ribbon body (left half-width boundary traced forward,
 * right half-width boundary traced back) plus FULL-DISC round caps centered on
 * the first/last samples as extra subpaths of the same path — then filled
 * EXACTLY ONCE at one globalAlpha. Because nothing is stroked per-segment and
 * no sub-path is re-filled, there is no alpha stacking anywhere in the stroke:
 * no round-cap "dots" at any opacity/speed, no butt-cap trapezoid steps at
 * joins, no AA bright edges between segments, no hollow/ringed tips. The
 * full-disc caps (not half-discs) fully cover the start/stop point even when a
 * stroke doubles back over itself, so its own outline re-crossing there can't
 * carve out a winding-0 colorless sliver.
 *
 * Widths are per-point (pressure for marker; pressure + writing speed for the
 * pen; a narrow pressure core for the pencil), spatially RESAMPLED along the
 * centerline so fast large gaps are subdivided (no long flat chords / width
 * jumps), then smoothed so a pressure/speed spike can't create a "bump". All of
 * it is DETERMINISTIC from the persisted vector (points + params) — tiles are
 * rebuilt from scratch on undo/redo/move/clear/load, so re-stamping a stroke
 * must reproduce identical pixels. Fountain has no randomness; pencil derives
 * its grain from a stable hash of stroke.id (mulberry32 PRNG).
 *
 * `drawAnnotatedStroke` dispatches: eraser (destination-out) → PdfEngine
 * drawStrokePath (unchanged); 'fountain'/'pencil' → their renderer; marker and
 * any legacy/no-style stroke → the marker renderer (so the DEFAULT brush is
 * always ribbon-drawn). When a marker stroke has pressureOpacity=true, the whole
 * stroke's alpha is scaled by the AVERAGE pressure (ink depth follows how hard
 * you press) — still a single fill, so it never stacks.
 */

import { drawStrokePath, applyOneEuro, smoothingToMinCutoff, strokeWidth } from './PdfEngine';
import type { PdfStroke } from './PdfTypes';

// ---- Small numeric helpers ----------------------------------------------------

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** clamp01, but treats NaN/±Infinity as the neutral value 0.5. */
function finite01(v: number): number {
  return Number.isFinite(v) ? clamp01(v) : 0.5;
}

/** Remove non-finite x/y/pressure/t from raw sample data (corrupt / pathological
 *  device events) so downstream math never produces NaN widths or positions. */
export function sanitizePoints(
  pts: { x: number; y: number; pressure: number; t: number }[],
): { x: number; y: number; pressure: number; t: number }[] {
  const out: { x: number; y: number; pressure: number; t: number }[] = [];
  let lastX = 0, lastY = 0, lastT = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    const x = Number.isFinite(q.x) ? q.x : lastX;
    const y = Number.isFinite(q.y) ? q.y : lastY;
    const pressure = finite01(q.pressure);
    const t = Number.isFinite(q.t) ? q.t : lastT;
    out.push({ x, y, pressure, t });
    lastX = x; lastY = y; lastT = t;
  }
  return out;
}

export function averagePressure(pts: { p: number }[]): number {
  if (pts.length === 0) return 0.5;
  let sum = 0;
  for (const pt of pts) sum += Number.isFinite(pt.p) ? clamp01(pt.p) : 0.5;
  return sum / pts.length;
}

// ---- Width computation ---------------------------------------------------------

/** Marker: linear pressure → width (same curve PdfEngine.drawStrokePath used). */
export function computeMarkerWidths(pts: { p: number }[], baseSize: number): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i++) {
    out[i] = Math.max(0.5, strokeWidth(finite01(pts[i].p), baseSize, false));
  }
  return out;
}

/** Reference speed (~world units/ms) at which fast writing counts as "full thin". */
const INK_SPEED_VREF = 1.0;

/** Fountain: pressure → width (capillary curve) × ink-gain × fast-thin speed
 *  factor. `inkSpeed` keeps its toolbar meaning — how much ink the pen lays
 *  down (higher → thicker base) — with a FIXED extra term that keeps fast
 *  strokes thinner than slow strokes (ink lags when you write fast). */
export function computeFountainWidths(
  pts: { x: number; y: number; p: number; t: number }[],
  baseSize: number,
  inkSpeed: number,
): number[] {
  const n = pts.length;
  const out = new Array<number>(n);
  const gain = 0.5 + 0.5 * clamp01(inkSpeed); // 0.5 (inkSpeed=0) → 1.0 (inkSpeed=1)

  for (let i = 0; i < n; i++) {
    const p = finite01(pts[i].p);
    // Thin at low pressure, approaching `size` at full pressure.
    let w = Math.max(0.4, baseSize * (0.08 + 0.92 * Math.pow(p, 1.6))) * gain;

    // Average adjacent segment speeds at this point → smooth taper. dt<=0 (equal
    // or inverted timestamps) is skipped so no division by zero / negative width.
    let v = 0, cnt = 0;
    if (i > 0) {
      const dt = pts[i].t - pts[i - 1].t;
      if (dt > 0) {
        v += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / dt;
        cnt++;
      }
    }
    if (i < n - 1) {
      const dt = pts[i + 1].t - pts[i].t;
      if (dt > 0) {
        v += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) / dt;
        cnt++;
      }
    }
    if (cnt > 0) {
      const sf = 1 - clamp01((v / cnt) / INK_SPEED_VREF);
      w *= Math.max(0.45, 1 - 0.55 * (1 - sf)); // fast → thinner (min 0.45×)
    }
    out[i] = Math.max(0.4, w);
  }
  return out;
}

/** Pencil lead core: narrow hard lead that widens a little with pressure. */
export function computePencilCoreWidths(pts: { p: number }[], baseSize: number): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = finite01(pts[i].p);
    out[i] = Math.max(0.6, baseSize * (0.28 + p * 0.42));
  }
  return out;
}

// ---- Resampling ---------------------------------------------------------------

/** Centerline resampling step: keep ribbon facets small relative to the width
 *  (≤ ~0.4× average width) so fast large gaps never become long flat chords and
 *  width transitions never jump. Never below 1 world unit. */
export function resampleSpacing(widths: number[]): number {
  if (widths.length === 0) return 1;
  let sum = 0;
  for (const w of widths) sum += Number.isFinite(w) ? Math.abs(w) : 0;
  return Math.max(1, (sum / widths.length) * 0.4);
}

export interface ResamplePoint {
  x: number;
  y: number;
}
export interface ResampleOut {
  points: ResamplePoint[];
  widths: number[];
}

/** Arc-length resample of the centerline (deterministic, linear). Inserted
 *  points carry linearly interpolated width so the ribbon outline follows the
 *  width field smoothly between real samples. The ORIGINAL stroke is never
 *  mutated; this runs on a render-time copy. Coincident duplicates are dropped
 *  but the real first/last samples are always preserved. */
export function resampleForRibbon(
  points: { x: number; y: number }[],
  widths: number[],
  spacing: number,
): ResampleOut {
  const step = Math.max(1, spacing);
  const outPts: ResamplePoint[] = [];
  const outW: number[] = [];

  const push = (x: number, y: number, w: number) => {
    if (outPts.length === 0) {
      outPts.push({ x, y });
      outW.push(w);
      return;
    }
    const last = outPts[outPts.length - 1];
    if (Math.hypot(last.x - x, last.y - y) < 1e-5) {
      outW[outW.length - 1] = w; // keep the latest width at a coincident point
      return;
    }
    outPts.push({ x, y });
    outW.push(w);
  };

  if (points.length === 0) return { points: outPts, widths: outW };
  push(points[0].x, points[0].y, widths[0]);

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-5) continue; // duplicate — the envelope is unchanged

    const w0 = widths[i - 1];
    const w1 = widths[i];
    const count = Math.floor(dist / step);
    for (let j = 1; j <= count; j++) {
      const t = (j * step) / dist;
      if (t >= 1) break; // endpoint push below handles the tail
      push(a.x + dx * t, a.y + dy * t, w0 + (w1 - w0) * t);
    }
    push(b.x, b.y, w1);
  }

  // Guarantee the real final sample survives (e.g. trailing duplicates).
  const last = points[points.length - 1];
  if (outPts.length === 0 || Math.hypot(outPts[outPts.length - 1].x - last.x, outPts[outPts.length - 1].y - last.y) >= 1e-5) {
    push(last.x, last.y, widths[widths.length - 1]);
  }

  return { points: outPts, widths: outW };
}

// ---- Width smoothing ------------------------------------------------------------

/** Smooth a width array (2 passes of a 3-point average + neighbor clamp) so a
 *  pressure/speed spike can't make adjacent widths jump — this removes the
 *  "bumps"/bumpy edges at fast corners and pen starts/ends. */
export function smoothWidths(widths: number[]): number[] {
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

// ---- Single-fill variable-width ribbon ------------------------------------------

/**
 * Draw a variable-width stroke as a ribbon body + two full-disc round caps and
 * fill the whole path exactly once. Left/right boundaries are the centerline
 * offset by ±halfWidth along each sample's normal.
 *
 * Canvas semantics that make this dot-free:
 *  - a single fill() never re-composites — no per-segment round caps to stack,
 *    no butt end-faces to create trapezoid steps, no overlapping strokes;
 *  - the round tips are FULL discs (own subpaths in the same path, positive
 *    winding), so the brush fully covers its start/stop point even when the
 *    stroke loops back over itself — no winding-0 sliver, no hollow/ring.
 *
 * No Path2D is used (keeps it jsdom/mock-ctx friendly and identical on real
 * canvases). Points/widths are already in the caller's coordinate space; dx/dy
 * optionally shift the whole stroke (live drag).
 */
export function drawVariableRibbon(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  widths: number[],
  color: string,
  alpha: number,
  composite: PdfStroke['compositeOperation'],
  dx = 0,
  dy = 0,
): void {
  const n = points.length;
  if (n === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = composite === 'destination-out' ? 'destination-out' : 'source-over';
  ctx.globalAlpha = clamp01(alpha);
  ctx.fillStyle = color;

  if (n === 1) {
    const radius = Math.max(0.5, widths[0]) * 0.5;
    ctx.beginPath();
    ctx.arc(points[0].x + dx, points[0].y + dy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const half = (w: number) => Math.max(0.5, w) * 0.5;
  const tangentAt = (i: number) => {
    const cur = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    if (Math.hypot(tx, ty) < 1e-5) {
      tx = next.x - cur.x;
      ty = next.y - cur.y;
    }
    if (Math.hypot(tx, ty) < 1e-5) {
      tx = cur.x - prev.x;
      ty = cur.y - prev.y;
    }
    const len = Math.hypot(tx, ty);
    if (len < 1e-5) return { x: 1, y: 0 }; // degenerate: single point handled above
    return { x: tx / len, y: ty / len };
  };

  const left: ResamplePoint[] = [];
  const right: ResamplePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangentAt(i);
    const hw = half(widths[i]);
    // normal = (-ty, tx)
    left.push({ x: points[i].x + -t.y * hw, y: points[i].y + t.x * hw });
    right.push({ x: points[i].x - -t.y * hw, y: points[i].y - t.x * hw });
  }

  ctx.beginPath();

  // Ribbon body (butt outline): left boundary forward, straight cross edge at
  // the far end, right boundary backward, closed across the start.
  ctx.moveTo(left[0].x + dx, left[0].y + dy);
  for (let i = 1; i < n; i++) {
    ctx.lineTo(left[i].x + dx, left[i].y + dy);
  }
  ctx.lineTo(right[n - 1].x + dx, right[n - 1].y + dy);
  for (let i = n - 2; i >= 0; i--) {
    ctx.lineTo(right[i].x + dx, right[i].y + dy);
  }
  ctx.closePath();

  // Round tips: FULL discs centered on the first/last samples, added as their
  // own subpaths of the SAME path (positive winding) — one fill, so no alpha
  // stacking anywhere. Full discs (not half) guarantee the brush fully covers
  // its start/stop spot even when the stroke doubles back so its own outline
  // re-crosses there — a half-disc cap can leave a winding-0 colorless sliver.
  const end = points[n - 1];
  const start = points[0];
  const endR = half(widths[n - 1]);
  const startR = half(widths[0]);
  ctx.moveTo(end.x + dx + endR, end.y + dy);
  ctx.arc(end.x + dx, end.y + dy, endR, 0, Math.PI * 2);
  ctx.moveTo(start.x + dx + startR, start.y + dy);
  ctx.arc(start.x + dx, start.y + dy, startR, 0, Math.PI * 2);

  ctx.fill();
  ctx.restore();
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

// ---- Marker (default brush) ----------------------------------------------------

function drawMarker(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const pts = preparePoints(stroke);
  if (pts.length === 0) return;

  const ribbon = buildRibbonData(pts, (fp) => computeMarkerWidths(fp, stroke.size));

  // Whole-stroke alpha: if the "pressure opacity" toggle is on, the stroke's ink
  // depth follows how hard you press (AVERAGE pressure) — still a single fill,
  // so it never stacks. Toggle off / legacy strokes stay at constant opacity.
  const alpha =
    stroke.pressureOpacity === true
      ? clamp01(stroke.opacity * (0.2 + 0.8 * averagePressure(pts)))
      : stroke.opacity;

  drawVariableRibbon(ctx, ribbon.points, ribbon.widths, stroke.color, alpha, stroke.compositeOperation, dx, dy);
}

// ---- Fountain pen --------------------------------------------------------------

function drawFountain(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const pts = preparePoints(stroke);
  if (pts.length === 0) return;

  const inkSpeed = stroke.inkSpeed ?? 0.5;
  const ribbon = buildRibbonData(pts, (fp) => computeFountainWidths(fp, stroke.size, inkSpeed));

  drawVariableRibbon(ctx, ribbon.points, ribbon.widths, stroke.color, stroke.opacity, stroke.compositeOperation, dx, dy);
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
  drawVariableRibbon(ctx, core.points, core.widths, stroke.color, clamp01(stroke.opacity * 0.85), stroke.compositeOperation, dx, dy);

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
