import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { drawSelectionHighlight, drawSelectionRect } from './CanvasRenderer';
import {
  drawDotGrid, getPressure, addRawPoint,
  hitTestStroke, hitTestStrokeBySegment, getStrokeBounds, boundsIntersectRect,
  type Bounds,
} from '../PdfAnnotation/PdfEngine';
import { drawAnnotatedStroke } from '../PdfAnnotation/PdfBrushRenderers';
import { screenToWorld, clampZoom, zoomAt, ERASER_RADIUS } from './constants';
import {
  stampStroke, eraseSegTiles, eraseDotTiles, drawVisibleTiles, rebuildTiles, removeStrokesFromTiles,
} from './InkTiles';
import TextNode from './TextNode';
import ImageObject from './ImageObject';
import TextObject from './TextObject';
import Toolbar from './Toolbar';
import ToolbarShell from './ToolbarShell';
import { useCanvasToolbarStore } from './useToolbarStore';
import { useNoteStore } from '../../store';
import { themeCanvasColors } from '../../themeColors';
import type { Stroke, StrokePoint, TextNodeData, ImageObject as ImageObjectType } from './types';

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
  const containerRef = useRef<HTMLDivElement>(null);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const isDrawingRef = useRef(false);
  const panAnchorRef = useRef<{ sx: number; sy: number; camX: number; camY: number } | null>(null);
  const selectAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const selectionRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const selectDragRef = useRef<{ start: { x: number; y: number }; ids: string[]; snapshots: Map<string, StrokePoint[]>; dx: number; dy: number } | null>(null);
  const inkTilesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertWorldRef = useRef<{ x: number; y: number } | null>(null);
  const [cursorScreen, setCursorScreen] = useState<{ x: number; y: number } | null>(null);
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
   *  `bounds` caches each stroke's bbox for the duration of the gesture (strokes
   *  only change by removal here), keeping the per-frame hit scan O(1) per stroke. */
  const strokeEraseRef = useRef<{
    started: boolean;
    raf: number;
    last: { x: number; y: number };
    pending: { x: number; y: number }[];
    /** Ink strokes erased VISUALLY during the drag but not yet removed from the
     *  store — the store commit happens once on pointer-up (no per-frame React
     *  churn, mirroring how pen/select-drag avoid mid-gesture store writes). */
    pendingIds: Set<string>;
    bounds: Map<string, Bounds>;
  } | null>(null);

  const objects = useCanvasStore((s) => s.objects);
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
    dirtyRef.current = true;
    scheduleRender();
  }, [uiScale]);

  useEffect(() => {
    resizeCanvas();
    const ro = new ResizeObserver(() => resizeCanvas());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [resizeCanvas]);

  // `transform: scale` changes the canvas's VISUAL size without changing its
  // layout box, so ResizeObserver won't fire — on a zoom change we must re-size
  // the backing store manually or ink is drawn/hit at the wrong spot.
  useEffect(() => {
    resizeCanvas();
  }, [uiScale, resizeCanvas]);

  useEffect(() => { useCanvasStore.getState().loadCanvasData(); }, []);

  // Flush the current canvas when the editor unmounts (leaving the view).
  useEffect(() => {
    return () => {
      const st = useCanvasStore.getState();
      if (st.loaded && st.currentCanvasId) st.saveCanvasData();
    };
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
    const vw = rect.width, vh = rect.height;
    const dpr = dprRef.current;
    const colors = themeCanvasColors(useNoteStore.getState().settings.theme);
    const cam = state.camera;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, vw, vh);

    if (state.showDotGrid) drawDotGrid(ctx, cam, vw, vh, colors.dotColor);

    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);

    // Rasterized ink tiles (O(1) per frame).
    drawVisibleTiles(ctx, inkTilesRef.current, cam, vw, vh, dpr);

    // Text nodes are now always-interactive DOM cards rendered ABOVE the canvas
    // (TextObject) — they are intentionally NOT drawn into the vector canvas.

    // Live drag-move of selected strokes (snapshot + delta).
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      const byId = new Map(state.objects.map((o) => [o.id, o]));
      for (const [id, snap] of d.snapshots) {
        const orig = byId.get(id);
        if (!orig || orig.type !== 'stroke') continue;
        drawAnnotatedStroke(ctx, { ...orig, points: snap.map((p) => ({ ...p, x: p.x + d.dx, y: p.y + d.dy })) });
      }
    } else if (state.selectedIds.length > 0) {
      drawSelectionHighlight(ctx, state.objects, state.selectedIds);
    }
    if (selectionRectRef.current) drawSelectionRect(ctx, selectionRectRef.current);

    // Live stroke (pen only — free eraser already writes tiles incrementally).
    if (currentStrokeRef.current
        && currentStrokeRef.current.compositeOperation !== 'destination-out'
        && currentStrokeRef.current.points.length > 0) {
      drawAnnotatedStroke(ctx, currentStrokeRef.current);
    }

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
    dirtyRef.current = false;
  }, []);

  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (dirtyRef.current) doRender();
    });
  }, [doRender]);

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
   * Erasing commits: one history snapshot per gesture (undo restores everything
   * a single drag removed), a cheap vector-list removal (NO renderEpoch bump, so
   * no page-wide rebuild), then a LOCAL clearing of just those strokes out of the
   * shared ink tiles. Pointerwork is coalesced to one flush per animation frame.
   */
  const commitStrokeErase = useCallback((targets: Stroke[]) => {
    if (targets.length === 0) return;
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    const st = useCanvasStore.getState();
    if (!wipe.started) {
      st.beginEraseGesture();
      wipe.started = true;
    }
    st.eraseStrokesLive(targets.map((s) => s.id));
    const remaining = useCanvasStore.getState().objects.filter(
      (o): o is Stroke => o.type === 'stroke',
    );
    removeStrokesFromTiles(inkTilesRef.current, remaining, targets, wipe.bounds);
    dirtyRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  /**
   * Erase strokes VISUALLY during a drag WITHOUT touching the store (no React
   * re-render / no per-frame store write — mirroring pen & select-drag). The
   * strokes are cleared out of the ink tiles immediately and queued in
   * `pendingIds`; the whole drag commits to the store once on pointer-up.
   */
  const applyVisualErase = useCallback((targets: Stroke[]) => {
    if (targets.length === 0) return;
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    for (const t of targets) wipe.pendingIds.add(t.id);
    const st = useCanvasStore.getState();
    // Strokes that are still VISIBLE: store strokes minus every erased-this-drag
    // stroke (they are already gone from the tiles in prior frames).
    const remaining = st.objects.filter(
      (o): o is Stroke => o.type === 'stroke' && !wipe.pendingIds.has(o.id),
    );
    removeStrokesFromTiles(inkTilesRef.current, remaining, targets, wipe.bounds);
    dirtyRef.current = true;
    scheduleRender();
  }, [scheduleRender]);

  /** Erase only the TOPMOST ink stroke under a point (the pointerdown click). */
  const eraseTopmostAt = useCallback((x: number, y: number) => {
    const wipe = strokeEraseRef.current;
    if (!wipe) return;
    const st = useCanvasStore.getState();
    const ink = st.objects.filter(
      (o): o is Stroke => o.type === 'stroke' && o.compositeOperation !== 'destination-out',
    );
    const half = ERASER_RADIUS / 2;
    for (let i = ink.length - 1; i >= 0; i--) {
      const s = ink[i];
      let bnd = wipe.bounds.get(s.id);
      if (!bnd) { bnd = getStrokeBounds(s); wipe.bounds.set(s.id, bnd); }
      if (!boundsIntersectRect(bnd, x - half, y - half, x + half, y + half)) continue;
      if (hitTestStrokeBySegment(s, x, y, x, y)) { commitStrokeErase([s]); return; }
    }
  }, [commitStrokeErase]);

  /**
   * Run the drag-wipe accumulated since the last frame: hit-test the travelled
   * segments against every ink stroke (bbox-cached, so O(1) per stroke) and erase
   * every crossed stroke VISUALLY (local tiles only — the store commit happens
   * once on pointer-up). Destination-out eraser carves are never hit.
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
    const st = useCanvasStore.getState();
    const ink = st.objects.filter(
      (o): o is Stroke =>
        o.type === 'stroke' && o.compositeOperation !== 'destination-out' && !wipe.pendingIds.has(o.id),
    );
    const targets: Stroke[] = [];
    const seen = new Set<string>();
    const half = ERASER_RADIUS / 2;
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1], b = all[i];
      const sx1 = Math.min(a.x, b.x) - half, sy1 = Math.min(a.y, b.y) - half;
      const sx2 = Math.max(a.x, b.x) + half, sy2 = Math.max(a.y, b.y) + half;
      for (const s of ink) {
        if (seen.has(s.id)) continue;
        let bnd = wipe.bounds.get(s.id);
        if (!bnd) { bnd = getStrokeBounds(s); wipe.bounds.set(s.id, bnd); }
        if (!boundsIntersectRect(bnd, sx1, sy1, sx2, sy2)) continue;
        if (hitTestStrokeBySegment(s, a.x, a.y, b.x, b.y)) { targets.push(s); seen.add(s.id); }
      }
    }
    applyVisualErase(targets);
  }, [applyVisualErase]);

  /** Schedule one wipe flush for the next animation frame (coalescing). */
  const scheduleWipe = useCallback(() => {
    const wipe = strokeEraseRef.current;
    if (!wipe || wipe.raf) return;
    wipe.raf = requestAnimationFrame(flushStrokeWipe);
  }, [flushStrokeWipe]);

  useEffect(() => {
    dirtyRef.current = true;
    scheduleRender();
  }, [objects, camera, activeTool, brushSettings, showDotGrid, editingTextId, selectedIds, selectionMode, scheduleRender]);

  // Structural ops (undo/redo/delete/move/clear/load) → rebuild ink tiles from
  // the vector source of truth.
  useEffect(() => {
    const state = useCanvasStore.getState();
    const strokes = state.objects.filter((o): o is Stroke => o.type === 'stroke');
    inkTilesRef.current = rebuildTiles(strokes);
    dirtyRef.current = true;
    scheduleRender();
  }, [renderEpoch, scheduleRender]);

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
    selectDragRef.current = { start: world, ids, snapshots, dx: 0, dy: 0 };
    // Remove the selected strokes from the tiles — they're drawn live during drag.
    const strokes = state.objects.filter((o): o is Stroke => o.type === 'stroke');
    inkTilesRef.current = rebuildTiles(strokes, new Set(ids));
    dirtyRef.current = true;
    scheduleRender();
  };

  // ---- Pointer Down -----------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const state = useCanvasStore.getState();
    const { sx, sy } = getCanvasPos(e);
    setCursorScreen({ x: sx, y: sy });

    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      canvas.setPointerCapture(e.pointerId);
      isDrawingRef.current = false;
      panAnchorRef.current = { sx: e.clientX, sy: e.clientY, camX: state.camera.x, camY: state.camera.y };
      return;
    }
    if (e.button !== 0) return;

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

    // Stroke eraser — click erases the whole topmost stroke; dragging keeps the
    // pointer captured and wipes every ink stroke the cursor disc touches
    // (coalesced to one animation-frame batch).
    if (state.activeTool === 'eraser' && state.eraserMode === 'stroke') {
      canvas.setPointerCapture(e.pointerId);
      strokeEraseRef.current = {
        started: false, raf: 0, last: { x: world.x, y: world.y },
        pending: [], pendingIds: new Set(), bounds: new Map(),
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
      size: isEraser ? ERASER_RADIUS : state.brushSettings.size,
      opacity: isEraser ? 1 : state.brushSettings.opacity,
      smoothing: isEraser ? 0 : state.brushSettings.smoothing,
      compositeOperation: isEraser ? 'destination-out' : 'source-over',
      style: isEraser ? undefined : (state.brush === 'fountain' || state.brush === 'pencil' ? state.brush : undefined),
      inkSpeed: isEraser ? undefined : state.brushSettings.inkSpeed,
      pressureOpacity: isEraser ? undefined : state.brushSettings.pressureOpacity,
      edgeFeather: isEraser ? undefined : state.brushSettings.edgeFeather,
      createdAt: Date.now(),
    };
    addRawPoint(stroke, world.x, world.y, getPressure(e), e.timeStamp);
    currentStrokeRef.current = stroke;
    if (isEraser) {
      // Free eraser: erase the initial dot immediately (destination-out into tiles).
      eraseDotTiles(inkTilesRef.current, world.x, world.y, ERASER_RADIUS);
    }

    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Move -----------------------------------------------------------

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { sx, sy } = getCanvasPos(e);
    const state = useCanvasStore.getState();
    setCursorScreen({ x: sx, y: sy });

    if (panAnchorRef.current) {
      state.setCamera({
        x: panAnchorRef.current.camX + e.clientX - panAnchorRef.current.sx,
        y: panAnchorRef.current.camY + e.clientY - panAnchorRef.current.sy,
      });
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
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
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

    const events: PointerEvent[] = (e.nativeEvent as any).getCoalescedEvents?.() || [e.nativeEvent];
    const stroke = currentStrokeRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const isEraser = stroke.compositeOperation === 'destination-out';
    for (const ce of events) {
      const wx = ce.clientX - rect.left;
      const wy = ce.clientY - rect.top;
      const w = screenToWorld(wx, wy, state.camera);
      addRawPoint(stroke, w.x, w.y, getPressure(ce), ce.timeStamp);
      if (isEraser && stroke.points.length >= 2) {
        const a = stroke.points[stroke.points.length - 2];
        eraseSegTiles(inkTilesRef.current, a.x, a.y, w.x, w.y, ERASER_RADIUS);
      }
    }

    dirtyRef.current = true;
    scheduleRender();
  }, [getCanvasPos, scheduleRender]);

  // ---- Pointer Up -------------------------------------------------------------

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The pointer may not actually be captured (e.g. a one-shot click that never
    // called setPointerCapture), or capture may already have been lost. Releasing
    // unconditionally throws here, which used to abort the cleanup below and leave
    // isDrawing/pan/select state stuck — the cause of unclickable toolbar/sidebar.
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }

    // End any whole-stroke-eraser wipe session. Flush any samples that arrived
    // since the last animation frame, then commit every visually-erased stroke
    // to the store in ONE history snapshot (removals were only tile-local so
    // far — nothing touched the store mid-drag).
    const wipe = strokeEraseRef.current;
    if (wipe) {
      if (wipe.pending.length > 0) flushStrokeWipe();
      if (wipe.pendingIds.size > 0) {
        const st = useCanvasStore.getState();
        if (!wipe.started) { st.beginEraseGesture(); wipe.started = true; }
        st.eraseStrokesLive([...wipe.pendingIds]);
      }
    }
    strokeEraseRef.current = null;

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

    // End select-drag: commit final positions (bumps epoch → rebuild tiles).
    if (selectDragRef.current) {
      const d = selectDragRef.current;
      selectDragRef.current = null;
      const entries = [...d.snapshots.entries()]
        .map(([id, snap]) => ({ id, points: snap.map((p) => ({ ...p, x: p.x + d.dx, y: p.y + d.dy })) }));
      useCanvasStore.getState().commitStrokesPoints(entries);
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
      if (stroke.points.length > 0) {
        useCanvasStore.getState().addStroke(stroke);
        if (stroke.compositeOperation !== 'destination-out') {
          // Pen: stamp into tiles. Free eraser already erased incrementally.
          stampStroke(inkTilesRef.current, stroke);
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

  const showCursor = (activeTool === 'pen' || activeTool === 'eraser') && cursorScreen && !isDraggingToolbar;
  // Circle diameter in screen px = world width × zoom, so it matches the drawn line.
  const laserSize = Math.max(1.5, brushSettings.size * 0.4);
  const cs = (activeTool === 'eraser'
    ? ERASER_RADIUS
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

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)', borderRadius: '0 0 12px 0' }}>
      <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickImage} />
      {/* Image objects render BEFORE the canvas → they sit below the ink layer. */}
      {objects.filter((o): o is ImageObjectType => o.type === 'image').map((o) => (
        <ImageObject key={o.id} obj={o} camera={camera} />
      ))}
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none', cursor: cursorStyle }}
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => setCursorScreen(null)}
        onWheel={handleWheel} />

      {/* Committed text = always-visible DOM cards (above ink). Interactive in the
          select / insert-text tools; the one being edited is rendered by TextNode. */}
      {objects
        .filter((o): o is TextNodeData => o.type === 'text' && o.id !== editingTextId)
        .map((o) => (
          <TextObject key={o.id} node={o} camera={camera} interactive={interactiveText} />
        ))}

      {showCursor && cursorScreen && (
        <div style={{ position: 'absolute', left: cursorScreen.x / uiScale, top: cursorScreen.y / uiScale, width: cs / uiScale, height: cs / uiScale,
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

      <ToolbarShell useStore={useCanvasToolbarStore}><Toolbar /></ToolbarShell>
    </div>
  );
};

export default InfiniteInkCanvas;
