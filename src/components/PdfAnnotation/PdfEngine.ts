/**
 * PdfEngine — Pure functions for the PDF annotation ink pipeline.
 *
 * Self-contained copy of the smoothing / stroke-drawing math (1€ filter,
 * raw-point sampling, pressure-width rendering) used by the infinite canvas,
 * so this module owns its writing pipeline and can evolve independently.
 *
 * Rendering model (two-layer raster):
 *   backgroundLayer  = pdf.js page render (read-only, never erased)
 *   inkLayer         = rasterized strokes (pen = source-over, eraser = destination-out)
 *   main canvas      = drawImage(bg) + drawImage(ink) + live stroke
 */

import type { PdfCamera, PdfItem, PdfStroke } from './PdfTypes';

// ---- Constants ----------------------------------------------------------------

/** Resolution factor for the baked page bitmaps (sharp up to this zoom). */
export const PDF_BAKE_SCALE = 3;
export const PDF_ERASER_RADIUS = 20; // world units

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

// ---- Pressure -----------------------------------------------------------------

export function getPressure(e: { pointerType: string; pressure: number }): number {
  // Non-pen pointers (mouse/touch) have no real pressure → neutral 0.5.
  if (e.pointerType !== 'pen') return 0.5;
  const p = e.pressure;
  // Hover / zero / corrupt events: keep a tiny floor so the pen never "disappears"
  // when a driver reports 0 while barely touching.
  if (!Number.isFinite(p) || p <= 0) return 0.05;
  // Otherwise pass the REAL tiny pressures through (a 16383-level tablet gives
  // values as small as ~0.001) so ultra-light strokes can be drawn very fine.
  return Math.max(0, Math.min(1, p));
}

// ---- Raw sampling -------------------------------------------------------------

/**
 * Adaptive capture decimation: samples closer than ~0.3 world px add no geometry
 * (rendering re-resamples at ≥1px anyway) but DO add per-frame cost when a very
 * long/slow stroke piles them up. Dropping only sub-0.3px points keeps the shape
 * identical while stopping slow-writing points from exploding.
 */
export const RAW_SAMPLE_MIN_DIST = 0.3;

export function addRawPoint(
  stroke: PdfStroke,
  x: number,
  y: number,
  pressure: number,
  t: number,
): void {
  const last = stroke.points[stroke.points.length - 1];
  if (last && Math.hypot(x - last.x, y - last.y) < RAW_SAMPLE_MIN_DIST) return;
  stroke.points.push({ x, y, pressure, t });
}

// ---- 1€ Filter ----------------------------------------------------------------

const BETA = 0.007;   // speed coefficient (paper value)
const DCUTOFF = 1.0;  // derivative cutoff

/** Map smoothing 0-1 → minCutoff Hz (exponential: 0→5Hz, 0.35→1Hz, 1→0.05Hz). */
export function smoothingToMinCutoff(smoothing: number): number {
  return 5 * Math.pow(0.01, smoothing);
}

