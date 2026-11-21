import { inkStrokesOnly, inkObjectVisible } from '../InkViewportObjects';
import { InkRenderBackend, strokeTileKeys, protectInkSegment } from './InkRenderBackend';
import { InkDisplayLayers } from '../InkDisplayLayers';
import { inkTraceId, recordInkTrace, traceInkStrokes } from '../InkDiagnostics';
import { inkPointerSamples, InkPointerQueue } from '../InkPointerSamples';
import { releaseStreamingInk } from '../PdfAnnotation/StreamingInkStroke';
import React, { useRef, useEffect, useCallback } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { useInkShapeGesture } from '../useInkShapeGesture';
import InkShapeEditor from '../InkShapeEditor';
import { beginSelectionCapture, endSelectionCapture, cancelSelectionCapture, inkSelectionCaptureHandlers,
  selectionOperation, combineSelection, hitSelectable, boxSelectableIds, createObjectDragPreview,
  drawObjectDragPreview, clearObjectDragPreview, type SelectionOperation, type SelectionCapture, type ObjectDragPreview } from '../InkSelection';
import { getInkStrokeIndex, type InkStrokeIndex } from '../PdfAnnotation/InkStrokeIndex';
import { bakeDragPreview, drawDragPreview, type DragPreview } from '../PdfAnnotation/InkDragPreview';
import { useBrushCursor } from '../useBrushCursor';
import { useInkInputActivity, setPointerHold } from '../inkInputActivity';
import { drawSelectionHighlight, drawSelectionRect } from './CanvasRenderer';
import {
  drawDotGrid, getPressure, addRawPoint,
  boundsIntersectRect,
  type Bounds,
} from '../PdfAnnotation/PdfEngine';
import { getCommittedStrokeBounds } from '../PdfAnnotation/InkTileErase';
import {
  createEraserPerf, addEraserScan, addEraserRestamp, logEraserPerf,
  type EraserPerf,
} from '../PdfAnnotation/eraserPerf';
import { drawAnnotatedStroke } from '../PdfAnnotation/PdfBrushRenderers';
import { screenToWorld, clampZoom, zoomAt, ERASER_RADIUS } from './constants';
import {
  stampStroke, eraseSegTiles, eraseDotTiles, drawVisibleTiles, removeStrokesFromTiles,
  disposeTiles, indexInkStrokes, materializeTiles, setTargetBakeScale, targetBakeScale,
  evictDistantTiles, inkTileBytes, inkTileCount, abandonBuilds,
} from './InkTiles';
import { reportInkFrame, resetInkFrame, noteCameraMove, noteInkFrame, cameraMoving, cameraSettled, CAMERA_SETTLE_MS } from '../InkFrameStats';

/** How long after the pointer's last move materialization still yields to it. */
const POINTER_ACTIVE_MS = 250;
import { releaseDocumentInkCaches, dropRastersNotAtScale } from '../PdfAnnotation/InkRasterCache';
import TextNode from './TextNode';
import ImageObject from './ImageObject';
import TextObject from './TextObject';
import Toolbar from './Toolbar';
import ToolbarShell from './ToolbarShell';
import { useCanvasToolbarStore } from './useToolbarStore';
import { useNoteStore } from '../../store';
import { themeCanvasColors } from '../../themeColors';
import type { Stroke, StrokePoint, TextNodeData, CanvasObject, ImageObject as ImageObjectType } from './types';

/** Transient laser-pointer stroke segment (never committed / persisted). */
interface LaserSegment {
  points: StrokePoint[];
  color: string;
  size: number;
  /** Timestamp of stroke start (pen-down). */
  start: number;
  /** Timestamp of pen-up — the fade clock starts HERE, not at pen-down. */
  end?: number;
}
const LASER_LIFETIME = 1800; // ms — how long a laser trail stays visible

/** Draw a laser segment at the given alpha. The caller decides alpha (uniform
 *  while writing so every trail stays lit, then a group fade from the last pen
 *  activity). */
