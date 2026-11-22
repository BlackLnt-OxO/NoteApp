import type { Camera } from './InfiniteInkCanvas/types';
import { drawVisibleTiles, inkTileBytes } from './InfiniteInkCanvas/InkTiles';
import { drawDotGrid } from './PdfAnnotation/PdfEngine';
import { reportInkFrame } from './InkFrameStats';
import { INK_TRACE_DETAIL_LIMIT, inkTraceId, inkTraceList, recordInkTrace, registerInkTrace, unregisterInkTrace, type InkTraceDetails } from './InkDiagnostics';
import type { InkViewportSize } from './InkViewport';

export interface InkLayerPaint {
  background: HTMLCanvasElement; ink: HTMLCanvasElement;
  tiles: Map<string, HTMLCanvasElement>; camera: Camera;
  width: number; height: number; dpr: number;
  capacity?: InkViewportSize;
  uiScale?: number;
  drawTile?: Parameters<typeof drawVisibleTiles>[6];
  backgroundColor: string; dotColor: string; showDotGrid: boolean;
  page?: { canvas: HTMLCanvasElement; width: number; height: number };
}

/** Extra pixels for BOTH retained layers combined, independent of document size. */
export const PAN_BUFFER_BUDGET = 4 * 1048576;
export function panBufferMargin(width: number, height: number, dpr: number): number {
  const sum = width + height;
  const allowance = PAN_BUFFER_BUDGET / (8 * dpr * dpr);
  let margin = Math.max(0, Math.min(192, Math.floor((Math.sqrt(sum * sum + 4 * allowance) - sum) / 4)));
  const base = Math.ceil(width * dpr) * Math.ceil(height * dpr);
  while (margin && 8 * (Math.ceil((width + 2 * margin) * dpr) * Math.ceil((height + 2 * margin) * dpr) - base) > PAN_BUFFER_BUDGET) margin--;
  return margin;
}

/** Assigning either canvas dimension clears it, even when the value is equal. */
export function sizeInkSurface(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, uiScale: number): boolean {
  const w = Math.max(1, Math.ceil(width * dpr)), h = Math.max(1, Math.ceil(height * dpr));
  const resized = canvas.width !== w || canvas.height !== h;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const cssWidth = w / (uiScale * dpr) + 'px', cssHeight = h / (uiScale * dpr) + 'px';
  if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
  if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
  return resized;
}

/** Retained static surfaces. Input frames do not redraw the historical document. */
export class InkDisplayLayers {
  private signature = '';
  private backgroundSignature = '';
  private page: HTMLCanvasElement | undefined;
  private tiles: Map<string, HTMLCanvasElement> | undefined;
  private fullInk = true;
  private anchor: Camera | undefined;
  private margin = 0;
  private dirtyKeys = new Set<string>();
  private traceRegistered = false;
  private traceView: InkTraceDetails = {};
  private tracePaint: InkTraceDetails = {};
  private traceSurface: HTMLCanvasElement | undefined;
  invalidate(keys?: ReadonlySet<string>): void {
    if (import.meta.env.DEV) recordInkTrace(this, 'display-invalidate', {
      layer: this.tiles ? inkTraceId(this.tiles) : null, keys: keys ? inkTraceList(keys, key => key) : null });
    if (!keys) this.fullInk = true;
    else for (const key of keys) this.dirtyKeys.add(key);
  }
  dispose(): void {
    if (import.meta.env.DEV) recordInkTrace(this, 'display-dispose', { layer: this.tiles ? inkTraceId(this.tiles) : null });
    unregisterInkTrace(this); this.traceRegistered = false; this.traceSurface = undefined;
    this.anchor = undefined; this.fullInk = true; this.dirtyKeys.clear();
  }

