/**
 * InkTiles — sparse rasterized ink layer for the infinite canvas, ported from
 * PdfCanvas's tiled two-layer model.
 *
 * Strokes are stamped into a sparse grid of offscreen canvases (TILE×TILE world
 * units each, baked at SCALE×). Pen = source-over, free-eraser =
 * destination-out (only ever touches ink). The main canvas draws only the
 * visible tiles per frame, so writing/erasing is O(1) instead of re-rendering
 * every stroke's vector every frame.
 *
 * Text nodes are NOT rasterized here — they keep their vector/DOM path.
 */

import type { Camera, Stroke } from './types';
import { screenToWorld, worldToScreen } from './constants';
import {
  drawAnnotatedStroke,
  prepareInkRibbon,
  drawInkRibbonSlice,
} from '../PdfAnnotation/PdfBrushRenderers';
import {
  drawEraserSegment,
  drawEraserDot,
  getStrokeBounds,
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

/** Draw a stroke into whichever tiles it intersects. For ribbon pens the ribbon
 *  is prepared once, then each tile stamps only the slice overlapping it — the
 *  pixels are identical (no re-smoothing, no seams) but cost scales with the
 *  tile instead of re-rasterizing the WHOLE stroke per tile. Eraser / pencil
 *  keep the whole-stroke path. */
export function stampStroke(tiles: Map<string, HTMLCanvasElement>, stroke: Stroke): void {
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

/**
 * Whole-stroke eraser live removal: clear the pixels of the removed stroke(s)
 * out of the SHARED ink-tile map. Affected tiles are cleared, then only the
 * strokes listed in those tiles' wipe-grid cells are re-stamped (the grid was
 * built once per wipe gesture and cell size == tile size, so this never scans
 * the whole page — cost scales with the strokes near the removed one, not with
 * the total stroke count). Destination-out eraser carves are re-stamped in their
 * original order so the z-relationship matches a full rebuild. Tiles left empty
 * are dropped.
 */
export function removeStrokesFromTiles(
  tiles: Map<string, HTMLCanvasElement>,
  grid: Map<string, Stroke[]>,
  skipIds: Set<string>,
  removed: Stroke[],
  cachedBounds?: Map<string, Bounds>,
): void {
  if (removed.length === 0) return;

  // Reuse the wipe gesture's per-stroke bounds cache (strokes are immutable
  // here) so removal cost is O(strokes near the erased one), not O(total points).
  const boundsOf = (s: Stroke): Bounds => {
    const b = cachedBounds?.get(s.id);
    if (b) return b;
    const nb = getStrokeBounds(s);
    cachedBounds?.set(s.id, nb);
    return nb;
  };

  // Tiles the removed strokes touch = the only tiles whose pixels can change.
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

  // Re-stamp, per cleared tile, only the strokes that the wipe grid lists for
  // that cell (except the ones erased this gesture). Mirrors stampStroke exactly.
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
      const ribbon = prepareInkRibbon(s);
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
