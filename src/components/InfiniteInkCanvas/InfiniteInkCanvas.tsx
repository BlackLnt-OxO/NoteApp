import React, { useRef, useEffect, useCallback } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { renderAll } from './CanvasRenderer';
import { processSample, getPressure } from './StrokeEngine';
import { screenToWorld, worldToScreen, clampZoom, zoomAt, ERASER_RADIUS } from './constants';
import TextNode from './TextNode';
import Toolbar from './Toolbar';
import ToolbarShell from './ToolbarShell';
import { useToolbarStore } from './useToolbarStore';
import type { Stroke, PointerSample, TextNodeData } from './types';

// ---- Component ---------------------------------------------------------------

const InfiniteInkCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const strokeStartRef = useRef<{ world: { x: number; y: number }; pressure: number; tiltX: number; tiltY: number; isEraser: boolean } | null>(null);
  const isDrawingRef = useRef(false);
  const panAnchorRef = useRef<{ sx: number; sy: number; camX: number; camY: number } | null>(null);
  const mouseWorldPosRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number>(0);
  const dprRef = useRef(1);
  const spaceDownRef = useRef(false);
  const dirtyRef = useRef(false);

  // Read from store (fine to re-subscribe — these are the values that change infrequently)
  const objects = useCanvasStore((s) => s.objects);
  const camera = useCanvasStore((s) => s.camera);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const brushSettings = useCanvasStore((s) => s.brushSettings);
  const dotDensity = useCanvasStore((s) => s.dotDensity);
  const editingTextId = useCanvasStore((s) => s.editingTextId);
  const isDraggingToolbar = useToolbarStore((s) => s.isDragging);

  // ---- Canvas sizing (DPI) ----------------------------------------------------

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

  // ---- Load data on mount -----------------------------------------------------

  useEffect(() => {
    useCanvasStore.getState().loadCanvasData();
  }, []);

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

    renderAll({
      ctx,
      canvasWidth: rect.width,
      canvasHeight: rect.height,
      camera: state.camera,
      objects: state.objects,
      currentStroke: currentStrokeRef.current,
      activeTool: state.activeTool,
      mouseWorldPos: mouseWorldPosRef.current,
      dotDensity: state.dotDensity,
      editingTextId: state.editingTextId,
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

  // Re-render when store state that affects the canvas changes
  useEffect(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [objects, camera, activeTool, brushSettings, dotDensity, editingTextId, scheduleRender]);

  // ---- Keyboard shortcuts -----------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture if user is typing in a textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;

      const state = useCanvasStore.getState();

      if (e.code === 'Space') {
        e.preventDefault();
        spaceDownRef.current = true;
      }

      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        state.undo();
      }
      if (e.ctrlKey && e.key === 'y') {
        e.preventDefault();
        state.redo();
      }
      if (e.ctrlKey && e.key === 'Z') {
        // Ctrl+Shift+Z = redo
        e.preventDefault();
        state.redo();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete selected / editing text node
        if (state.editingTextId) {
          state.deleteTextNode(state.editingTextId);
        }
      }
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        state.setCamera({ x: 0, y: 0, zoom: 1 });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDownRef.current = false;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ---- Pointer helpers --------------------------------------------------------

  const getCanvasPos = useCallback((e: React.PointerEvent): { sx: number; sy: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { sx: 0, sy: 0 };
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }, []);

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);

      const state = useCanvasStore.getState();
      const { sx, sy } = getCanvasPos(e);

      // Middle mouse or pan tool → start panning
      if (e.button === 1 || (e.button === 0 && (state.activeTool === 'pan' || spaceDownRef.current))) {
        isDrawingRef.current = false;
        panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: state.camera.x, camY: state.camera.y };
        return;
      }

      if (e.button !== 0) return;

      const world = screenToWorld(sx, sy, state.camera);

      if (state.activeTool === 'pen' || state.activeTool === 'eraser') {
        isDrawingRef.current = true;

        const isEraser = state.activeTool === 'eraser';

        // Store start info — the first stamp will be emitted on pointermove
        // so that pressure mapping and spacing are consistent with the rest
        // of the stroke (no isolated dot on pointerdown).
        strokeStartRef.current = {
          world: { x: world.x, y: world.y },
          pressure: getPressure(e),
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          isEraser,
        };

        currentStrokeRef.current = {
          id: `stroke_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'stroke',
          points: [], // empty — filled on first pointermove
          brushSettings: isEraser
            ? {
                size: ERASER_RADIUS,
                opacity: 1,
                hardness: 0.9,
                spacing: 0.15,
                smoothing: 0.2,
                color: '#000000',
                pressureSize: false,
                pressureOpacity: false,
              }
            : { ...state.brushSettings },
          compositeOperation: isEraser ? 'destination-out' : 'source-over',
          createdAt: Date.now(),
        };
      } else if (state.activeTool === 'text') {
        // Create text node at click position
        state.addTextNode(world.x, world.y);
      }
    },
    [getCanvasPos, scheduleRender],
  );

  // ---- Pointer Move -----------------------------------------------------------

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const { sx, sy } = getCanvasPos(e);
      const state = useCanvasStore.getState();

      // Update mouse world pos for eraser cursor
      mouseWorldPosRef.current = screenToWorld(sx, sy, state.camera);

      // Panning
      if (panAnchorRef.current) {
        const dx = e.clientX - panAnchorRef.current.sx;
        const dy = e.clientY - panAnchorRef.current.sy;
        state.setCamera({
          x: panAnchorRef.current.camX + dx,
          y: panAnchorRef.current.camY + dy,
        });
        dirtyRef.current = true;
        scheduleRender();
        return;
      }

      if (!isDrawingRef.current || !currentStrokeRef.current) {
        // Even when not drawing, show eraser cursor
        if (state.activeTool === 'eraser') {
          dirtyRef.current = true;
          scheduleRender();
        }
        return;
      }

      // Process coalesced events for high-freq pen sampling
      const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];

      for (const ce of events) {
        const cex = ce.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0);
        const cey = ce.clientY - (canvasRef.current?.getBoundingClientRect().top ?? 0);
        const world = screenToWorld(cex, cey, state.camera);

        const pressure = getPressure(ce);
        const sample: PointerSample = {
          x: world.x,
          y: world.y,
          pressure,
          tiltX: ce.tiltX,
          tiltY: ce.tiltY,
          timestamp: Date.now(),
        };

        const stroke = currentStrokeRef.current!;

        // If this is the very first move event, emit the deferred start point first
        if (strokeStartRef.current) {
          const ss = strokeStartRef.current;
          const isEraser = ss.isEraser;
          const bs = isEraser
            ? {
                size: ERASER_RADIUS, opacity: 1, hardness: 0.9, spacing: 0.15,
                smoothing: 0.2, color: '#000000',
                pressureSize: false as const, pressureOpacity: false as const,
              }
            : state.brushSettings;

          const startSample: PointerSample = {
            x: ss.world.x, y: ss.world.y,
            pressure: ss.pressure, tiltX: ss.tiltX, tiltY: ss.tiltY,
            timestamp: Date.now(),
          };

          const startStamps = processSample(null, startSample, bs);
          stroke.points.push(...startStamps);
          strokeStartRef.current = null; // consumed
        }

        const prevStamp = stroke.points.length > 0 ? stroke.points[stroke.points.length - 1] : null;

        const isEraser = state.activeTool === 'eraser';
        const bs = isEraser
          ? {
              size: ERASER_RADIUS, opacity: 1, hardness: 0.9, spacing: 0.15,
              smoothing: 0.2, color: '#000000',
              pressureSize: false as const, pressureOpacity: false as const,
            }
          : state.brushSettings;

        const newStamps = processSample(prevStamp, sample, bs);
        stroke.points.push(...newStamps);
      }

      dirtyRef.current = true;
      scheduleRender();
    },
    [getCanvasPos, scheduleRender],
  );

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.releasePointerCapture(e.pointerId);

      // End pan
      if (panAnchorRef.current) {
        panAnchorRef.current = null;
        return;
      }

      // Finalize stroke
      if (isDrawingRef.current && currentStrokeRef.current) {
        const stroke = currentStrokeRef.current;
        if (stroke.points.length > 0) {
          useCanvasStore.getState().addStroke(stroke);
        }
        currentStrokeRef.current = null;
        strokeStartRef.current = null;
        isDrawingRef.current = false;
        dirtyRef.current = true;
        scheduleRender();
      }

      isDrawingRef.current = false;
      panAnchorRef.current = null;
    },
    [scheduleRender],
  );

  // ---- Wheel (pan + zoom) -----------------------------------------------------

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();

      const state = useCanvasStore.getState();
      const { sx, sy } = getCanvasPos(e as unknown as React.PointerEvent);

      if (e.ctrlKey) {
        // Zoom centered on mouse
        const delta = -e.deltaY * 0.001;
        const newZoom = clampZoom(state.camera.zoom * (1 + delta));
        const nextCamera = zoomAt(state.camera, sx, sy, newZoom);
        state.setCamera(nextCamera);
      } else {
        // Pan
        state.setCamera({
          x: state.camera.x - e.deltaX,
          y: state.camera.y - e.deltaY,
        });
      }
    },
    [getCanvasPos],
  );

  // ---- Cursor style -----------------------------------------------------------

  const cursorStyle =
    activeTool === 'eraser' ? 'none' : activeTool === 'text' ? 'text' : 'crosshair';

  // ---- Editing text node for overlay ------------------------------------------

  const editingNode = objects.find(
    (o): o is TextNodeData => o.type === 'text' && o.id === editingTextId,
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: '#1a1a2e',
        borderRadius: '0 0 12px 0',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          touchAction: 'none',
          userSelect: 'none',
          cursor: cursorStyle,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onWheel={handleWheel}
      />

      {/* Text node editing overlay */}
      {editingNode && <TextNode node={editingNode} camera={camera} />}

      {/* Zoned overlay while dragging toolbar — lighter edges = snap zone */}
      {isDraggingToolbar && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 99, display: 'flex', pointerEvents: 'none' }}>
          <div style={{ width: '25%', background: 'rgba(0,0,0,0.12)' }} />
          <div style={{ width: '50%', background: 'rgba(0,0,0,0.35)' }} />
          <div style={{ width: '25%', background: 'rgba(0,0,0,0.12)' }} />
        </div>
      )}

      {/* Toolbar */}
      <ToolbarShell>
        <Toolbar />
      </ToolbarShell>
    </div>
  );
};

export default InfiniteInkCanvas;
