/**
 * PdfBrushRenderers — shared brush-style rasterizers for the annotation ink
 * pipeline (used by BOTH the infinite canvas and the PDF annotation canvas, so
 * strokes stay pixel-identical across the two surfaces).
 *
 * RENDERING MODEL (union of same-winding subpaths, ONE fill): a stroke is drawn
 * as one quad per consecutive sample pair plus one round disc per sample, all
 * added to the SAME path and filled exactly once with the explicit NONZERO rule.
 * Because every subpath is an independent, convex, same-orientation closed
 * shape, an overlap inside the stroke is winding ±2 (never 0) — so when a stroke
 * turns back and covers itself it can NOT carve out a transparent hole, and a
 * single fill means no alpha stacking anywhere (no round-cap dots at any
 * opacity/speed, no AA bright edges, no hollow/ringed tips, even under
 * self-overlap). 'evenodd' is never used.
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

import { drawStrokePath, applyOneEuro, smoothingToMinCutoff } from './PdfEngine';
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

/** Marker alpha: with "pressure controls opacity" ON, the whole stroke's alpha
 *  swings with AVERAGE pressure inside a narrow band around the opacity slider
 *  (±10 PERCENTAGE POINTS, clamped to 0..1) — light pressure → lower bound, full
 *  pressure → upper bound, mid pressure ≈ the slider value. Toggle OFF keeps the
 *  exact slider opacity. */
export function markerStrokeAlpha(opacity: number, avgPressure: number, pressureOpacityEnabled: boolean): number {
  const op = clamp01(opacity);
  if (!pressureOpacityEnabled) return op;
  const lo = Math.max(0, op - 0.1);
  const hi = Math.min(1, op + 0.1);
  return lo + (hi - lo) * clamp01(avgPressure);
}

// ---- Pressure + width computation -------------------------------------------------

/** Forward EMA (+ light backward pass) over the pressure samples so a single
 *  device spike can't cause a sharp width jump. Coordinate smoothing (the 1€
 *  filter) and pressure smoothing are kept separate. */
export function smoothPressure(pts: { p: number }[], responsiveness = 0.42): number[] {
  const n = pts.length;
  if (n === 0) return [];
  const alpha = Math.max(0.05, Math.min(0.9, responsiveness));
  const out = new Array<number>(n);
  out[0] = finite01(pts[0].p);
  for (let i = 1; i < n; i++) {
    out[i] = out[i - 1] + (finite01(pts[i].p) - out[i - 1]) * alpha;
  }
  for (let i = n - 2; i >= 0; i--) {
    out[i] = out[i] + (out[i + 1] - out[i]) * 0.15;
  }
  return out;
}

/** Hairline floor: very light pressure should map to an EXTREMELY thin line (the
 *  user's 16383-level tablet reports genuinely tiny pressures). The floor is a
 *  ~0.15 px world absolute (≈1.5% of the brush size) — fine enough to act as a
 *  near-hairline while not fully flickering out. */
function minStrokeWidth(baseSize: number): number {
  return Math.max(0.15, baseSize * 0.015);
}

/** Pressure → width. LINEAR mapping (gamma=1) so a light touch maps to a thin
 *  line and only heavier pressure fattens it — Photoshop-style size-by-pressure
 *  with a small hairline floor. */
export function pressureToWidth(pressure: number, baseSize: number, gamma = 1): number {
  const p = Math.pow(finite01(pressure), gamma);
  const min = minStrokeWidth(baseSize);
  const max = Math.max(min, baseSize);
  return min + (max - min) * p;
}

/** Cap per-sample width deltas (wider can change a bit faster than narrower) so
 *  a pressure spike can't blow a stroke up instantly, then a light backward
 *  blend so the tail doesn't step. */
export function stabilizeWidths(widths: number[], baseSize: number): number[] {
  const n = widths.length;
  if (n === 0) return [];
  const min = minStrokeWidth(baseSize);
  const max = Math.max(min, baseSize * 1.15);
  const widening = Math.max(0.35, baseSize * 0.16);
  const narrowing = Math.max(0.25, baseSize * 0.11);
  const safe = (w: number) => (Number.isFinite(w) ? w : min);

  const out = new Array<number>(n);
  out[0] = Math.max(min, Math.min(max, safe(widths[0])));
  for (let i = 1; i < n; i++) {
    const target = Math.max(min, Math.min(max, safe(widths[i])));
    const d = target - out[i - 1];
    out[i] = d > widening ? out[i - 1] + widening : d < -narrowing ? out[i - 1] - narrowing : target;
  }
  for (let i = n - 2; i >= 0; i--) {
    out[i] = out[i] * 0.84 + out[i + 1] * 0.16;
  }
  return out;
}

