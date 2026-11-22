import { createInkCanvas } from '../InkCanvasSurface';
/**
 * InkTiles — sparse rasterized ink layer for the infinite canvas, ported from
 * PdfCanvas's tiled two-layer model.
 *
 * Strokes are stamped into a sparse grid of offscreen canvases (TILE×TILE world
 * units each, baked at SCALE×). Pen = source-over, free-eraser =
 * destination-out (only ever touches ink). The main canvas draws only the
 * visible tiles per frame. Committed ink scales with visible tiles; live pen
 * rendering updates new samples, and erasing replays cached local ink.
 *
 * Text nodes are NOT rasterized here — they keep their vector/DOM path.
 */

import type { Camera, Stroke } from './types';
import {
  stampCachedStroke, getStrokeRaster, drawStrokeRaster,
  registerTileScale, tileScaleOf, LEGACY_BAKE_SCALE,
  requestStrokeRaster, pumpStrokeRasterBuilds, pendingRasterBuilds,
} from '../PdfAnnotation/InkRasterCache';
import { eraseStrokeRegions } from '../PdfAnnotation/InkTileErase';
import { getInkStrokeIndex, type InkStrokeIndex } from '../PdfAnnotation/InkStrokeIndex';
import { screenToWorld, worldToScreen } from './constants';
import {
  drawEraserSegment,
  drawEraserDot,
  type Bounds,
} from '../PdfAnnotation/PdfEngine';

const TILE = 512; // world units per tile

// ---- Bake scale: how many tile pixels per world unit --------------------------
//
// Ink used to be baked at a fixed 3× supersample regardless of how it was shown.
// On a 3.5k-stroke canvas at zoom 0.43 that meant ~54 visible tiles of 1536²
// (486 MiB of surfaces) drawn into ~273 device px each — a 5.6× downscale per
// tile per frame, 127 M source pixels a frame, which an integrated GPU cannot
// stream at 60 fps. Baking at the density the ink is DISPLAYED at costs a
// fraction of the memory and makes each frame a ≤2× resample.
//
// The same idea as tldraw's level-of-detail (`steppedScreenScale`) plus its
// debounced zoom: pick a coarse step while the camera moves, re-bake when it
// settles. Looked at another way it is Excalidraw's static/interactive split —
// the costly layer is only rebuilt when it actually has to be.

/** Steps ink may be baked at, in tile pixels per world unit. Powers of two
 *  (plus the legacy 3) so the world↔pixel maths stays exact. */
export const BAKE_STEPS = [0.25, 0.5, 1, 2, LEGACY_BAKE_SCALE] as const;
/** Above this, ink is upsampled when shown. It is deliberately the live layer's
 *  own bake scale (`StreamingInkStroke`), so a stroke looks the same the moment
 *  it is committed as it did while being written — no sharpness seam between
 *  "just written" and "already written" ink. */
const MAX_BAKE_SCALE = LEGACY_BAKE_SCALE;
/** Upgrade as soon as the display outgrows the bake (sharpness matters); only
 *  downgrade well below it (memory matters less than re-baking often). Together
 *  these stop a zoom hovering on a step boundary from re-baking in a loop. */
const BAKE_UP_RATIO = 1.15;
const BAKE_DOWN_RATIO = 2.4;

/** The coarsest bake step that is still at least as dense as the display, so
 *  showing a tile is always a downscale (by at most 2×) rather than an upscale. */
export function bakeStepAtLeast(deviceScale: number): number {
  for (const s of BAKE_STEPS) if (s >= deviceScale) return s;
  return MAX_BAKE_SCALE;
}

/** The bake step to move to from `current` for a display density of
 *  `deviceScale` (= camera.zoom × devicePixelRatio), with hysteresis. */
export function bakeStepFor(deviceScale: number, current: number): number {
  const ideal = bakeStepAtLeast(deviceScale);
  if (ideal > current) return deviceScale > current * BAKE_UP_RATIO ? ideal : current;
  if (ideal < current) return deviceScale < current / BAKE_DOWN_RATIO ? ideal : current;
  return current;
}

