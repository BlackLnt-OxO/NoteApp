/**
 * PdfCanvas — the interactive canvas for the PDF annotation view.
 *
 * Rendering model (two-layer raster):
 *   backgroundLayer  = pdf.js page render (read-only offscreen canvas)
 *   inkLayer         = rasterized strokes (offscreen canvas; pen source-over,
 *                      eraser destination-out) — rebuilt from vector source of
 *                      truth whenever the store's renderEpoch bumps
 *   main canvas      = drawImage(bg) + drawImage(ink) + live stroke + selection
 *
 * Writing is O(1) per frame (2 drawImage + the single live stroke).  Pen-up
 * rasterizes just the new stroke; the eraser rasterizes incrementally live.
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { usePdfStore } from './PdfStore';
import { useToolbarStore } from '../InfiniteInkCanvas/useToolbarStore';
import {
  PDF_BAKE_SCALE,
  PDF_ERASER_RADIUS,
  getPressure,
  addRawPoint,
  drawStrokePath,
  drawEraserSegment,
  drawEraserDot,
  hitTestStroke,
  getStrokeBounds,
  boundsIntersectRect,
  screenToWorld,
  clampZoom,
  zoomAt,
  fitCamera,
} from './PdfEngine';
import { renderPageToCanvas, getPageSize, cleanupPage } from './PdfLoader';
import type { PdfStroke } from './PdfTypes';

// ---- Selection drawing helpers (world coords) ---------------------------------

function drawSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  strokes: PdfStroke[],
  selectedIds: string[],
): void {
  ctx.save();
  ctx.strokeStyle = '#6b5ce7';
  ctx.lineWidth = 1.5 / (ctx.getTransform().a || 1);
  ctx.setLineDash([5, 4]);
  const set = new Set(selectedIds);
  for (const s of strokes) {
    if (!set.has(s.id)) continue;
    const b = getStrokeBounds(s);
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }
  ctx.restore();
}

function drawSelectionRect(
  ctx: CanvasRenderingContext2D,
  r: { x1: number; y1: number; x2: number; y2: number },
): void {
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

// ---- Component ----------------------------------------------------------------

const PdfCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const dprRef = useRef(1);
  const rafRef = useRef(0);
  const dirtyRef = useRef(false);

  const currentStrokeRef = useRef<PdfStroke | null>(null);
  const eraserStrokeRef = useRef<PdfStroke | null>(null);
  const isDrawingRef = useRef(false);
  const panAnchorRef = useRef<{ sx: number; sy: number; camX: number; camY: number } | null>(null);
  const spaceDownRef = useRef(false);

  const selectAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const selectionRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const selectDragRef = useRef<{ start: { x: number; y: number } } | null>(null);

  const pageLoadTokenRef = useRef(0);
  const prevPageRef = useRef(0);

  // React-level subscriptions (drives cursor + page-load/rebuild effects)
  const pdfDoc = usePdfStore((s) => s.pdfDoc);
  const currentPage = usePdfStore((s) => s.currentPage);
  const renderEpoch = usePdfStore((s) => s.renderEpoch);
  const activeTool = usePdfStore((s) => s.activeTool);
  const brush = usePdfStore((s) => s.brush);
  const eraserMode = usePdfStore((s) => s.eraserMode);
  const camera = usePdfStore((s) => s.camera);
  const isDraggingToolbar = useToolbarStore((s) => s.isDragging);
  const [cursorScreen, setCursorScreen] = useState<{ x: number; y: number } | null>(null);

  // ---- Canvas sizing ----------------------------------------------------------

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    dirtyRef.current = true;
    scheduleRender();
  }, []);

  useEffect(() => {
    resizeCanvas();
    const ro = new ResizeObserver(() => resizeCanvas());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [resizeCanvas]);

  // ---- Render loop ------------------------------------------------------------

  const doRender = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const st = usePdfStore.getState();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vw = rect.width, vh = rect.height;
    const dpr = dprRef.current;
    const cam = st.camera;
    const size = st.pageSizes[st.currentPage];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, vw, vh);

    if (size) {
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      const bg = bgCanvasRef.current;
      const ink = inkCanvasRef.current;
      if (bg) ctx.drawImage(bg, 0, 0, size.width, size.height);
      if (ink) ctx.drawImage(ink, 0, 0, size.width, size.height);

      const strokes = st.strokes[st.currentPage] ?? [];
      if (st.selectedIds.length > 0) drawSelectionHighlight(ctx, strokes, st.selectedIds);
      if (selectionRectRef.current) drawSelectionRect(ctx, selectionRectRef.current);

      if (isDrawingRef.current && currentStrokeRef.current) {
        drawStrokePath(ctx, currentStrokeRef.current);
      }
      ctx.restore();
    }

    dirtyRef.current = false;
  }, []);

  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (dirtyRef.current) doRender();
    });
  }, [doRender]);

  // ---- Rebuild inkLayer from vector source of truth ---------------------------

  const rebuildInk = useCallback(() => {
    const st = usePdfStore.getState();
    const size = st.pageSizes[st.currentPage];
    if (!size) return;
    // Lazy-create the offscreen ink layer (it holds the rasterized strokes).
    if (!inkCanvasRef.current) inkCanvasRef.current = document.createElement('canvas');
    const ink = inkCanvasRef.current;
    const w = Math.round(size.width * PDF_BAKE_SCALE);
    const h = Math.round(size.height * PDF_BAKE_SCALE);
    if (ink.width !== w || ink.height !== h) {
      ink.width = w;
      ink.height = h;
    }
    const ctx = ink.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ink.width, ink.height);
    ctx.setTransform(PDF_BAKE_SCALE, 0, 0, PDF_BAKE_SCALE, 0, 0);
    const strokes = st.strokes[st.currentPage] ?? [];
    for (const s of strokes) drawStrokePath(ctx, s);
  }, []);

  // Structural changes (undo/redo/delete/move/clear) → rebuild inkLayer
  useEffect(() => {
    if (!pdfDoc) return;
    rebuildInk();
    dirtyRef.current = true;
    scheduleRender();
  }, [renderEpoch, pdfDoc, rebuildInk, scheduleRender]);

  // ---- Page load (render background + fit camera + rebuild ink) ---------------

  useEffect(() => {
    if (!pdfDoc) return;
    const token = ++pageLoadTokenRef.current;
    const pageNum = currentPage;
    const container = containerRef.current;
    const vw = container?.clientWidth ?? window.innerWidth;
    const vh = container?.clientHeight ?? window.innerHeight;

    (async () => {
      const size = await getPageSize(pdfDoc, pageNum);
      if (token !== pageLoadTokenRef.current) return;
      usePdfStore.getState().setPageSize(pageNum, size);

      const bg = bgCanvasRef.current ??= document.createElement('canvas');
      await renderPageToCanvas(pdfDoc, pageNum, bg, PDF_BAKE_SCALE);
      if (token !== pageLoadTokenRef.current) return;

      const cam = fitCamera(size.width, size.height, vw, vh);
      usePdfStore.getState().resetCamera(cam);
      rebuildInk();
      dirtyRef.current = true;
      scheduleRender();

      if (prevPageRef.current && prevPageRef.current !== pageNum) {
        cleanupPage(pdfDoc, prevPageRef.current);
      }
      prevPageRef.current = pageNum;
    })();
  }, [pdfDoc, currentPage, rebuildInk, scheduleRender]);

  // ---- Space key for pan ------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        spaceDownRef.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDownRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ---- Helpers ----------------------------------------------------------------

  const getCanvasPos = useCallback((e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { sx: e.clientX - rect.left, sy: e.clientY - rect.top } : { sx: 0, sy: 0 };
  }, []);

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const st = usePdfStore.getState();
    const { sx, sy } = getCanvasPos(e);
    setCursorScreen({ x: e.clientX, y: e.clientY });

    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = false;
      panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: st.camera.x, camY: st.camera.y };
      return;
    }
    if (e.button !== 0) return;
    if (!st.pdfDoc || !st.pageSizes[st.currentPage]) return;

    const world = screenToWorld(sx, sy, st.camera);

    // Selection tool
    if (st.activeTool === 'select') {
      canvas.setPointerCapture(e.pointerId);
      const strokes = st.strokes[st.currentPage] ?? [];
      const hit = [...strokes].reverse().find((o) => hitTestStroke(o, world.x, world.y));

      if (hit) {
        // Press on a stroke → select (or keep the group) and drag-move it
        const alreadySelected = st.selectedIds.includes(hit.id);
        const ids = alreadySelected ? st.selectedIds : [hit.id];
        if (!alreadySelected) st.setSelectedIds(ids);
        st.pushHistory(st.currentPage);
        selectDragRef.current = { start: world };
        dirtyRef.current = true;
        scheduleRender();
      } else if (st.selectionMode === 'click') {
        st.clearSelection();
      } else {
        // Box select
        selectAnchorRef.current = { x: world.x, y: world.y };
        selectionRectRef.current = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      }
      return;
    }

    // Stroke eraser (click a stroke to delete it)
    if (st.activeTool === 'eraser' && st.eraserMode === 'stroke') {
      const strokes = st.strokes[st.currentPage] ?? [];
      const hit = [...strokes].reverse().find((o) => hitTestStroke(o, world.x, world.y));
      if (hit) st.removeStroke(st.currentPage, hit.id);
      return;
    }

    // Pen / free eraser — begin a stroke
    canvas.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    const isEraser = st.activeTool === 'eraser';
    const stroke: PdfStroke = {
      id: `pdf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'stroke',
      points: [],
      color: isEraser ? '#000000' : st.brush.color,
      size: isEraser ? PDF_ERASER_RADIUS : st.brush.size,
      opacity: isEraser ? 1 : st.brush.opacity,
      smoothing: isEraser ? 0 : st.brush.smoothing,
      compositeOperation: isEraser ? 'destination-out' : 'source-over',
      createdAt: Date.now(),
    };
    addRawPoint(stroke, world.x, world.y, getPressure(e), e.timeStamp);
    if (isEraser) {
      eraserStrokeRef.current = stroke;
    } else {
      currentStrokeRef.current = stroke;
    }
    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Move -----------------------------------------------------------

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { sx, sy } = getCanvasPos(e);
    const st = usePdfStore.getState();
    setCursorScreen({ x: e.clientX, y: e.clientY });

    if (panAnchorRef.current) {
      st.setCamera({
        x: panAnchorRef.current.camX + e.clientX - panAnchorRef.current.sx,
        y: panAnchorRef.current.camY + e.clientY - panAnchorRef.current.sy,
      });
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    if (selectAnchorRef.current) {
      const w = screenToWorld(sx, sy, st.camera);
      selectionRectRef.current = { x1: selectAnchorRef.current.x, y1: selectAnchorRef.current.y, x2: w.x, y2: w.y };
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Drag-move selected strokes (applied to the store; inkLayer rebuilds via epoch)
    if (selectDragRef.current) {
      const w = screenToWorld(sx, sy, st.camera);
      const dx = w.x - selectDragRef.current.start.x;
      const dy = w.y - selectDragRef.current.start.y;
      st.moveStrokesLive(st.currentPage, st.selectedIds, dx, dy);
      return;
    }

    if (!isDrawingRef.current) return;

    // Free eraser — rasterize incrementally onto inkLayer (destination-out)
    if (eraserStrokeRef.current) {
      const ink = inkCanvasRef.current;
      const ctx = ink?.getContext('2d');
      if (!ink || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      const es = eraserStrokeRef.current;
      ctx.setTransform(PDF_BAKE_SCALE, 0, 0, PDF_BAKE_SCALE, 0, 0);
      const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
      for (const ce of events) {
        const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, st.camera);
        const last = es.points[es.points.length - 1];
        if (last && Math.hypot(w.x - last.x, w.y - last.y) < 0.5) continue;
        addRawPoint(es, w.x, w.y, 1, ce.timeStamp);
        if (es.points.length >= 2) {
          const a = es.points[es.points.length - 2];
          drawEraserSegment(ctx, a.x, a.y, w.x, w.y, PDF_ERASER_RADIUS);
        }
      }
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Pen — collect coalesced raw points; the live stroke is drawn each frame
    if (currentStrokeRef.current) {
      const rect = canvas.getBoundingClientRect();
      const stroke = currentStrokeRef.current;
      const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
      for (const ce of events) {
        const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, st.camera);
        addRawPoint(stroke, w.x, w.y, getPressure(ce), ce.timeStamp);
      }
      dirtyRef.current = true;
      scheduleRender();
    }
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.releasePointerCapture?.(e.pointerId);

    if (panAnchorRef.current) {
      panAnchorRef.current = null;
      return;
    }

    // Finalize box selection
    if (selectAnchorRef.current && selectionRectRef.current) {
      const r = selectionRectRef.current;
      const st = usePdfStore.getState();
      const strokes = st.strokes[st.currentPage] ?? [];
      const ids = strokes
        .filter((o) => boundsIntersectRect(getStrokeBounds(o), r.x1, r.y1, r.x2, r.y2))
        .map((o) => o.id);
      st.setSelectedIds(ids);
      selectAnchorRef.current = null;
      selectionRectRef.current = null;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    if (selectDragRef.current) {
      selectDragRef.current = null;
      return;
    }

    if (!isDrawingRef.current) return;

    // Free eraser — commit (already rasterized incrementally)
    if (eraserStrokeRef.current) {
      const es = eraserStrokeRef.current;
      eraserStrokeRef.current = null;
      if (es.points.length === 1) {
        const ink = inkCanvasRef.current;
        const ctx = ink?.getContext('2d');
        if (ink && ctx) {
          ctx.setTransform(PDF_BAKE_SCALE, 0, 0, PDF_BAKE_SCALE, 0, 0);
          drawEraserDot(ctx, es.points[0].x, es.points[0].y, PDF_ERASER_RADIUS);
        }
      }
      const st = usePdfStore.getState();
      if (es.points.length > 0) st.commitStroke(st.currentPage, es);
      isDrawingRef.current = false;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Pen — rasterize the finished stroke onto inkLayer, then commit
    if (currentStrokeRef.current) {
      const stroke = currentStrokeRef.current;
      currentStrokeRef.current = null;
      if (stroke.points.length > 0) {
        const st = usePdfStore.getState();
        const ink = inkCanvasRef.current;
        const ctx = ink?.getContext('2d');
        if (ink && ctx) {
          ctx.setTransform(PDF_BAKE_SCALE, 0, 0, PDF_BAKE_SCALE, 0, 0);
          drawStrokePath(ctx, stroke);
        }
        st.commitStroke(st.currentPage, stroke);
      }
      isDrawingRef.current = false;
      dirtyRef.current = true;
      scheduleRender();
    }

    isDrawingRef.current = false;
    panAnchorRef.current = null;
  }, [scheduleRender]);

  // ---- Wheel ------------------------------------------------------------------

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const st = usePdfStore.getState();
    const { sx, sy } = getCanvasPos(e as unknown as React.PointerEvent);
    if (e.ctrlKey) {
      st.setCamera({ x: st.camera.x - e.deltaX, y: st.camera.y - e.deltaY });
    } else {
      const newZoom = clampZoom(st.camera.zoom * (1 - e.deltaY * 0.001));
      st.setCamera(zoomAt(st.camera, sx, sy, newZoom));
    }
    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender]);

  // ---- Cursor -----------------------------------------------------------------

  const freeEraser = activeTool === 'eraser' && eraserMode === 'free';
  const cursorStyle = (activeTool === 'pen' || freeEraser)
    ? 'none'
    : activeTool === 'select' ? 'crosshair'
    : activeTool === 'eraser' ? 'crosshair'
    : 'default';
  const showCursor = (activeTool === 'pen' || freeEraser) && cursorScreen && !isDraggingToolbar;
  const cs = (activeTool === 'eraser' ? PDF_ERASER_RADIUS : brush.size) * camera.zoom;

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#1a1a2e' }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none', cursor: cursorStyle }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onWheel={handleWheel}
      />

      {showCursor && cursorScreen && (
        <div style={{
          position: 'fixed', left: cursorScreen.x, top: cursorScreen.y, width: cs, height: cs,
          borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.7)',
          background: activeTool === 'eraser' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
          pointerEvents: 'none', zIndex: 9999, transform: 'translate(-50%, -50%)',
        }} />
      )}
    </div>
  );
};

export default PdfCanvas;
