/**
 * CanvasRenderer — Pure drawing functions.  No React, no state.
 */

import type { Camera, CanvasObject, Stroke, TextNodeData } from './types';
import { screenToWorld, worldToScreen } from './constants';
import { drawSmoothStroke, getStrokeBounds } from './StrokeEngine';

// ---- Public entry point ------------------------------------------------------

export interface RenderParams {
  ctx: CanvasRenderingContext2D;
  canvasWidth: number;
  canvasHeight: number;
  camera: Camera;
  objects: CanvasObject[];
  currentStroke: Stroke | null;
  showDotGrid: boolean;
  /** Workbench background color (theme-aware). */
  background: string;
  /** Dot-grid ink color (theme-aware). */
  dotColor: string;
  editingTextId: string | null;
  selectedIds: string[];
  selectionRect: { x1: number; y1: number; x2: number; y2: number } | null;
  dpr: number;
}

export function renderAll(params: RenderParams): void {
  const { ctx, canvasWidth, canvasHeight, camera, objects, currentStroke, showDotGrid, background, dotColor, editingTextId, selectedIds, selectionRect, dpr } = params;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  drawObjects(ctx, objects, editingTextId);

  if (currentStroke && currentStroke.points.length > 0) {
    drawSmoothStroke(ctx, currentStroke, currentStroke.smoothing);
  }

  // Selection highlights
  if (selectedIds.length > 0) {
    drawSelectionHighlight(ctx, objects, selectedIds);
  }
  if (selectionRect) {
    drawSelectionRect(ctx, selectionRect);
  }

  ctx.restore(); // camera

  if (showDotGrid) drawDotGrid(ctx, camera, canvasWidth, canvasHeight, dotColor);

  ctx.restore(); // DPR
}

// ---- Selection rendering -----------------------------------------------------

export function drawSelectionHighlight(ctx: CanvasRenderingContext2D, objects: CanvasObject[], selectedIds: string[]): void {
  ctx.save();
  ctx.strokeStyle = '#6b5ce7';
  ctx.lineWidth = 1.5 / (ctx.getTransform().a || 1);
  ctx.setLineDash([5, 4]);
  const set = new Set(selectedIds);
  for (const obj of objects) {
    if (obj.type !== 'stroke' || !set.has(obj.id)) continue;
    const b = getStrokeBounds(obj);
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }
  ctx.restore();
}

export function drawSelectionRect(ctx: CanvasRenderingContext2D, r: { x1: number; y1: number; x2: number; y2: number }): void {
  ctx.save();
  ctx.strokeStyle = '#6b5ce7';
  ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
  ctx.setLineDash([5, 4]);
  ctx.fillStyle = 'rgba(107,92,231,0.08)';
  const x = Math.min(r.x1, r.x2), y = Math.min(r.y1, r.y2);
  const w = Math.abs(r.x2 - r.x1), h = Math.abs(r.y2 - r.y1);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// ---- Dot Grid ----------------------------------------------------------------

const DOT_SCREEN_STEP = 24;
const DOT_RADIUS = 0.7;

function drawDotGrid(ctx: CanvasRenderingContext2D, camera: Camera, canvasW: number, canvasH: number, dotColor: string): void {
  const worldStep = DOT_SCREEN_STEP / camera.zoom;
  const tl = screenToWorld(0, 0, camera);
  const br = screenToWorld(canvasW, canvasH, camera);
  const sx = Math.floor(tl.x / worldStep) * worldStep;
  const sy = Math.floor(tl.y / worldStep) * worldStep;
  const ex = br.x + worldStep;
  const ey = br.y + worldStep;
  if (((ex - sx) / worldStep) * ((ey - sy) / worldStep) > 40000) return;

  ctx.fillStyle = dotColor;
  ctx.beginPath();
  for (let wx = sx; wx <= ex; wx += worldStep) {
    for (let wy = sy; wy <= ey; wy += worldStep) {
      const s = worldToScreen(wx, wy, camera);
      ctx.moveTo(s.x + DOT_RADIUS, s.y);
      ctx.arc(s.x, s.y, DOT_RADIUS, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

// ---- Objects -----------------------------------------------------------------

function drawObjects(ctx: CanvasRenderingContext2D, objects: CanvasObject[], editingTextId: string | null): void {
  for (const obj of objects) {
    if (obj.type === 'stroke') {
      drawSmoothStroke(ctx, obj, obj.smoothing);
    } else if (obj.type === 'text' && obj.id !== editingTextId) {
      drawTextOnCanvas(ctx, obj);
    }
  }
}

// ---- Text on Canvas ----------------------------------------------------------

export function drawTextOnCanvas(ctx: CanvasRenderingContext2D, node: TextNodeData): void {
  if (!node.content) return;
  ctx.save();
  const px = 10, py = 8;
  ctx.fillStyle = 'rgba(30,30,50,0.75)';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  roundRect(ctx, node.x - px, node.y - py, node.width + px * 2, node.height + py * 2, 8);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#e0e0e0';
  ctx.font = `${node.fontSize}px -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'top';
  const words = node.content.split(/(\s+)/);
  const maxW = Math.max(node.width, 50);
  const lh = node.fontSize * 1.4;
  let line = '', y = node.y;
  for (const w of words) {
    const t = line + w;
    if (ctx.measureText(t).width > maxW && line.length > 0) {
      ctx.fillText(line, node.x, y); y += lh; line = w.trimStart();
    } else { line = t; }
  }
  if (line.trim()) ctx.fillText(line, node.x, y);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
