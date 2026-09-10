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
 * Writing/erasing is O(1) per frame.  Pen-up stamps the finished stroke into
 * tiles; free-erase stamps destination-out into tiles live.  Structural ops
 * (undo/redo/delete/move/clear) rebuild the tiles from the vector source of
 * truth when the store's renderEpoch bumps.
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { usePdfStore } from './PdfStore';
import { usePdfToolbarStore } from '../InfiniteInkCanvas/useToolbarStore';
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
  hitTestStroke,
  hitTestStrokeBySegment,
  getStrokeBounds,
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
  prepareInkRibbon,
  drawInkRibbonSlice,
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

/** Subset of page items that are ink strokes (the rest are DOM-only objects). */
function strokesOnly(items: PdfItem[]): PdfStroke[] {
  return items.filter((o): o is PdfStroke => o.type === 'stroke');
}

// ---- Whole-stroke-eraser spatial hash -------------------------------------
// Strokes are hashed once per wipe gesture into cells the size of an ink tile.
// The drag hit-scan and the tile re-stamp then only touch strokes in cells near
// the cursor, so erase cost is independent of how many strokes the page holds.

/** Insert a stroke into the wipe hash (into every cell its bounds overlap). */
function addStrokeToGrid(grid: Map<string, PdfStroke[]>, s: PdfStroke, b: Bounds): void {
  const tx0 = Math.floor(b.minX / TILE), tx1 = Math.floor(b.maxX / TILE);
  const ty0 = Math.floor(b.minY / TILE), ty1 = Math.floor(b.maxY / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tx + ':' + ty;
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(s);
    }
  }
}

/** Collect the distinct strokes whose grid cells overlap the given rect. */
function collectGridStrokes(
  grid: Map<string, PdfStroke[]>,
  x1: number, y1: number, x2: number, y2: number,
  out: PdfStroke[],
): void {
  const cx0 = Math.floor(Math.min(x1, x2) / TILE), cx1 = Math.floor(Math.max(x1, x2) / TILE);
  const cy0 = Math.floor(Math.min(y1, y2) / TILE), cy1 = Math.floor(Math.max(y1, y2) / TILE);
  const seen = new Set<string>();
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const arr = grid.get(cx + ':' + cy);
      if (!arr) continue;
      for (const s of arr) {
        if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
      }
    }
  }
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

const TILE = 512; // world units per tile
const SCALE = PDF_BAKE_SCALE;
/** Background canvases always kept hot: every anchored page + the current page. */
const BG_CACHE_MIN = 3;
const BG_CACHE_MAX = 8;

function tileKey(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

function getTile(tiles: Map<string, HTMLCanvasElement>, tx: number, ty: number): HTMLCanvasElement {
  const key = tileKey(tx, ty);
  let c = tiles.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = Math.round(TILE * SCALE);
    c.height = Math.round(TILE * SCALE);
    tiles.set(key, c);
  }
  return c;
}

function tileCtx(tiles: Map<string, HTMLCanvasElement>, tx: number, ty: number): CanvasRenderingContext2D {
  return getTile(tiles, tx, ty).getContext('2d')!;
}

/** Draw a stroke into whichever tiles it intersects. For ribbon pens the ribbon
 *  is prepared once, then each tile stamps only the slice overlapping it — the
 *  pixels are identical (no re-smoothing, no seams) but cost scales with the
 *  tile instead of re-rasterizing the WHOLE stroke per tile. Eraser / pencil
 *  keep the whole-stroke path. */
function stampStroke(tiles: Map<string, HTMLCanvasElement>, stroke: PdfStroke): void {
  const b = getStrokeBounds(stroke);
  const tx0 = Math.floor(b.minX / TILE), tx1 = Math.floor(b.maxX / TILE);
  const ty0 = Math.floor(b.minY / TILE), ty1 = Math.floor(b.maxY / TILE);
  const ribbon = prepareInkRibbon(stroke);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ctx = tileCtx(tiles, tx, ty);
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
      if (ribbon) {
        drawInkRibbonSlice(ctx, ribbon, tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE);
      } else {
        drawAnnotatedStroke(ctx, stroke);
      }
    }
  }
}

