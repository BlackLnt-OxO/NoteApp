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
import { stampCachedStroke, getStrokeRaster, drawStrokeRaster } from '../PdfAnnotation/InkRasterCache';
import { eraseStrokeRegions } from '../PdfAnnotation/InkTileErase';
import { getInkStrokeIndex, type InkStrokeIndex } from '../PdfAnnotation/InkStrokeIndex';
import { screenToWorld, worldToScreen } from './constants';
import {
  drawEraserSegment,
  drawEraserDot,
  type Bounds,
} from '../PdfAnnotation/PdfEngine';

const TILE = 512; // world units per tile
const SCALE = 3;  // bake supersampling (matches PDF_BAKE_SCALE)


function tileKey(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

/** Stamp and cache committed pixels, sharing live coverage for version 2 ink. */
export function stampStroke(tiles: Map<string, HTMLCanvasElement>, stroke: Stroke): void {
  stampCachedStroke(tiles, stroke, TILE, SCALE);
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
      const ctx = tile.getContext('2d')!;
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
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
      const ctx = tile.getContext('2d')!;
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
      drawEraserDot(ctx, x, y, size);
    }
  }
}

/** Draw all ink tiles that intersect the current viewport (camera already applied). */
export function drawVisibleTiles(
  ctx: CanvasRenderingContext2D,
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
  dpr: number,
): void {
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE), tx1 = Math.floor(br.x / TILE);
  const ty0 = Math.floor(tl.y / TILE), ty1 = Math.floor(br.y / TILE);

  // The caller's ctx is already under the world transform (camera translate +
  // zoom). Drawing tiles in WORLD coords makes each tile's target rectangle land
  // on fractional device pixels, so 3×-supersampled tiles get soft/aliased edges
  // and adjacent tiles leave a 1px seam (dark line in dark theme, white in light).
  // Instead, reset to the device-pixel (dpr) base and draw each tile in SCREEN
  // coords, snapped to integer device pixels so neighbors share an exact edge.
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = tiles.get(tileKey(tx, ty));
      if (!c) continue;
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

/** Tiles rasterized per pass: a full viewport at zoom 1 in one frame, so an
 *  open paints in a single step, while a zoomed-out view fills in over a few
 *  frames instead of blocking one. */
const MATERIALIZE_BUDGET = 32;
/** Tiles kept rasterized beyond the viewport, so a short pan doesn't have to
 *  wait for a new tile to be built. */
const MATERIALIZE_MARGIN = 1;

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

/** Rasterize ONE tile from the index's tile bucket (which preserves document
 *  order, so a free-eraser carve lands on top of exactly what it covered). */
function materializeTile(
  tiles: Map<string, HTMLCanvasElement>,
  tx: number,
  ty: number,
): void {
  const strokes = getInkStrokeIndex(tiles).grid.get(tileKey(tx, ty));
  if (!strokes || strokes.length === 0) return;
  const tile = document.createElement('canvas');
  tile.width = tile.height = Math.round(TILE * SCALE);
  tiles.set(tileKey(tx, ty), tile);
  const ctx = tile.getContext('2d')!;
  ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
  for (const s of strokes) {
    drawStrokeRaster(ctx, s, getStrokeRaster(s, tx, ty, TILE, SCALE), SCALE);
  }
}

/**
 * Rasterize the tiles covering the viewport (plus `margin`), nearest the centre
 * first, up to `budget` of them. Returns how many tiles still need rasterizing,
 * so the caller can finish the job over the next frames.
 */
export function materializeTiles(
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
  budget: number = MATERIALIZE_BUDGET,
  margin: number = MATERIALIZE_MARGIN,
): { materialized: number; remaining: number } {
  const index = getInkStrokeIndex(tiles);
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE) - margin, tx1 = Math.floor(br.x / TILE) + margin;
  const ty0 = Math.floor(tl.y / TILE) - margin, ty1 = Math.floor(br.y / TILE) + margin;
  const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2;

  const missing: { tx: number; ty: number; d: number }[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(tx, ty);
      if (tiles.has(key)) continue;
      if (!index.grid.has(key)) continue; // no ink here — nothing to build
      const dx = (tx + 0.5) * TILE - cx, dy = (ty + 0.5) * TILE - cy;
      missing.push({ tx, ty, d: dx * dx + dy * dy });
    }
  }
  if (missing.length === 0) return { materialized: 0, remaining: 0 };
  missing.sort((a, b) => a.d - b.d);
  const take = missing.slice(0, budget);
  for (const m of take) materializeTile(tiles, m.tx, m.ty);
  return { materialized: take.length, remaining: missing.length - take.length };
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

/** Repair the removed ink's dirty rectangles, retaining the rest of each tile. */
export function removeStrokesFromTiles(
  tiles: Map<string, HTMLCanvasElement>,
  grid: Map<string, Stroke[]>,
  skipIds: Set<string>,
  removed: Stroke[],
  cachedBounds?: Map<string, Bounds>,
): void {
  eraseStrokeRegions(tiles, grid, skipIds, removed, TILE, SCALE, cachedBounds);
}
