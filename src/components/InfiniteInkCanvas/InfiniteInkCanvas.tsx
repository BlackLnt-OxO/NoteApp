import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { renderAll } from './CanvasRenderer';
import { addRawPoint, getPressure, hitTestStroke, getStrokeBounds, boundsIntersectRect } from './StrokeEngine';
import { screenToWorld, clampZoom, zoomAt, ERASER_RADIUS } from './constants';
import TextNode from './TextNode';
import Toolbar from './Toolbar';
import ToolbarShell from './ToolbarShell';
import { useToolbarStore } from './useToolbarStore';
import { useNoteStore } from '../../store';
import { themeCanvasColors } from '../../themeColors';
import type { Stroke, StrokePoint, TextNodeData } from './types';

const InfiniteInkCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const isDrawingRef = useRef(false);
  const panAnchorRef = useRef<{ sx: number; sy: number; camX: number; camY: number } | null>(null);
  const selectAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const selectionRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const selectDragRef = useRef<{ start: { x: number; y: number }; snapshots: Map<string, StrokePoint[]> } | null>(null);
  const [cursorScreen, setCursorScreen] = useState<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number>(0);
  const dprRef = useRef(1);
  const spaceDownRef = useRef(false);
  const dirtyRef = useRef(false);

  const objects = useCanvasStore((s) => s.objects);
  const camera = useCanvasStore((s) => s.camera);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const brushSettings = useCanvasStore((s) => s.brushSettings);
  const showDotGrid = useCanvasStore((s) => s.showDotGrid);
  const editingTextId = useCanvasStore((s) => s.editingTextId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const selectionMode = useCanvasStore((s) => s.selectionMode);
  const eraserMode = useCanvasStore((s) => s.eraserMode);
  const isDraggingToolbar = useToolbarStore((s) => s.isDragging);
  const tOffset = useToolbarStore((s) => s.offset);
  const tWidth = useToolbarStore((s) => s.width);
  const tSide = useToolbarStore((s) => s.side);
  const theme = useNoteStore((s) => s.settings.theme);

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

  useEffect(() => { useCanvasStore.getState().loadCanvasData(); }, []);

  // ---- Render loop ------------------------------------------------------------

  const doRender = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const state = useCanvasStore.getState();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const colors = themeCanvasColors(useNoteStore.getState().settings.theme);
    renderAll({
      ctx, canvasWidth: rect.width, canvasHeight: rect.height,
      camera: state.camera, objects: state.objects,
      currentStroke: currentStrokeRef.current,
      showDotGrid: state.showDotGrid,
      background: colors.background,
      dotColor: colors.dotColor,
      editingTextId: state.editingTextId,
      selectedIds: state.selectedIds,
      selectionRect: selectionRectRef.current,
      dpr: dprRef.current,
    });
    dirtyRef.current = false;
  }, []);

  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (dirtyRef.current) doRender();
    });
  }, [doRender]);

  useEffect(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [objects, camera, activeTool, brushSettings, showDotGrid, editingTextId, selectedIds, selectionMode, scheduleRender]);

  // Repaint when the theme flips (workbench bg / dot grid / cursor ring).
  useEffect(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [theme, scheduleRender]);

  // ---- Keyboard ---------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      const state = useCanvasStore.getState();
      if (e.code === 'Space') { e.preventDefault(); spaceDownRef.current = true; }
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); state.undo(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); state.redo(); }
      if (e.ctrlKey && e.key === 'Z') { e.preventDefault(); state.redo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.editingTextId) {
        state.deleteTextNode(state.editingTextId);
      }
      if (e.ctrlKey && e.key === '0') { e.preventDefault(); state.setCamera({ x: 0, y: 0, zoom: 1 }); }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDownRef.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  // ---- Helpers ----------------------------------------------------------------

  const getCanvasPos = useCallback((e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { sx: e.clientX - rect.left, sy: e.clientY - rect.top } : { sx: 0, sy: 0 };
  }, []);

  // ---- Select-drag helper ------------------------------------------------------

  const startSelectDrag = (ids: string[], world: { x: number; y: number }) => {
    const state = useCanvasStore.getState();
    const snapshots = new Map<string, StrokePoint[]>();
    for (const o of state.objects) {
      if (o.type === 'stroke' && ids.includes(o.id)) snapshots.set(o.id, o.points.map((p) => ({ ...p })));
    }
    state.pushHistory(); // record state before move (for undo)
    selectDragRef.current = { start: world, snapshots };
    dirtyRef.current = true;
    scheduleRender();
  };

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const state = useCanvasStore.getState();
    const { sx, sy } = getCanvasPos(e);
    setCursorScreen({ x: e.clientX, y: e.clientY });

    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = false;
      panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: state.camera.x, camY: state.camera.y };
      return;
    }
    if (e.button !== 0) return;

    const world = screenToWorld(sx, sy, state.camera);

    if (state.activeTool === 'text') {
      state.addTextNode(world.x, world.y);
      return;
    }

    // Selection tool
    if (state.activeTool === 'select') {
      canvas.setPointerCapture(e.pointerId);

      // Pressing on a stroke → select it (or keep the existing selection group)
      // and begin a drag-move. Works in BOTH click and box modes.
      const hit = [...state.objects].reverse().find((o) => o.type === 'stroke' && hitTestStroke(o, world.x, world.y));

      if (hit) {
        const alreadySelected = state.selectedIds.includes(hit.id);
        const ids = alreadySelected ? state.selectedIds : [hit.id];
        if (!alreadySelected) state.setSelectedIds(ids);
        startSelectDrag(ids, world);
        return;
      }

      // Pressing on empty canvas
      if (state.selectionMode === 'click') {
        state.clearSelection();
      } else {
        // Box select — start dragging a rectangle
        selectAnchorRef.current = { x: world.x, y: world.y };
        selectionRectRef.current = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      }
      return;
    }

    // Stroke eraser (click to delete an entire stroke)
    if (state.activeTool === 'eraser' && state.eraserMode === 'stroke') {
      const hit = [...state.objects].reverse().find((o) => o.type === 'stroke' && hitTestStroke(o, world.x, world.y));
      if (hit) state.deleteObject(hit.id);
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;

    const isEraser = state.activeTool === 'eraser';
    const stroke: Stroke = {
      id: `stroke_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'stroke',
      points: [],
      color: isEraser ? '#000000' : state.brushSettings.color,
      size: isEraser ? ERASER_RADIUS : state.brushSettings.size,
      opacity: isEraser ? 1 : state.brushSettings.opacity,
      smoothing: isEraser ? 0 : state.brushSettings.smoothing,
      compositeOperation: isEraser ? 'destination-out' : 'source-over',
      createdAt: Date.now(),
    };
    addRawPoint(stroke, world.x, world.y, getPressure(e), e.timeStamp);
    currentStrokeRef.current = stroke;

    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Move -----------------------------------------------------------

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { sx, sy } = getCanvasPos(e);
    const state = useCanvasStore.getState();
    setCursorScreen({ x: e.clientX, y: e.clientY });

    if (panAnchorRef.current) {
      state.setCamera({
        x: panAnchorRef.current.camX + e.clientX - panAnchorRef.current.sx,
        y: panAnchorRef.current.camY + e.clientY - panAnchorRef.current.sy,
      });
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Box selection dragging
    if (selectAnchorRef.current) {
      const w = screenToWorld(sx, sy, state.camera);
      selectionRectRef.current = { x1: selectAnchorRef.current.x, y1: selectAnchorRef.current.y, x2: w.x, y2: w.y };
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Move selected strokes
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      const w = screenToWorld(sx, sy, state.camera);
      const dx = w.x - d.start.x;
      const dy = w.y - d.start.y;
      for (const [id, snap] of d.snapshots) {
        const moved = snap.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
        useCanvasStore.getState().updateStrokePoints(id, moved);
      }
      return; // store update triggers re-render
    }

    if (!isDrawingRef.current || !currentStrokeRef.current) return;

    const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
    const stroke = currentStrokeRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    for (const ce of events) {
      const wx = ce.clientX - rect.left;
      const wy = ce.clientY - rect.top;
      const w = screenToWorld(wx, wy, state.camera);
      addRawPoint(stroke, w.x, w.y, getPressure(ce), ce.timeStamp);
    }

    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.releasePointerCapture(e.pointerId);

    if (panAnchorRef.current) { panAnchorRef.current = null; return; }

    // Finalize box selection
    if (selectAnchorRef.current && selectionRectRef.current) {
      const r = selectionRectRef.current;
      const state = useCanvasStore.getState();
      const ids = state.objects
        .filter((o) => o.type === 'stroke' && boundsIntersectRect(getStrokeBounds(o), r.x1, r.y1, r.x2, r.y2))
        .map((o) => o.id);
      state.setSelectedIds(ids);
      selectAnchorRef.current = null;
      selectionRectRef.current = null;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // End select-drag (movement already applied incrementally)
    if (selectDragRef.current) {
      selectDragRef.current = null;
      return;
    }

    if (isDrawingRef.current && currentStrokeRef.current) {
      const stroke = currentStrokeRef.current;
      if (stroke.points.length > 0) useCanvasStore.getState().addStroke(stroke);
      currentStrokeRef.current = null;
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
    const state = useCanvasStore.getState();
    const { sx, sy } = getCanvasPos(e as unknown as React.PointerEvent);
    if (e.ctrlKey) {
      state.setCamera({ x: state.camera.x - e.deltaX, y: state.camera.y - e.deltaY });
    } else {
      const newZoom = clampZoom(state.camera.zoom * (1 - e.deltaY * 0.001));
      state.setCamera(zoomAt(state.camera, sx, sy, newZoom));
    }
  }, [getCanvasPos]);

  // ---- Cursor -----------------------------------------------------------------

  const freeEraser = activeTool === 'eraser' && eraserMode === 'free';
  const strokeEraser = activeTool === 'eraser' && eraserMode === 'stroke';
  // None → CSS circle overlay (pen / free eraser); others use native cursor
  const cursorStyle = (activeTool === 'pen' || freeEraser) ? 'none'
    : strokeEraser ? 'crosshair'
    : activeTool === 'text' ? 'text'
    : activeTool === 'select' ? 'crosshair'
    : 'default';
  const editingNode = objects.find((o): o is TextNodeData => o.type === 'text' && o.id === editingTextId);

  const showCursor = (activeTool === 'pen' || freeEraser) && cursorScreen && !isDraggingToolbar;
  // Circle diameter in screen px = world width × zoom, so it matches the drawn line
  const cs = (activeTool === 'eraser' ? ERASER_RADIUS : brushSettings.size) * camera.zoom;
  const isLight = theme === 'light';
  const ringBorder = isLight ? 'rgba(30,30,40,0.85)' : 'rgba(255,255,255,0.7)';
  const ringBg = isLight
    ? (activeTool === 'eraser' ? 'rgba(30,30,40,0.14)' : 'rgba(30,30,40,0.07)')
    : (activeTool === 'eraser' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)');

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)', borderRadius: '0 0 12px 0' }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none', cursor: cursorStyle }}
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp} onLostPointerCapture={handlePointerUp} onWheel={handleWheel} />

      {showCursor && cursorScreen && (
        <div style={{ position: 'fixed', left: cursorScreen.x, top: cursorScreen.y, width: cs, height: cs,
          borderRadius: '50%', border: `1.5px solid ${ringBorder}`,
          background: ringBg,
          pointerEvents: 'none', zIndex: 9999, transform: 'translate(-50%, -50%)' }} />
      )}

      {editingNode && <TextNode node={editingNode} camera={camera} />}

      {isDraggingToolbar && (() => {
        const cw = containerRef.current?.clientWidth ?? window.innerWidth;
        const mid = cw * 0.5;
        const tl = tSide === 'left' ? tOffset : cw - tOffset - tWidth;
        const tr = tSide === 'left' ? tOffset + tWidth : cw - tOffset;
        // Highlight the half the toolbar CENTER is over — must match the
        // snap-on-release logic in ToolbarShell (center < vpW/2 → left).
        const snapLeft = (tl + tr) / 2 < mid;
        return (
          <div style={{ position: 'absolute', inset: 0, zIndex: 99, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '50%',
              background: snapLeft ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.15)', transition: 'background 0.10s' }} />
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: '50%',
              background: !snapLeft ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.15)', transition: 'background 0.10s' }} />
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1,
              background: 'rgba(255,255,255,0.12)' }} />
          </div>
        );
      })()}

      <ToolbarShell><Toolbar /></ToolbarShell>
    </div>
  );
};

export default InfiniteInkCanvas;