/**
 * Whole-stroke eraser live removal: clear the removed stroke(s) out of the
 * shared ink-tile map. Affected tiles are cleared, then only the strokes listed
 * in those tiles' wipe-grid cells are re-stamped (the grid was built once per
 * wipe gesture and cell size == tile size, so cost scales with the strokes near
 * the removed one, never with the total page stroke count). Destination-out
 * eraser carves are re-stamped in order so the z-relationship matches a full
 * rebuild. Empty tiles are dropped.
 */
type InkRibbon = ReturnType<typeof prepareInkRibbon>;

function removeStrokesFromInk(
  tiles: Map<string, HTMLCanvasElement>,
  grid: Map<string, PdfStroke[]>,
  skipIds: Set<string>,
  removed: PdfStroke[],
  cachedBounds?: Map<string, Bounds>,
  ribbons?: Map<string, InkRibbon>,
): void {
  if (removed.length === 0) return;

  const boundsOf = (s: PdfStroke): Bounds => {
    const b = cachedBounds?.get(s.id);
    if (b) return b;
    const nb = getStrokeBounds(s);
    cachedBounds?.set(s.id, nb);
    return nb;
  };

  const cleared = new Set<string>();
  for (const r of removed) {
    const b = boundsOf(r);
    const tx0 = Math.floor(b.minX / TILE), tx1 = Math.floor(b.maxX / TILE);
    const ty0 = Math.floor(b.minY / TILE), ty1 = Math.floor(b.maxY / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = tileKey(tx, ty);
        if (tiles.has(key)) cleared.add(key);
      }
    }
  }
  if (cleared.size === 0) return;

  for (const key of cleared) {
    const c = tiles.get(key);
    const ctx = c && c.getContext('2d');
    if (!c || !ctx) continue;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }

  // Re-stamp, per cleared tile, only the strokes the wipe grid lists for that
  // cell (except the ones erased this gesture). Mirrors stampStroke exactly.
  const stillNeeded = new Set<string>();
  for (const key of cleared) {
    const c = tiles.get(key);
    const ctx = c && c.getContext('2d');
    if (!c || !ctx) continue;
    const list = grid.get(key);
    if (!list) continue;
    const sep = key.indexOf(':');
    const tx = Number(key.slice(0, sep)), ty = Number(key.slice(sep + 1));
    for (const s of list) {
      if (skipIds.has(s.id)) continue;
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
      // Prepare the ribbon geometry once per stroke per gesture; a long stroke
      // can be re-stamped into many cleared tiles across several erase frames.
      let ribbon: InkRibbon;
      if (ribbons) {
        if (!ribbons.has(s.id)) ribbons.set(s.id, prepareInkRibbon(s));
        ribbon = ribbons.get(s.id)!;
      } else {
        ribbon = prepareInkRibbon(s);
      }
      if (ribbon) {
        drawInkRibbonSlice(ctx, ribbon, tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE);
      } else {
        drawAnnotatedStroke(ctx, s);
      }
      stillNeeded.add(key);
    }
  }
  for (const key of cleared) {
    if (!stillNeeded.has(key)) tiles.delete(key);
  }
}