export function applyOneEuro(
  pts: { x: number; y: number; pressure: number; t: number }[],
  minCutoff: number,
): { x: number; y: number; p: number }[] {
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

// ---- Width --------------------------------------------------------------------

/** Pressure → width.  eraser = constant. */
export function strokeWidth(pressure: number, baseSize: number, isEraser: boolean): number {
  if (isEraser) return baseSize;
  return Math.max(0.5, baseSize * (0.2 + 0.8 * Math.max(0.05, Math.min(1, pressure))));
}

// ---- Stroke path rendering ----------------------------------------------------

/**
 * Draw a stroke onto a context that is already in WORLD coordinates
 * (e.g. the main canvas under the camera transform, or the inkLayer under a
 * bakeScale transform). `dx/dy` optionally shift the whole stroke (live drag).
 */
export function drawStrokePath(
  ctx: CanvasRenderingContext2D,
  stroke: PdfStroke,
  dx = 0,
  dy = 0,
): void {
  const raw = stroke.points;
  if (raw.length === 0) return;

  const isEraser = stroke.compositeOperation === 'destination-out';
  const minCutoff = smoothingToMinCutoff(stroke.smoothing);
  const pts = applyOneEuro(raw, minCutoff);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = stroke.compositeOperation;
  ctx.globalAlpha = stroke.opacity;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  if (pts.length === 1) {
    const w = strokeWidth(pts[0].p, stroke.size, isEraser);
    ctx.beginPath();
    ctx.arc(pts[0].x + dx, pts[0].y + dy, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const w = (strokeWidth(a.p, stroke.size, isEraser) + strokeWidth(b.p, stroke.size, isEraser)) / 2;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x + dx, a.y + dy);
    ctx.lineTo(b.x + dx, b.y + dy);
    ctx.stroke();
  }

  ctx.restore();
}

/** Incremental eraser segment (free-eraser live feedback) — destination-out. */
export function drawEraserSegment(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  size: number,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/** Incremental eraser dot (single-point click). */
export function drawEraserDot(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---- Hit testing (selection) --------------------------------------------------

export interface Bounds {
  minX: number; minY: number; maxX: number; maxY: number;
}

export function getStrokeBounds(stroke: PdfStroke): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const r = stroke.size / 2;
  for (const p of stroke.points) {
    if (p.x - r < minX) minX = p.x - r;
    if (p.y - r < minY) minY = p.y - r;
    if (p.x + r > maxX) maxX = p.x + r;
    if (p.y + r > maxY) maxY = p.y + r;
  }
  return { minX, minY, maxX, maxY };
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitTestStroke(stroke: PdfStroke, x: number, y: number): boolean {
  const threshold = stroke.size / 2 + 6;
  const pts = stroke.points;
  if (pts.length === 0) return false;
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= threshold;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= threshold) return true;
  }
  return false;
}

/** World-space bounding box of any page item (stroke → its path bounds). */
export function getItemBounds(item: PdfItem): Bounds {
  if (item.type === 'stroke') return getStrokeBounds(item);
  return { minX: item.x, minY: item.y, maxX: item.x + item.width, maxY: item.y + item.height };
}

/** Point hit-test over any page item (stroke → proximity; object → its rect). */
export function hitTestItem(item: PdfItem, x: number, y: number): boolean {
  if (item.type === 'stroke') return hitTestStroke(item, x, y);
  return x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height;
}

export function boundsIntersectRect(b: Bounds, x1: number, y1: number, x2: number, y2: number): boolean {
  const rx1 = Math.min(x1, x2), rx2 = Math.max(x1, x2);
  const ry1 = Math.min(y1, y2), ry2 = Math.max(y1, y2);
  return !(b.maxX < rx1 || b.minX > rx2 || b.maxY < ry1 || b.minY > ry2);
}

// ---- Coordinate transforms ----------------------------------------------------

export function screenToWorld(sx: number, sy: number, cam: PdfCamera): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}

export function worldToScreen(wx: number, wy: number, cam: PdfCamera): { x: number; y: number } {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y };
}

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** Zoom so the world point under (sx,sy) stays fixed. */
export function zoomAt(cam: PdfCamera, sx: number, sy: number, nextZoom: number): PdfCamera {
  const worldX = (sx - cam.x) / cam.zoom;
  const worldY = (sy - cam.y) / cam.zoom;
  return { zoom: nextZoom, x: sx - worldX * nextZoom, y: sy - worldY * nextZoom };
}

/** Camera that centers and fits a page inside a viewport with padding. */
export function fitCamera(pageW: number, pageH: number, vw: number, vh: number, pad = 24): PdfCamera {
  const zoom = clampZoom(Math.min((vw - pad * 2) / pageW, (vh - pad * 2) / pageH));
  return { zoom, x: (vw - pageW * zoom) / 2, y: (vh - pageH * zoom) / 2 };
}

// ---- Dot grid -----------------------------------------------------------------

const DOT_SCREEN_STEP = 24;
const DOT_RADIUS = 0.7;

/** Dot-grid overlay, drawn in screen space but anchored to the world (zoom-consistent). */
export function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  cam: PdfCamera,
  canvasW: number,
  canvasH: number,
  dotColor: string,
): void {
  const worldStep = DOT_SCREEN_STEP / cam.zoom;
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(canvasW, canvasH, cam);
  const sx = Math.floor(tl.x / worldStep) * worldStep;
  const sy = Math.floor(tl.y / worldStep) * worldStep;
  const ex = br.x + worldStep;
  const ey = br.y + worldStep;
  if (((ex - sx) / worldStep) * ((ey - sy) / worldStep) > 40000) return;

  ctx.fillStyle = dotColor;
  ctx.beginPath();
  for (let wx = sx; wx <= ex; wx += worldStep) {
    for (let wy = sy; wy <= ey; wy += worldStep) {
      const s = worldToScreen(wx, wy, cam);
      ctx.moveTo(s.x + DOT_RADIUS, s.y);
      ctx.arc(s.x, s.y, DOT_RADIUS, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}