/** Marker (default brush): width is driven ONLY by smoothed pressure through a
 *  gamma curve — never by writing speed — and stabilized so it changes smoothly.
 *  Opacity stays constant (see drawMarker). */
export function computeMarkerWidths(pts: { p: number }[], baseSize: number): number[] {
  const pressures = smoothPressure(pts, 0.42);
  const widths = new Array<number>(pressures.length);
  for (let i = 0; i < pressures.length; i++) {
    widths[i] = pressureToWidth(pressures[i], baseSize);
  }
  return stabilizeWidths(widths, baseSize);
}

/** Reference speed (~world units/ms) at which fast writing counts as "full thin". */
const INK_SPEED_VREF = 1.0;

/** Average of the two adjacent segment speeds at a sample; dt<=0 / non-finite is
 *  skipped (never divides), extreme speeds are clamped by the caller. */
export function computePointSpeed(
  pts: { x: number; y: number; t: number }[],
  index: number,
): number {
  let sum = 0, count = 0;
  const add = (a: { x: number; y: number; t: number }, b: { x: number; y: number; t: number }) => {
    const dt = b.t - a.t;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const speed = dist / dt;
    if (Number.isFinite(speed)) {
      sum += speed;
      count++;
    }
  };
  if (index > 0) add(pts[index - 1], pts[index]);
  if (index < pts.length - 1) add(pts[index], pts[index + 1]);
  return count > 0 ? sum / count : 0;
}

/** Fountain: pressure (gamma curve) is the main width driver; writing speed only
 *  thins the stroke by a bounded ≤~42% (never to the point of disappearing), and
 *  alpha stays constant. `inkSpeed` keeps its toolbar meaning (how much ink the
 *  pen lays down → base thickness), NOT "faster = thicker": fast always thins. */
export function computeFountainWidths(
  pts: { x: number; y: number; p: number; t: number }[],
  baseSize: number,
  inkSpeed: number,
): number[] {
  const n = pts.length;
  if (n === 0) return [];
  const pressures = smoothPressure(pts, 0.42);
  const gain = 0.5 + 0.5 * clamp01(inkSpeed); // 0.5 (inkSpeed=0) → 1.0 (inkSpeed=1)
  const min = minStrokeWidth(baseSize);

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const pw = pressureToWidth(pressures[i], baseSize) * gain;
    const norm = clamp01(computePointSpeed(pts, i) / INK_SPEED_VREF);
    const speedFactor = Math.max(0.58, 1 - norm * 0.42); // slow≈1 → fast≈0.58
    out[i] = Math.max(min, pw * speedFactor);
  }
  return stabilizeWidths(out, baseSize);
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
 * Draw a variable-width stroke as a UNION of small same-orientation closed
 * subpaths and fill the whole path exactly ONCE with the explicit NONZERO rule:
 *  - one quad (rectangle) per consecutive sample pair, from the +normal side of
 *    `a` to the +normal side of `b`, around to the -normal side and back;
 *  - one round disc centered on EVERY sample (round joins + round tips).
 *
 * Why NOT a single self-intersecting outer outline: when a stroke turns back and
 * covers itself, one big left/right outline crosses itself and nonzero winding
 * can cancel to 0 in the overlap — a transparent "dug out" hole. With a union of
 * independent convex subpaths that are ALL wound the same direction, an overlap
 * is winding ±2 (never 0), so a retrace can NEVER carve a hole.
 *
 * Canvas semantics that make this dot-free AND hole-free:
 *  - exactly one fill('nonzero'); nothing is stroked per-segment, no sub-path is
 *    re-filled, no alpha stacking → no round-cap dots, no AA bright edges;
 *  - the round discs are subpaths of the SAME path, so tips/joins are smooth;
 *  - explicit 'nonzero' (never 'evenodd').
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
  feather = true,
): void {
  const n = points.length;
  if (n === 0) return;

  const half = (w: number) => Math.max(0.06, w * 0.5); // allow sub-0.25px hairlines
  const disc = (cx: number, cy: number, r: number, ccw: boolean) => {
    ctx.moveTo(cx + dx + r, cy + dy);
    ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2, ccw);
  };

  ctx.save();
  ctx.globalCompositeOperation = composite === 'destination-out' ? 'destination-out' : 'source-over';
  ctx.globalAlpha = clamp01(alpha);
  ctx.fillStyle = color;

  // Optional soft ink edge (default ON): a SHORT feather that scales WITH the
  // stroke width (×0.25) but is capped (~0.6 world px), so thin strokes keep a
  // subtle edge and thick strokes never grow a big blurry halo. Applies to the
  // single union fill; hairline-slim strokes get a tiny radius.
  if (feather) {
    let sum = 0;
    for (const w of widths) sum += Number.isFinite(w) ? w : 0;
    const avgWidth = widths.length ? sum / widths.length : 0;
    const softWorld = Math.min(0.6, avgWidth * 0.25);
    if (softWorld > 0.05) {
      let scale = 1;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = typeof (ctx as any).getTransform === 'function' ? (ctx as any).getTransform() : undefined;
        if (t) scale = Math.hypot(t.a, t.b) || 1;
      } catch {
        scale = 1;
      }
      try {
        ctx.filter = `blur(${softWorld * scale}px)`; // device px = world × current scale
      } catch {
        /* no filter support → crisp edge */
      }
    }
  }
  ctx.beginPath();

  if (n === 1) {
    disc(points[0].x, points[0].y, half(widths[0]), false);
    ctx.fill('nonzero');
    ctx.restore();
    return;
  }

  // Quads. Each is an independent closed subpath (own moveTo) so they never join
  // into one giant self-crossing outline.
  let discCCW = false; // pick disc winding to MATCH the quad winding below
  let emitted = false;
  for (let i = 1; i < n; i++) {
    const a = points[i - 1];
    const b = points[i];
    const sdx = b.x - a.x;
    const sdy = b.y - a.y;
    const len = Math.hypot(sdx, sdy);
    if (len < 1e-5) continue;

    const nx = -sdy / len;
    const ny = sdx / len;
    const ra = half(widths[i - 1]);
    const rb = half(widths[i]);

    const x1 = a.x + nx * ra, y1 = a.y + ny * ra;
    const x2 = b.x + nx * rb, y2 = b.y + ny * rb;
    const x3 = b.x - nx * rb, y3 = b.y - ny * rb;
    const x4 = a.x - nx * ra, y4 = a.y - ny * ra;

    if (!emitted) {
      emitted = true;
      // Shoelace sign of the FIRST quad → winding all quads share.
      const area = (x1 * y2 - x2 * y1) + (x2 * y3 - x3 * y2) + (x3 * y4 - x4 * y3) + (x4 * y1 - x1 * y4);
      // ctx.arc(default anticlockwise=false) sweeps increasing angle → POSITIVE
      // signed area in the canvas frame, so a NEGATIVE quad must use ccw=true.
      discCCW = area < 0;
    }

    ctx.moveTo(x1 + dx, y1 + dy);
    ctx.lineTo(x2 + dx, y2 + dy);
    ctx.lineTo(x3 + dx, y3 + dy);
    ctx.lineTo(x4 + dx, y4 + dy);
    ctx.closePath();
  }

  if (!emitted) {
    // All samples coincident → single disc.
    disc(points[0].x, points[0].y, half(widths[0]), false);
    ctx.fill('nonzero');
    ctx.restore();
    return;
  }

  // Round join + round tip discs at every sample (own subpaths, same winding as
  // the quads). Shared by two neighbouring quads, so joints stay smooth.
  for (let i = 0; i < n; i++) {
    disc(points[i].x, points[i].y, half(widths[i]), discCCW);
  }

  ctx.fill('nonzero');
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