/** Erase a segment (destination-out) across the tiles it touches. */
function eraseSegTiles(tiles: Map<string, HTMLCanvasElement>, x1: number, y1: number, x2: number, y2: number, size: number): void {
  const pad = size / 2 + 2;
  const tx0 = Math.floor((Math.min(x1, x2) - pad) / TILE), tx1 = Math.floor((Math.max(x1, x2) + pad) / TILE);
  const ty0 = Math.floor((Math.min(y1, y2) - pad) / TILE), ty1 = Math.floor((Math.max(y1, y2) + pad) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ctx = tileCtx(tiles, tx, ty);
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
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
      const ctx = tileCtx(tiles, tx, ty);
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
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
): void {
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

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = tiles.get(tileKey(tx, ty));
      if (!c) continue;
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
  const bgCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const inkTilesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const dprRef = useRef(1);
  const rafRef = useRef(0);
  const dirtyRef = useRef(false);

  const currentStrokeRef = useRef<PdfStroke | null>(null);
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
  const selectionRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Drag-move state: absolute snapshots + live delta (no cumulative drift).
  const selectDragRef = useRef<{
    start: { x: number; y: number };
    ids: string[];
    snapshots: Map<string, PdfPoint[]>;
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
    /** Spatial hash (cell == ink tile) so erase cost doesn't scale with the
     *  total stroke count on the page. Built once when the gesture starts. */
    grid: Map<string, PdfStroke[]>;
    /** Prepared ribbon geometry per stroke, cached for the whole gesture. */
    ribbons: Map<string, InkRibbon>;
    /** Dev-only timing for this gesture (null in prod). */
    perf: EraserPerf | null;
  } | null>(null);

  const pageLoadTokenRef = useRef(0);
  const prevPageRef = useRef(0);

  // Insert-tool state: where the user clicked (image mode) + hidden file picker.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertWorldRef = useRef<{ x: number; y: number } | null>(null);

  // React-level subscriptions
  const pdfDoc = usePdfStore((s) => s.pdfDoc);
  const currentPage = usePdfStore((s) => s.currentPage);
  const renderEpoch = usePdfStore((s) => s.renderEpoch);
  const activeTool = usePdfStore((s) => s.activeTool);
  const brushType = usePdfStore((s) => s.brushType);
  const brush = usePdfStore((s) => s.brush);
  const showDotGrid = usePdfStore((s) => s.showDotGrid);
  const camera = usePdfStore((s) => s.camera);
  const currentItems = usePdfStore((s) => s.items[s.currentPage] ?? []);
  const editingTextId = usePdfStore((s) => s.editingTextId);
  const insertMode = usePdfStore((s) => s.insertMode);
  const pendingImageInsert = usePdfStore((s) => s.pendingImageInsert);
  const isDraggingToolbar = usePdfToolbarStore((s) => s.isDragging);
  const theme = useNoteStore((s) => s.settings.theme);
  const uiScale = useNoteStore((s) => s.uiScale);
  const [cursorScreen, setCursorScreen] = useState<{ x: number; y: number } | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);

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
    dirtyRef.current = true;
    scheduleRender();
  }, [uiScale]);

  useEffect(() => {
    resizeCanvas();
    const ro = new ResizeObserver(() => resizeCanvas());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [resizeCanvas]);

  // transform: scale doesn't fire ResizeObserver → re-size on uiScale changes.
  useEffect(() => {
    resizeCanvas();
  }, [uiScale, resizeCanvas]);

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
    const colors = themeCanvasColors(useNoteStore.getState().settings.theme);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, vw, vh);

    // Dot grid (behind everything, screen-space, zoom-consistent)
    if (st.showDotGrid) drawDotGrid(ctx, cam, vw, vh, colors.dotColor);

    if (size) {
      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);

      const bg = bgCanvasRef.current;
      if (bg) ctx.drawImage(bg, 0, 0, size.width, size.height);

      drawVisibleTiles(ctx, inkTilesRef.current, cam, vw, vh, dpr);

      const strokes = strokesOnly(st.items[st.currentPage] ?? []);

      // Live drag-move: selected strokes are excluded from tiles and drawn here
      // at their snapped positions (snapshot + delta), so they track the cursor.
      if (selectDragRef.current) {
        const d = selectDragRef.current;
        const byId = new Map(strokes.map((s) => [s.id, s]));
        const moved: PdfStroke[] = [];
        for (const id of d.ids) {
          const orig = byId.get(id);
          const snap = d.snapshots.get(id);
          if (!orig || !snap) continue;
          moved.push({ ...orig, points: snap.map((p) => ({ ...p, x: p.x + d.dx, y: p.y + d.dy })) });
        }
        for (const m of moved) drawAnnotatedStroke(ctx, m);
        if (st.selectedIds.length > 0) drawSelectionHighlight(ctx, moved, st.selectedIds);
      } else if (st.selectedIds.length > 0) {
        drawSelectionHighlight(ctx, strokes, st.selectedIds);
      }

      if (selectionRectRef.current) drawSelectionRect(ctx, selectionRectRef.current);

      if (isDrawingRef.current && currentStrokeRef.current) {
        drawAnnotatedStroke(ctx, currentStrokeRef.current);
      }

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

    dirtyRef.current = false;
  }, []);

  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (dirtyRef.current) doRender();
    });
  }, [doRender]);

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

  const rebuildInk = useCallback((excludeIds?: Set<string>) => {
    const st = usePdfStore.getState();
    const strokes = strokesOnly(st.items[st.currentPage] ?? []);
    const tiles = new Map<string, HTMLCanvasElement>();
    for (const s of strokes) {
      if (excludeIds?.has(s.id)) continue;
      stampStroke(tiles, s);
    }
    inkTilesRef.current = tiles;
  }, []);

  // Structural changes (undo/redo/delete/move/clear) → rebuild tiles
  useEffect(() => {
    if (!pdfDoc) return;
    rebuildInk();
    dirtyRef.current = true;
    scheduleRender();
  }, [renderEpoch, pdfDoc, rebuildInk, scheduleRender]);

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
    const rect = canvasRef.current?.getBoundingClientRect();
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
    const rect = canvas.getBoundingClientRect();
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
   * hash (`grid`) built once per gesture means every frame only touches strokes
   * near the cursor — cost is independent of the page's total stroke count.
   */
  const applyVisualErase = useCallback((targets: PdfStroke[]) => {
    if (targets.length === 0) return;
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    for (const t of targets) wipe.pendingIds.add(t.id);
    const tRestamp = performance.now();
    removeStrokesFromInk(inkTilesRef.current, wipe.grid, wipe.pendingIds, targets, wipe.bounds, wipe.ribbons);
    addEraserRestamp(wipe.perf, targets.length, performance.now() - tRestamp);
    dirtyRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  /** Erase only the TOPMOST ink stroke under a point (the pointerdown click). */
  const eraseTopmostAt = useCallback((x: number, y: number) => {
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    const st = usePdfStore.getState();
    const ink = strokesOnly(st.items[wipe.page] ?? [])
      .filter((s) => s.compositeOperation !== 'destination-out' && !wipe.pendingIds.has(s.id));
    const half = PDF_ERASER_RADIUS / 2;
    for (let i = ink.length - 1; i >= 0; i--) {
      const s = ink[i];
      const bnd = wipe.bounds.get(s.id);
      if (bnd && !boundsIntersectRect(bnd, x - half, y - half, x + half, y + half)) continue;
      if (hitTestStrokeBySegment(s, x, y, x, y, bnd)) { applyVisualErase([s]); return; }
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
    const half = PDF_ERASER_RADIUS / 2;
    let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    for (const p of all) {
      if (p.x < bx1) bx1 = p.x;
      if (p.y < by1) by1 = p.y;
      if (p.x > bx2) bx2 = p.x;
      if (p.y > by2) by2 = p.y;
    }
    const candidates: PdfStroke[] = [];
    const tScan = performance.now();
    collectGridStrokes(wipe.grid, bx1 - half, by1 - half, bx2 + half, by2 + half, candidates);
    const targets: PdfStroke[] = [];
    for (const s of candidates) {
      if (wipe.pendingIds.has(s.id)) continue;
      if (s.compositeOperation === 'destination-out') continue;
      const bnd = wipe.bounds.get(s.id);
      for (let i = 1; i < all.length; i++) {
        if (hitTestStrokeBySegment(s, all[i - 1].x, all[i - 1].y, all[i].x, all[i].y, bnd)) {
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
    wipe.raf = requestAnimationFrame(flushStrokeWipe);
  }, [flushStrokeWipe]);

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const st = usePdfStore.getState();
    const { sx, sy } = getCanvasPos(e);
    setCursorScreen({ x: sx, y: sy });
    updateRingColor(e.clientX, e.clientY);

    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = false;
      panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: st.camera.x, camY: st.camera.y };
      return;
    }
    if (e.button !== 0) return;
    if (!st.pdfDoc || !st.pageSizes[st.currentPage]) return;

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
      canvas.setPointerCapture(e.pointerId);
      const strokes = strokesOnly(st.items[st.currentPage] ?? []);
      const hit = [...strokes].reverse().find((o) => hitTestStroke(o, world.x, world.y));

      if (hit) {
        // Press on a stroke → select (or keep the group) and begin drag-move.
        const alreadySelected = st.selectedIds.includes(hit.id);
        const ids = alreadySelected ? st.selectedIds : [hit.id];
        if (!alreadySelected) st.setSelectedIds(ids);

        // Snapshot the selected strokes' points (absolute), record history once.
        const snapshots = new Map<string, PdfPoint[]>();
        for (const s of strokes) {
          if (ids.includes(s.id)) snapshots.set(s.id, s.points.map((p) => ({ ...p })));
        }
        st.pushHistory(st.currentPage);
        selectDragRef.current = { start: world, ids, snapshots, dx: 0, dy: 0 };
        // Hide the selected strokes from tiles; they're drawn live during drag.
        rebuildInk(new Set(ids));
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

    // Stroke eraser — click erases the whole topmost stroke; dragging keeps the
    // pointer captured and wipes every ink stroke the cursor disc touches
    // (coalesced to one animation-frame batch).
    if (st.activeTool === 'eraser' && st.eraserMode === 'stroke') {
      canvas.setPointerCapture(e.pointerId);
      strokeEraseRef.current = {
        page: st.currentPage, started: false, raf: 0,
        last: { x: world.x, y: world.y }, pending: [], pendingIds: new Set(),
        bounds: new Map(), grid: new Map(), ribbons: new Map(), perf: createEraserPerf(),
      };
      // Hash every stroke once per gesture; erase cost then stays local to the
      // cells under the cursor no matter how many strokes the page holds.
      {
        const w = strokeEraseRef.current!;
        const cur = st.items[st.currentPage] ?? [];
        for (const o of cur) {
          if (o.type !== 'stroke') continue;
          const s = o as PdfStroke;
          const b = getStrokeBounds(s);
          w.bounds.set(s.id, b);
          addStrokeToGrid(w.grid, s, b);
        }
      }
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
      size: isEraser ? PDF_ERASER_RADIUS : st.brush.size,
      opacity: isEraser ? 1 : st.brush.opacity,
      smoothing: isEraser ? 0 : st.brush.smoothing,
      compositeOperation: isEraser ? 'destination-out' : 'source-over',
      style: isEraser ? undefined : (st.brushType === 'fountain' || st.brushType === 'pencil' ? st.brushType : undefined),
      inkSpeed: isEraser ? undefined : st.brush.inkSpeed,
      pressureOpacity: isEraser ? undefined : st.brush.pressureOpacity,
      edgeFeather: isEraser ? undefined : st.brush.edgeFeather,
      createdAt: Date.now(),
    };
    addRawPoint(stroke, world.x, world.y, getPressure(e), e.timeStamp);
    if (isEraser) {
      eraserStrokeRef.current = stroke;
      // Erase the initial dot immediately for instant feedback.
      eraseDotTiles(inkTilesRef.current, world.x, world.y, PDF_ERASER_RADIUS);
    } else {
      currentStrokeRef.current = stroke;
    }
    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender, rebuildInk, updateRingColor]);

  // ---- Pointer Move -----------------------------------------------------------

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { sx, sy } = getCanvasPos(e);
    const st = usePdfStore.getState();
    setCursorScreen({ x: sx, y: sy });
    updateRingColor(e.clientX, e.clientY);

    if (panAnchorRef.current) {
      st.setCamera({
        x: panAnchorRef.current.camX + e.clientX - panAnchorRef.current.sx,
        y: panAnchorRef.current.camY + e.clientY - panAnchorRef.current.sy,
      });
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
        const rect = canvas.getBoundingClientRect();
        const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
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
      const rect = canvas.getBoundingClientRect();
      const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
      for (const ce of events) {
        const w = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top, st.camera);
        const last = es.points[es.points.length - 1];
        if (last && Math.hypot(w.x - last.x, w.y - last.y) < 0.5) continue;
        addRawPoint(es, w.x, w.y, 1, ce.timeStamp);
        if (es.points.length >= 2) {
          const a = es.points[es.points.length - 2];
          eraseSegTiles(inkTilesRef.current, a.x, a.y, w.x, w.y, PDF_ERASER_RADIUS);
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
  }, [getCanvasPos, scheduleRender, updateRingColor]);

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.releasePointerCapture?.(e.pointerId);

    // End any whole-stroke-eraser wipe session. Flush any samples that arrived
    // since the last animation frame, then commit every visually-erased stroke
    // to the store in ONE history snapshot (removals were only tile-local so
    // far — nothing touched the store mid-drag).
    const wipe = strokeEraseRef.current;
    if (wipe) {
      if (wipe.pending.length > 0) flushStrokeWipe();
      if (wipe.pendingIds.size > 0) {
        const st = usePdfStore.getState();
        if (!wipe.started) { st.beginStrokeErase(wipe.page); wipe.started = true; }
        st.eraseStrokesLive(wipe.page, [...wipe.pendingIds]);
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
      const strokes = strokesOnly(st.items[st.currentPage] ?? []);
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

    // End drag-move: commit final positions (bumps epoch → rebuild tiles).
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      selectDragRef.current = null;
      const st = usePdfStore.getState();
      const entries = d.ids
        .map((id) => {
          const snap = d.snapshots.get(id);
          return snap ? { id, points: snap.map((p) => ({ ...p, x: p.x + d.dx, y: p.y + d.dy })) } : null;
        })
        .filter((x): x is { id: string; points: PdfPoint[] } => x !== null);
      st.commitStrokesPoints(st.currentPage, entries);
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
      if (es.points.length > 0) st.commitStroke(st.currentPage, es);
      isDrawingRef.current = false;
      dirtyRef.current = true;
      scheduleRender();
      return;
    }

    // Pen — stamp the finished stroke into tiles, then commit
    if (currentStrokeRef.current) {
      const stroke = currentStrokeRef.current;
      currentStrokeRef.current = null;
      if (stroke.points.length > 0) {
        const st = usePdfStore.getState();
        stampStroke(inkTilesRef.current, stroke);
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
  const showCursor = (activeTool === 'pen' || activeTool === 'eraser') && cursorScreen && !isDraggingToolbar;
  const laserSize = Math.max(1.5, brush.size * 0.4);
  const cs = (activeTool === 'eraser'
    ? PDF_ERASER_RADIUS
    : brushType === 'laser' ? laserSize : brush.size) * camera.zoom;
  const editingTextNode = currentItems.find((o): o is PdfTextObjectData => o.type === 'text' && o.id === editingTextId);

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)' }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none', cursor: cursorStyle }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
        onPointerLeave={() => setCursorScreen(null)}
        onWheel={handleWheel}
      />

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
        if (o.type === 'text') {
          if (o.id === editingTextId) return null; // editor overlay handles it below
          return <PdfTextObject key={o.id} node={o} page={currentPage} camera={camera} interactive={textInteractive} />;
        }
        if (o.type === 'image') {
          return <PdfImageObject key={o.id} obj={o} page={currentPage} camera={camera} interactive={imageInteractive} />;
        }
        return null;
      })}
      {editingTextNode && (
        <PdfTextNode key={editingTextNode.id} node={editingTextNode} page={currentPage} camera={camera} />
      )}

      {showCursor && cursorScreen && (
        <div
          ref={ringRef}
          style={{
            position: 'absolute', left: cursorScreen.x / uiScale, top: cursorScreen.y / uiScale,
            width: cs / uiScale, height: cs / uiScale,
            borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.7)',
            background: activeTool === 'eraser' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
            pointerEvents: 'none', zIndex: 9999, transform: 'translate(-50%, -50%)',
          }}
        />
      )}
    </div>
  );
};

export default PdfCanvas;
