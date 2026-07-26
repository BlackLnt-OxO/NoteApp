/**
 * CanvasRenderer — All canvas 2D drawing routines.
 *
 * Pure drawing functions — no React, no state reads.
 * All data arrives via parameters.
 */

import type { Camera, CanvasObject, Stroke, TextNodeData } from './types';
import { screenToWorld, worldToScreen, parseRGBA } from './constants';

// ---- Public entry point ------------------------------------------------------

export interface RenderParams {
  ctx: CanvasRenderingContext2D;
  canvasWidth: number;
  canvasHeight: number;
  camera: Camera;
  objects: CanvasObject[];
  currentStroke: Stroke | null;
  showDotGrid: boolean;
  editingTextId: string | null;
  dpr: number;
}

export function renderAll(params: RenderParams): void {
  const {
    ctx, canvasWidth, canvasHeight, camera,
    objects, currentStroke,
    showDotGrid, editingTextId, dpr,
  } = params;

  // 1. Clear + background
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 2. Apply camera transform
  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  // 3. Draw strokes & text (eraser only affects this layer)
  drawObjects(ctx, objects, editingTextId);

  // 4. Current in-progress stroke
  if (currentStroke && currentStroke.points.length > 0) {
    drawStroke(ctx, currentStroke);
  }

  ctx.restore(); // undo camera transform

  // 6. Dot grid — drawn AFTER strokes so eraser can't erase it
  if (showDotGrid) {
    drawDotGrid(ctx, camera, canvasWidth, canvasHeight);
  }

  ctx.restore(); // undo DPR scaling
}

// ---- Dot Grid ----------------------------------------------------------------
// Dots keep a consistent visual spacing (screen px) at all zoom levels.

const DOT_SCREEN_STEP = 24;  // visual px between dots — never changes
const DOT_ALPHA = 0.18;
const DOT_RADIUS = 0.7;      // screen px

