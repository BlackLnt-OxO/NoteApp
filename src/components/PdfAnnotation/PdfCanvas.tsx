import { inkStrokesOnly, inkObjectVisible } from '../InkViewportObjects';
import { InkRenderBackend, strokeTileKeys, protectInkSegment } from '../InfiniteInkCanvas/InkRenderBackend';
import { InkDisplayLayers } from '../InkDisplayLayers';
import { inkTraceId, recordInkTrace, traceInkStrokes } from '../InkDiagnostics';
import { inkPointerSamples, InkPointerQueue } from '../InkPointerSamples';
import { releaseStreamingInk } from './StreamingInkStroke';
import { useInkShapeGesture } from '../useInkShapeGesture';
import InkShapeEditor from '../InkShapeEditor';
import { beginSelectionCapture, endSelectionCapture, cancelSelectionCapture, inkSelectionCaptureHandlers,
  selectionOperation, combineSelection, hitSelectable, boxSelectableIds, createObjectDragPreview,
  drawObjectDragPreview, clearObjectDragPreview, type SelectionOperation, type SelectionCapture, type ObjectDragPreview } from '../InkSelection';
/**
 * PdfCanvas — the interactive canvas for the PDF annotation view.
 *
 * Rendering model (tiled two-layer raster):
 *   backgroundLayer  = pdf.js page render (read-only offscreen canvas)
 *   inkTiles         = a sparse grid of offscreen canvases (TILE×TILE world
 *                      units each) holding the rasterized strokes. Pen = source-over,
 *                      eraser = destination-out (only touches ink, never the page).
 *                      Tiles are created on demand, so annotations can be written
 *                      ANYWHERE on the canvas — not just over the PDF page.
 *   main canvas      = drawImage(bg) + draw visible ink tiles + live stroke + selection
 *
 * Committed ink scales with visible tiles; live ink updates only new samples.
 * Whole-stroke erasing repairs local pixel regions. Pen-up stamps a stroke into
 * tiles; free-erase stamps destination-out into tiles live.  Structural ops
 * (undo/redo/delete/move/clear) rebuild the tiles from the vector source of
 * truth when the store's renderEpoch bumps.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { usePdfStore } from './PdfStore';
import { getInkStrokeIndex, type InkStrokeIndex } from './InkStrokeIndex';
import { stampCachedStroke, releaseDocumentInkCaches, tileScaleOf } from './InkRasterCache';
import { useBrushCursor } from '../useBrushCursor';
import { useInkInputActivity } from '../inkInputActivity';
import { eraseStrokeRegions, getCommittedStrokeBounds } from './InkTileErase';
import { usePdfToolbarStore } from '../InfiniteInkCanvas/useToolbarStore';
import { indexInkStrokes, materializeTiles, inkTileBytes, inkTileCount, targetBakeScale, abandonBuilds } from '../InfiniteInkCanvas/InkTiles';
import { reportInkFrame, noteCameraMove, noteInkFrame, cameraSettled, cameraMoving, CAMERA_SETTLE_MS } from '../InkFrameStats';

/** How long after the pointer's last move materialization still yields to it. */
const POINTER_ACTIVE_MS = 250;
const EMPTY_ITEMS: PdfItem[] = [];
import { bakeDragPreview, drawDragPreview, type DragPreview } from './InkDragPreview';
import { useNoteStore } from '../../store';
import { themeCanvasColors } from '../../themeColors';
import {
  PDF_BAKE_SCALE,
  PDF_ERASER_RADIUS,
  getPressure,
  addRawPoint,
  drawEraserSegment,
  drawEraserDot,
  drawDotGrid,
  boundsIntersectRect,
  screenToWorld,
  worldToScreen,
  clampZoom,
  zoomAt,
  fitCamera,
  type Bounds,
} from './PdfEngine';
import {
  drawAnnotatedStroke,
} from './PdfBrushRenderers';
import { renderPageToCanvas, getPageSize, cleanupPage } from './PdfLoader';
import {
  createEraserPerf, addEraserScan, addEraserRestamp, logEraserPerf,
  type EraserPerf,
} from './eraserPerf';
import type { PdfItem, PdfPoint, PdfStroke, PdfTextObject as PdfTextObjectData } from './PdfTypes';
import PdfTextNode from './PdfTextNode';
import PdfTextObject from './PdfTextObject';
import PdfImageObject from './PdfImageObject';
import AssetObject from '../FileLibrary/AssetObject';
import { assetDropTarget, makeAssetPlacement, useAssetDrop } from '../FileLibrary/assetDrop';

/** Subset of page items that are ink strokes (the rest are DOM-only objects). */
function strokesOnly(items: PdfItem[]): PdfStroke[] {
  return inkStrokesOnly(items);
}

/** Transient laser-pointer stroke segment (never committed / persisted). */
interface LaserSegment {
  points: PdfPoint[];
  color: string;
  size: number;
  /** Timestamp of stroke start (pen-down). */
  start: number;
  /** Timestamp of pen-up — the fade clock starts HERE, not at pen-down. */
  end?: number;
}
const LASER_LIFETIME = 1800; // ms — how long a laser trail stays visible

/** Draw a laser segment; it stays fully visible while writing (no `end` yet),
 *  then fades linearly from the pen-up time. */
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

// ---- Tiling -------------------------------------------------------------------

/** Release a page's tile pixels as soon as they are replaced or abandoned. A
 *  tile is 1536² at 3× bake (9.4 MiB), and a dense page is dozens of them. */
function disposeTiles(tiles: Map<string, HTMLCanvasElement>): void {
  for (const c of tiles.values()) c.width = 0;
  tiles.clear();
}

const TILE = 512; // world units per tile
const SCALE = PDF_BAKE_SCALE;
/** Background canvases always kept hot: every anchored page + the current page. */
const BG_CACHE_MIN = 3;
const BG_CACHE_MAX = 8;

function tileKey(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

/** Stamp and cache committed pixels, sharing live coverage for version 2 ink. */
function stampStroke(tiles: Map<string, HTMLCanvasElement>, stroke: PdfStroke): void {
  stampCachedStroke(tiles, stroke, TILE, SCALE);
}

/** Shared dirty-region repair for the whole-stroke eraser. */
function removeStrokesFromInk(
  tiles: Map<string, HTMLCanvasElement>,
  grid: Map<string, PdfStroke[]>,
  skipIds: Set<string>,
  removed: PdfStroke[],
  cachedBounds?: Map<string, Bounds>,
): void {
  eraseStrokeRegions(tiles, grid, skipIds, removed, TILE, SCALE, cachedBounds);
}

// The free eraser only ever carves tiles that ALREADY exist: a tile with no
// canvas holds no ink, so there is nothing to carve, and creating one to carve
// nothing just allocates an empty tile everywhere the disc brushed past.

/** Erase a segment (destination-out) across the tiles it touches. */
function eraseSegTiles(tiles: Map<string, HTMLCanvasElement>, x1: number, y1: number, x2: number, y2: number, size: number): void {
  const pad = size / 2 + 2;
  const tx0 = Math.floor((Math.min(x1, x2) - pad) / TILE), tx1 = Math.floor((Math.max(x1, x2) + pad) / TILE);
  const ty0 = Math.floor((Math.min(y1, y2) - pad) / TILE), ty1 = Math.floor((Math.max(y1, y2) + pad) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const tile = tiles.get(tileKey(tx, ty));
      if (!tile) continue;
      const s = tileScaleOf(tile);
      const ctx = tile.getContext('2d')!;
      ctx.setTransform(s, 0, 0, s, -tx * TILE * s, -ty * TILE * s);
      drawEraserSegment(ctx, x1, y1, x2, y2, size);
    }
  }
}

