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
import { stampCachedStroke } from '../PdfAnnotation/InkRasterCache';
import { eraseStrokeRegions } from '../PdfAnnotation/InkTileErase';
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

/** Stamp and cache committed pixels, sharing live coverage for version 2 ink. */
export function stampStroke(tiles: Map<string, HTMLCanvasElement>, stroke: Stroke): void {
  stampCachedStroke(tiles, stroke, TILE, SCALE);
}

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
      const ctx = tileCtx(tiles, tx, ty);
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
      const ctx = tileCtx(tiles, tx, ty);
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