/** Target bake scale per tile LAYER (the map identity), used for tiles created
 *  from now on. Deliberately not on the tiles: a tile's own scale is recorded on
 *  the tile (see registerTileScale), because they coexist at different scales. */
const layerBakeScale = new WeakMap<Map<string, HTMLCanvasElement>, number>();

/** The bake scale new tiles for this layer should use. */
export function targetBakeScale(tiles: Map<string, HTMLCanvasElement>): number {
  return layerBakeScale.get(tiles) ?? MAX_BAKE_SCALE;
}

/** Follow the camera's display density. Cheap (no rasterization) so it can run
 *  on every camera change, which keeps a pen-up stamp at the right density
 *  instead of building a full-density tile that must then be re-baked. */
export function setTargetBakeScale(
  tiles: Map<string, HTMLCanvasElement>,
  deviceScale: number,
): number {
  // A layer's FIRST contact jumps straight to the display's step. The hysteresis
  // bands are relative to the current step, and an unset layer reads as MAX — so
  // hysteresis alone would pin a fresh document at deviceScale 1.25–3.45 to 3×
  // forever: tiles 2.25× the pixels (and GPU upload) per completed tile than the
  // display asks for, in exactly the zoom range the user actually works in.
  if (!layerBakeScale.has(tiles)) {
    const ideal = bakeStepAtLeast(deviceScale);
    layerBakeScale.set(tiles, ideal);
    return ideal;
  }
  const next = bakeStepFor(deviceScale, targetBakeScale(tiles));
  layerBakeScale.set(tiles, next);
  return next;
}


function tileKey(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

/** Stamp and cache committed pixels, sharing live coverage for version 2 ink. */
export function stampStroke(tiles: Map<string, HTMLCanvasElement>, stroke: Stroke): void {
  stampCachedStroke(tiles, stroke, TILE, targetBakeScale(tiles));
}

// The free eraser only ever carves tiles that ALREADY exist: a tile with no
// canvas holds no ink, so there is nothing to carve, and creating one to carve
// nothing would (a) allocate an empty tile everywhere the disc brushed past and
// (b) — with lazily built tiles — mark a region as built that never was, hiding
// its ink for the rest of the session.

/** Erase a segment (destination-out) across the tiles it touches. */
export function eraseSegTiles(
  tiles: Map<string, HTMLCanvasElement>,
  x1: number, y1: number, x2: number, y2: number, size: number,
): void {
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
export function eraseDotTiles(
  tiles: Map<string, HTMLCanvasElement>,
  x: number, y: number, size: number,
): void {
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

/** Draw viewport ink, optionally restricted to dirty keys (camera already
 *  applied). Returns how many it drew, for the perf readout. */
export function drawVisibleTiles(
  ctx: CanvasRenderingContext2D,
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
  dpr: number,
  drawTile?: (ctx: CanvasRenderingContext2D, key: string, canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number) => void,
  keys?: ReadonlySet<string>,
): number {
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE), tx1 = Math.floor(br.x / TILE);
  const ty0 = Math.floor(tl.y / TILE), ty1 = Math.floor(br.y / TILE);

  // The caller's ctx is already under the world transform (camera translate +
  // zoom). Drawing tiles in WORLD coords makes each tile's target rectangle land
  // on fractional device pixels, so adjacent tiles leave a 1px seam (dark line in
  // dark theme, white in light). Instead, reset to the device-pixel (dpr) base
  // and draw each tile in SCREEN coords, snapped to integer device pixels so
  // neighbors share an exact edge. The SNAPPING is what prevents seams — not the
  // filter quality below.
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  // A tile is baked at the display's own density (see bakeStepAtLeast), so this
  // is at most a 2× downscale — where a high-quality filter is indistinguishable
  // from the cheap one but several times the texture bandwidth on an integrated
  // GPU, paid once per visible tile per frame.
  ctx.imageSmoothingQuality = 'low';

  let drawn = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(tx, ty);
      if (keys && !keys.has(key)) continue;
      const c = tiles.get(key);
      if (!c) continue;
      drawn++;
      // Snap each tile's SHARED boundary once. A tile's lower-right corner is the
      // next tile's upper-left in world space, so rounding the lower-right corner
      // and the next tile's upper-left to the same device pixel gives adjacent
      // tiles an identical edge → no seam at any zoom. Rounding left+width
      // independently double-rounds the shared boundary and can disagree by 1px.
      const tl = worldToScreen(tx * TILE, ty * TILE, cam);
      const br = worldToScreen((tx + 1) * TILE, (ty + 1) * TILE, cam);
      const x0 = Math.round(tl.x * dpr) / dpr;
      const y0 = Math.round(tl.y * dpr) / dpr;
      const x1 = Math.round(br.x * dpr) / dpr;
      const y1 = Math.round(br.y * dpr) / dpr;
      if (drawTile) drawTile(ctx, key, c, x0, y0, x1 - x0, y1 - y0);
      else ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
    }
  }

  ctx.restore();
  return drawn;
}