  paint(p: InkLayerPaint): void {
    const { camera: cam, dpr, width: vw, height: vh } = p;
    const uiScale = p.uiScale ?? 1;
    if (import.meta.env.DEV) {
      this.traceSurface = p.ink;
      this.traceView = { at: performance.now(), camera: { ...cam }, width: vw, height: vh, dpr, uiScale };
      if (!this.traceRegistered) {
        registerInkTrace(this, () => ({ kind: 'display', layer: this.tiles ? inkTraceId(this.tiles) : null,
          ...this.traceView, lastPaint: this.tracePaint, fullInk: this.fullInk, dirtyKeys: inkTraceList(this.dirtyKeys, key => key),
          bitmap: { width: this.traceSurface?.width ?? 0, height: this.traceSurface?.height ?? 0 } }));
        this.traceRegistered = true;
      }
    }
    const capacity = p.capacity ?? p;
    const signature = [cam.zoom, dpr, capacity.width, capacity.height, uiScale].join(':');
    const backgroundSignature = [p.backgroundColor, p.dotColor, p.showDotGrid, p.page?.width, p.page?.height].join(':');
    const changed = signature !== this.signature || !this.anchor
      || Math.abs(cam.x - this.anchor.x) > this.margin || Math.abs(cam.y - this.anchor.y) > this.margin;
    if (changed) {
      this.anchor = { ...cam };
      // The retained margin and the live canvas use the same device-pixel phase.
      this.margin = Math.floor(panBufferMargin(capacity.width, capacity.height, dpr) * dpr) / dpr;
    }
    const anchor = this.anchor!;
    const width = capacity.width + 2 * this.margin, height = capacity.height + 2 * this.margin;
    const paintCamera = { ...anchor, x: anchor.x + this.margin, y: anchor.y + this.margin };
    const backgroundResized = sizeInkSurface(p.background, width, height, dpr, uiScale);
    const inkResized = sizeInkSurface(p.ink, width, height, dpr, uiScale);
    if (import.meta.env.DEV && (backgroundResized || inkResized)) recordInkTrace(this, 'display-resize', {
      width: p.ink.width, height: p.ink.height, background: backgroundResized, ink: inkResized,
    });
    for (const canvas of [p.background, p.ink]) {
      canvas.style.left = -this.margin / uiScale + 'px'; canvas.style.top = -this.margin / uiScale + 'px';
      canvas.style.right = canvas.style.bottom = 'auto'; canvas.style.willChange = 'transform';
      // Panning within the fixed border moves the existing compositor texture;
      // it does not repaint every historical tile at each pointer sample.
      canvas.style.transform = `translate(${(cam.x - anchor.x) / uiScale}px, ${(cam.y - anchor.y) / uiScale}px)`;
    }
    if (changed || backgroundResized || backgroundSignature !== this.backgroundSignature || this.page !== p.page?.canvas) {
      const start = performance.now(), ctx = p.background.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, p.background.width / dpr, p.background.height / dpr);
      ctx.fillStyle = p.backgroundColor; ctx.fillRect(0, 0, p.background.width / dpr, p.background.height / dpr);
      if (p.showDotGrid) drawDotGrid(ctx, paintCamera, width, height, p.dotColor);
      if (p.page) {
        ctx.save(); ctx.translate(paintCamera.x, paintCamera.y); ctx.scale(cam.zoom, cam.zoom);
        ctx.drawImage(p.page.canvas, 0, 0, p.page.width, p.page.height); ctx.restore();
      }
      this.page = p.page?.canvas;
      this.backgroundSignature = backgroundSignature;
      reportInkFrame({ paintMs: performance.now() - start });
    }
    if (changed || inkResized || this.tiles !== p.tiles || this.fullInk || this.dirtyKeys.size) {
      const ctx = p.ink.getContext('2d')!, start = performance.now();
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const dirty = !changed && !inkResized && this.tiles === p.tiles && !this.fullInk ? this.dirtyKeys : undefined;
      if (dirty) {
        ctx.beginPath();
        for (const key of this.dirtyKeys) {
          const [tx, ty] = key.split(':').map(Number);
          const x0 = Math.round((tx * 512 * cam.zoom + paintCamera.x) * dpr) / dpr;
          const y0 = Math.round((ty * 512 * cam.zoom + paintCamera.y) * dpr) / dpr;
          const x1 = Math.round(((tx + 1) * 512 * cam.zoom + paintCamera.x) * dpr) / dpr;
          const y1 = Math.round(((ty + 1) * 512 * cam.zoom + paintCamera.y) * dpr) / dpr;
          ctx.rect(x0, y0, x1 - x0, y1 - y0);
        }
        ctx.clip();
      }
      ctx.clearRect(0, 0, p.ink.width / dpr, p.ink.height / dpr);
      const drawn: { key: string; canvas: number }[] = [];
      const count = drawVisibleTiles(ctx, p.tiles, paintCamera, width, height, dpr, import.meta.env.DEV
        ? (context, key, canvas, x, y, w, h) => {
          if (drawn.length < INK_TRACE_DETAIL_LIMIT) drawn.push({ key, canvas: inkTraceId(canvas) });
          if (p.drawTile) p.drawTile(context, key, canvas, x, y, w, h);
          else context.drawImage(canvas, x, y, w, h);
        } : p.drawTile, dirty);
      ctx.restore();
      if (import.meta.env.DEV) {
        this.tracePaint = { at: performance.now(), layer: inkTraceId(p.tiles), camera: { ...cam }, paintCamera: { ...paintCamera },
          width, height, dpr, full: !dirty, requestedKeys: dirty ? inkTraceList(dirty, key => key) : null,
          drawnCount: count, drawn, truncated: count > drawn.length };
        recordInkTrace(this, 'display-paint', this.tracePaint);
      }
      reportInkFrame({ drawMs: performance.now() - start, tileCount: p.tiles.size, tileBytes: inkTileBytes(p.tiles) });
    }
    let visibleTiles = 0;
    for (let ty = Math.floor(-cam.y / cam.zoom / 512); ty <= Math.floor((vh - cam.y) / cam.zoom / 512); ty++) {
      for (let tx = Math.floor(-cam.x / cam.zoom / 512); tx <= Math.floor((vw - cam.x) / cam.zoom / 512); tx++) {
        if (p.tiles.has(`${tx}:${ty}`)) visibleTiles++;
      }
    }
    reportInkFrame({ visibleTiles });
    this.signature = signature; this.tiles = p.tiles; this.fullInk = false; this.dirtyKeys.clear();
  }
}
