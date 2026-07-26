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
  activeTool: string;
  mouseWorldPos: { x: number; y: number } | null;
  showDotGrid: boolean;
  editingTextId: string | null;
  dpr: number;
}

export function renderAll(params: RenderParams): void {
  const {
    ctx, canvasWidth, canvasHeight, camera,
    objects, currentStroke, activeTool, mouseWorldPos,
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

  // 5. Eraser cursor
  if (activeTool === 'eraser' && mouseWorldPos) {
    drawEraserCursor(ctx, mouseWorldPos);
  }

  ctx.restore(); // undo camera transform

  // 6. Dot grid — drawn AFTER strokes so eraser can't erase it
  if (showDotGrid) {
    drawDotGrid(ctx, camera, canvasWidth, canvasHeight);
  }

  ctx.restore(); // undo DPR scaling
}

// ---- Dot Grid ----------------------------------------------------------------

const DOT_SPACING = 24; // fixed world-space grid spacing

function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  canvasW: number,
  canvasH: number,
): void {
  const topLeft = screenToWorld(0, 0, camera);
  const bottomRight = screenToWorld(canvasW, canvasH, camera);

  // Pick a step that looks good at current zoom
  let step = DOT_SPACING;
  if (camera.zoom < 0.25) step = DOT_SPACING * 4;
  else if (camera.zoom < 0.5) step = DOT_SPACING * 2;
  else if (camera.zoom > 2) step = Math.max(6, DOT_SPACING / 2);

  const startX = Math.floor(topLeft.x / step) * step;
  const startY = Math.floor(topLeft.y / step) * step;
  const endX = bottomRight.x + step;
  const endY = bottomRight.y + step;

  const dotAlpha = Math.max(0.04, Math.min(0.18, camera.zoom * 0.10));
  const dotRadius = Math.max(0.3, Math.min(1.6, camera.zoom * 0.6));

  ctx.fillStyle = `rgba(255,255,255,${dotAlpha.toFixed(3)})`;
  ctx.beginPath();
  for (let wx = startX; wx <= endX; wx += step) {
    for (let wy = startY; wy <= endY; wy += step) {
      const s = worldToScreen(wx, wy, camera);
      ctx.moveTo(s.x + dotRadius, s.y);
      ctx.arc(s.x, s.y, dotRadius, 0, Math.PI * 2);
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

// Off-screen canvas cache for soft stamps (keyed by size+color+hardness)
const stampCache = new Map<string, HTMLCanvasElement>();

function getOrCreateStamp(
  size: number,
  color: string,
  hardness: number,
  opacity: number,
): HTMLCanvasElement {
  const key = `${size.toFixed(1)}|${color}|${hardness.toFixed(2)}`;
  const cached = stampCache.get(key);
  // Note: opacity is applied per-stamp via globalAlpha, so we don't key on it

  // Return cached stamp if available (we'll re-draw with correct alpha)
  if (cached) return cached;

  // Enforce cache size limit
  if (stampCache.size > 200) {
    const firstKey = stampCache.keys().next().value;
    if (firstKey) stampCache.delete(firstKey);
  }

  const dpr = 2; // render stamps at 2x for quality
  const paddedSize = Math.ceil(size * dpr) + 4;
  const off = document.createElement('canvas');
  off.width = paddedSize;
  off.height = paddedSize;

  const octx = off.getContext('2d')!;
  const cx = paddedSize / 2;
  const cy = paddedSize / 2;
  const radius = (size / 2) * dpr;

  const { r, g, b } = parseRGBA(color);

  if (hardness >= 0.98) {
    // Hard circle
    octx.beginPath();
    octx.arc(cx, cy, radius, 0, Math.PI * 2);
    octx.fillStyle = `rgb(${r},${g},${b})`;
    octx.fill();
  } else {
    // Soft radial gradient
    const gradient = octx.createRadialGradient(cx, cy, radius * hardness, cx, cy, radius);
    gradient.addColorStop(0, `rgb(${r},${g},${b})`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    octx.fillStyle = gradient;
    octx.fillRect(0, 0, paddedSize, paddedSize);
  }

  stampCache.set(key, off);
  return off;
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const { points, brushSettings, compositeOperation } = stroke;
  if (points.length === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = compositeOperation;

  const color = brushSettings.color;

  for (const point of points) {
    if (point.size <= 0.1) continue;

    const stamp = getOrCreateStamp(point.size, color, brushSettings.hardness, point.opacity);
    const halfW = stamp.width / 4; // DPR=2 → divide by 2 for CSS, then /2 for centering = /4
    const halfH = stamp.height / 4;

    ctx.globalAlpha = point.opacity;
    ctx.drawImage(
      stamp,
      point.x - halfW,
      point.y - halfH,
      stamp.width / 2,  // CSS size = canvas pixels / DPR
      stamp.height / 2,
    );
  }

  ctx.restore();
}

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

// ---- Eraser Cursor -----------------------------------------------------------

function drawEraserCursor(
  ctx: CanvasRenderingContext2D,
  mousePos: { x: number; y: number },
): void {
  const r = 10; // world units — visual only
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mousePos.x, mousePos.y, r, 0, Math.PI * 2);
  ctx.stroke();
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
