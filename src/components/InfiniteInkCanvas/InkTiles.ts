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

/** Draw all ink tiles that intersect the current viewport (camera already
 *  applied). Returns how many it drew, for the perf readout. */
export function drawVisibleTiles(
  ctx: CanvasRenderingContext2D,
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
  dpr: number,
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
      const c = tiles.get(tileKey(tx, ty));
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
      ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
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
/** Work allowed per materialization pass. A BYTE budget, because "32 tiles" is
 *  300 MiB at a 3× bake and 2 MiB at 0.25× — the pass must not blow the frame
 *  budget at one density and crawl at another. A dense tile can still overshoot
 *  on its own (slicing could only happen between tiles), but it shrinks with the
 *  square of the bake scale. */
const MATERIALIZE_BUDGET_BYTES = 12 * 1024 * 1024;
const MATERIALIZE_MAX_TILES = 64;
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
  margin?: number;
  budgetBytes?: number;
  maxTiles?: number;
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
 * Rasterize ONE tile from the index's tile bucket (which preserves document
 * order, so a free-eraser carve lands on top of exactly what it covered), at
 * `scale` pixels per world unit.
 *
 * The new canvas is rasterized COMPLETELY before it replaces the old one, so a
 * re-bake never shows a half-built or blank tile: the old tile keeps rendering
 * until the replacement is ready, and is freed the moment it is swapped out.
 * Returns false when there is nothing to put in this tile.
 */
function materializeTile(
  tiles: Map<string, HTMLCanvasElement>,
  tx: number,
  ty: number,
  scale: number,
  skipIds?: Set<string>,
): boolean {
  const strokes = getInkStrokeIndex(tiles).grid.get(tileKey(tx, ty));
  if (!strokes || strokes.length === 0) return false;
  const tile = document.createElement('canvas');
  tile.width = tile.height = Math.max(1, Math.round(TILE * scale));
  const ctx = tile.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, -tx * TILE * scale, -ty * TILE * scale);
  let drew = false;
  for (const s of strokes) {
    if (skipIds?.has(s.id)) continue;
    drawStrokeRaster(ctx, s, getStrokeRaster(s, tx, ty, TILE, scale), scale);
    drew = true;
  }
  if (!drew) return false;
  registerTileScale(tile, scale);
  const key = tileKey(tx, ty);
  const previous = tiles.get(key);
  tiles.set(key, tile);
  if (previous) previous.width = 0;
  return true;
}

/**
 * Bring the tiles covering the viewport (plus `margin`) up to date, nearest the
 * centre first, within this pass' budget. Returns how many tiles still need
 * work, so the caller can finish over the next frames.
 *
 * A tile needs work when it is absent, or was baked at a different scale than
 * the display now wants — the same call therefore both fills in new ground and
 * re-bakes after a zoom, with no separate invalidation path.
 */
export function materializeTiles(
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
  dpr: number,
  opts: MaterializeOptions = {},
): { materialized: number; remaining: number; scale: number } {
  const margin = opts.margin ?? MATERIALIZE_MARGIN;
  const budgetBytes = opts.budgetBytes ?? MATERIALIZE_BUDGET_BYTES;
  const maxTiles = opts.maxTiles ?? MATERIALIZE_MAX_TILES;
  // Device pixels per world unit. `uiScale` must NOT appear: the backing store is
  // layout × uiScale × dpr while the viewport is measured in visual (layout ×
  // uiScale) px and drawn under a dpr transform — the uiScale terms cancel.
  const scale = opts.fixedScale ?? setTargetBakeScale(tiles, cam.zoom * dpr);
  if (opts.fixedScale) layerBakeScale.set(tiles, opts.fixedScale);
  const index = getInkStrokeIndex(tiles);
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE) - margin, tx1 = Math.floor(br.x / TILE) + margin;
  const ty0 = Math.floor(tl.y / TILE) - margin, ty1 = Math.floor(br.y / TILE) + margin;
  const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;

  const due: { tx: number; ty: number; d: number }[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(tx, ty);
      const strokes = index.grid.get(key);
      if (!strokes || strokes.length === 0) continue; // no ink here — nothing to build
      const existing = tiles.get(key);
      if (existing && tileScaleOf(existing) === scale) continue; // already right
      // A tile whose every stroke is suppressed has nothing to draw; counting it
      // would leave the caller's chain spinning on it forever.
      if (opts.skipIds && strokes.every((s) => opts.skipIds!.has(s.id))) continue;
      const dx = (tx + 0.5) * TILE - cx, dy = (ty + 0.5) * TILE - cy;
      due.push({ tx, ty, d: dx * dx + dy * dy });
    }
  }
  if (due.length === 0) return { materialized: 0, remaining: 0, scale };
  due.sort((a, b) => a.d - b.d);

  const bytesPerTile = Math.round(TILE * scale) * Math.round(TILE * scale) * 4;
  const perPass = Math.max(1, Math.min(maxTiles, Math.floor(budgetBytes / Math.max(1, bytesPerTile))));
  let materialized = 0;
  for (const m of due.slice(0, perPass)) {
    if (materializeTile(tiles, m.tx, m.ty, scale, opts.skipIds)) materialized++;
  }
  const taken = Math.min(perPass, due.length);
  return { materialized, remaining: due.length - taken, scale };
}

/** Estimated bytes held by a tile layer's canvases. */
export function inkTileBytes(tiles: Map<string, HTMLCanvasElement>): number {
  let total = 0;
  for (const c of tiles.values()) total += c.width * c.height * 4;
  return total;
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
): void {
  eraseStrokeRegions(tiles, grid, skipIds, removed, TILE, targetBakeScale(tiles), cachedBounds);
}