/** Rebuild the tile map from the vector source of truth (structural ops). */
export function rebuildTiles(
  strokes: Stroke[],
  excludeIds?: Set<string>,
): Map<string, HTMLCanvasElement> {
  const tiles = new Map<string, HTMLCanvasElement>();
  for (const s of strokes) {
    if (excludeIds?.has(s.id)) continue;
    stampStroke(tiles, s);
  }
  return tiles;
}

// ---- Lazy materialization ----------------------------------------------------
//
// Rasterizing a whole document up front is what made a canvas with a few
// thousand strokes take seconds to open: measured on a 3.5k-stroke canvas, only
// about a quarter of the strokes (and a third of the tiles) are on screen, and
// the rest were paid for on every open even if the user never panned there.
//
// So a document is INDEXED whole (cheap — bounds and segment blocks, no pixels)
// and RASTERIZED only where it is looked at. A tile is therefore either complete
// or absent; absent tiles cost nothing to draw, are skipped by the dirty-region
// repair, and are skipped by the free eraser (erasing into empty space is
// already a no-op). Nothing else changes: a materialized tile holds exactly the
// strokes an eager build would have put in it, in the same document order.

/** Tiles kept rasterized beyond the viewport, so a short pan doesn't have to
 *  wait for a new tile to be built. */
const MATERIALIZE_MARGIN = 1;
/** Time a materialization pass may spend rasterizing, in ms. TIME, not a tile
 *  count or a byte count: the cost of a tile depends on how much ink is in it,
 *  which varies by orders of magnitude across a document — a byte budget bounds
 *  MEMORY but lets one dense tile block the frame for as long as it takes, which
 *  is exactly the "crossing a zoom level stalls for seconds" symptom. A build is
 *  therefore sliced BY STROKE across frames (see TileBuild). */
const MATERIALIZE_BUDGET_MS = 6;
/** Tiles this far outside the viewport may be reclaimed once the layer exceeds
 *  its budget. Comfortably beyond MATERIALIZE_MARGIN so a short pan never
 *  discards what it is about to need. */
const EVICT_DISTANCE_TILES = 3;
const TILE_BUDGET_BYTES = 192 * 1024 * 1024;

/** Index every stroke WITHOUT rasterizing any, so a tile built later still
 *  contains all the ink that belongs to it. Whole-stroke erase and its
 *  dirty-region repair read this index, and a lazily built tile must be
 *  indistinguishable from an eagerly built one. */
export function indexInkStrokes(
  tiles: Map<string, HTMLCanvasElement>,
  strokes: Stroke[],
): InkStrokeIndex {
  const index = getInkStrokeIndex(tiles);
  for (const s of strokes) index.add(s);
  return index;
}

