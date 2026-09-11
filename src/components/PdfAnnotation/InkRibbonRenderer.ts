import { autoFeatherWorld, FEATHER_MIN_WORLD, clamp01 } from './InkMath';
import type { PdfStroke } from './PdfTypes';

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
  /** `false` = no feather, `true` = derive from the widths given, or an explicit
   *  radius in WORLD px. Callers that draw a slice of a stroke MUST pass the
   *  explicit value (see InkMath.resolveFeatherWorld) — deriving it here from a
   *  slice makes each tile pick its own blur. */
  feather: boolean | number = true,
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

  // Optional soft ink edge. The radius comes from the caller when it is a number
  // (already resolved for the whole stroke), otherwise it is derived from whatever
  // widths were passed — which is only correct when those are the whole stroke.
  const softWorld = typeof feather === 'number' ? Math.max(0, feather)
    : feather ? autoFeatherWorld(widths) : 0;
  {
    if (softWorld > FEATHER_MIN_WORLD) {
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