/** Erase a single dot (destination-out) across the tiles it touches. */
function eraseDotTiles(tiles: Map<string, HTMLCanvasElement>, x: number, y: number, size: number): void {
  const pad = size / 2 + 2;
  const tx0 = Math.floor((x - pad) / TILE), tx1 = Math.floor((x + pad) / TILE);
  const ty0 = Math.floor((y - pad) / TILE), ty1 = Math.floor((y + pad) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const tile = tiles.get(tileKey(tx, ty));
      if (!tile) continue;
      const s = tileScaleOf(tile);
      const ctx = tile.getContext('2d')!;
      ctx.setTransform(s, 0, 0, s, -tx * TILE * s, -ty * TILE * s);
      drawEraserDot(ctx, x, y, size);
    }
  }
}

/** Draw all ink tiles that intersect the current viewport (already in world transform). */
function drawVisibleTiles(
  ctx: CanvasRenderingContext2D,
  tiles: Map<string, HTMLCanvasElement>,
  cam: { x: number; y: number; zoom: number },
  vw: number,
  vh: number,
  dpr: number,
): number {
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE), tx1 = Math.floor(br.x / TILE);
  const ty0 = Math.floor(tl.y / TILE), ty1 = Math.floor(br.y / TILE);

  // Snap tiles to integer device pixels so neighbors share an exact edge → no
  // 1px seam (dark/white line) and crisper edges when 3×-supersampled tiles are
  // downscaled. See InkTiles.drawVisibleTiles for the same rationale.
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  let drawn = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = tiles.get(tileKey(tx, ty));
      if (!c) continue;
      drawn++;
      // Snap shared boundaries once (see InkTiles.drawVisibleTiles) so adjacent
      // tiles share an exact edge at any zoom — no 1px seam.
      const tl = worldToScreen(tx * TILE, ty * TILE, cam);
      const br = worldToScreen((tx + 1) * TILE, (ty + 1) * TILE, cam);
      const x0 = Math.round(tl.x * dpr) / dpr;
      const y0 = Math.round(tl.y * dpr) / dpr;
      const x1 = Math.round(br.x * dpr) / dpr;
      const y1 = Math.round(br.y * dpr) / dpr;
      ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
    }
  }

  ctx.restore();
  return drawn;
}

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
    const b = getCommittedStrokeBounds(s);
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
  const backgroundLayerRef = useRef<HTMLCanvasElement>(null);
  const committedLayerRef = useRef<HTMLCanvasElement>(null);
  const displayLayersRef = useRef(new InkDisplayLayers());
  const manipulatedIdsRef = useRef(new Set<string>());
  const backgroundPausedRef = useRef(false);
  const backendRef = useRef<InkRenderBackend | null>(null);
  const backendPageRef = useRef(0);
  const boundsRef = useRef<DOMRect | null>(null);
  const inputQueueRef = useRef(new InkPointerQueue());
  const pointerUpRef = useRef<((event: React.PointerEvent<HTMLCanvasElement>) => void) | null>(null);
  const pointerOwnerRef = useRef<number | null>(null);
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);
  const flushPanCamera = useCallback(() => {
    const camera = pendingPanRef.current; pendingPanRef.current = null;
    if (camera) usePdfStore.getState().setCamera(camera);
  }, []);
  const lastQueuedRef = useRef<{ x: number; y: number } | undefined>();
  const gestureTilesRef = useRef(new Set<string>());
  const containerRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const inkTilesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  /** When the pointer last moved — see the canvas's twin. */
  const lastPointerAtRef = useRef(-Infinity);
  /** What the ink layer currently holds: the page it was synced to, and the
   *  stroke list it was synced from. Written only by rebuildInk, so a structural
   *  change can repair just the difference instead of re-rasterizing the page. */
  const prevPageInkRef = useRef<{ page: number; strokes: PdfStroke[] } | null>(null);
  /** Pending frame of the lazy tile materialization chain (see InkTiles). */
  const materializeRafRef = useRef(0);
  /** Timer that re-runs materialization once the camera stops moving. */
  const lodSettleRef = useRef(0);

  const dprRef = useRef(1);
  const rafRef = useRef(0);
  const dirtyRef = useRef(false);

  const currentStrokeRef = useRef<PdfStroke | null>(null);
  const shapeEditPreviewRef = useRef<PdfStroke | null>(null);
  const shapeEditorIdRef = useRef<string | null>(null);
  const eraserStrokeRef = useRef<PdfStroke | null>(null);
  const isDrawingRef = useRef(false);
  const panAnchorRef = useRef<{ sx: number; sy: number; camX: number; camY: number } | null>(null);
  const spaceDownRef = useRef(false);
  const laserRef = useRef<LaserSegment[]>([]);
  /** Timestamp of the most recent laser pen-down / move / pen-up — all trails
   *  stay lit while writing, then fade together from this instant. */
  const laserActiveRef = useRef(0);
  const laserRafRef = useRef(0);

  const selectAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const selectionCaptureRef = useRef<SelectionCapture | null>(null);
  const selectionOperationRef = useRef<{ operation: SelectionOperation; base: string[] }>({ operation: 'replace', base: [] });
  const selectionRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Drag-move state: absolute snapshots + live delta (no cumulative drift).
  // `strokes` holds the ORIGINAL objects so the live preview can be drawn with a
  // dx/dy offset instead of a rebuilt copy of every point each frame.
  const selectDragRef = useRef<{
    start: { x: number; y: number };
    ids: string[];
    strokes: PdfStroke[];
    /** Raster of the dragged strokes, baked once at drag start — see
     *  InkDragPreview. */
    preview: DragPreview | null;
    objects: ObjectDragPreview;
    dx: number;
    dy: number;
  } | null>(null);

  // Active whole-stroke-eraser wipe session (drag-to-erase), page-scoped so the
  // current page can't change under a pointer capture. Pointer moves are
  // coalesced into ONE animation-frame flush (max one erase + one repaint per
  // frame). `started` becomes true on the first removal so one wipe gesture =
  // ONE history snapshot; `bounds` caches each stroke's bbox for the gesture.
  const strokeEraseRef = useRef<{
    page: number;
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
    grid: Map<string, PdfStroke[]>;
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
    // shared pixel caches immediately; leaving them to the GC made the next
    // document (on EITHER surface) start by evicting all of it.
    disposeTiles(inkTilesRef.current);
    inkTilesRef.current = new Map();
    prevPageInkRef.current = null;
    releaseDocumentInkCaches();
    // StrictMode replays effects on mount; cancelled frame IDs must not prevent
    // the replayed sizing/render effects from scheduling their first frame.
    rafRef.current = 0;
    laserRafRef.current = 0;
    materializeRafRef.current = 0;
    if (strokeEraseRef.current) strokeEraseRef.current.raf = 0;
  }, []);

  const pageLoadTokenRef = useRef(0);
  const prevPageRef = useRef(0);

  // Insert-tool state: where the user clicked (image mode) + hidden file picker.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertWorldRef = useRef<{ x: number; y: number } | null>(null);

  // React-level subscriptions
  const pdfDoc = usePdfStore((s) => s.pdfDoc);
  const currentPage = usePdfStore((s) => s.currentPage);
  const currentItemId = usePdfStore((s) => s.currentItemId);
  const selectedIds = usePdfStore((s) => s.selectedIds);
  const shapeScope = `${currentItemId ?? ''}/${currentPage}`;
  const renderEpoch = usePdfStore((s) => s.renderEpoch);
  const activeTool = usePdfStore((s) => s.activeTool);
  const brushType = usePdfStore((s) => s.brushType);
  const brush = usePdfStore((s) => s.brush);
  const showDotGrid = usePdfStore((s) => s.showDotGrid);
  const camera = usePdfStore((s) => s.camera);
  const currentItems = usePdfStore((s) => s.items[s.currentPage] ?? EMPTY_ITEMS);
  const editingTextId = usePdfStore((s) => s.editingTextId);
  const insertMode = usePdfStore((s) => s.insertMode);
  const pendingImageInsert = usePdfStore((s) => s.pendingImageInsert);
  const isDraggingToolbar = usePdfToolbarStore((s) => s.isDragging);
  const theme = useNoteStore((s) => s.settings.theme);
  const uiScale = useNoteStore((s) => s.uiScale);
  const { ringRef, moveCursor, hideCursor } = useBrushCursor(
    uiScale, (activeTool === 'pen' || activeTool === 'eraser') && !isDraggingToolbar,
  );
  useInkInputActivity(canvasRef);

  // ---- Canvas sizing ----------------------------------------------------------

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    // Layout (untransformed) size — unaffected by the App-root CSS scale, so the
    // canvas fills its container at EVERY uiScale. (getBoundingClientRect returns
    // the scaled visual size; using it made the canvas spill past / mis-map.)
    const lw = container.offsetWidth;
    const lh = container.offsetHeight;
    // Backing store sized for the VISUAL size (layout × scale) × dpr → sharp.
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

  // transform: scale doesn't fire ResizeObserver → re-size on uiScale changes.
  useEffect(() => {
    resizeCanvas();
  }, [uiScale, resizeCanvas]);

  // ---- Render loop ------------------------------------------------------------

  const flushInput = useCallback(() => {
    const stroke = currentStrokeRef.current ?? eraserStrokeRef.current;
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
    // Frame-interval sampling rides on the render loop (see InkFrameStats).
    noteInkFrame();
    const st = usePdfStore.getState();
    const container = containerRef.current;
    if (!container) return;
    const rect = boundsRef.current ?? container.getBoundingClientRect();
    const vw = rect.width, vh = rect.height;
    const dpr = dprRef.current;
    const cam = st.camera;
    const size = st.pageSizes[st.currentPage];

    const colors = themeCanvasColors(useNoteStore.getState().settings.theme);
    const bgLayer = backgroundLayerRef.current, inkLayer = committedLayerRef.current;
    if (bgLayer && inkLayer) {
      displayLayersRef.current.paint({ background: bgLayer, ink: inkLayer, tiles: inkTilesRef.current,
        camera: cam, width: vw, height: vh, dpr, uiScale: useNoteStore.getState().uiScale,
        drawTile: (context, key, tile, x, y, w, h) => { const backend = backendRef.current; if (backend) backend.drawTile(context, key, tile, x, y, w, h); else context.drawImage(tile, x, y, w, h); }, backgroundColor: colors.background,
        dotColor: colors.dotColor, showDotGrid: st.showDotGrid,
        page: size && bgCanvasRef.current ? { canvas: bgCanvasRef.current, width: size.width, height: size.height } : undefined });
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vw, vh);

    if (size) {
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      backendRef.current?.drawPending(ctx);
      if (shapeEditPreviewRef.current) drawAnnotatedStroke(ctx, shapeEditPreviewRef.current);


      const strokes = strokesOnly(st.items[st.currentPage] ?? []);

      // Live drag-move: selected strokes are excluded from tiles and drawn here
      // from their ORIGINAL objects plus the drag delta, so they track the cursor
      // without cloning their points (or missing the renderer's cached coverage)
      // on every frame.
      if (selectDragRef.current) {
        const d = selectDragRef.current;
        drawObjectDragPreview(d.objects, containerRef.current, d.dx, d.dy, cam.zoom, useNoteStore.getState().uiScale);
        // One blit of the raster baked at drag start; the strokes themselves are
        // only drawn when the raster was refused (too large).
        if (d.preview) drawDragPreview(ctx, d.preview, d.dx, d.dy);
        else for (const s of d.strokes) drawAnnotatedStroke(ctx, s, d.dx, d.dy);
        if (st.selectedIds.length > 0) {
          // Outline the cached bounds translated by the delta — rebuilding the
          // strokes just to measure them would re-scan every point per frame.
          ctx.save();
          ctx.strokeStyle = '#6b5ce7';
          ctx.lineWidth = 1.5 / (ctx.getTransform().a || 1);
          ctx.setLineDash([5, 4]);
          for (const s of d.strokes) {
            const b = getCommittedStrokeBounds(s);
            ctx.strokeRect(b.minX + d.dx, b.minY + d.dy, b.maxX - b.minX, b.maxY - b.minY);
          }
          ctx.restore();
        }
      } else if (st.selectedIds.length > 0) {
        drawSelectionHighlight(ctx, strokes, st.selectedIds.filter(id => id !== shapeEditorIdRef.current));
      }

      if (selectionRectRef.current) drawSelectionRect(ctx, selectionRectRef.current);

      if (isDrawingRef.current && currentStrokeRef.current) {
        drawAnnotatedStroke(ctx, currentStrokeRef.current);
      }

      if (eraserStrokeRef.current) drawAnnotatedStroke(ctx, eraserStrokeRef.current);

      // Transient laser-pointer strokes. While writing, all trails stay lit
      // (a new stroke re-lights earlier ones); when idle they fade together from
      // the last pen activity.
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
    }

    reportInkFrame({ liveMs: performance.now() - liveStart, zoom: cam.zoom, dpr, surface: 'pdf', bakeScale: targetBakeScale(inkTilesRef.current) });
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
    scope: shapeScope, enabled: activeTool === 'pen' && brushType !== 'laser',
    getScope: () => { const s = usePdfStore.getState(); return `${s.currentItemId ?? ''}/${s.currentPage}`; },
    zoom: () => usePdfStore.getState().camera.zoom,
    getStroke: () => currentStrokeRef.current,
    setStroke: stroke => { currentStrokeRef.current = stroke; },
    flush: flushInput, repaint: () => { dirtyRef.current = true; scheduleRender(); },
  });
  useEffect(() => {
    const recent = shapeGesture.recent;
    if (activeTool === 'pen' && recent && selectedIds.length === 0
        && currentItems.some(o => o.id === recent.id && o.type === 'stroke' && o.geometry)) usePdfStore.getState().setSelectedIds([recent.id]);
  }, [currentItems, selectedIds, activeTool, shapeGesture.recent]);
  useEffect(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [selectedIds, scheduleRender]);
  const previewShapeEdit = (next: PdfStroke, original: PdfStroke) => {
    const tiles = inkTilesRef.current, index = getInkStrokeIndex(tiles);
    if (!shapeEditPreviewRef.current) {
      const ids = new Set([original.id]);
      removeStrokesFromInk(tiles, index.grid, ids, [original], index.bounds);
      index.remove(ids); backendRef.current?.suppress(ids); displayLayersRef.current.invalidate();
    }
    shapeEditPreviewRef.current = next;
    for (const s of [original, next]) for (const key of strokeTileKeys(s)) gestureTilesRef.current.add(key);
    dirtyRef.current = true; scheduleRender();
  };
  const finishShapeEdit = (next: PdfStroke, original: PdfStroke, recordHistory: boolean) => {
    const st = usePdfStore.getState();
    if (`${st.currentItemId ?? ''}/${st.currentPage}` !== shapeScope || !(st.items[currentPage] ?? []).includes(original)) {
      shapeEditPreviewRef.current = null; gestureTilesRef.current.clear(); return;
    }
    previewShapeEdit(next, original);
    st.replaceStroke(currentPage, next, recordHistory);
    const actual = (usePdfStore.getState().items[currentPage] ?? []).find((o): o is PdfStroke => o.type === 'stroke' && o.id === next.id)!;
    getInkStrokeIndex(inkTilesRef.current).add(actual);
    backendRef.current?.retain(actual, strokesOnly(usePdfStore.getState().items[currentPage] ?? []));
    shapeEditPreviewRef.current = null; gestureTilesRef.current.clear();
    dirtyRef.current = true; scheduleRender();
  };

  // Laser fade loop: advance frames while any segment is still visible, then stop.
  const tickLaser = useCallback(() => {
    laserRafRef.current = 0;
    const now = performance.now();
    // While writing, keep ALL trails lit; once idle, clear the group after fade.
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

  // ---- Rebuild ink tiles from vector source of truth --------------------------

  /** True while a pointer gesture owns the tiles (see the canvas's twin). A
   *  marquee is gated too — nothing needs the tiles mid-drag, and the pending
   *  materialize/re-bake chain would steal frames from it. */
  const inkGestureActive = useCallback(() => (
    shapeEditPreviewRef.current !== null ||
    currentStrokeRef.current !== null || eraserStrokeRef.current !== null
    || strokeEraseRef.current !== null || selectDragRef.current !== null
    || selectAnchorRef.current !== null || isDrawingRef.current
  ), []);

  /** Bring the tiles the camera is looking at up to date; one budgeted pass per
   *  call. Returns how many still need work, so the caller can continue on the
   *  next frame instead of blocking this one. */
  const materializePage = useCallback((): number => {
    if (backgroundPausedRef.current) return 0;
    const container = containerRef.current;
    if (!container) return 0;
    const state = usePdfStore.getState();
    if (!state.pageSizes[state.currentPage]) return 0;
    if (backendPageRef.current !== state.currentPage) { backendRef.current?.dispose(); backendRef.current = null; backendPageRef.current = state.currentPage; }
    const rect = boundsRef.current ?? container.getBoundingClientRect();
    if (!backendRef.current) backendRef.current = new InkRenderBackend({ surface: 'pdf', tiles: () => inkTilesRef.current,
        displayBytes: () => [canvasRef.current, backgroundLayerRef.current, committedLayerRef.current].reduce((bytes, canvas) => bytes + (canvas ? canvas.width * canvas.height * 4 : 0), 0), fixedScale: SCALE,
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
    backendRef.current.sync(strokesOnly(state.items[state.currentPage] ?? []));
    return backendRef.current.requestViewport(state.camera, rect.width, rect.height, dprRef.current, cameraSettled());
  }, [scheduleRender]);

  const scheduleMaterialize = useCallback(() => {
    if (materializeRafRef.current) return;
    const step = () => {
      materializeRafRef.current = 0;
      if (materializePage() > 0) materializeRafRef.current = requestAnimationFrame(step);
      if (dirtyRef.current) scheduleRender();
    };
    materializeRafRef.current = requestAnimationFrame(step);
  }, [materializePage, doRender]);

  /**
   * Re-index the page and rasterize ONLY the tiles the camera is looking at.
   *
   * This used to stamp every stroke into tiles on every structural change, so
   * deleting one annotation on a heavily annotated page re-rasterized the whole
   * page — the same cost the infinite canvas had. Indexing is cheap (bounds and
   * segment blocks, no pixels) and a lazily built tile is byte-identical to an
   * eagerly built one, so the page can be indexed whole and rasterized where it
   * is seen. The PDF keeps a FIXED bake scale: a page is a handful of tiles, and
   * its background is baked at PDF_BAKE_SCALE, so ink at a coarser density would
   * look softer than the page text beside it.
   */
  const rebuildInk = useCallback(() => {
    const st = usePdfStore.getState();
    const page = st.currentPage;
    const strokes = strokesOnly(st.items[page] ?? []);
    const layer = inkTilesRef.current;
    const prev = prevPageInkRef.current;

    // Small change? Repair the EXISTING tiles instead of rebuilding them. The
    // history snapshots share stroke references, so an undo differs from the
    // current page by just the last gesture's strokes — repairing their
    // rectangles leaves every other tile untouched, where a rebuild re-rendered
    // the whole visible page (undo flashed like a page load). The baseline is
    // taken here rather than from a store subscription because this is the ONLY
    // function that syncs the layer; a page change (asynchronous) makes the whole
    // list differ, which is exactly when the rebuild below is the right answer.
    let incremental = false;
    if (prev && prev.page === page) {
      const prevById = new Map<string, PdfStroke>();
      for (const s of prev.strokes) prevById.set(s.id, s);
      const nowById = new Map<string, PdfStroke>();
      for (const s of strokes) nowById.set(s.id, s);
      const added: PdfStroke[] = [], removed: PdfStroke[] = [];
      for (const [id, s] of nowById) {
        const p = prevById.get(id);
        if (!p) added.push(s);
        else if (p !== s) { removed.push(p); added.push(s); } // same id, points replaced
      }
      for (const [id, s] of prevById) if (!nowById.has(id)) removed.push(s);
      if (added.length + removed.length <= 64) {
        incremental = true;
        prevPageInkRef.current = { page, strokes };
        if (added.length + removed.length > 0) {
          const index = getInkStrokeIndex(layer);
          abandonBuilds(layer);
          const removedIds = new Set(removed.map((s) => s.id));
          if (removed.length > 0) removeStrokesFromInk(layer, index.grid, removedIds, removed, index.bounds);
          index.remove(removedIds);
          // See the canvas's twin: only stamp what the layer does not already
          // hold, or a translucent stroke composites twice and darkens.
          for (const s of added) if (!index.has(s.id)) index.add(s);
          backendRef.current?.sync(strokes);
        }
      }
    }

    if (!incremental) {
      const tiles = new Map<string, HTMLCanvasElement>();
      indexInkStrokes(tiles, strokes);
      inkTilesRef.current = tiles;
      if (import.meta.env.DEV) recordInkTrace(tiles, 'layer-rebuild', { surface: 'pdf', layer: inkTraceId(tiles),
        previousLayer: inkTraceId(layer), strokeCount: strokes.length, page });
      // Free the replaced tiles' pixels now rather than leaving a dense page's
      // ~1 GiB of surfaces for the GC while the new ones are allocated.
      disposeTiles(layer);
      prevPageInkRef.current = { page, strokes };
    }
    // A gesture captured the OLD layer's index/grid/bounds; its repairs would now
    // write into disposed canvases, which silently becomes a no-op. Drop it.
    strokeEraseRef.current = null;
    clearObjectDragPreview(selectDragRef.current?.objects);
    selectDragRef.current = null;
    cancelSelectionCapture(selectionCaptureRef, pointerOwnerRef);
    displayLayersRef.current.invalidate();
    scheduleMaterialize();
  }, [scheduleMaterialize]);

  // Structural changes (undo/redo/delete/move/clear) → rebuild tiles
  useEffect(() => {
    if (!pdfDoc) return;
    rebuildInk();
    dirtyRef.current = true;
    scheduleRender();
  }, [renderEpoch, pdfDoc, rebuildInk, scheduleRender]);

  // Camera moved (pan / zoom) → the view may want tiles it has not built yet.
  // Scheduled, never materialized inline: this runs on every wheel tick.
  useEffect(() => {
    noteCameraMove();
    scheduleMaterialize();
    // Come back once the view settles (see the canvas's twin).
    if (lodSettleRef.current) clearTimeout(lodSettleRef.current);
    lodSettleRef.current = window.setTimeout(() => {
      lodSettleRef.current = 0;
      scheduleMaterialize();
    }, CAMERA_SETTLE_MS + 20);
  }, [camera, scheduleMaterialize]);

  // Dot-grid toggle → repaint
  useEffect(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [showDotGrid, scheduleRender]);

  // Theme flip → repaint the workbench bg / dot grid
  useEffect(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [theme, scheduleRender]);

  // ---- Page load (render background + fit camera + rebuild ink) ---------------

  useEffect(() => {
    if (!pdfDoc) return;
    const token = ++pageLoadTokenRef.current;
    const pageNum = currentPage;
    const container = containerRef.current;
    // clientWidth is LAYOUT px; the canvas/user space is VISUAL px (layout × uiScale).
    const vw = container ? container.clientWidth * uiScale : window.innerWidth;
    const vh = container ? container.clientHeight * uiScale : window.innerHeight;

    const finish = (bg: HTMLCanvasElement) => {
      const st = usePdfStore.getState();
      const size = st.pageSizes[pageNum];
      if (!size) return;
      // Resume a saved camera if present, otherwise fit the page to the viewport.
      const cam = st.pendingResumeCamera ?? fitCamera(size.width, size.height, vw, vh);
      if (st.pendingResumeCamera) usePdfStore.setState({ pendingResumeCamera: null });
      usePdfStore.getState().resetCamera(cam);
      // Swap in the ready background atomically — the canvas visible to the
      // render loop is never the one being written, so the view can't flash a
      // half-rendered (or just-cleared) page mid-switch.
      bgCanvasRef.current = bg;
      rebuildInk();
      scheduleMaterialize();
      dirtyRef.current = true;
      scheduleRender();
      // Background is ready — drop the open/rendering overlay.
      usePdfStore.setState({ loading: false, loadingPhase: null });
      if (prevPageRef.current && prevPageRef.current !== pageNum) {
        cleanupPage(pdfDoc, prevPageRef.current);
      }
      prevPageRef.current = pageNum;
    };

    (async () => {
      // Reuse the stored page size when available (loadPdfDocument already
      // measured page 1) to avoid a redundant getPage during first open.
      let size = usePdfStore.getState().pageSizes[pageNum];
      if (!size) {
        size = await getPageSize(pdfDoc, pageNum);
        if (token !== pageLoadTokenRef.current) return;
        usePdfStore.getState().setPageSize(pageNum, size);
      }

      // Show a brief "rendering page N" note while the bg bakes.
      usePdfStore.setState({ loading: true, loadingPhase: `渲染页面 ${pageNum}` });

      // Cache hit (anchor page / recently visited) → instant switch, no wait.
      const cached = bgCacheRef.current.get(pageNum);
      if (cached) {
        finish(cached);
        return;
      }

      // Miss → render into a scratch canvas, then atomically swap it in.
      const scratch = document.createElement('canvas');
      await renderPageToCanvas(pdfDoc, pageNum, scratch, PDF_BAKE_SCALE);
      if (token !== pageLoadTokenRef.current) return;

      // Insert into cache (LRU; anchored pages are never evicted). Capacity
      // grows with the anchor count so every anchor + the current page stays hot.
      const cache = bgCacheRef.current;
      cache.set(pageNum, scratch);
      const anchors = usePdfStore.getState().anchorPages;
      const cacheMax = Math.min(BG_CACHE_MAX, Math.max(BG_CACHE_MIN, anchors.length + 1));
      while (cache.size > cacheMax) {
        let oldest: number | undefined;
        for (const k of cache.keys()) {
          if (!anchors.includes(k)) { oldest = k; break; }
        }
        if (oldest === undefined) break;
        cache.delete(oldest);
      }

      finish(scratch);
    })();
  }, [pdfDoc, currentPage, rebuildInk, scheduleRender]);

  // Drop the background cache when the document closes (in case this component
  // stays mounted across open/close cycles).
  useEffect(() => {
    if (!pdfDoc) bgCacheRef.current.clear();
  }, [pdfDoc]);

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
    const rect = boundsRef.current ?? canvasRef.current?.getBoundingClientRect();
    return rect ? { sx: e.clientX - rect.left, sy: e.clientY - rect.top } : { sx: 0, sy: 0 };
  }, []);

  // Brush ring color follows a simple region rule (no pixel sampling): over the
  // PDF page (light) → dark ring; outside the page (dark UI) → light ring.
  const updateRingColor = useCallback((clientX: number, clientY: number) => {
    const el = ringRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const st = usePdfStore.getState();
    const size = st.pageSizes[st.currentPage];
    const rect = boundsRef.current ?? canvas.getBoundingClientRect();
    const world = screenToWorld(clientX - rect.left, clientY - rect.top, st.camera);
    const insidePage =
      !!size &&
      world.x >= 0 && world.y >= 0 &&
      world.x <= size.width && world.y <= size.height;
    const isEraser = st.activeTool === 'eraser';
    if (insidePage) {
      // On the PDF page (light background) → dark ring
      el.style.borderColor = 'rgba(30,30,40,0.85)';
      el.style.background = isEraser ? 'rgba(30,30,40,0.14)' : 'rgba(30,30,40,0.07)';
    } else {
      // Outside the page — contrast against the themed workbench
      const isLight = useNoteStore.getState().settings.theme === 'light';
      if (isLight) {
        el.style.borderColor = 'rgba(30,30,40,0.85)';
        el.style.background = isEraser ? 'rgba(30,30,40,0.14)' : 'rgba(30,30,40,0.07)';
      } else {
        el.style.borderColor = 'rgba(255,255,255,0.75)';
        el.style.background = isEraser ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
      }
    }
  }, []);

  // ---- Whole-stroke eraser helper -------------------------------------------

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
  const applyVisualErase = useCallback((targets: PdfStroke[]) => {
    if (targets.length === 0) return;
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    for (const t of targets) wipe.pendingIds.add(t.id);
    backendRef.current?.suppress(targets.map(t => t.id));
    displayLayersRef.current.invalidate();
    const tRestamp = performance.now();
    removeStrokesFromInk(inkTilesRef.current, wipe.grid, wipe.pendingIds, targets, wipe.bounds);
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
    const targets: PdfStroke[] = [];
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

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>, preferredId?: string, captureTarget?: Element) => {
    if (pointerOwnerRef.current !== null && pointerOwnerRef.current !== e.pointerId) return;
    pointerOwnerRef.current = e.pointerId; gestureTilesRef.current.clear(); inputQueueRef.current.clear(); lastQueuedRef.current = undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const st = usePdfStore.getState();
    const { sx, sy } = getCanvasPos(e);
    moveCursor(sx, sy);
    updateRingColor(e.clientX, e.clientY);

    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = false;
      panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: st.camera.x, camY: st.camera.y };
      return;
    }
    if (e.button !== 0) return;
    if (!st.pdfDoc || !st.pageSizes[st.currentPage]) return;
    shapeGesture.dismiss();
    if (st.activeTool === 'pen') st.clearSelection();

    const world = screenToWorld(sx, sy, st.camera);

    // Insert tool: text card placed at the click point (opens its editor) /
    // image mode remembers the point and opens the file picker.
    if (st.activeTool === 'insert') {
      if (st.insertMode === 'image') {
        // Commit any open text editor first (its own finishReturn restores the tool).
        const ae = document.activeElement;
        if (ae && ae instanceof HTMLTextAreaElement) ae.blur();
        insertWorldRef.current = world;
        fileInputRef.current?.click();
      } else {
        // If a text editor is already open, this click just FINISHES that box
        // (blur → commit → returns to the pen tool) — never spawn another one.
        const hadEditor = st.editingTextId != null;
        const ae = document.activeElement;
        if (ae && ae instanceof HTMLTextAreaElement) ae.blur();
        if (hadEditor) return;
        st.addTextNode(st.currentPage, world.x, world.y);
      }
      return;
    }

    // Selection tool
    if (st.activeTool === 'select') {
      beginSelectionCapture(selectionCaptureRef, captureTarget ?? canvas, e.pointerId, canvas);
      const operation = selectionOperation(e);
      selectionOperationRef.current = { operation, base: st.selectedIds.slice() };
      const items = st.items[st.currentPage] ?? [], strokes = strokesOnly(items);
      const hit = hitSelectable(items, world.x, world.y, preferredId);

      if (hit) {
        if (operation !== 'replace') {
          st.setSelectedIds(combineSelection(st.selectedIds, [hit.id], operation));
          return;
        }
        // Press on a stroke → select (or keep the group) and begin drag-move.
        const alreadySelected = st.selectedIds.includes(hit.id);
        const ids = alreadySelected ? st.selectedIds : [hit.id];
        if (!alreadySelected) st.setSelectedIds(ids);

        // Keep original ink for the raster preview; commit the mixed group once on drop.
        const idSet = new Set(ids);
        const dragged: PdfStroke[] = [];
        for (const s of strokes) {
          if (idSet.has(s.id)) dragged.push(s);
        }
        selectDragRef.current = {
          start: world, ids, strokes: dragged,
          objects: createObjectDragPreview(items, ids, containerRef.current),
          preview: bakeDragPreview(dragged, SCALE),
          dx: 0, dy: 0,
        };
        // Hide the selected strokes from the tiles — they're drawn live during
        // the drag. Clear ONLY their own pixels: rebuilding the page's tiles here
        // is what made dragging on a dense page stall for seconds.
        const tiles = inkTilesRef.current;
        const index = getInkStrokeIndex(tiles);
        traceInkStrokes('drag-start', tiles, dragged, { surface: 'pdf' });
        removeStrokesFromInk(tiles, index.grid, idSet, dragged, index.bounds);
        index.remove(idSet);
    backendRef.current?.suppress(idSet);
    displayLayersRef.current.invalidate();
        dirtyRef.current = true;
        scheduleRender();
      } else if (st.selectionMode === 'click') {
        if (operation === 'replace') st.clearSelection();
      } else {
        // Box select
        selectAnchorRef.current = { x: world.x, y: world.y };
        selectionRectRef.current = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      }
      return;
    }

    // Stroke eraser — click erases the whole topmost stroke; dragging keeps the
    // pointer captured and wipes every ink stroke the cursor disc touches
    // (coalesced to one animation-frame batch).
    if (st.activeTool === 'eraser' && st.eraserMode === 'stroke') {
      canvas.setPointerCapture(e.pointerId);
      const index = getInkStrokeIndex(inkTilesRef.current);
      strokeEraseRef.current = {
        page: st.currentPage, started: false, raf: 0,
        last: { x: world.x, y: world.y }, pending: [], pendingIds: new Set(),
        bounds: index.bounds, grid: index.grid, index,
        radius: st.brush.eraserSize ?? PDF_ERASER_RADIUS,
        perf: createEraserPerf(),
      };
      eraseTopmostAt(world.x, world.y);
      return;
    }

    // Laser pointer — a transient stroke that never commits to strokes/history/tiles.
    if (st.brushType === 'laser') {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      const seg: LaserSegment = {
        points: [],
        color: st.brush.color,
        size: Math.max(1.5, st.brush.size * 0.4),
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

    // Pen / free eraser — begin a stroke
    canvas.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    const isEraser = st.activeTool === 'eraser';
    const stroke: PdfStroke = {
      id: `pdf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'stroke',
      points: [],
      color: isEraser ? '#000000' : st.brush.color,
      size: isEraser ? (st.brush.eraserSize ?? PDF_ERASER_RADIUS) : st.brush.size,
      opacity: isEraser ? 1 : st.brush.opacity,
      renderVersion: !isEraser ? 2 : undefined,
      smoothing: isEraser ? 0 : st.brush.smoothing,
      compositeOperation: isEraser ? 'destination-out' : 'source-over',
      style: isEraser ? undefined : (st.brushType === 'fountain' || st.brushType === 'pencil' ? st.brushType : undefined),
      inkSpeed: isEraser ? undefined : st.brush.inkSpeed,
      pressureOpacity: isEraser ? undefined : st.brush.pressureOpacity,
      edgeFeather: isEraser ? undefined : st.brush.edgeFeather,
      featherSize: isEraser ? undefined : st.brush.featherSize,
      createdAt: Date.now(),
    };
    addRawPoint(stroke, world.x, world.y, getPressure(e), e.timeStamp);
    if (isEraser) {
      eraserStrokeRef.current = stroke;
      protectInkSegment(gestureTilesRef.current, world.x, world.y, undefined, stroke.size / 2 + 8);
      // Erase the initial dot immediately for instant feedback.
      eraseDotTiles(inkTilesRef.current, world.x, world.y, stroke.size);
      displayLayersRef.current.invalidate();
    } else {
      currentStrokeRef.current = stroke;
      shapeGesture.begin({ x: e.clientX, y: e.clientY }, e.pointerType);
    protectInkSegment(gestureTilesRef.current, world.x, world.y, undefined, stroke.size / 2 + 8);
    }
    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender, rebuildInk, updateRingColor]);

  // ---- Pointer Move -----------------------------------------------------------

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const inputStart = performance.now();
    try {
    if (pointerOwnerRef.current !== null && pointerOwnerRef.current !== e.pointerId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { sx, sy } = getCanvasPos(e);
    const st = usePdfStore.getState();
    lastPointerAtRef.current = performance.now();
    moveCursor(sx, sy);
    updateRingColor(e.clientX, e.clientY);

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
    if (st.activeTool === 'eraser' && st.eraserMode === 'stroke' && strokeEraseRef.current) {
      const w = screenToWorld(sx, sy, st.camera);
      const wipe = strokeEraseRef.current;
      const last = wipe.pending[wipe.pending.length - 1] ?? wipe.last;
      if (last.x !== w.x || last.y !== w.y) {
        wipe.pending.push(w);
        scheduleWipe();
      }
      return;
    }

    if (selectAnchorRef.current) {
      const w = screenToWorld(sx, sy, st.camera);
      selectionRectRef.current = { x1: selectAnchorRef.current.x, y1: selectAnchorRef.current.y, x2: w.x, y2: w.y };
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Drag-move selected strokes: update the live delta (absolute, no drift).
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      const w = screenToWorld(sx, sy, st.camera);
      d.dx = w.x - d.start.x;
      d.dy = w.y - d.start.y;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Laser pointer — append coalesced points to the active laser segment.
    if (isDrawingRef.current && st.brushType === 'laser') {
      const seg = laserRef.current[laserRef.current.length - 1];
      if (seg) {
        const rect = boundsRef.current ?? canvas.getBoundingClientRect();
        const events: PointerEvent[] = inkPointerSamples(e.nativeEvent);
        for (const ce of events) {
          const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, st.camera);
          addRawPoint(seg as any, w.x, w.y, getPressure(ce), ce.timeStamp);
        }
      }
      laserActiveRef.current = performance.now();
      startLaser();
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    if (!isDrawingRef.current) return;

    // Free eraser — erase into tiles incrementally (destination-out)
    if (eraserStrokeRef.current) {
      const es = eraserStrokeRef.current;
      const rect = boundsRef.current ?? canvas.getBoundingClientRect();
      const events: PointerEvent[] = inkPointerSamples(e.nativeEvent);
      for (const ce of events) {
        const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, st.camera);
        protectInkSegment(gestureTilesRef.current, w.x, w.y, lastQueuedRef.current ?? es.points[es.points.length - 1], es.size / 2 + 8);
        lastQueuedRef.current = w;
        inputQueueRef.current.push({ x: w.x, y: w.y, pressure: 1, t: ce.timeStamp });
      }
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Pen — collect coalesced raw points; the live stroke is drawn each frame
    if (currentStrokeRef.current) {
      const rect = boundsRef.current ?? canvas.getBoundingClientRect();
      const stroke = currentStrokeRef.current;
      const events: PointerEvent[] = inkPointerSamples(e.nativeEvent);
      const inputStart = performance.now();
      for (const ce of events) {
        const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, st.camera);
        if (shapeGesture.move({ x: ce.clientX, y: ce.clientY }, w)) continue;
        protectInkSegment(gestureTilesRef.current, w.x, w.y, lastQueuedRef.current ?? stroke.points[stroke.points.length - 1], stroke.size / 2 + 8);
        lastQueuedRef.current = w;
        inputQueueRef.current.push({ x: w.x, y: w.y, pressure: getPressure(ce), t: ce.timeStamp });
      }
      reportInkFrame({ inputMs: performance.now() - inputStart });
      dirtyRef.current = true;
      scheduleRender();
    }
    } finally { reportInkFrame({ inputMs: performance.now() - inputStart }); }
  }, [getCanvasPos, scheduleRender, updateRingColor]);

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerOwnerRef.current === null || pointerOwnerRef.current !== e.pointerId) return;
    shapeGesture.stop();
    const selectionCapture = endSelectionCapture(selectionCaptureRef);
    if (e.type === 'pointerup' && (selectDragRef.current || selectAnchorRef.current)) {
      const { sx, sy } = getCanvasPos(e), cam = usePdfStore.getState().camera;
      const at = screenToWorld(sx, sy, cam);
      if (selectDragRef.current) { selectDragRef.current.dx = at.x - selectDragRef.current.start.x; selectDragRef.current.dy = at.y - selectDragRef.current.start.y; }
      if (selectionRectRef.current) { selectionRectRef.current.x2 = at.x; selectionRectRef.current.y2 = at.y; }
    }
    flushPanCamera();
    flushInput();
    const tailStroke = currentStrokeRef.current ?? eraserStrokeRef.current;
    if (e.type === 'pointerup' && tailStroke?.points.length) {
      const rect = boundsRef.current ?? canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const cam = usePdfStore.getState().camera;
        const point = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, cam);
        const last = tailStroke.points[tailStroke.points.length - 1];
        if (tailStroke.geometry) shapeGesture.move({ x: e.clientX, y: e.clientY }, point);
        else if (point.x !== last.x || point.y !== last.y) {
          inputQueueRef.current.push({ x: point.x, y: point.y, pressure: e.pressure > 0 ? e.pressure : last.pressure, t: e.timeStamp });
          flushInput();
        }
      }
    } pointerOwnerRef.current = null; gestureTilesRef.current.clear();
    setTimeout(() => { materializePage(); scheduleMaterialize(); }, 0);
    const canvas = canvasRef.current;
    try { (selectionCapture ?? canvas)?.releasePointerCapture?.(e.pointerId); } catch { /* already lost */ }

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
        const st = usePdfStore.getState();
        if (!wipe.started) { st.beginStrokeErase(wipe.page); wipe.started = true; }
        st.eraseStrokesLive(wipe.page, [...wipe.pendingIds]);
        wipe.index.remove(wipe.pendingIds);
      }
      logEraserPerf(wipe.perf, 'pdf');
    }
    strokeEraseRef.current = null;

    if (panAnchorRef.current) {
      panAnchorRef.current = null;
      return;
    }

    // Finalize box selection
    if (selectAnchorRef.current && selectionRectRef.current) {
      const r = selectionRectRef.current;
      const st = usePdfStore.getState();
      const ids = boxSelectableIds(st.items[st.currentPage] ?? [], r, containerRef.current, st.camera);
      const { operation, base } = selectionOperationRef.current;
      st.setSelectedIds(combineSelection(base, ids, operation));
      selectAnchorRef.current = null;
      selectionRectRef.current = null;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // End drag-move: commit the final positions, then stamp ONLY the moved
    // strokes back into the tiles (a page-wide rebuild would undo the local
    // erase done at drag start).
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      selectDragRef.current = null;
      clearObjectDragPreview(d.objects);
      const st = usePdfStore.getState();
      if (!d.dx && !d.dy && d.strokes.length) st.commitStrokesPoints(st.currentPage, d.strokes.map(s => ({ id: s.id, points: s.points })));
      else st.commitSelectionMove(st.currentPage, d.ids, d.dx, d.dy);
      const tiles = inkTilesRef.current;
      const movedIds = new Set(d.strokes.map(s => s.id));
      for (const o of usePdfStore.getState().items[st.currentPage] ?? []) {
        if (o.type === 'stroke' && movedIds.has(o.id)) {
          getInkStrokeIndex(tiles).add(o);
          backendRef.current?.retain(o, strokesOnly(usePdfStore.getState().items[usePdfStore.getState().currentPage] ?? []));
        }
      }
      if (import.meta.env.DEV) traceInkStrokes('drag-end', tiles,
        strokesOnly(usePdfStore.getState().items[st.currentPage] ?? []).filter(o => movedIds.has(o.id)),
        { surface: 'pdf', dx: d.dx, dy: d.dy });
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Laser pointer — stop feeding points; group fade starts from this pen-up.
    // Never commitStroke/stampStroke.
    if (isDrawingRef.current && usePdfStore.getState().brushType === 'laser') {
      const seg = laserRef.current[laserRef.current.length - 1];
      if (seg && seg.end === undefined) seg.end = performance.now();
      laserActiveRef.current = performance.now();
      isDrawingRef.current = false;
      dirtyRef.current = true;
      scheduleRender();
      startLaser();
      return;
    }

    if (!isDrawingRef.current) return;

    // Free eraser — commit (already erased into tiles live)
    if (eraserStrokeRef.current) {
      const es = eraserStrokeRef.current;
      eraserStrokeRef.current = null;
      const st = usePdfStore.getState();
      if (es.points.length > 0) {
        getInkStrokeIndex(inkTilesRef.current).add(es);
        st.commitStroke(st.currentPage, es);
        if (!backendRef.current) materializePage();
        backendRef.current?.retain(es, strokesOnly(usePdfStore.getState().items[st.currentPage] ?? EMPTY_ITEMS));
      }
      isDrawingRef.current = false;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Pen — stamp the finished stroke into tiles, then commit
    if (currentStrokeRef.current) {
      const stroke = currentStrokeRef.current;
      shapeGesture.finish(stroke);
      currentStrokeRef.current = null;
      if (stroke.points.length > 0) {
        const st = usePdfStore.getState();
        getInkStrokeIndex(inkTilesRef.current).add(stroke);
        st.commitStroke(st.currentPage, stroke);
        if (stroke.geometry) st.setSelectedIds([stroke.id]);
        if (!backendRef.current) materializePage();
        backendRef.current?.retain(stroke, strokesOnly(usePdfStore.getState().items[st.currentPage] ?? []));
      }
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
  // default action still runs, so ctrl+wheel would zoom the whole app window as
  // well as panning the page.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-lightbox], [data-ink-shape-panel]')) return;
      e.preventDefault();
      flushPanCamera();
      const st = usePdfStore.getState();
      const rect = boundsRef.current ?? container.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      if (e.ctrlKey) {
        st.setCamera({ x: st.camera.x - e.deltaX, y: st.camera.y - e.deltaY });
      } else {
        const newZoom = clampZoom(st.camera.zoom * (1 - e.deltaY * 0.001));
        st.setCamera(zoomAt(st.camera, sx, sy, newZoom));
      }
      // A trailing wheel event must not leave the active pan at its old origin.
      if (panAnchorRef.current) {
        const cam = usePdfStore.getState().camera;
        panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y };
      }
      dirtyRef.current = true;
      scheduleRender();
    };
    // Capture-phase on the container — see the canvas's twin: the DOM cards sit
    // above the canvas and would otherwise swallow a wheel aimed at them.
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => container.removeEventListener('wheel', onWheel, { capture: true });
  }, [scheduleRender, flushPanCamera]);

  // ---- Insert: pick image files, downscale + place page-scaled at the click -----
  const downscaleImage = useCallback(
    (file: File) =>
      new Promise<{ dataUrl: string; width: number; height: number }>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const MAX = 1280;
            let w = img.width;
            let h = img.height;
            if (w > MAX) { h = Math.round((h * MAX) / w); w = MAX; }
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            c.getContext('2d')!.drawImage(img, 0, 0, w, h);
            resolve({ dataUrl: c.toDataURL('image/png'), width: w, height: h });
          };
          img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
      }),
    [],
  );

  const onPickImages = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const page = usePdfStore.getState().currentPage;
    const target = insertWorldRef.current;
    insertWorldRef.current = null;
    const rasters: { dataUrl: string; width: number; height: number }[] = [];
    for (const f of files) rasters.push(await downscaleImage(f));
    if (rasters.length === 0) return;
    const st = usePdfStore.getState();
    const size = st.pageSizes[page];
    const pageW = size ? size.width : 595;
    st.pushHistory(page);
    rasters.forEach((r, i) => {
      const worldW = Math.min(r.width, pageW * 0.7);
      const worldH = (worldW * r.height) / r.width;
      const cx = target ? target.x + i * 48 : pageW / 2;
      const cy = target ? target.y + i * 48 : 0;
      st.addImageObject(page, { dataUrl: r.dataUrl, x: cx - worldW / 2, y: cy - worldH / 2, width: worldW, height: worldH }, false);
    });
    // After a multi-image import return to the pen tool (matches the canvas).
    st.setActiveTool('pen');
  }, [downscaleImage]);

  // External screenshot queued (queueImageInsert) → drop it centered on the viewport.
  useEffect(() => {
    if (!pendingImageInsert) return;
    const page = usePdfStore.getState().currentPage;
    const size = usePdfStore.getState().pageSizes[page];
    const pageW = size ? size.width : 595;
    const worldW = Math.min(pendingImageInsert.width, pageW * 0.7);
    const worldH = (worldW * pendingImageInsert.height) / pendingImageInsert.width;
    const cam = usePdfStore.getState().camera;
    const container = containerRef.current;
    const vw = container ? container.clientWidth * uiScale : 800;
    const vh = container ? container.clientHeight * uiScale : 600;
    const center = screenToWorld(vw / 2, vh / 2, cam);
    usePdfStore.getState().addImageObject(page, {
      dataUrl: pendingImageInsert.dataUrl,
      x: center.x - worldW / 2,
      y: center.y - worldH / 2,
      width: worldW,
      height: worldH,
    });
  }, [pendingImageInsert, uiScale]);

  // ---- Cursor -----------------------------------------------------------------

  // Pen AND the eraser (both free & whole-stroke modes) share the round brush
  // cursor; the ring stays visible while pressing/dragging (never hidden on down).
  const cursorStyle = (activeTool === 'pen' || activeTool === 'eraser')
    ? 'none'
    : activeTool === 'select' ? 'crosshair'
    : activeTool === 'insert' ? (insertMode === 'text' ? 'text' : 'crosshair')
    : 'default';
  const textInteractive = activeTool === 'select' || (activeTool === 'insert' && insertMode === 'text');
  const imageInteractive = activeTool === 'select';
  const laserSize = Math.max(1.5, brush.size * 0.4);
  const cs = (activeTool === 'eraser'
    ? (brush.eraserSize ?? PDF_ERASER_RADIUS)
    : brushType === 'laser' ? laserSize : brush.size) * camera.zoom;
  const editingTextNode = currentItems.find((o): o is PdfTextObjectData => o.type === 'text' && o.id === editingTextId);

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
    ? currentItems.find((o): o is PdfStroke => o.type === 'stroke' && !!o.geometry && o.id === selectedIds[0]) : undefined;
  shapeEditorIdRef.current = selectedShape?.id ?? null;
  useAssetDrop(containerRef, (assetId, x, y) => {
    const state = usePdfStore.getState();
    const { pdfDoc, currentPage } = state;
    if (!pdfDoc) return;
    const world = screenToWorld(x, y, state.camera);
    const size = state.pageSizes[currentPage];
    if (!size || world.x < 0 || world.y < 0 || world.x > size.width || world.y > size.height) return;
    void makeAssetPlacement(assetId, world.x, world.y).then(placement => {
      const current = usePdfStore.getState();
      if (placement && current.pdfDoc === pdfDoc && containerRef.current) current.addAssetObject(currentPage, placement);
    });
  });
  const selectionEvents = inkSelectionCaptureHandlers({ enabled: () => usePdfStore.getState().activeTool === 'select',
    canvas: canvasRef, capture: selectionCaptureRef, owner: pointerOwnerRef, shapeId: shapeEditorIdRef,
    down: handlePointerDown, move: handlePointerMove, up: handlePointerUp });

  return (
    <div ref={containerRef}
      {...assetDropTarget}
      {...selectionEvents}
      onGotPointerCaptureCapture={event => { const id = (event.target as HTMLElement).closest('[data-ink-object-id]')?.getAttribute('data-ink-object-id'); if (id) manipulatedIdsRef.current.add(id); }}
      onLostPointerCaptureCapture={event => { const id = (event.target as HTMLElement).closest('[data-ink-object-id]')?.getAttribute('data-ink-object-id'); if (id) manipulatedIdsRef.current.delete(id); }}
      style={{ isolation: 'isolate', position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)' }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none', cursor: cursorStyle }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onPointerLeave={hideCursor}
      />
      <canvas ref={backgroundLayerRef} aria-hidden="true" data-ink-layer="background" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -2 }} />
      <canvas ref={committedLayerRef} aria-hidden="true" data-ink-layer="committed" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1 }} />
      {selectedShape && <InkShapeEditor key={shapeScope + selectedShape.id} stroke={selectedShape} camera={camera} uiScale={uiScale} container={containerRef}
        original={shapeGesture.recent} onPreview={previewShapeEdit} onFinish={finishShapeEdit}
        onDismiss={() => { shapeGesture.dismiss(); usePdfStore.getState().clearSelection(); }} />}

      {/* Insert tool: hidden image picker (opened on an insert-image click). */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={onPickImages}
      />

      {/* DOM overlays for inserted objects (text cards / images), above the canvas
          but gated to pointer-events none unless the tool makes them interactive. */}
      {currentItems.map((o) => {
        if (o.type !== 'stroke' && !inkObjectVisible(o, camera, boundsRef.current?.width ?? window.innerWidth,
          boundsRef.current?.height ?? window.innerHeight, [...usePdfStore.getState().selectedIds, ...manipulatedIdsRef.current, editingTextId ?? ''])) return null;
        if (o.type === 'text') {
          if (o.id === editingTextId) return null; // editor overlay handles it below
          return <PdfTextObject key={o.id} node={o} page={currentPage} camera={camera} interactive={textInteractive} />;
        }
        if (o.type === 'image') {
          return <PdfImageObject key={o.id} obj={o} page={currentPage} camera={camera} interactive={imageInteractive} />;
        }
        if (o.type === 'asset') {
          return <AssetObject key={o.id} object={o} camera={camera} interactive={imageInteractive}
            selected={selectedIds.includes(o.id)} startResize={() => usePdfStore.getState().pushHistory(currentPage)}
            onDelete={() => usePdfStore.getState().deleteObject(currentPage, o.id)}
            resize={(width, height) => usePdfStore.getState().resizeAssetObject(currentPage, o.id, width, height)} />;
        }
        return null;
      })}
      {editingTextNode && (
        <PdfTextNode key={editingTextNode.id} node={editingTextNode} page={currentPage} camera={camera} />
      )}

      <div
        ref={ringRef}
        style={{
          position: 'absolute', left: 0, top: 0, visibility: 'hidden',
          width: cs / uiScale, height: cs / uiScale,
          borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.7)',
          background: activeTool === 'eraser' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
          pointerEvents: 'none', zIndex: 9999, transform: 'translate(-50%, -50%)',
        }}
      />
    </div>
  );
};

export default PdfCanvas;