export interface MaterializeOptions {
  preview?: boolean;
  /** Same-density tiles invalidated by source edits also need reconstruction. */
  forceKeys?: ReadonlySet<string>;
  /** Gesture-local protection; unrelated tiles may continue loading. */
  protectedKeys?: ReadonlySet<string>;
  margin?: number;
  /** Rasterization time this pass may use (default MATERIALIZE_BUDGET_MS). */
  budgetMs?: number;
  /** Hard cap on strokes rasterized in this pass.
   *
   *  The time budget alone cannot bound a frame: it is checked BETWEEN strokes,
   *  and one stroke's raster (a fresh canvas, the ribbon, the blit) can cost
   *  several ms by itself, so a dense tile overshoots by a whole stroke however
   *  tight the budget is. That overshoot IS the stutter felt when panning fast,
   *  so while the camera is moving the caller caps the count instead — a few
   *  strokes a frame fills new ground in tens of frames, still far faster than
   *  the eye needs, and every frame stays short. */
  /** Points rasterized in this pass. The frame-cost proxy that actually holds:
   *  a stroke's raster cost is ~linear in its points, and a stroke is indivisible,
   *  so a points budget bounds the pass (plus at most one indivisible stroke). */
  maxPoints?: number;
  /** Re-rasterize tiles that are already built, at the current bake scale.
   *
   *  The editor turns this OFF while the camera is moving. Crossing a bake step
   *  means every visible tile has to be re-rasterized at up to 9× the pixels, and
   *  paying that during the gesture is felt as a stall — while the ink already on
   *  screen is only slightly soft. So the upgrade waits for the view to settle;
   *  absent tiles are built either way, since there is nothing to show without
   *  them. */
  rebake?: boolean;
  /** Strokes the caller has erased VISUALLY but not yet committed to the store.
   *  They are still in the index, so re-rasterizing their tile would resurrect
   *  them — see the gesture gate in InfiniteInkCanvas, which normally means this
   *  never runs mid-gesture. */
  skipIds?: Set<string>;
  /** Pin the bake scale instead of following the display density. The PDF page
   *  uses this: a page is a handful of tiles, and its background is baked at
   *  PDF_BAKE_SCALE, so ink at a coarser density would look softer than the page
   *  text printed beside it. */
  fixedScale?: number;
}

/**
 * A tile rasterization in progress. Built up stroke by stroke across as many
 * frames as it takes, so no single frame is ever stuck behind one dense tile.
 *
 * The strokes come from the index's tile bucket, which preserves document order
 * — so a free-eraser carve lands on top of exactly what it covered — and the
 * finished canvas replaces the old tile only once it is COMPLETE. Until then the
 * old tile keeps rendering, so a re-bake never shows a blank or half-built tile.
 */
interface TileBuild {
  key: string;
  tx: number;
  ty: number;
  scale: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  strokes: Stroke[];
  /** Next stroke to rasterize. */
  next: number;
  /** Whether anything was actually drawn (skipIds can suppress every stroke). */
  drew: boolean;
}

const buildStates = new WeakMap<Map<string, HTMLCanvasElement>, Map<string, TileBuild>>();

function buildsFor(tiles: Map<string, HTMLCanvasElement>): Map<string, TileBuild> {
  let builds = buildStates.get(tiles);
  if (!builds) { builds = new Map(); buildStates.set(tiles, builds); }
  return builds;
}

/** Drop every in-progress tile build of this layer. For callers about to mutate
 *  the tiles OUTSIDE the materialize chain (structural repair): an in-flight
 *  build captured the index buckets as they were, and completing it would
 *  overwrite the repair. Builds restart lazily if their tile is still needed. */
export function abandonBuilds(tiles: Map<string, HTMLCanvasElement>): void {
  for (const build of buildsFor(tiles).values()) build.canvas.width = 0;
  buildsFor(tiles).clear();
}