function drawLaser(ctx: CanvasRenderingContext2D, seg: LaserSegment, alpha: number): void {
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

const InfiniteInkCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundLayerRef = useRef<HTMLCanvasElement>(null);
  const committedLayerRef = useRef<HTMLCanvasElement>(null);
  const displayLayersRef = useRef(new InkDisplayLayers());
  const manipulatedIdsRef = useRef(new Set<string>());
  const backgroundPausedRef = useRef(false);
  const backendRef = useRef<InkRenderBackend | null>(null);
  const boundsRef = useRef<DOMRect | null>(null);
  const inputQueueRef = useRef(new InkPointerQueue());
  const pointerUpRef = useRef<((event: React.PointerEvent<HTMLCanvasElement>) => void) | null>(null);
  const pointerOwnerRef = useRef<number | null>(null);
  const lastQueuedRef = useRef<{ x: number; y: number } | undefined>();
  const gestureTilesRef = useRef(new Set<string>());
  const containerRef = useRef<HTMLDivElement>(null);
  /** When the pointer last moved. Materialization yields to it the same way it
   *  yields to a moving camera — see runMaterialize. */
  const lastPointerAtRef = useRef(-Infinity);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const shapeEditPreviewRef = useRef<Stroke | null>(null);
  const shapeEditorIdRef = useRef<string | null>(null);
  const isDrawingRef = useRef(false);
  const panAnchorRef = useRef<{ sx: number; sy: number; camX: number; camY: number } | null>(null);
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);
  const flushPanCamera = useCallback(() => {
    const camera = pendingPanRef.current; pendingPanRef.current = null;
    if (camera) useCanvasStore.getState().setCamera(camera);
  }, []);
  const middlePanRef = useRef(false);
  const prevObjectsRef = useRef<CanvasObject[] | null>(null);
  const selectAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const selectionCaptureRef = useRef<SelectionCapture | null>(null);
  const selectionOperationRef = useRef<{ operation: SelectionOperation; base: string[] }>({ operation: 'replace', base: [] });
  const selectionRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  /** Active select-drag. `strokes` holds the ORIGINAL stroke objects and
   *  `preview` a raster of them baked once at drag start — so a frame of the drag
   *  costs one drawImage instead of re-rendering the whole selection. Re-rendering
   *  per frame is not just O(points): a version-2 stroke goes through the live
   *  cache, whose budget a large selection blows, so every frame re-processed the
   *  point lists it had just evicted. */
  const selectDragRef = useRef<{
    start: { x: number; y: number };
    ids: string[];
    strokes: Stroke[];
    preview: DragPreview | null;
    objects: ObjectDragPreview;
    dx: number;
    dy: number;
  } | null>(null);
  const inkTilesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  /** Pending frame of the lazy tile materialization chain (see InkTiles). */
  const materializeRafRef = useRef(0);
  /** Timer that re-runs materialization once the camera stops moving. */
  const lodSettleRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertWorldRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number>(0);
  const dprRef = useRef(1);
  const spaceDownRef = useRef(false);
  const dirtyRef = useRef(false);
  const laserRef = useRef<LaserSegment[]>([]);
  const laserRafRef = useRef(0);
  /** Timestamp of the most recent laser pen-down / move / pen-up — when a stroke
   *  is being drawn, all trails stay lit; once idle they all fade together from
   *  this instant. */
  const laserActiveRef = useRef(0);
  /** Active whole-stroke-eraser wipe session (drag-to-erase). Pointer moves are
   *  coalesced into ONE animation-frame flush (max one erase + one repaint per
   *  frame), so the wipe never does per-pointermove work. `started` becomes true
   *  on the first removal so the whole gesture shares ONE history snapshot.
   *  `index` supplies committed bounds and segment blocks without rebuilding
   *  them on pointer-down. */
  const strokeEraseRef = useRef<{
    started: boolean;
    raf: number;
    last: { x: number; y: number };
    pending: { x: number; y: number }[];
    /** Ink strokes erased VISUALLY during the drag but not yet removed from the
     *  store — the store commit happens once on pointer-up (no per-frame React
     *  churn, mirroring how pen/select-drag avoid mid-gesture store writes). */
    pendingIds: Set<string>;
    /** Per-stroke bounds, cached for the whole gesture. */
    bounds: Map<string, Bounds>;
    index: InkStrokeIndex;
    /** Eraser diameter (world units) snapshotted at pointer-down, so changing the
     *  size mid-drag can't make the hit radius disagree with the drawn ring. */
    radius: number;
    /** Spatial hash (cell == ink tile) so erase cost doesn't scale with the
     *  total stroke count on the page. Maintained as strokes are committed. */
    grid: Map<string, Stroke[]>;
    /** Dev-only timing for this gesture (null in prod). */
    perf: EraserPerf | null;
  } | null>(null);

  useEffect(() => () => {
    const owner = pointerOwnerRef.current;
    if (owner !== null) pointerUpRef.current?.({ pointerId: owner, type: 'pointercancel' } as React.PointerEvent<HTMLCanvasElement>);
    clearObjectDragPreview(selectDragRef.current?.objects);
    cancelSelectionCapture(selectionCaptureRef, pointerOwnerRef);
    backendRef.current?.dispose(); backendRef.current = null;
    displayLayersRef.current.dispose();
    inputQueueRef.current.clear(); gestureTilesRef.current.clear();
    if (currentStrokeRef.current) releaseStreamingInk(currentStrokeRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (laserRafRef.current) cancelAnimationFrame(laserRafRef.current);
    if (strokeEraseRef.current?.raf) cancelAnimationFrame(strokeEraseRef.current.raf);
    if (materializeRafRef.current) cancelAnimationFrame(materializeRafRef.current);
    if (lodSettleRef.current) clearTimeout(lodSettleRef.current);
    // Leaving the editor = leaving the document. Free its rasterized ink and the
    // shared pixel caches NOW: together they are ~1 GiB on a dense canvas, and
    // leaving them to the GC made the NEXT canvas — however light — open slowly,
    // because allocating its tiles meant evicting all of them first.
    disposeTiles(inkTilesRef.current);
    inkTilesRef.current = new Map();
    // A new layer has no index, even if the vectors are unchanged. StrictMode
    // replays setup after this cleanup and must index the document again.
    prevObjectsRef.current = null;
    releaseDocumentInkCaches();
    resetInkFrame();
    // StrictMode replays effects on mount; cancelled frame IDs must not prevent
    // the replayed sizing/render effects from scheduling their first frame.
    rafRef.current = 0;
    laserRafRef.current = 0;
    materializeRafRef.current = 0;
    if (strokeEraseRef.current) strokeEraseRef.current.raf = 0;
  }, []);

  const objects = useCanvasStore((s) => s.objects);
  const shapeScope = useCanvasStore((s) => s.currentCanvasId) ?? '';
  const camera = useCanvasStore((s) => s.camera);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const brush = useCanvasStore((s) => s.brush);
  const brushSettings = useCanvasStore((s) => s.brushSettings);
  const showDotGrid = useCanvasStore((s) => s.showDotGrid);
  const editingTextId = useCanvasStore((s) => s.editingTextId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const selectionMode = useCanvasStore((s) => s.selectionMode);
  const insertMode = useCanvasStore((s) => s.insertMode);
  const isDraggingToolbar = useCanvasToolbarStore((s) => s.isDragging);
  const tOffset = useCanvasToolbarStore((s) => s.offset);
  const tWidth = useCanvasToolbarStore((s) => s.width);
  const tSide = useCanvasToolbarStore((s) => s.side);
  const theme = useNoteStore((s) => s.settings.theme);
  const uiScale = useNoteStore((s) => s.uiScale);
  const { ringRef, moveCursor, hideCursor } = useBrushCursor(
    uiScale, (activeTool === 'pen' || activeTool === 'eraser') && !isDraggingToolbar,
  );
  useInkInputActivity(canvasRef);
  const renderEpoch = useCanvasStore((s) => s.renderEpoch);
  const pendingImageInsert = useCanvasStore((s) => s.pendingImageInsert);

  // ---- Canvas sizing ----------------------------------------------------------

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    // Layout (untransformed) size — unaffected by CSS scale, so the canvas fills
    // its container at EVERY zoom. (getBoundingClientRect returns the scaled
    // visual size; setting the element CSS size from it made the canvas spill
    // past or empty at the right/bottom.)
    const lw = container.offsetWidth;
    const lh = container.offsetHeight;
    // Backing store sized for the VISUAL size (layout × scale) × dpr → stays sharp.
    canvas.width = Math.max(1, Math.round(lw * uiScale * dpr));
    canvas.height = Math.max(1, Math.round(lh * uiScale * dpr));
    // Element CSS size = layout px; the CSS scale renders it at the visual size.
    canvas.style.width = lw + 'px';
    canvas.style.height = lh + 'px';
    boundsRef.current = container.getBoundingClientRect();
    for (const layer of [backgroundLayerRef.current, committedLayerRef.current]) {
      if (!layer) continue;
      layer.width = canvas.width; layer.height = canvas.height;
      layer.style.width = canvas.style.width; layer.style.height = canvas.style.height;
    }
    displayLayersRef.current.resize();
    dirtyRef.current = true;
    scheduleRender();
  }, [uiScale]);

  useEffect(() => {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    const refreshBounds = () => { if (containerRef.current) boundsRef.current = containerRef.current.getBoundingClientRect(); };
    window.addEventListener('scroll', refreshBounds, true);
    const ro = new ResizeObserver(() => resizeCanvas());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => { ro.disconnect(); window.removeEventListener('resize', resizeCanvas); window.removeEventListener('scroll', refreshBounds, true); };
  }, [resizeCanvas]);

  // `transform: scale` changes the canvas's VISUAL size without changing its
  // layout box, so ResizeObserver won't fire — on a zoom change we must re-size
  // the backing store manually or ink is drawn/hit at the wrong spot.
  useEffect(() => {
    resizeCanvas();
  }, [uiScale, resizeCanvas]);

  useEffect(() => { if (!useCanvasStore.getState().loaded) void useCanvasStore.getState().loadCanvasData().catch(console.error); }, []);

  // Flush the current canvas when the editor unmounts (leaving the view).
  useEffect(() => {
    return () => {
      const st = useCanvasStore.getState();
      if (st.loaded && st.currentCanvasId) st.saveCanvasData();
    };
  }, []);

  // ---- Render loop ------------------------------------------------------------

  const flushInput = useCallback(() => {
    const stroke = currentStrokeRef.current;
    if (!stroke) { inputQueueRef.current.clear(); return; }
    if (stroke.geometry) { inputQueueRef.current.clear(); return; }
    inputQueueRef.current.drain(sample => {
      const previous = stroke.points[stroke.points.length - 1];
      addRawPoint(stroke, sample.x, sample.y, sample.pressure, sample.t);
      if (stroke.compositeOperation === 'destination-out' && previous) {
        eraseSegTiles(inkTilesRef.current, previous.x, previous.y, sample.x, sample.y, stroke.size);
        displayLayersRef.current.invalidate(gestureTilesRef.current);
      }
    });
  }, []);

  const doRender = useCallback(() => {
    flushPanCamera();
    flushInput();
    const liveStart = performance.now();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Frame-interval sampling rides on the render loop (see InkFrameStats): free,
    // and it measures only frames the app actually painted.
    noteInkFrame();
    const state = useCanvasStore.getState();
    const container = containerRef.current;
    if (!container) return;
    const rect = boundsRef.current ?? container.getBoundingClientRect();
    const vw = rect.width, vh = rect.height;
    const dpr = dprRef.current;
    const cam = state.camera;

    const colors = themeCanvasColors(useNoteStore.getState().settings.theme);
    const bgLayer = backgroundLayerRef.current, inkLayer = committedLayerRef.current;
    if (bgLayer && inkLayer) {
      displayLayersRef.current.paint({ background: bgLayer, ink: inkLayer, tiles: inkTilesRef.current,
        camera: cam, width: vw, height: vh, dpr, uiScale: useNoteStore.getState().uiScale,
        drawTile: (context, key, tile, x, y, w, h) => { const backend = backendRef.current; if (backend) backend.drawTile(context, key, tile, x, y, w, h); else context.drawImage(tile, x, y, w, h); }, backgroundColor: colors.background,
        dotColor: colors.dotColor, showDotGrid: state.showDotGrid });
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);

    // Rasterized ink tiles (O(1) per frame).
    const inkStart = performance.now();
    backendRef.current?.drawPending(ctx);
    if (shapeEditPreviewRef.current) drawAnnotatedStroke(ctx, shapeEditPreviewRef.current);

    // Text nodes are now always-interactive DOM cards rendered ABOVE the canvas
    // (TextObject) — they are intentionally NOT drawn into the vector canvas.

    // Live drag-move of selected strokes: one blit of the raster baked at drag
    // start. If a mid-drag zoom has moved the bake scale on, the preview is the
    // wrong density — fall back to drawing the strokes, which is always right.
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      drawObjectDragPreview(d.objects, containerRef.current, d.dx, d.dy, cam.zoom, useNoteStore.getState().uiScale);
      const p = d.preview;
      if (p && p.scale === targetBakeScale(inkTilesRef.current)) {
        drawDragPreview(ctx, p, d.dx, d.dy);
      } else {
        for (const s of d.strokes) drawAnnotatedStroke(ctx, s, d.dx, d.dy);
      }
    } else if (state.selectedIds.length > 0) {
      drawSelectionHighlight(ctx, state.objects, state.selectedIds.filter(id => id !== shapeEditorIdRef.current));
    }
    if (selectionRectRef.current) drawSelectionRect(ctx, selectionRectRef.current);

    // Live stroke (pen only — free eraser already writes tiles incrementally).
    if (currentStrokeRef.current
        && currentStrokeRef.current.compositeOperation !== 'destination-out'
        && currentStrokeRef.current.points.length > 0) {
      drawAnnotatedStroke(ctx, currentStrokeRef.current);
    }
    if (currentStrokeRef.current?.compositeOperation === 'destination-out') drawAnnotatedStroke(ctx, currentStrokeRef.current);

    // Transient laser-pointer strokes. While any stroke is being drawn, all
    // trails stop fading and stay lit (so writing a new stroke re-lights earlier
    // ones); when idle they fade together from the last pen activity.
    const now = performance.now();
    const holding = laserRef.current.some((s) => s.end === undefined);
    if (holding) {
      for (const seg of laserRef.current) drawLaser(ctx, seg, 1);
    } else {
      const gAge = now - laserActiveRef.current;
      const gAlpha = gAge >= LASER_LIFETIME ? 0 : 1 - gAge / LASER_LIFETIME;
      for (const seg of laserRef.current) drawLaser(ctx, seg, gAlpha);
    }

    ctx.restore();

    reportInkFrame({
      liveMs: performance.now() - liveStart,

      tileCount: inkTileCount(inkTilesRef.current),
      tileBytes: inkTileBytes(inkTilesRef.current),
      bakeScale: targetBakeScale(inkTilesRef.current),
      zoom: cam.zoom,
      dpr,
      surface: 'canvas',
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

  const shapeGesture = useInkShapeGesture({
    scope: shapeScope, enabled: activeTool === 'pen' && brush !== 'laser',
    getScope: () => useCanvasStore.getState().currentCanvasId ?? '',
    zoom: () => useCanvasStore.getState().camera.zoom,
    getStroke: () => currentStrokeRef.current,
    setStroke: stroke => { currentStrokeRef.current = stroke; },
    flush: flushInput, repaint: () => { dirtyRef.current = true; scheduleRender(); },
  });
  useEffect(() => {
    const recent = shapeGesture.recent;
    if (activeTool === 'pen' && recent && selectedIds.length === 0
        && objects.some(o => o.id === recent.id && o.type === 'stroke' && o.geometry)) useCanvasStore.getState().setSelectedIds([recent.id]);
  }, [objects, selectedIds, activeTool, shapeGesture.recent]);

  const previewShapeEdit = (next: Stroke, original: Stroke) => {
    const tiles = inkTilesRef.current, index = getInkStrokeIndex(tiles);
    if (!shapeEditPreviewRef.current) {
      const ids = new Set([original.id]);
      removeStrokesFromTiles(tiles, index.grid, ids, [original], index.bounds);
      index.remove(ids); backendRef.current?.suppress(ids); displayLayersRef.current.invalidate();
    }
    shapeEditPreviewRef.current = next;
    for (const s of [original, next]) for (const key of strokeTileKeys(s)) gestureTilesRef.current.add(key);
    dirtyRef.current = true; scheduleRender();
  };
  const finishShapeEdit = (next: Stroke, original: Stroke, recordHistory: boolean) => {
    const st = useCanvasStore.getState();
    if ((st.currentCanvasId ?? '') !== shapeScope || !st.objects.includes(original)) {
      shapeEditPreviewRef.current = null; gestureTilesRef.current.clear(); return;
    }
    previewShapeEdit(next, original);
    st.replaceStroke(next, recordHistory);
    const actual = useCanvasStore.getState().objects.find((o): o is Stroke => o.type === 'stroke' && o.id === next.id)!;
    getInkStrokeIndex(inkTilesRef.current).add(actual);
    backendRef.current?.retain(actual, inkStrokesOnly(useCanvasStore.getState().objects));
    shapeEditPreviewRef.current = null; gestureTilesRef.current.clear();
    dirtyRef.current = true; scheduleRender();
  };

  // Laser fade loop: advance frames while any segment is still visible, then
  // stop. Independent of scheduleRender's dirty-flag gating, so the fade never
  // stalls after one frame.
  const tickLaser = useCallback(() => {
    laserRafRef.current = 0;
    const now = performance.now();
    // While writing, keep ALL trails lit (earlier strokes stay until the last
    // one lifts). Once idle, clear the whole group after it fades past lifetime.
    const holding = laserRef.current.some((s) => s.end === undefined);
    if (!holding && now - laserActiveRef.current >= LASER_LIFETIME) {
      laserRef.current = [];
      // Paint ONE final frame with no lasers so the last faint (alpha≈0) trail is
      // not left on the canvas until an unrelated later render clears it.
      dirtyRef.current = true;
      doRender();
    }
    if (laserRef.current.length) {
      dirtyRef.current = true;
      doRender();
      laserRafRef.current = requestAnimationFrame(tickLaser);
    }
  }, [doRender]);
  const startLaser = useCallback(() => {
    if (!laserRafRef.current) laserRafRef.current = requestAnimationFrame(tickLaser);
  }, [tickLaser]);

  /**
   * Whole-stroke eraser core. Only INK strokes (source-over) may be erased —
   * destination-out "eraser carve" strokes are never hit (see PdfEngine notes),
   * so erasing a partially-erased stroke removes the whole ink stroke instead of
   * deleting the carve and resurrecting the full original.
   *
   * Erasing is VISUAL first: strokes are cleared out of the shared ink tiles
   * immediately and queued in `pendingIds`; the STORE commit happens once on
   * pointer-up (one history snapshot, no per-frame React churn). The spatial
   * hash (`grid`) maintained at commit time means each frame only touches strokes
   * near the cursor — cost is independent of the page's total stroke count.
   */
  const applyVisualErase = useCallback((targets: Stroke[]) => {
    if (targets.length === 0) return;
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    for (const t of targets) wipe.pendingIds.add(t.id);
    backendRef.current?.suppress(targets.map(t => t.id));
    displayLayersRef.current.invalidate();
    const tRestamp = performance.now();
    removeStrokesFromTiles(inkTilesRef.current, wipe.grid, wipe.pendingIds, targets, wipe.bounds);
    addEraserRestamp(wipe.perf, targets.length, performance.now() - tRestamp);
    dirtyRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  /** Erase only the TOPMOST ink stroke under a point (the pointerdown click). */
  const eraseTopmostAt = useCallback((x: number, y: number) => {
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    const ink = wipe.index.topmost(x, y);
    const half = wipe.radius / 2;
    for (const s of ink) {
      if (wipe.pendingIds.has(s.id) || s.compositeOperation === 'destination-out') continue;
      const bnd = wipe.bounds.get(s.id);
      if (bnd && !boundsIntersectRect(bnd, x - half, y - half, x + half, y + half)) continue;
      if (wipe.index.hit(s, x, y, x, y, wipe.radius)) { applyVisualErase([s]); return; }
    }
  }, [applyVisualErase]);

  /**
   * Run the drag-wipe accumulated since the last frame. One spatial-hash query
   * over the travelled bounding box (expanded by the eraser disc half-width),
   * then exact segment hit-tests on those strokes only. Erases VISUALLY; the
   * store commit happens once on pointer-up.
   */
  const flushStrokeWipe = useCallback(() => {
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    wipe.raf = 0;
    if (wipe.pending.length === 0) return;
    const pending = wipe.pending;
    wipe.pending = [];
    // Fold the buffered samples into one polyline (dedupe consecutive samples).
    const all: { x: number; y: number }[] = [wipe.last];
    for (const p of pending) {
      const prev = all[all.length - 1];
      if (prev.x !== p.x || prev.y !== p.y) all.push(p);
    }
    wipe.last = all[all.length - 1];
    if (all.length < 2) return;
    const half = wipe.radius / 2;
    let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    for (const p of all) {
      if (p.x < bx1) bx1 = p.x;
      if (p.y < by1) by1 = p.y;
      if (p.x > bx2) bx2 = p.x;
      if (p.y > by2) by2 = p.y;
    }
    const tScan = performance.now();
    const candidates = wipe.index.collect(bx1 - half, by1 - half, bx2 + half, by2 + half);
    const targets: Stroke[] = [];
    for (const s of candidates) {
      if (wipe.pendingIds.has(s.id)) continue;
      if (s.compositeOperation === 'destination-out') continue;
      for (let i = 1; i < all.length; i++) {
        if (wipe.index.hit(s, all[i - 1].x, all[i - 1].y, all[i].x, all[i].y, wipe.radius)) {
          targets.push(s);
          break;
        }
      }
    }
    addEraserScan(wipe.perf, 1, candidates.length, performance.now() - tScan);
    applyVisualErase(targets);
  }, [applyVisualErase]);

  /** Schedule one wipe flush for the next animation frame (coalescing). */
  const scheduleWipe = useCallback(() => {
    const wipe = strokeEraseRef.current;
    if (!wipe || wipe.raf) return;
    wipe.raf = requestAnimationFrame(() => {
      flushStrokeWipe();
      if (dirtyRef.current) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        doRender();
      }
    });
  }, [flushStrokeWipe, doRender]);

  /** True while a pointer gesture owns the tiles. Rasterizing or reclaiming them
   *  then would be wrong: a wipe's erased strokes are still in the index (only
   *  suppressed via pendingIds until pointer-up), and a free-eraser carve is not
   *  committed to the store until pointer-up either — so a rebuild would
   *  resurrect erased ink. Nothing needs it either, since a gesture does not move
   *  the camera. A marquee is gated too: nothing is erased during one, but the
   *  pending materialize/re-bake chain would steal frames from the drag. */
  const inkGestureActive = useCallback(() => (
    currentStrokeRef.current !== null || strokeEraseRef.current !== null
    || shapeEditPreviewRef.current !== null
    || selectDragRef.current !== null || selectAnchorRef.current !== null || isDrawingRef.current
  ), []);

  // Materialize the tiles the viewport needs, in one pass per call; if the view
  // needs more than one pass' budget (wide zoom-out, or a re-bake after zooming),
  // keep going frame by frame rather than blocking on the whole document at once.
  const runMaterialize = useCallback((): number => {
    if (backgroundPausedRef.current) return 0;
    const container = containerRef.current;
    if (!container) return 0;
    const rect = boundsRef.current ?? container.getBoundingClientRect();
    if (!backendRef.current) {
      backendRef.current = new InkRenderBackend({ tiles: () => inkTilesRef.current,
        displayBytes: () => [canvasRef.current, backgroundLayerRef.current, committedLayerRef.current].reduce((bytes, canvas) => bytes + (canvas ? canvas.width * canvas.height * 4 : 0), 0),

        protectedKeys: () => {
          const keys = new Set(gestureTilesRef.current);
          if (selectDragRef.current) for (const stroke of selectDragRef.current.strokes) for (const key of strokeTileKeys(stroke)) keys.add(key);
          const wipe = strokeEraseRef.current;
          if (wipe) for (const id of wipe.pendingIds) {
            const b = wipe.bounds.get(id); if (b) protectInkSegment(keys, b.minX, b.minY, { x: b.maxX, y: b.maxY }, 0);
          }
          return keys;
        },
        publish: keys => { displayLayersRef.current.invalidate(keys); dirtyRef.current = true; scheduleRender(); },
      });
    }
    const state = useCanvasStore.getState();
    const strokes = inkStrokesOnly(state.objects);
    backendRef.current.sync(strokes);
    return backendRef.current.requestViewport(state.camera, rect.width, rect.height, dprRef.current, cameraSettled());
  }, [scheduleRender]);

  const scheduleMaterialize = useCallback(() => {
    if (materializeRafRef.current) return;
    const step = () => {
      materializeRafRef.current = 0;
      const remaining = runMaterialize();
      if (remaining === 0) {
        // Reclaim tiles the camera has left behind, and rasters of a bake scale
        // we no longer use — only once the view is settled and no gesture is in
        // flight, so a pan or a wipe never does book-keeping work mid-flight.
        const container = containerRef.current;
        const { camera: cam } = useCanvasStore.getState();
        if (container && !inkGestureActive() && cameraSettled()) {
          const rect = boundsRef.current ?? container.getBoundingClientRect();
          evictDistantTiles(inkTilesRef.current, cam, rect.width, rect.height);
          dropRastersNotAtScale(targetBakeScale(inkTilesRef.current));
        }
      } else {
        materializeRafRef.current = requestAnimationFrame(step);
      }
      if (dirtyRef.current) scheduleRender();
    };
    materializeRafRef.current = requestAnimationFrame(step);
  }, [runMaterialize, inkGestureActive, doRender]);

  useEffect(() => {
    // Tag camera frames for the frame stats — and hence the re-bake/eviction
    // gating that reads them — on CAMERA changes only. This used to ride on the
    // effect below, whose deps include objects/selectedIds/tool changes, so a
    // selection change mislabelled the next 150ms of frames as "camera moving"
    // in the diagnostics panel.
    noteCameraMove();
  }, [camera]);

  useEffect(() => {
    dirtyRef.current = true;
    // Schedule only — never materialize synchronously here. This effect runs on
    // every camera change, i.e. on every wheel tick and pointermove of a pan, and
    // rasterizing tiles inline is what made zooming stutter.
    setTargetBakeScale(inkTilesRef.current, useCanvasStore.getState().camera.zoom * dprRef.current);
    scheduleMaterialize();
    // …and come back once the view has settled, to do the work this pass
    // deliberately skipped: re-bake at the new density, reclaim what drifted off.
    if (lodSettleRef.current) clearTimeout(lodSettleRef.current);
    lodSettleRef.current = window.setTimeout(() => {
      lodSettleRef.current = 0;
      scheduleMaterialize();
    }, CAMERA_SETTLE_MS + 20);
    scheduleRender();
  }, [objects, camera, activeTool, brushSettings, showDotGrid, editingTextId, selectedIds, selectionMode,
      scheduleMaterialize, scheduleRender]);

  // Structural ops (undo/redo/delete/move/clear/load) → bring the ink layer up
  // to date with the new object list. When the change is small, the EXISTING
  // tiles are repaired in place instead of rebuilt: history snapshots share
  // stroke references, so an undo differs from the current list by just the last
  // gesture's strokes — repairing their rectangles keeps every other tile pixel
  // for pixel, where a rebuild re-rendered the whole visible canvas (undo felt
  // like opening the document again). Big diffs (load, clear) fall back to a
  // rebuild; either way the document is INDEXED whole and RASTERIZED only where
  // it is looked at (see InkTiles).
  useEffect(() => {
    const state = useCanvasStore.getState();
    const strokes = inkStrokesOnly(state.objects);
    const prev = prevObjectsRef.current;
    const layer = inkTilesRef.current;

    let incremental = false;
    if (prev) {
      const prevById = new Map<string, Stroke>();
      for (const o of prev) if (o.type === 'stroke') prevById.set(o.id, o);
      const nowById = new Map<string, Stroke>();
      for (const o of strokes) nowById.set(o.id, o);
      const added: Stroke[] = [], removed: Stroke[] = [];
      for (const [id, s] of nowById) {
        const p = prevById.get(id);
        if (!p) added.push(s);
        else if (p !== s) { removed.push(p); added.push(s); } // same id, replaced object (moved points)
      }
      for (const [id, s] of prevById) if (!nowById.has(id)) removed.push(s);
      if (added.length + removed.length <= 64) {
        incremental = true;
        if (added.length + removed.length > 0) {
          const index = getInkStrokeIndex(layer);
          // An in-flight build captured the buckets as they were, and completing
          // it would overwrite the repair — drop it; builds restart lazily.
          abandonBuilds(layer);
          const removedIds = new Set(removed.map((s) => s.id));
          // `removed` carries same-id replacements (a stroke whose points moved),
          // so this both clears the old pixels and un-indexes the id.
          if (removed.length > 0) removeStrokesFromTiles(layer, index.grid, removedIds, removed, index.bounds);
          index.remove(removedIds);
          // Stamp only what the layer does NOT already hold: stamping a stroke
          // that is already rasterized composites it a second time, and a
          // translucent stroke darkens at every self-overlap. stampStroke()
          // indexes the stroke itself.
          for (const s of added) if (!index.has(s.id)) index.add(s);
          backendRef.current?.sync(strokes);
        }
      }
    }

    if (!incremental) {
      const tiles = new Map<string, HTMLCanvasElement>();
      indexInkStrokes(tiles, strokes);
      setTargetBakeScale(tiles, state.camera.zoom * dprRef.current);
      inkTilesRef.current = tiles;
      if (import.meta.env.DEV) recordInkTrace(tiles, 'layer-rebuild', { surface: 'canvas', layer: inkTraceId(tiles),
        previousLayer: inkTraceId(layer), strokeCount: strokes.length, renderEpoch: state.renderEpoch });
      disposeTiles(layer);
    }
    // Any in-flight gesture captured the layer's index/grid/bounds. After a
    // rebuild its repairs would write into disposed canvases (`width = 0`),
    // silently turning the repair into a no-op — an erase that appears to do
    // nothing. Drop the gesture instead: the next pointermove falls through its
    // empty branch and pointer-up cannot commit stale state.
    strokeEraseRef.current = null;
    clearObjectDragPreview(selectDragRef.current?.objects);
    selectDragRef.current = null;
    cancelSelectionCapture(selectionCaptureRef, pointerOwnerRef);
    displayLayersRef.current.invalidate();
    dirtyRef.current = true;
    scheduleMaterialize();
    scheduleRender();
  }, [renderEpoch, scheduleMaterialize, scheduleRender]);
  // Diff baseline for the effect above. It must be written AFTER that effect has
  // read it — effects run in declaration order, so on a commit that changes both
  // objects and renderEpoch, this still sees the PRE-change list there.
  useEffect(() => {
    prevObjectsRef.current = useCanvasStore.getState().objects;
  }, [objects]);

  // Drop a queued screenshot at the current viewport center (world coords).
  // The image object stays a DOM layer BELOW the canvas so ink overdraws it.
  useEffect(() => {
    if (!pendingImageInsert) return;
    const container = containerRef.current;
    const vw = container?.clientWidth ?? window.innerWidth;
    const vh = container?.clientHeight ?? window.innerHeight;
    const st = useCanvasStore.getState();
    const c = screenToWorld(vw / 2, vh / 2, st.camera);
    // World-space size scaled ~1.2 so a full screenshot is comfortably large.
    const worldW = pendingImageInsert.width;
    const worldH = pendingImageInsert.height;
    st.addImageObject({
      dataUrl: pendingImageInsert.dataUrl,
      x: c.x - worldW / 2,
      y: c.y - worldH / 2,
      width: worldW,
      height: worldH,
    });
  }, [pendingImageInsert]);

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
    const rect = boundsRef.current ?? canvasRef.current?.getBoundingClientRect();
    return rect ? { sx: e.clientX - rect.left, sy: e.clientY - rect.top } : { sx: 0, sy: 0 };
  }, []);

  // ---- Select-drag helper ------------------------------------------------------

  const startSelectDrag = (ids: string[], world: { x: number; y: number }) => {
    const state = useCanvasStore.getState();
    const idSet = new Set(ids);
    const strokes: Stroke[] = [];
    for (const o of state.objects) {
      if (o.type === 'stroke' && idSet.has(o.id)) strokes.push(o);
    }
    // The dragged strokes are drawn live on top of the tiles for the whole
    // gesture, so their committed pixels must come out of the tiles first — but
    // ONLY their own pixels: repainting the whole page (every stroke, every
    // tile) here is what made a drag on a dense canvas stall for seconds before
    // it even started. This repairs just the rectangles they occupied.
    const tiles = inkTilesRef.current;
    const index = getInkStrokeIndex(tiles);
    traceInkStrokes('drag-start', tiles, strokes, { surface: 'canvas' });
    removeStrokesFromTiles(tiles, index.grid, idSet, strokes, index.bounds);
    index.remove(idSet);
    backendRef.current?.suppress(idSet);
    displayLayersRef.current.invalidate();
    selectDragRef.current = {
      start: world, ids, strokes,
      objects: createObjectDragPreview(state.objects, ids, containerRef.current),
      preview: bakeDragPreview(strokes, targetBakeScale(tiles)),
      dx: 0, dy: 0,
    };
    dirtyRef.current = true;
    scheduleRender();
  };

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>, preferredId?: string, captureTarget?: Element) => {
    if (pointerOwnerRef.current !== null && pointerOwnerRef.current !== e.pointerId) return;
    pointerOwnerRef.current = e.pointerId;
    gestureTilesRef.current.clear(); inputQueueRef.current.clear(); lastQueuedRef.current = undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const state = useCanvasStore.getState();
    const { sx, sy } = getCanvasPos(e);
    moveCursor(sx, sy);

    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = false;
      panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: state.camera.x, camY: state.camera.y };
      return;
    }
    if (e.button !== 0) return;
    shapeGesture.dismiss();
    if (state.activeTool === 'pen') state.clearSelection();

    const world = screenToWorld(sx, sy, state.camera);

    // While a text box is being edited, clicking empty canvas = END the edit
    // (commit via the textarea blur) instead of spawning another box.
    const endEditIfActive = () => {
      if (state.editingTextId == null) return false;
      const ae = document.activeElement;
      if (ae && ae instanceof HTMLTextAreaElement) ae.blur();
      return true;
    };

    if (state.activeTool === 'insert') {
      if (state.insertMode === 'image') {
        // Click once to pick an image → it lands at the clicked world point.
        insertWorldRef.current = world;
        fileInputRef.current?.click();
      } else {
        if (endEditIfActive()) return;
        state.addTextNode(world.x, world.y);
      }
      return;
    }
    if (state.activeTool === 'text') {
      if (endEditIfActive()) return;
      state.addTextNode(world.x, world.y);
      return;
    }

    // Selection tool
    if (state.activeTool === 'select') {
      beginSelectionCapture(selectionCaptureRef, captureTarget ?? canvas, e.pointerId, canvas);
      const operation = selectionOperation(e);
      selectionOperationRef.current = { operation, base: state.selectedIds.slice() };
      const hit = hitSelectable(state.objects, world.x, world.y, preferredId);

      if (hit) {
        if (operation !== 'replace') {
          state.setSelectedIds(combineSelection(state.selectedIds, [hit.id], operation));
          return;
        }
        const alreadySelected = state.selectedIds.includes(hit.id);
        const ids = alreadySelected ? state.selectedIds : [hit.id];
        if (!alreadySelected) state.setSelectedIds(ids);
        startSelectDrag(ids, world);
        return;
      }

      // Pressing on empty canvas
      if (state.selectionMode === 'click') {
        if (operation === 'replace') state.clearSelection();
      } else {
        // Box select — start dragging a rectangle
        selectAnchorRef.current = { x: world.x, y: world.y };
        selectionRectRef.current = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      }
      return;
    }

    // Stroke eraser — click erases the whole topmost stroke; dragging keeps the
    // pointer captured and wipes every ink stroke the cursor disc touches
    // (coalesced to one animation-frame batch).
    if (state.activeTool === 'eraser' && state.eraserMode === 'stroke') {
      canvas.setPointerCapture(e.pointerId);
      const index = getInkStrokeIndex(inkTilesRef.current);
      strokeEraseRef.current = {
        started: false, raf: 0, last: { x: world.x, y: world.y },
        pending: [], pendingIds: new Set(), bounds: index.bounds, grid: index.grid, index,
        radius: state.brushSettings.eraserSize ?? ERASER_RADIUS,
        perf: createEraserPerf(),
      };
      eraseTopmostAt(world.x, world.y);
      return;
    }

    // Laser pointer — a transient stroke that never lands in objects/history/tiles.
    if (state.brush === 'laser') {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      const seg: LaserSegment = {
        points: [],
        color: state.brushSettings.color,
        size: Math.max(1.5, state.brushSettings.size * 0.4),
        start: performance.now(),
      };
      addRawPoint(seg as any, world.x, world.y, getPressure(e), e.timeStamp);
      laserRef.current.push(seg);
      laserActiveRef.current = performance.now();
      startLaser();
      dirtyRef.current = true;
      scheduleRender();
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
      size: isEraser ? (state.brushSettings.eraserSize ?? ERASER_RADIUS) : state.brushSettings.size,
      opacity: isEraser ? 1 : state.brushSettings.opacity,
      renderVersion: !isEraser ? 2 : undefined,
      smoothing: isEraser ? 0 : state.brushSettings.smoothing,
      compositeOperation: isEraser ? 'destination-out' : 'source-over',
      style: isEraser ? undefined : (state.brush === 'fountain' || state.brush === 'pencil' ? state.brush : undefined),
      inkSpeed: isEraser ? undefined : state.brushSettings.inkSpeed,
      pressureOpacity: isEraser ? undefined : state.brushSettings.pressureOpacity,
      edgeFeather: isEraser ? undefined : state.brushSettings.edgeFeather,
      featherSize: isEraser ? undefined : state.brushSettings.featherSize,
      createdAt: Date.now(),
    };
    addRawPoint(stroke, world.x, world.y, getPressure(e), e.timeStamp);
    currentStrokeRef.current = stroke;
    if (!isEraser) shapeGesture.begin({ x: e.clientX, y: e.clientY }, e.pointerType);
    protectInkSegment(gestureTilesRef.current, world.x, world.y, undefined, stroke.size / 2 + 8);
    if (isEraser) {
      // Free eraser: erase the initial dot immediately (destination-out into tiles).
      eraseDotTiles(inkTilesRef.current, world.x, world.y, stroke.size);
      displayLayersRef.current.invalidate();
    }

    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Move -----------------------------------------------------------

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const inputStart = performance.now();
    try {
    if (pointerOwnerRef.current !== null && pointerOwnerRef.current !== e.pointerId) return;
    if (middlePanRef.current && (e.buttons & 4) === 0) {
      pointerUpRef.current?.(e);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { sx, sy } = getCanvasPos(e);
    const state = useCanvasStore.getState();
    lastPointerAtRef.current = performance.now();
    moveCursor(sx, sy);

    if (panAnchorRef.current) {
      pendingPanRef.current = {
        x: panAnchorRef.current.camX + e.clientX - panAnchorRef.current.sx,
        y: panAnchorRef.current.camY + e.clientY - panAnchorRef.current.sy,
      };
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Whole-stroke eraser — buffer the pointer sample and let the rAF flush do
    // the (single) hit-scan + erase per frame instead of on every pointermove.
    if (state.activeTool === 'eraser' && state.eraserMode === 'stroke' && strokeEraseRef.current) {
      const w = screenToWorld(sx, sy, state.camera);
      const wipe = strokeEraseRef.current;
      const last = wipe.pending[wipe.pending.length - 1] ?? wipe.last;
      if (last.x !== w.x || last.y !== w.y) {
        wipe.pending.push(w);
        scheduleWipe();
      }
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

    // Move selected strokes (snapshot + delta — no per-move store writes).
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      const w = screenToWorld(sx, sy, state.camera);
      d.dx = w.x - d.start.x;
      d.dy = w.y - d.start.y;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Laser pointer — append coalesced points to the active laser segment.
    if (isDrawingRef.current && state.brush === 'laser') {
      const seg = laserRef.current[laserRef.current.length - 1];
      if (seg) {
        const rect = boundsRef.current ?? canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const events: PointerEvent[] = inkPointerSamples(e.nativeEvent);
          for (const ce of events) {
            const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, state.camera);
            addRawPoint(seg as any, w.x, w.y, getPressure(ce), ce.timeStamp);
          }
        }
      }
      laserActiveRef.current = performance.now();
      startLaser();
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    if (!isDrawingRef.current || !currentStrokeRef.current) return;

    const events: PointerEvent[] = inkPointerSamples(e.nativeEvent);
    const stroke = currentStrokeRef.current;
    const rect = boundsRef.current ?? canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const inputStart = performance.now();
    for (const ce of events) {
      const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, state.camera);
      if (shapeGesture.move({ x: ce.clientX, y: ce.clientY }, w)) continue;
      protectInkSegment(gestureTilesRef.current, w.x, w.y, lastQueuedRef.current ?? stroke.points[stroke.points.length - 1], stroke.size / 2 + 8);
      lastQueuedRef.current = w;
      inputQueueRef.current.push({ x: w.x, y: w.y, pressure: getPressure(ce), t: ce.timeStamp });
    }
    reportInkFrame({ inputMs: performance.now() - inputStart });

    dirtyRef.current = true;
    scheduleRender();
    } finally { reportInkFrame({ inputMs: performance.now() - inputStart }); }
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerOwnerRef.current === null || pointerOwnerRef.current !== e.pointerId) return;
    shapeGesture.stop();
    const selectionCapture = endSelectionCapture(selectionCaptureRef);
    if (e.type === 'pointerup' && (selectDragRef.current || selectAnchorRef.current)) {
      const { sx, sy } = getCanvasPos(e), cam = useCanvasStore.getState().camera;
      const at = screenToWorld(sx, sy, cam);
      if (selectDragRef.current) { selectDragRef.current.dx = at.x - selectDragRef.current.start.x; selectDragRef.current.dy = at.y - selectDragRef.current.start.y; }
      if (selectionRectRef.current) { selectionRectRef.current.x2 = at.x; selectionRectRef.current.y2 = at.y; }
    }
    flushPanCamera();
    if (middlePanRef.current) { middlePanRef.current = false; setPointerHold(false); }
    flushInput();
    const tailStroke = currentStrokeRef.current;
    if (e.type === 'pointerup' && tailStroke?.points.length) {
      const rect = boundsRef.current ?? canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const cam = useCanvasStore.getState().camera;
        const point = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam);
        const last = tailStroke.points[tailStroke.points.length - 1];
        if (tailStroke.geometry) shapeGesture.move({ x: e.clientX, y: e.clientY }, point);
        else if (point.x !== last.x || point.y !== last.y) {
          inputQueueRef.current.push({ x: point.x, y: point.y, pressure: e.pressure > 0 ? e.pressure : last.pressure, t: e.timeStamp });
          flushInput();
        }
      }
    }
    pointerOwnerRef.current = null;
    gestureTilesRef.current.clear();
    setTimeout(() => { runMaterialize(); scheduleMaterialize(); }, 0);
    const canvas = canvasRef.current;
    // The pointer may not actually be captured (e.g. a one-shot click that never
    // called setPointerCapture), or capture may already have been lost. Releasing
    // unconditionally throws here, which used to abort the cleanup below and leave
    // isDrawing/pan/select state stuck — the cause of unclickable toolbar/sidebar.
    try { (selectionCapture ?? canvas)?.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }

    // End any whole-stroke-eraser wipe session. Flush any samples that arrived
    // since the last animation frame, then commit every visually-erased stroke
    // to the store in ONE history snapshot (removals were only tile-local so
    // far — nothing touched the store mid-drag).
    const wipe = strokeEraseRef.current;
    if (wipe) {
      if (wipe.raf) cancelAnimationFrame(wipe.raf);
      wipe.raf = 0;
      if (wipe.pending.length > 0) flushStrokeWipe();
      if (wipe.pendingIds.size > 0) {
        const st = useCanvasStore.getState();
        if (!wipe.started) { st.beginEraseGesture(); wipe.started = true; }
        st.eraseStrokesLive([...wipe.pendingIds]);
        wipe.index.remove(wipe.pendingIds);
      }
      logEraserPerf(wipe.perf, 'canvas');
    }
    strokeEraseRef.current = null;

    if (panAnchorRef.current) { panAnchorRef.current = null; return; }

    // Finalize box selection
    if (selectAnchorRef.current && selectionRectRef.current) {
      const r = selectionRectRef.current;
      const state = useCanvasStore.getState();
      const ids = boxSelectableIds(state.objects, r, containerRef.current, state.camera);
      const { operation, base } = selectionOperationRef.current;
      state.setSelectedIds(combineSelection(base, ids, operation));
      selectAnchorRef.current = null;
      selectionRectRef.current = null;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // End select-drag: commit the final positions, then stamp ONLY the moved
    // strokes back into the tiles. A page-wide rebuild here would undo the whole
    // point of the local erase at drag start.
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      selectDragRef.current = null;
      clearObjectDragPreview(d.objects);
      const st = useCanvasStore.getState();
      if (!d.dx && !d.dy && d.strokes.length) st.commitStrokesPoints(d.strokes.map(s => ({ id: s.id, points: s.points })));
      else st.commitSelectionMove(d.ids, d.dx, d.dy);
      const tiles = inkTilesRef.current;
      const movedIds = new Set(d.strokes.map(s => s.id));
      for (const o of useCanvasStore.getState().objects) {
        if (o.type === 'stroke' && movedIds.has(o.id)) {
          getInkStrokeIndex(tiles).add(o);
          backendRef.current?.retain(o, useCanvasStore.getState().objects.filter((item): item is Stroke => item.type === 'stroke'));
        }
      }
      if (import.meta.env.DEV) traceInkStrokes('drag-end', tiles,
        useCanvasStore.getState().objects.filter((o): o is Stroke => o.type === 'stroke' && movedIds.has(o.id)),
        { surface: 'canvas', dx: d.dx, dy: d.dy });
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Laser pointer — stop feeding points; the group fade clock starts from this
    // pen-up. Never addStroke/stampStroke.
    if (isDrawingRef.current && useCanvasStore.getState().brush === 'laser') {
      const seg = laserRef.current[laserRef.current.length - 1];
      if (seg && seg.end === undefined) seg.end = performance.now();
      laserActiveRef.current = performance.now();
      isDrawingRef.current = false;
      dirtyRef.current = true;
      scheduleRender();
      startLaser();
      return;
    }

    if (isDrawingRef.current && currentStrokeRef.current) {
      const stroke = currentStrokeRef.current;
      shapeGesture.finish(stroke);
      if (stroke.points.length > 0) {
        useCanvasStore.getState().addStroke(stroke);
        if (stroke.geometry) useCanvasStore.getState().setSelectedIds([stroke.id]);
        if (stroke.compositeOperation !== 'destination-out') {
          // Pen: stamp into tiles. Free eraser already erased incrementally.
          getInkStrokeIndex(inkTilesRef.current).add(stroke);
          if (!backendRef.current) runMaterialize();
          backendRef.current?.retain(stroke, inkStrokesOnly(useCanvasStore.getState().objects));
        } else {
          getInkStrokeIndex(inkTilesRef.current).add(stroke);
          if (!backendRef.current) runMaterialize();
          backendRef.current?.retain(stroke, inkStrokesOnly(useCanvasStore.getState().objects));
        }
      }
      currentStrokeRef.current = null;
      isDrawingRef.current = false;
      dirtyRef.current = true;
      scheduleRender();
    }
    isDrawingRef.current = false;
    panAnchorRef.current = null;
  }, [scheduleRender]);

  pointerUpRef.current = handlePointerUp;

  // ---- Wheel ------------------------------------------------------------------

  // Attached natively, NOT via React's `onWheel`: React registers wheel listeners
  // as PASSIVE at the root, where preventDefault() is ignored — Chrome warns
  // ("Unable to preventDefault inside passive event listener") and the event's
  // default action still runs. Here that means the browser's own ctrl+wheel page
  // zoom is not suppressed, so ctrl+wheel would zoom the whole app window as well
  // as panning the canvas.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      // The modal image viewer is the one surface where a wheel does not belong
      // to the canvas.
      if ((e.target as HTMLElement | null)?.closest?.('[data-lightbox], [data-ink-shape-panel]')) return;
      e.preventDefault();
      flushPanCamera();
      const state = useCanvasStore.getState();
      const rect = boundsRef.current ?? container.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      if (e.ctrlKey) {
        state.setCamera({ x: state.camera.x - e.deltaX, y: state.camera.y - e.deltaY });
      } else {
        const newZoom = clampZoom(state.camera.zoom * (1 - e.deltaY * 0.001));
        state.setCamera(zoomAt(state.camera, sx, sy, newZoom));
      }
      // A trailing wheel event must not leave the active pan at its old origin.
      if (panAnchorRef.current) {
        const cam = useCanvasStore.getState().camera;
        panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y };
      }
      dirtyRef.current = true;
      scheduleRender();
    };
    // CAPTURE-phase on the CONTAINER, not the canvas: the DOM cards (images,
    // text) sit ABOVE the canvas and would swallow a wheel aimed at them, so
    // scrolling over a picture used to do nothing. The container owns the whole
    // canvas area, so one listener covers every layer of it.
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => container.removeEventListener('wheel', onWheel, { capture: true });
  }, [scheduleRender, flushPanCamera]);

  // Middle button ALWAYS pans the canvas, from wherever it lands — including on
  // the DOM cards (images, text) that sit over the canvas and would otherwise
  // start their own drag. The listener is CAPTURE-phase on the container, so it
  // runs before any card handler and stopPropagation keeps the card from ever
  // seeing a middle-button press. The canvas then captures the pointer, so the
  // pan keeps tracking even when the cursor is over a card.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onMiddleDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      if (pointerOwnerRef.current !== null) return;
      if ((e.target as HTMLElement | null)?.closest?.('[data-lightbox]')) return;
      e.preventDefault();
      e.stopPropagation();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const state = useCanvasStore.getState();
      pointerOwnerRef.current = e.pointerId;
      middlePanRef.current = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* window release listeners still end the pan */ }
      isDrawingRef.current = false;
      setPointerHold(true); // persistence must defer for the whole pan
      panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: state.camera.x, camY: state.camera.y };
    };
    const onMiddleUp = (e: PointerEvent) => {
      if (middlePanRef.current && e.pointerId === pointerOwnerRef.current) {
        pointerUpRef.current?.(e as unknown as React.PointerEvent<HTMLCanvasElement>);
      }
    };
    const onBlur = () => {
      const owner = pointerOwnerRef.current;
      if (middlePanRef.current && owner !== null) pointerUpRef.current?.({ pointerId: owner, type: 'pointercancel' } as React.PointerEvent<HTMLCanvasElement>);
    };
    container.addEventListener('pointerdown', onMiddleDown, true);
    window.addEventListener('pointerup', onMiddleUp, true);
    window.addEventListener('pointercancel', onMiddleUp, true);
    window.addEventListener('lostpointercapture', onMiddleUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      container.removeEventListener('pointerdown', onMiddleDown, true);
      window.removeEventListener('pointerup', onMiddleUp, true);
      window.removeEventListener('pointercancel', onMiddleUp, true);
      window.removeEventListener('lostpointercapture', onMiddleUp, true);
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, []);

  // Insert → image: read the picked file(s), downscale each, and place them at
  // the click point. Multiple picks cascade (each offset down-right) so they
  // never stack on top of one another; after inserting we revert to the brush.
  const onPickImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const target = insertWorldRef.current;
    if (!files.length || !target) return;
    // One snapshot for the whole batch → a single undo removes every image.
    const st = useCanvasStore.getState();
    st.pushHistory();
    files.forEach((file, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result || '');
        const img = new Image();
        img.onload = () => {
          const maxW = 1280;
          const scale = Math.min(1, maxW / img.naturalWidth);
          const w = Math.round(img.naturalWidth * scale);
          const h = Math.round(img.naturalHeight * scale);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          if (ctx) ctx.drawImage(img, 0, 0, w, h);
          const off = i * 48;
          useCanvasStore.getState().addImageObject({
            dataUrl: c.toDataURL('image/png'),
            x: target.x + off - w / 2,
            y: target.y + off - h / 2,
            width: w,
            height: h,
          }, false);
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
    });
    // Back to pen so the next click draws instead of re-opening the picker.
    st.setActiveTool('pen');
  }, []);

  // ---- Cursor -----------------------------------------------------------------

  // Pen AND the eraser (both free & whole-stroke modes) share the round brush
  // cursor; the ring stays visible while pressing/dragging (never hidden on down).
  const cursorStyle = (activeTool === 'pen' || activeTool === 'eraser') ? 'none'
    : activeTool === 'text' ? 'text'
    : activeTool === 'insert' && insertMode === 'text' ? 'text'
    : (activeTool === 'select' || activeTool === 'insert') ? 'crosshair'
    : 'default';
  const editingNode = objects.find((o): o is TextNodeData => o.type === 'text' && o.id === editingTextId);

  // Circle diameter in screen px = world width × zoom, so it matches the drawn line.
  const laserSize = Math.max(1.5, brushSettings.size * 0.4);
  const cs = (activeTool === 'eraser'
    ? (brushSettings.eraserSize ?? ERASER_RADIUS)
    : brush === 'laser' ? laserSize : brushSettings.size) * camera.zoom;
  const isLight = theme === 'light';
  const ringBorder = isLight ? 'rgba(30,30,40,0.85)' : 'rgba(255,255,255,0.7)';
  const ringBg = isLight
    ? (activeTool === 'eraser' ? 'rgba(30,30,40,0.14)' : 'rgba(30,30,40,0.07)')
    : (activeTool === 'eraser' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)');
  // Text cards are interactive in the select tool and in insert-text mode; while
  // drawing/erasing they are pointer-events:none so strokes pass through.
  const interactiveText =
    activeTool === 'select' || (activeTool === 'insert' && insertMode === 'text');

  useEffect(() => {
    const flushGesture = () => {
      const owner = pointerOwnerRef.current;
      if (owner !== null) canvasRef.current?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: owner }));
    };
    const suspend = () => { backgroundPausedRef.current = true; if (materializeRafRef.current) cancelAnimationFrame(materializeRafRef.current); materializeRafRef.current = 0; backendRef.current?.dispose(); backendRef.current = null; };
    const resume = () => { backgroundPausedRef.current = false; dirtyRef.current = true; scheduleRender(); scheduleMaterialize(); };
    window.addEventListener('ink:flush-gesture', flushGesture);
    window.addEventListener('ink:suspend-background', suspend);
    window.addEventListener('ink:resume-background', resume);
    return () => {
      window.removeEventListener('ink:flush-gesture', flushGesture);
      window.removeEventListener('ink:suspend-background', suspend);
      window.removeEventListener('ink:resume-background', resume);
    };
  }, []);

  const selectedShape = (activeTool === 'select' || shapeGesture.recent?.id === selectedIds[0]) && selectedIds.length === 1
    ? objects.find((o): o is Stroke => o.type === 'stroke' && !!o.geometry && o.id === selectedIds[0]) : undefined;
  shapeEditorIdRef.current = selectedShape?.id ?? null;
  const selectionEvents = inkSelectionCaptureHandlers({ enabled: () => useCanvasStore.getState().activeTool === 'select',
    canvas: canvasRef, capture: selectionCaptureRef, owner: pointerOwnerRef, shapeId: shapeEditorIdRef,
    down: handlePointerDown, move: handlePointerMove, up: handlePointerUp });

  return (
    <div ref={containerRef}
      {...selectionEvents}
      onGotPointerCaptureCapture={event => { const id = (event.target as HTMLElement).closest('[data-ink-object-id]')?.getAttribute('data-ink-object-id'); if (id) manipulatedIdsRef.current.add(id); }}
      onLostPointerCaptureCapture={event => { const id = (event.target as HTMLElement).closest('[data-ink-object-id]')?.getAttribute('data-ink-object-id'); if (id) manipulatedIdsRef.current.delete(id); }}
      style={{ isolation: 'isolate', position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)', borderRadius: '0 0 12px 0' }}>
      <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickImage} />
      {/* Image objects render BEFORE the canvas → they sit below the ink layer. */}
      {objects.filter((o): o is ImageObjectType => o.type === 'image' && inkObjectVisible(o, camera, boundsRef.current?.width ?? window.innerWidth, boundsRef.current?.height ?? window.innerHeight, [...selectedIds, ...manipulatedIdsRef.current])).map((o) => (
        <ImageObject key={o.id} obj={o} camera={camera} />
      ))}
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none', cursor: cursorStyle }}
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onPointerLeave={hideCursor} />
      <canvas ref={backgroundLayerRef} aria-hidden="true" data-ink-layer="background" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -2 }} />
      <canvas ref={committedLayerRef} aria-hidden="true" data-ink-layer="committed" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1 }} />
      {selectedShape && <InkShapeEditor key={shapeScope + selectedShape.id} stroke={selectedShape} camera={camera} uiScale={uiScale} container={containerRef}
        original={shapeGesture.recent} onPreview={previewShapeEdit} onFinish={finishShapeEdit}
        onDismiss={() => { shapeGesture.dismiss(); useCanvasStore.getState().clearSelection(); }} />}

      {/* Committed text = always-visible DOM cards (above ink). Interactive in the
          select / insert-text tools; the one being edited is rendered by TextNode. */}
      {objects
        .filter((o): o is TextNodeData => o.type === 'text' && o.id !== editingTextId && inkObjectVisible(o, camera, boundsRef.current?.width ?? window.innerWidth, boundsRef.current?.height ?? window.innerHeight, selectedIds))
        .map((o) => (
          <TextObject key={o.id} node={o} camera={camera} interactive={interactiveText} />
        ))}

      <div ref={ringRef} style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', width: cs / uiScale, height: cs / uiScale,
        borderRadius: '50%', border: `1.5px solid ${ringBorder}`,
        background: ringBg,
        pointerEvents: 'none', zIndex: 9999, transform: 'translate(-50%, -50%)' }} />

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

      <ToolbarShell useStore={useCanvasToolbarStore}><Toolbar /></ToolbarShell>
    </div>
  );
};

export default InfiniteInkCanvas;
