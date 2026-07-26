/**
 * StrokeEngine — Raw-point sampling + quadratic-bezier rendering.
 *
 * Principle: sample raw, smooth at render time.
 * No EMA, no prediction, no lag — the last point always connects to the
 * real-time pen position.
 */

import type { StrokePoint, Stroke } from './types';

// ---- Pressure ----------------------------------------------------------------

export function getPressure(e: { pointerType: string; pressure: number }): number {
  if (e.pointerType === 'pen') return e.pressure > 0.01 ? e.pressure : 0.05;
  return 0.5;
}

// ---- Raw-point sampling (no smoothing) ---------------------------------------

export function addRawPoint(
  stroke: Stroke,
  worldX: number,
  worldY: number,
  pressure: number,
): void {
  const point: StrokePoint = { x: worldX, y: worldY, pressure };
  const last = stroke.points[stroke.points.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.01) return;
  stroke.points.push(point);
}

// ---- Quadratic-bezier rendering (smooth visually, no data lag) ---------------

export function drawSmoothStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
): void {
  const points = stroke.points;
  if (points.length === 0) return;

  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = stroke.opacity;

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
    ctx.restore();
    return;
  }

  if (points.length === 2) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.lineWidth = stroke.size;
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i++) {
    const curr = points[i];
    const next = points[i + 1];
    const mx = (curr.x + next.x) / 2;
    const my = (curr.y + next.y) / 2;
    ctx.lineWidth = stroke.size;
    ctx.quadraticCurveTo(curr.x, curr.y, mx, my);
  }

  // Last point uses live position — no lag at pen tip
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();

  ctx.restore();
}