function startBuild(
  index: InkStrokeIndex,
  tx: number,
  ty: number,
  scale: number,
): TileBuild | null {
  const strokes = index.grid.get(tileKey(tx, ty));
  if (!strokes || strokes.length === 0) return null;
  const canvas = createInkCanvas();
  canvas.width = canvas.height = Math.max(1, Math.round(TILE * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, -tx * TILE * scale, -ty * TILE * scale);
  return { key: tileKey(tx, ty), tx, ty, scale, canvas, ctx, strokes, next: 0, drew: false };
}

/** Rasterize strokes of `build` until the deadline, leaving it resumable. The
 *  only unit that can be sliced is a stroke — the smallest thing a dense tile is
 *  made of — so the clock is checked BEFORE each stroke: a stroke raster costs
 *  far more than the check, and checking only after every 8th stroke let a dense
 *  tile run up to 8 rasters past the deadline on every pass, which is felt as a
 *  stutter on each frame of a fast pan. */
function advanceBuild(build: TileBuild, deadline: number, skipIds: Set<string> | undefined, quota: { points: number }, drewThisPass: { n: number }, preview = false): void {
  while (build.next < build.strokes.length) {
    const s = build.strokes[build.next];
    // A stroke's raster cost is ~linear in its POINT count (every segment is
    // drawn separately, for pixel fidelity), and the count is known BEFORE the
    // work — so points, not milliseconds, are what bounds a frame. The first
    // stroke of a pass is always taken (unless the quota is already spent — the
    // pump shares it): otherwise a stroke costing more than the whole budget
    // would stall its tile forever.
    if (quota.points <= 0) break;
    if (drewThisPass.n > 0 && s.points.length > quota.points) break;
    if (performance.now() >= deadline) break;
    if (skipIds?.has(s.id)) { build.next++; continue; }
    // The raster may still be cooking: one monster stroke measured 46 ms whole,
    // so long ones are sliced across passes (see InkRasterCache). The tile PAUSES
    // here — drawing any later stroke first would break z-order, and drawing a
    // half-cooked raster is impossible by construction (it is swapped into the
    // cache only on completion).
    const raster = requestStrokeRaster(s, build.tx, build.ty, TILE, build.scale, preview);
    if (!raster) break;
    build.next++;
    drawStrokeRaster(build.ctx, s, raster, build.scale);
    build.drew = true;
    quota.points -= s.points.length;
    drewThisPass.n++;
  }
}

/**
 * Bring the tiles covering the viewport (plus `margin`) up to date, nearest the
 * centre first, within this pass' time budget. Returns how many tiles still need
 * work, so the caller can finish over the next frames.
 *
 * A tile needs work when it is absent, or (if `rebake`) was baked at a different
 * scale than the display now wants — the same call therefore both fills in new
 * ground and re-bakes after a zoom, with no separate invalidation path. Work is
 * resumable per tile, so crossing a bake step costs a few extra frames of
 * soft-ish ink rather than one multi-second freeze.
 */
export function materializeTiles(
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
  dpr: number,
  opts: MaterializeOptions = {},
): { materialized: number; remaining: number; scale: number; completed: string[] } {
  const margin = opts.margin ?? MATERIALIZE_MARGIN;
  const rebake = opts.rebake ?? true;
  // The scale is tracked even when a re-bake is deferred: new tiles must be born
  // at the density the display wants, whatever happens to the existing ones.
  const scale = opts.fixedScale ?? setTargetBakeScale(tiles, cam.zoom * dpr);
  if (opts.fixedScale) layerBakeScale.set(tiles, opts.fixedScale);
  const index = getInkStrokeIndex(tiles);
  const builds = buildsFor(tiles);
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE) - margin, tx1 = Math.floor(br.x / TILE) + margin;
  const ty0 = Math.floor(tl.y / TILE) - margin, ty1 = Math.floor(br.y / TILE) + margin;
  const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;
  const inView = (tx: number, ty: number) => tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1;
  // The viewport WITHOUT the margin — the part of the layer the user can see.
  const inViewport = (tx: number, ty: number) =>
    tx >= Math.floor(tl.x / TILE) && tx <= Math.floor(br.x / TILE)
    && ty >= Math.floor(tl.y / TILE) && ty <= Math.floor(br.y / TILE);

  // Abandon builds that became pointless — the density target moved, or the tile
  // scrolled away. They restart if either changes back.
  for (const [key, build] of [...builds]) {
    if (build.scale !== scale || !inView(build.tx, build.ty)) {
      build.canvas.width = 0;
      builds.delete(key);
    }
  }

  // Work list: builds already part-rasterized first (they are part-paid for),
  // then newly due tiles nearest the centre.
  const work: { tx: number; ty: number; d: number }[] = [...builds.values()]
    .map((b) => ({ tx: b.tx, ty: b.ty, d: -1 }));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(tx, ty);
      if (opts.protectedKeys?.has(key)) continue;
      if (builds.has(key)) continue;
      const strokes = index.grid.get(key);
      if (!strokes || strokes.length === 0) continue; // no ink here — nothing to build
      const existing = tiles.get(key);
      // A tile already at the right density is done; one at another density waits
      // for the view to settle (see `rebake`).
      if (existing && tileScaleOf(existing) === scale && !opts.forceKeys?.has(key)) continue;
      if (existing && !rebake) continue;
      // Re-bake only what is being LOOKED at. The margin exists so a short pan
      // finds tiles already there — not so tiles the camera can't see churn
      // every time the bake step moves. A margin tile at another density keeps
      // rendering (slightly soft) and upgrades if it ever scrolls into view.
      if (existing && !inViewport(tx, ty)) continue;
      // A tile whose every stroke is suppressed has nothing to draw; counting it
      // would leave the caller's chain spinning on it forever.
      if (opts.skipIds && strokes.every((s) => opts.skipIds!.has(s.id))) continue;
      const dx = (tx + 0.5) * TILE - cx, dy = (ty + 0.5) * TILE - cy;
      work.push({ tx, ty, d: dx * dx + dy * dy });
    }
  }
  // A tile needing nothing can still have a raster cooking for a tile that is
  // about to scroll in — keep the caller's chain alive while builds are out.
  if (work.length === 0) return { materialized: 0, remaining: pendingRasterBuilds(), scale, completed: [] };
  work.sort((a, b) => a.d - b.d);

  const deadline = performance.now() + (opts.budgetMs ?? MATERIALIZE_BUDGET_MS);
  const quota = { points: opts.maxPoints ?? Infinity };
  const drewThisPass = { n: 0 };
  // Cook the stroke rasters tiles are paused on FIRST — a paused tile cannot
  // advance past an unbuilt stroke, so cooking is the bottleneck, and a monster
  // stroke's raster only finishes if these slices get their share of the frames.
  // But the pump draws from a SLICE of the quota, so tiles keep drawing strokes
  // whose raster is already ready; an unlimited quota cooks at full width.
  const pumpShare = { points: quota.points === Infinity ? Infinity : Math.ceil(quota.points / 3) };
  pumpStrokeRasterBuilds(deadline, pumpShare);
  quota.points -= pumpShare.points === Infinity ? 0 : Math.ceil((opts.maxPoints ?? Infinity) / 3) - pumpShare.points;
  let materialized = 0, unfinished = 0, visited = 0;
  const completed: string[] = [];
  for (const w of work) {
    // Always advance at least one build; then stop as soon as the budget is gone.
    if (visited > 0 && (performance.now() >= deadline || quota.points <= 0)) break;
    visited++;
    const key = tileKey(w.tx, w.ty);
    if (opts.protectedKeys?.has(key)) continue;
    let build = builds.get(key);
    if (!build) {
      const started = startBuild(index, w.tx, w.ty, scale);
      if (!started) continue;
      build = started;
      builds.set(key, build);
    }
    advanceBuild(build, deadline, opts.skipIds, quota, drewThisPass, opts.preview);
    if (build.next < build.strokes.length) { unfinished++; continue; }
    builds.delete(key);
    if (build.drew) {
      registerTileScale(build.canvas, scale);
      const previous = tiles.get(key);
      tiles.set(key, build.canvas);
      if (previous) previous.width = 0;
    }
    materialized++;
    completed.push(key);
  }
  return { materialized, remaining: unfinished + (work.length - visited) + pendingRasterBuilds(), scale, completed };
}

