import { inkStrokesOnly, inkObjectVisible } from '../InkViewportObjects';
import { InkRenderBackend, strokeTileKeys, protectInkSegment } from './InkRenderBackend';
import { InkDisplayLayers, sizeInkSurface } from '../InkDisplayLayers';
import { useInkViewport, type InkViewportSize } from '../InkViewport';
import { inkTraceId, recordInkTrace, traceInkStrokes } from '../InkDiagnostics';
import { inkPointerSamples, InkPointerQueue } from '../InkPointerSamples';
import { releaseStreamingInk } from '../PdfAnnotation/StreamingInkStroke';
import React, { useRef, useEffect, useCallback } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { useInkShapeGesture } from '../useInkShapeGesture';
import InkShapeEditor from '../InkShapeEditor';
import InkCommentLayer from '../InkCommentLayer';
import { activateCommentDrag, commentDragIds, type PendingCommentDrag } from '../InkComments';
import { beginSelectionCapture, endSelectionCapture, cancelSelectionCapture, inkSelectionCaptureHandlers,
  selectionOperation, combineSelection, hitSelectable, boxSelectableIds, createObjectDragPreview,
  drawObjectDragPreview, clearObjectDragPreview, type SelectionOperation, type SelectionCapture, type ObjectDragPreview } from '../InkSelection';
import { getInkStrokeIndex, type InkStrokeIndex } from '../PdfAnnotation/InkStrokeIndex';
import { bakeDragPreview, drawDragPreview, type DragPreview } from '../PdfAnnotation/InkDragPreview';
import { useBrushCursor } from '../useBrushCursor';
import { useInkInputActivity, setPointerHold, notifyInkStrokeStart } from '../inkInputActivity';
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
import { drawAnnotatedStroke, drawLiveAnnotatedStroke } from '../PdfAnnotation/PdfBrushRenderers';
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
import AssetObject from '../FileLibrary/AssetObject';
import { assetDropTarget, makeAssetPlacement, useAssetDrop } from '../FileLibrary/assetDrop';
import { externalFileTarget, placeDroppedItems, receiveExternalFiles } from '../FileLibrary/externalFiles';
import TextObject from './TextObject';
import Toolbar from './Toolbar';
import { useNoteStore } from '../../store';
import { themeCanvasColors } from '../../themeColors';
import { InkLaserTrail, LASER_LIFETIME } from '../InkLaserTrail';
import type { Stroke, TextNodeData, CanvasObject, ImageObject as ImageObjectType } from './types';

const InfiniteInkCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundLayerRef = useRef<HTMLCanvasElement>(null);
  const committedLayerRef = useRef<HTMLCanvasElement>(null);
  const displayLayersRef = useRef(new InkDisplayLayers());
  const manipulatedIdsRef = useRef(new Set<string>());
  const backgroundPausedRef = useRef(false);
  const backendRef = useRef<InkRenderBackend | null>(null);
  const boundsRef = useRef<DOMRect | null>(null);
  const capacityRef = useRef<InkViewportSize | null>(null);
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
    comment: boolean;
  } | null>(null);
  const pendingCommentDragRef = useRef<PendingCommentDrag | null>(null);
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
  const laserRef = useRef<InkLaserTrail[]>([]);
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
    if (selectDragRef.current?.preview) selectDragRef.current.preview.canvas.width = 0;
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
  const theme = useNoteStore((s) => s.settings.theme);
  const uiScale = useNoteStore((s) => s.uiScale);
  const { ringRef, moveCursor, hideCursor } = useBrushCursor(
    uiScale, activeTool === 'pen' || activeTool === 'eraser',
  );
  useInkInputActivity(canvasRef);
  const renderEpoch = useCanvasStore((s) => s.renderEpoch);
  const pendingImageInsert = useCanvasStore((s) => s.pendingImageInsert);

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
    const { uiScale } = useNoteStore.getState();
    const capacity = capacityRef.current ?? rect;
    sizeInkSurface(canvas, capacity.width, capacity.height, dpr, uiScale);

    const colors = themeCanvasColors(useNoteStore.getState().settings.theme);
    const bgLayer = backgroundLayerRef.current, inkLayer = committedLayerRef.current;
    if (bgLayer && inkLayer) {
      displayLayersRef.current.paint({ background: bgLayer, ink: inkLayer, tiles: inkTilesRef.current,
        camera: cam, width: vw, height: vh, capacity, dpr, uiScale,
        drawTile: (context, key, tile, x, y, w, h) => { const backend = backendRef.current; if (backend) backend.drawTile(context, key, tile, x, y, w, h); else context.drawImage(tile, x, y, w, h); }, backgroundColor: colors.background,
        dotColor: colors.dotColor, showDotGrid: state.showDotGrid });
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);

    // Rasterized ink tiles (O(1) per frame).
    const inkStart = performance.now();
    backendRef.current?.drawPending(ctx);
    if (shapeEditPreviewRef.current) drawAnnotatedStroke(ctx, shapeEditPreviewRef.current);

    // Text nodes are now always-interactive DOM cards rendered ABOVE the canvas
    // (TextObject) — they are intentionally NOT drawn into the vector canvas.

    // The drag preview keeps its own density through zoom and tile upgrades.
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      drawObjectDragPreview(d.objects, containerRef.current, d.dx, d.dy, cam.zoom, useNoteStore.getState().uiScale);
      const p = d.preview;
      if (p) drawDragPreview(ctx, p, d.dx, d.dy);
    } else if (state.selectedIds.length > 0) {
      drawSelectionHighlight(ctx, state.objects, state.selectedIds.filter(id => id !== shapeEditorIdRef.current));
    }
    if (selectionRectRef.current) drawSelectionRect(ctx, selectionRectRef.current);

    // Live stroke (pen only — free eraser already writes tiles incrementally).
    if (currentStrokeRef.current
        && currentStrokeRef.current.compositeOperation !== 'destination-out'
        && currentStrokeRef.current.points.length > 0) {
      drawLiveAnnotatedStroke(ctx, currentStrokeRef.current);
    }
    if (currentStrokeRef.current?.compositeOperation === 'destination-out') drawAnnotatedStroke(ctx, currentStrokeRef.current);

    // Transient laser-pointer strokes. While any stroke is being drawn, all
    // trails stop fading and stay lit (so writing a new stroke re-lights earlier
    // ones); when idle they fade together from the last pen activity.
    const now = performance.now();
    const holding = laserRef.current.some((s) => s.end === undefined);
    if (holding) {
      for (const seg of laserRef.current) seg.draw(ctx, 1);
    } else {
      const gAge = now - laserActiveRef.current;
      const gAlpha = gAge >= LASER_LIFETIME ? 0 : 1 - gAge / LASER_LIFETIME;
      for (const seg of laserRef.current) seg.draw(ctx, gAlpha);
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
    if (backgroundPausedRef.current || selectDragRef.current) return 0;
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

  const repaintViewport = useCallback(() => { dirtyRef.current = true; scheduleRender(); }, [scheduleRender]);
  const extent = useInkViewport({
    container: containerRef, bounds: boundsRef, capacity: capacityRef, dpr: dprRef,
    uiScale, repaint: repaintViewport, requestTiles: scheduleMaterialize,
  });

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
    if (prev && !selectDragRef.current?.strokes.length) {
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
    backendRef.current?.sync(strokes);
    // Any in-flight gesture captured the layer's index/grid/bounds. After a
    // rebuild its repairs would write into disposed canvases (`width = 0`),
    // silently turning the repair into a no-op — an erase that appears to do
    // nothing. Drop the gesture instead: the next pointermove falls through its
    // empty branch and pointer-up cannot commit stale state.
    strokeEraseRef.current = null;
    clearObjectDragPreview(selectDragRef.current?.objects);
    if (selectDragRef.current?.preview) selectDragRef.current.preview.canvas.width = 0;
    selectDragRef.current = null;
    pendingCommentDragRef.current = null;
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
      if (tag === 'TEXTAREA' || tag === 'INPUT' || document.querySelector('[data-file-dialog]')) return;
      const state = useCanvasStore.getState();
      if (e.code === 'Space') { e.preventDefault(); spaceDownRef.current = true; }
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); state.undo(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); state.redo(); }
      if (e.ctrlKey && e.key === 'Z') { e.preventDefault(); state.redo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.editingTextId) {
        state.deleteTextNode(state.editingTextId);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const deletable = state.objects.filter(object => (object.type === 'asset' || object.type === 'comment')
          && state.selectedIds.includes(object.id));
        if (deletable.length) {
          e.preventDefault();
          state.deleteObjects(deletable.map(object => object.id));
        }
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

  const startSelectDrag = useCallback((ids: string[], world: { x: number; y: number }, comment = false) => {
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
    if (strokes.length) {
      const keys = new Set(strokes.flatMap(strokeTileKeys));
      removeStrokesFromTiles(tiles, index.grid, idSet, strokes, index.bounds, true);
      index.remove(idSet);
      backendRef.current?.suppress(idSet, keys);
      displayLayersRef.current.invalidate(keys);
    }
    selectDragRef.current = {
      start: world, ids, strokes,
      objects: createObjectDragPreview(state.objects, ids, containerRef.current),
      preview: bakeDragPreview(strokes, targetBakeScale(tiles)),
      dx: 0, dy: 0, comment,
    };
    dirtyRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>, preferredId?: string, captureTarget?: Element) => {
    if (pointerOwnerRef.current !== null && pointerOwnerRef.current !== e.pointerId) return;
    pointerOwnerRef.current = e.pointerId;
    gestureTilesRef.current.clear(); inputQueueRef.current.clear(); lastQueuedRef.current = undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const state = useCanvasStore.getState();
    // Editor entrance animations can move the viewport without resizing it.
    if (containerRef.current) boundsRef.current = containerRef.current.getBoundingClientRect();
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
        if (hit.type === 'comment') pendingCommentDragRef.current = {
          start: world, ids: commentDragIds({ items: state.objects, selectedIds: ids, camera: state.camera }, containerRef.current),
        };
        else startSelectDrag(ids, world);
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

    notifyInkStrokeStart(e.pointerId);
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
      const { color, size, smoothing } = state.brushSettings;
      const seg = new InkLaserTrail(color, Math.max(1.5, size * 0.4), smoothing);
      seg.append(world.x, world.y, e.timeStamp);
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
      renderVersion: isEraser ? undefined : state.brush === 'pencil' || state.brush === 'fountain' ? 5 : 2,
      smoothing: isEraser ? 0 : state.brushSettings.smoothing,
      compositeOperation: isEraser ? 'destination-out' : 'source-over',
      style: isEraser ? undefined : (state.brush === 'fountain' || state.brush === 'pencil' ? state.brush : undefined),
      inkSpeed: isEraser ? undefined : state.brushSettings.inkSpeed,
      inputZoom: !isEraser && state.brush === 'fountain' ? state.camera.zoom : undefined,
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
  }, [getCanvasPos, scheduleRender, startSelectDrag]);

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

    // Start the heavier paint preview only once a title press becomes a drag.
    if (pendingCommentDragRef.current) {
      activateCommentDrag(pendingCommentDragRef, screenToWorld(sx, sy, state.camera), state.camera.zoom, startSelectDrag);
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
            seg.append(w.x, w.y, ce.timeStamp);
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
  }, [getCanvasPos, scheduleRender, startSelectDrag]);

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerOwnerRef.current === null || pointerOwnerRef.current !== e.pointerId) return;
    shapeGesture.stop();
    const selectionCapture = endSelectionCapture(selectionCaptureRef);
    if (e.type === 'pointerup' && (selectDragRef.current || selectAnchorRef.current || pendingCommentDragRef.current)) {
      const { sx, sy } = getCanvasPos(e), cam = useCanvasStore.getState().camera;
      const at = screenToWorld(sx, sy, cam);
      activateCommentDrag(pendingCommentDragRef, at, cam.zoom, startSelectDrag);
      if (selectDragRef.current) { selectDragRef.current.dx = at.x - selectDragRef.current.start.x; selectDragRef.current.dy = at.y - selectDragRef.current.start.y; }
      if (selectionRectRef.current) { selectionRectRef.current.x2 = at.x; selectionRectRef.current.y2 = at.y; }
    }
    pendingCommentDragRef.current = null;
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
      if (d.comment && e.type !== 'pointerup') d.dx = d.dy = 0;
      if (d.dx || d.dy) st.commitSelectionMove(d.ids, d.dx, d.dy);
      else if (!d.comment && d.strokes.length) st.commitStrokesPoints(d.strokes.map(s => ({ id: s.id, points: s.points })));
      const objects = useCanvasStore.getState().objects;
      // The index is updated in this handler. Undo may arrive before effects
      // run, so the diff baseline has to follow the same commit.
      prevObjectsRef.current = objects;
      const tiles = inkTilesRef.current;
      const movedIds = new Set(d.strokes.map(s => s.id));
      if (movedIds.size) {
        const strokes = inkStrokesOnly(objects);
        const moved = strokes.filter(o => movedIds.has(o.id));
        const index = getInkStrokeIndex(tiles);
        for (const stroke of moved) index.add(stroke);
        const backend = backendRef.current;
        if (backend && moved.length) backend.retainMany(moved, strokes, d.preview ? { preview: d.preview, dx: d.dx, dy: d.dy } : undefined);
        else if (d.preview) d.preview.canvas.width = 0;
        traceInkStrokes('drag-end', tiles, moved, { surface: 'canvas', dx: d.dx, dy: d.dy });
      }
      dirtyRef.current = true;
      scheduleMaterialize();
      scheduleRender();
      return;
    }

    // Laser pointer — stop feeding points; the group fade clock starts from this
    // pen-up. Never addStroke/stampStroke.
    const state = useCanvasStore.getState();
    if (isDrawingRef.current && state.brush === 'laser') {
      const seg = laserRef.current[laserRef.current.length - 1];
      const now = performance.now();
      if (seg && seg.end === undefined) {
        if (e.type === 'pointerup') {
          const { sx, sy } = getCanvasPos(e);
          const end = screenToWorld(sx, sy, state.camera);
          seg.append(end.x, end.y, e.timeStamp);
        }
        seg.end = now;
      }
      laserActiveRef.current = now;
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
  }, [scheduleMaterialize, scheduleRender, startSelectDrag]);

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
  useAssetDrop(containerRef, (assetId, x, y) => {
    const state = useCanvasStore.getState();
    const canvasId = state.currentCanvasId;
    if (!canvasId || !state.loaded) return;
    const world = screenToWorld(x, y, state.camera);
    void makeAssetPlacement(assetId, world.x, world.y).then(placement => {
      const current = useCanvasStore.getState();
      if (placement && current.currentCanvasId === canvasId && containerRef.current) current.addAssetObject(placement);
    });
  });
  const selectionEvents = inkSelectionCaptureHandlers({ enabled: () => useCanvasStore.getState().activeTool === 'select',
    canvas: canvasRef, capture: selectionCaptureRef, owner: pointerOwnerRef, shapeId: shapeEditorIdRef,
    down: handlePointerDown, move: handlePointerMove, up: handlePointerUp });
  const cullWidth = extent?.width ?? window.innerWidth;
  const cullHeight = extent?.height ?? window.innerHeight;
  const readCommentSelection = useCallback(() => {
    const state = useCanvasStore.getState();
    if (!state.loaded || !state.currentCanvasId || state.activeTool !== 'select'
      || state.editingTextId || pointerOwnerRef.current !== null) return null;
    return { items: state.objects, selectedIds: state.selectedIds, camera: state.camera };
  }, []);

  return (
    <div ref={containerRef} tabIndex={-1}
      {...assetDropTarget}
      {...externalFileTarget(event => {
        const state = useCanvasStore.getState();
        const id = state.currentCanvasId;
        if (!id || !state.loaded) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const origin = screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, state.camera);
        receiveExternalFiles(event.dataTransfer, items => {
          const current = useCanvasStore.getState();
          if (containerRef.current && current.currentCanvasId === id && current.loaded) current.addDroppedObjects(placeDroppedItems(items, origin));
        });
      })}
      {...selectionEvents}
      onGotPointerCaptureCapture={event => { const id = (event.target as HTMLElement).closest('[data-ink-object-id]')?.getAttribute('data-ink-object-id'); if (id) manipulatedIdsRef.current.add(id); }}
      onLostPointerCaptureCapture={event => { const id = (event.target as HTMLElement).closest('[data-ink-object-id]')?.getAttribute('data-ink-object-id'); if (id) manipulatedIdsRef.current.delete(id); }}
      style={{ isolation: 'isolate', position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)', borderRadius: '0 0 12px 0' }}>
      <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickImage} />
      {/* Image objects render BEFORE the canvas → they sit below the ink layer. */}
      {objects.filter((o): o is ImageObjectType => o.type === 'image' && inkObjectVisible(o, camera, cullWidth, cullHeight, [...selectedIds, ...manipulatedIdsRef.current])).map((o) => (
        <ImageObject key={o.id} obj={o} camera={camera} />
      ))}
      {objects.map(object => object.type === 'asset' && inkObjectVisible(object, camera, cullWidth, cullHeight,
        [...selectedIds, ...manipulatedIdsRef.current]) ? <AssetObject key={object.id} object={object} camera={camera}
          interactive={activeTool === 'select'} selected={selectedIds.includes(object.id)}
          onDelete={() => useCanvasStore.getState().deleteObject(object.id)}
          onRelink={(previous, path) => useCanvasStore.getState().relinkLocalObject(object.id, previous, path)}
          startResize={() => useCanvasStore.getState().pushHistory()}
          resize={(width, height) => useCanvasStore.getState().resizeAssetObject(object.id, width, height)} /> : null)}
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none', cursor: cursorStyle }}
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onPointerLeave={hideCursor} />
      <canvas ref={backgroundLayerRef} aria-hidden="true" data-ink-layer="background" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -3 }} />
      <canvas ref={committedLayerRef} aria-hidden="true" data-ink-layer="committed" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1 }} />
      <InkCommentLayer key={shapeScope} container={containerRef} items={objects} selectedIds={selectedIds}
        camera={camera} uiScale={uiScale} viewportWidth={cullWidth} viewportHeight={cullHeight} interactive={activeTool === 'select'}
        readSelection={readCommentSelection} onCreate={useCanvasStore.getState().addComment}
        onUpdate={useCanvasStore.getState().updateComment} onSelect={id => useCanvasStore.getState().setSelectedIds([id])} />
      {selectedShape && <InkShapeEditor key={shapeScope + selectedShape.id} stroke={selectedShape} camera={camera} uiScale={uiScale} container={containerRef}
        original={shapeGesture.recent} onPreview={previewShapeEdit} onFinish={finishShapeEdit}
        onDismiss={() => { shapeGesture.dismiss(); useCanvasStore.getState().clearSelection(); }} />}

      {/* Committed text = always-visible DOM cards (above ink). Interactive in the
          select / insert-text tools; the one being edited is rendered by TextNode. */}
      {objects
        .filter((o): o is TextNodeData => o.type === 'text' && o.id !== editingTextId && inkObjectVisible(o, camera, cullWidth, cullHeight, selectedIds))
        .map((o) => (
          <TextObject key={o.id} node={o} camera={camera} interactive={interactiveText} />
        ))}

      <div ref={ringRef} style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', width: cs / uiScale, height: cs / uiScale,
        borderRadius: '50%', border: `1.5px solid ${ringBorder}`,
        background: ringBg,
        pointerEvents: 'none', zIndex: 9999, transform: 'translate(-50%, -50%)' }} />

      {editingNode && <TextNode node={editingNode} camera={camera} />}

      <Toolbar />
    </div>
  );
};

export default InfiniteInkCanvas;
