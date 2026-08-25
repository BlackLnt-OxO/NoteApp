/**
 * StrokeEngine — Raw-point sampling + 1€ filter smoothing + pressure rendering.
 *
 * - Sampling stores raw points (no lag).
 * - Smoothing uses the 1€ Filter (Géry Casiez, 2012) — the same
 *   speed-adaptive scheme as Photoshop/Procreate: slow strokes are
 *   stabilised heavily, fast strokes stay responsive.
 * - The LAST point is always rendered raw, so the pen tip never lags.
 * - Pressure controls stroke width (variable-width rendering).
 */

import type { StrokePoint, Stroke } from './types';

// ---- Pressure ----------------------------------------------------------------

export function getPressure(e: { pointerType: string; pressure: number }): number {
  if (e.pointerType === 'pen') return e.pressure > 0.01 ? e.pressure : 0.05;
  return 0.5;
}

// ---- Raw sampling ------------------------------------------------------------

export function addRawPoint(
  stroke: Stroke,
  x: number,
  y: number,
  pressure: number,
  t: number,
): void {
  const last = stroke.points[stroke.points.length - 1];
  if (last && Math.hypot(x - last.x, y - last.y) < 0.01) return;
  stroke.points.push({ x, y, pressure, t });
}

// ---- 1€ Filter ---------------------------------------------------------------

const BETA = 0.007;   // speed coefficient (paper value)
const DCUTOFF = 1.0;  // derivative cutoff

/** Map smoothing 0-1 → minCutoff Hz (exponential: 0→5Hz, 0.35→1Hz, 1→0.05Hz). */
export function smoothingToMinCutoff(smoothing: number): number {
  return 5 * Math.pow(0.01, smoothing);
}

function applyOneEuro(pts: StrokePoint[], minCutoff: number): { x: number; y: number; p: number }[] {
  if (pts.length === 0) return [];

  const out: { x: number; y: number; p: number }[] = [];
  let prevX = pts[0].x, prevY = pts[0].y, prevP = pts[0].pressure, prevT = pts[0].t;
  let dxHat = 0, dyHat = 0;
  out.push({ x: prevX, y: prevY, p: prevP });

  for (let i = 1; i < pts.length; i++) {
    const isLast = i === pts.length - 1;
    const raw = pts[i];
    const dt = (raw.t - prevT) / 1000;

    // Last point always raw (live pen tip), otherwise filter
    if (isLast || dt <= 0 || dt > 1) {
      out.push({ x: raw.x, y: raw.y, p: raw.pressure });
      continue;
    }

    const dx = (raw.x - prevX) / dt;
    const dy = (raw.y - prevY) / dt;
    const speed = Math.hypot(dx, dy);
    const cutoff = minCutoff + BETA * speed;
    const tau = 1 / (2 * Math.PI * cutoff);
    const alpha = 1 / (1 + tau / dt);

    const sx = prevX + alpha * (raw.x - prevX);
    const sy = prevY + alpha * (raw.y - prevY);
    const sp = prevP + alpha * (raw.pressure - prevP);

    const dtau = 1 / (2 * Math.PI * DCUTOFF);
    const dalpha = 1 / (1 + dtau / dt);
    dxHat += dalpha * (dx - dxHat);
    dyHat += dalpha * (dy - dyHat);

    out.push({ x: sx, y: sy, p: sp });
    prevX = sx; prevY = sy; prevP = sp; prevT = raw.t;
  }

  return out;
}

// ---- Rendering ---------------------------------------------------------------

/** Pressure → width.  eraser = constant. */
function width(pressure: number, baseSize: number, isEraser: boolean): number {
  if (isEraser) return baseSize;
  return Math.max(0.5, baseSize * (0.2 + 0.8 * Math.max(0.05, Math.min(1, pressure))));
}

export function drawSmoothStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  smoothing: number,
): void {
  const raw = stroke.points;
  if (raw.length === 0) return;

  const isEraser = stroke.compositeOperation === 'destination-out';
  const minCutoff = smoothingToMinCutoff(smoothing);
  const pts = applyOneEuro(raw, minCutoff);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = stroke.compositeOperation;
  ctx.globalAlpha = stroke.opacity;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  if (pts.length === 1) {
    const w = width(pts[0].p, stroke.size, isEraser);
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Variable-width segments with round caps — smooth via 1€ filtered points
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const w = (width(a.p, stroke.size, isEraser) + width(b.p, stroke.size, isEraser)) / 2;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.restore();
}