/** Cancel only builds touched by a source edit. Keep complete pixels as previews. */
export function invalidateTileBuilds(tiles: Map<string, HTMLCanvasElement>, keys: ReadonlySet<string>): void {
  const builds = buildsFor(tiles);
  for (const key of keys) {
    const build = builds.get(key);
    if (build) { build.canvas.width = 0; builds.delete(key); }
  }
}

/** Estimated bytes held by a tile layer's canvases. */
export function inkTileBytes(tiles: Map<string, HTMLCanvasElement>): number {
  let total = 0;
  for (const c of tiles.values()) total += c.width * c.height * 4;
  return total;
}
export function inkTileBuildBytes(tiles: Map<string, HTMLCanvasElement>): number {
  let bytes = 0;
  for (const build of buildsFor(tiles).values()) bytes += build.canvas.width * build.canvas.height * 4;
  return bytes;
}

/** How many tiles a layer holds, for diagnostics. */
export function inkTileCount(tiles: Map<string, HTMLCanvasElement>): number {
  return tiles.size;
}

/**
 * Reclaim tiles far outside the viewport once the layer exceeds its byte budget.
 *
 * Safe because a tile's pixels are a pure function of the index (the vector
 * source of truth, carves included), so an evicted tile is rebuilt identically
 * when it is looked at again — and the free eraser and the dirty-region repair
 * both skip tiles that are not present, so absence is silently handled rather
 * than mis-drawn. MUST NOT run while a gesture is in flight: during a wipe the
 * erased strokes are still in the index, so rebuilding their tiles would
 * resurrect them.
 */
