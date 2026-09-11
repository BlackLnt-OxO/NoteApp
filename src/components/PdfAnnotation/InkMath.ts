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
// ---- Edge feather ---------------------------------------------------------------

/**
 * Cap for the WIDTH-DERIVED feather, in world px. Only applies to strokes with no
 * explicit featherSize (ink written before the 羽化大小 control existed).
 */
export const FEATHER_AUTO_MAX = 0.6;

/**
 * Below this the blur is not worth a canvas filter (world px). Deliberately far
 * under anything visible: the old code cut off at 0.05 world, which is ABOVE the
 * feather a lightly-pressed thin stroke produces (width floor is ~0.15 world, so
 * the derived feather lands near 0.04) — light strokes silently got no feather at
 * all, with a hard on/off edge rather than a gradual falloff.
 */
export const FEATHER_MIN_WORLD = 0.01;

/** Width-derived feather (world px) for one ribbon: scales with stroke width,
 *  capped so a fat stroke never grows a blurry halo. */
export function autoFeatherWorld(widths: readonly number[]): number {
  let sum = 0;
  for (const w of widths) sum += Number.isFinite(w) ? w : 0;
  const avg = widths.length ? sum / widths.length : 0;
  return Math.min(FEATHER_AUTO_MAX, avg * 0.25);
}

/**
 * The feather radius (world px) for a stroke — ONE value per stroke.
 *
 * This is the single source of truth for both renderers. It must be resolved
 * once from the WHOLE stroke, never from a tile's slice of it: the tile stamp
 * path used to average only the widths it was handed, so each 512-unit tile
 * picked its own blur and one stroke's edge softened by a different amount along
 * its length (measured 0.28px at one end rising to 1.75px at the other), with a
 * visible step at tile boundaries.
 *
 * `stroke.featherSize` (the 羽化大小 control) wins when present; 0 means off.
 */
export function resolveFeatherWorld(
  stroke: { edgeFeather?: boolean; featherSize?: number },
  widths: readonly number[],
): number {
  if (stroke.edgeFeather === false) return 0;
  const explicit = stroke.featherSize;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.max(0, explicit);
  return autoFeatherWorld(widths);
}

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