function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  canvasW: number,
  canvasH: number,
): void {
  // World-space step that produces the desired screen spacing
  const worldStep = DOT_SCREEN_STEP / camera.zoom;

  const topLeft = screenToWorld(0, 0, camera);
  const bottomRight = screenToWorld(canvasW, canvasH, camera);

  const startX = Math.floor(topLeft.x / worldStep) * worldStep;
  const startY = Math.floor(topLeft.y / worldStep) * worldStep;
  const endX = bottomRight.x + worldStep;
  const endY = bottomRight.y + worldStep;

  // Skip if there would be too many dots (extreme zoom-out)
  const estDots = ((endX - startX) / worldStep) * ((endY - startY) / worldStep);
  if (estDots > 40000) return;

  ctx.fillStyle = `rgba(255,255,255,${DOT_ALPHA.toFixed(3)})`;
  ctx.beginPath();
  for (let wx = startX; wx <= endX; wx += worldStep) {
    for (let wy = startY; wy <= endY; wy += worldStep) {
      const s = worldToScreen(wx, wy, camera);
      ctx.moveTo(s.x + DOT_RADIUS, s.y);
      ctx.arc(s.x, s.y, DOT_RADIUS, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

// ---- Objects -----------------------------------------------------------------

function drawObjects(
  ctx: CanvasRenderingContext2D,
  objects: CanvasObject[],
  editingTextId: string | null,
): void {
  for (const obj of objects) {
    if (obj.type === 'stroke') {
      drawStroke(ctx, obj);
    } else if (obj.type === 'text' && obj.id !== editingTextId) {
      drawTextOnCanvas(ctx, obj);
    }
  }
}

// ---- Stroke ------------------------------------------------------------------

const stampCache = new Map<string, HTMLCanvasElement>();

function getOrCreateStamp(size: number, color: string, hardness: number): HTMLCanvasElement {
  const key = `${size.toFixed(1)}|${color}|${hardness.toFixed(2)}`;
  const c = stampCache.get(key);
  if (c) return c;
  if (stampCache.size > 200) stampCache.delete(stampCache.keys().next().value!);

  const dpr = 2;
  const padded = Math.ceil(size * dpr) + 4;
  const off = document.createElement('canvas');
  off.width = padded; off.height = padded;
  const octx = off.getContext('2d')!;
  const cx = padded / 2; const cy = padded / 2;
  const radius = (size / 2) * dpr;
  const { r, g, b } = parseRGBA(color);

  if (hardness >= 0.98) {
    octx.beginPath(); octx.arc(cx, cy, radius, 0, Math.PI * 2);
    octx.fillStyle = `rgb(${r},${g},${b})`; octx.fill();
  } else {
    const g = octx.createRadialGradient(cx, cy, radius * hardness, cx, cy, radius);
    g.addColorStop(0, `rgb(${r},${g},${b})`);
    g.addColorStop(1, `rgba(${r},${g},${b},0)`);
    octx.fillStyle = g; octx.fillRect(0, 0, padded, padded);
  }
  stampCache.set(key, off);
  return off;
}

// Per-stroke bitmap cache — bakes stamp set to one offscreen canvas
interface CachedStroke {
  bitmap: HTMLCanvasElement;
  ox: number; oy: number; // world-space top-left of the bitmap
}

const strokeBmp = new Map<string, CachedStroke>();

function renderStrokeToBitmap(stroke: Stroke): CachedStroke {
  const { points, brushSettings } = stroke;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    const r = p.size / 2;
    if (p.x - r < minX) minX = p.x - r;
    if (p.y - r < minY) minY = p.y - r;
    if (p.x + r > maxX) maxX = p.x + r;
    if (p.y + r > maxY) maxY = p.y + r;
  }
  const M = 4;
  const w = Math.min(8192, Math.max(1, Math.ceil(maxX - minX) + M * 2));
  const h = Math.min(8192, Math.max(1, Math.ceil(maxY - minY) + M * 2));

  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;
  const ox = minX - M;
  const oy = minY - M;
  octx.translate(-ox, -oy);

  const color = brushSettings.color;
  for (const p of points) {
    if (p.size <= 0.1) continue;
    const s = getOrCreateStamp(p.size, color, brushSettings.hardness);
    const hw = s.width / 4; const hh = s.height / 4;
    octx.globalAlpha = p.opacity;
    octx.drawImage(s, p.x - hw, p.y - hh, s.width / 2, s.height / 2);
  }

  const entry: CachedStroke = { bitmap: off, ox, oy };
  strokeBmp.set(stroke.id, entry);
  if (strokeBmp.size > 500) strokeBmp.delete(strokeBmp.keys().next().value!);
  return entry;
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  if (stroke.points.length === 0) return;

  // Eraser always per-stamp (destination-out modifies existing pixels)
  if (stroke.compositeOperation === 'destination-out') {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const p of stroke.points) {
      if (p.size <= 0.1) continue;
      const s = getOrCreateStamp(p.size, stroke.brushSettings.color, stroke.brushSettings.hardness);
      const hw = s.width / 4; const hh = s.height / 4;
      ctx.globalAlpha = p.opacity;
      ctx.drawImage(s, p.x - hw, p.y - hh, s.width / 2, s.height / 2);
    }
    ctx.restore();
    return;
  }

  let c = strokeBmp.get(stroke.id);
  if (!c) c = renderStrokeToBitmap(stroke);

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.drawImage(c.bitmap, c.ox, c.oy);
  ctx.restore();
}

export { drawStroke, drawDotGrid };
export function clearStrokeCache() { strokeBmp.clear(); }

// ---- Text on Canvas ----------------------------------------------------------

function drawTextOnCanvas(
  ctx: CanvasRenderingContext2D,
  node: TextNodeData,
): void {
  if (!node.content) return;

  ctx.save();

  // Background pill
  const padX = 10;
  const padY = 8;
  ctx.fillStyle = 'rgba(30,30,50,0.75)';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  roundRect(ctx, node.x - padX, node.y - padY, node.width + padX * 2, node.height + padY * 2, 8);
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.fillStyle = '#e0e0e0';
  ctx.font = `${node.fontSize}px -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'top';

  // Simple word wrap
  const words = node.content.split(/(\s+)/);
  const maxWidth = Math.max(node.width, 50);
  const lineHeight = node.fontSize * 1.4;
  let line = '';
  let y = node.y;

  for (const word of words) {
    const testLine = line + word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && line.length > 0) {
      ctx.fillText(line, node.x, y);
      y += lineHeight;
      line = word.trimStart();
    } else {
      line = testLine;
    }
  }
  if (line.trim()) {
    ctx.fillText(line, node.x, y);
  }

  ctx.restore();
}

// ---- Helper: rounded rect ----------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
