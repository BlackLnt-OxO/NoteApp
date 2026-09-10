/**
 * inkOverlays — the non-ink chrome drawn on top of an ink surface: selection
 * highlight, box-select rectangle, and the transient laser-pointer trail.
 *
 * These were duplicated across the two surfaces (and the selection helpers had a
 * third copy in `CanvasRenderer.ts`, whose other exports were unreachable from
 * any real component). Consolidated here so both surfaces behave identically.
 */

import type { InkItem, InkPoint, InkStroke } from './inkTypes';
import { getStrokeBounds } from './inkGeometry';

/** Selection accent — matches the app's accent purple. */
const SELECTION_COLOR = '#6b5ce7';

// ---- Selection ------------------------------------------------------------------

/**
 * Dashed bounding box around each selected stroke. Non-stroke items (text cards,
 * images) are rendered as DOM overlays and draw their own affordances, so they
 * are skipped here.
 */
export function drawSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  items: InkItem[],
  selectedIds: string[],
): void {
  if (selectedIds.length === 0) return;
  ctx.save();
  ctx.strokeStyle = SELECTION_COLOR;
  // Divide by the camera scale so the dashes stay 1.5 device px at any zoom.
  ctx.lineWidth = 1.5 / (ctx.getTransform().a || 1);
  ctx.setLineDash([5, 4]);
  const set = new Set(selectedIds);
  for (const item of items) {
    if (item.type !== 'stroke' || !set.has(item.id)) continue;
    const b = getStrokeBounds(item as InkStroke);
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }
  ctx.restore();
}

/** Fill + dashed outline for an in-progress box selection (world coords). */
export function drawSelectionRect(
  ctx: CanvasRenderingContext2D,
  r: { x1: number; y1: number; x2: number; y2: number },
): void {
  ctx.save();
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
  ctx.setLineDash([5, 4]);
  ctx.fillStyle = 'rgba(107,92,231,0.08)';
  const x = Math.min(r.x1, r.x2), y = Math.min(r.y1, r.y2);
  const w = Math.abs(r.x2 - r.x1), h = Math.abs(r.y2 - r.y1);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// ---- Laser pointer ---------------------------------------------------------------

/**
 * A transient laser-pointer stroke. Never committed, persisted or rasterized into
 * tiles — it lives only in a ref and is redrawn (and eventually faded) per frame.
 */
export interface LaserSegment {
  points: InkPoint[];
  color: string;
  size: number;
  /** Timestamp of stroke start (pen-down). */
  start: number;
  /** Timestamp of pen-up — the fade clock starts HERE, not at pen-down. */
  end?: number;
}

/** How long a laser trail stays visible after the last pen activity. */
export const LASER_LIFETIME = 1800; // ms

/**
 * Draw a laser segment at the given alpha. The caller decides alpha (uniform
 * while writing so every trail stays lit, then a group fade from the last pen
 * activity).
 */
export function drawLaser(ctx: CanvasRenderingContext2D, seg: LaserSegment, alpha: number): void {
  if (alpha <= 0 || seg.points.length === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = seg.color;
  ctx.fillStyle = seg.color;
  ctx.lineWidth = seg.size;
  ctx.globalAlpha = alpha;
  ctx.shadowColor = seg.color;
  ctx.shadowBlur = 6;
  if (seg.points.length === 1) {
    ctx.beginPath();
    ctx.arc(seg.points[0].x, seg.points[0].y, seg.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(seg.points[0].x, seg.points[0].y);
    for (let i = 1; i < seg.points.length; i++) ctx.lineTo(seg.points[i].x, seg.points[i].y);
    ctx.stroke();
  }
  ctx.restore();
}