export function evictDistantTiles(
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
  budgetBytes: number = TILE_BUDGET_BYTES,
): number {
  const total = inkTileBytes(tiles);
  if (total <= budgetBytes) return 0;
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE) - EVICT_DISTANCE_TILES, tx1 = Math.floor(br.x / TILE) + EVICT_DISTANCE_TILES;
  const ty0 = Math.floor(tl.y / TILE) - EVICT_DISTANCE_TILES, ty1 = Math.floor(br.y / TILE) + EVICT_DISTANCE_TILES;
  let evicted = 0;
  let held = total;
  // Map iteration order is insertion order, which for a canvas being panned
  // around is close enough to least-recently-visited.
  for (const key of [...tiles.keys()]) {
    if (held <= budgetBytes) break;
    const sep = key.indexOf(':');
    const tx = Number(key.slice(0, sep)), ty = Number(key.slice(sep + 1));
    if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) continue; // near the view — keep
    const c = tiles.get(key)!;
    held -= c.width * c.height * 4;
    c.width = 0;
    tiles.delete(key);
    evicted++;
  }
  return evicted;
}

/**
 * Release every tile's backing store NOW instead of handing it to the GC.
 *
 * A tile is 1536² at 3× bake (9.4 MiB), and a dense canvas is a hundred of them
 * — dropping the Map reference alone leaves ~1 GiB of GPU/CPU surfaces alive
 * while the next canvas allocates its own, which is what made a light canvas
 * slow to open after a heavy one was visited. Setting `width = 0` frees the
 * pixels immediately. The map is left empty so the caller can hand the same
 * instance to a fresh `rebuildTiles` if it wants to.
 */
export function disposeTiles(tiles: Map<string, HTMLCanvasElement>): void {
  abandonBuilds(tiles);
  for (const c of tiles.values()) c.width = 0;
  tiles.clear();
}

/** Repair the removed ink's dirty rectangles, retaining the rest of each tile.
 *  Each tile is repaired at its OWN bake scale (see InkTileErase). */
export function removeStrokesFromTiles(
  tiles: Map<string, HTMLCanvasElement>,
  grid: Map<string, Stroke[]>,
  skipIds: Set<string>,
  removed: Stroke[],
  cachedBounds?: Map<string, Bounds>,
  dragPreview = false,
): void {
  eraseStrokeRegions(tiles, grid, skipIds, removed, TILE, targetBakeScale(tiles), cachedBounds, dragPreview);
}