// ---- Tile-stamping helper ---------------------------------------------------------

export interface InkRibbon {
  points: ResamplePoint[];
  widths: number[];
  color: string;
  alpha: number;
  composite: PdfStroke['compositeOperation'];
  /** soft-edge feather flag captured at draw time (defaults to ON). */
  edge: boolean;
  /** world margin around a tile: half of the widest local width (+ small slack). */
  pad: number;
}

/** Rasterize a pen stroke's final ribbon ONCE (smoothing + width + resample) so
 *  tiles can be stamped from slices instead of re-processing + re-filling the WHOLE
 *  stroke into every tile it touches. Returns null for eraser / pencil — eraser
 *  keeps PdfEngine.drawStrokePath, and pencil grain is not sliceable, so those
 *  stay on the whole-stroke path. */
export function prepareInkRibbon(stroke: PdfStroke): InkRibbon | null {
  if (stroke.compositeOperation === 'destination-out') return null;
  if (stroke.style === 'pencil') return null;

  const pts = preparePoints(stroke);
  if (pts.length === 0) return null;

  let ribbon: ResampleOut;
  let alpha: number;
  if (stroke.style === 'fountain') {
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
  drawVariableRibbon(ctx, slicePoints, sliceWidths, ribbon.color, ribbon.alpha, ribbon.composite, 0, 0, ribbon.edge);
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

  drawVariableRibbon(ctx, ribbon.points, ribbon.widths, stroke.color, alpha, stroke.compositeOperation, dx, dy, stroke.edgeFeather !== false);
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
  drawVariableRibbon(ctx, ribbon.points, ribbon.widths, stroke.color, alpha, stroke.compositeOperation, dx, dy, stroke.edgeFeather !== false);
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
  drawVariableRibbon(ctx, core.points, core.widths, stroke.color, clamp01(stroke.opacity * 0.85), stroke.compositeOperation, dx, dy, stroke.edgeFeather !== false);

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
