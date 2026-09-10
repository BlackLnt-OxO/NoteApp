/**
 * inkGrid — the spatial hash the whole-stroke eraser ("擦除笔画") uses.
 *
 * Built ONCE per wipe gesture, then queried once per animation frame with the
 * eraser's travelled bounding box. Without it the per-frame hit scan would be
 * O(every stroke on the page); with it, cost scales with the strokes near the
 * cursor.
 *
 * Cell size == ink tile size, so a grid key is the same string as a tile key and
 * the tile re-stamp can reuse this grid directly to find what to redraw.
 *
 * NOTE: strokes are currently inserted by their WHOLE bounding box. A stroke that
 * spans the page therefore lands in every cell along its extent, so a query near
 * any part of it still returns it and the caller pays a full polyline hit test
 * over all its points every frame. Splitting long strokes into per-segment
 * buckets is the planned fix (it keeps hit cost proportional to the part of the
 * stroke actually near the cursor) and is local to this module.
 */

import type { InkBounds, InkStroke } from './inkTypes';

/** Grid cell size in world units. Must equal the ink tile size. */
export const GRID_CELL = 512;

/** Insert a stroke into every cell its bounds overlap. */
export function addStrokeToGrid(grid: Map<string, InkStroke[]>, s: InkStroke, b: InkBounds): void {
  const tx0 = Math.floor(b.minX / GRID_CELL), tx1 = Math.floor(b.maxX / GRID_CELL);
  const ty0 = Math.floor(b.minY / GRID_CELL), ty1 = Math.floor(b.maxY / GRID_CELL);
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
export function collectGridStrokes(
  grid: Map<string, InkStroke[]>,
  x1: number, y1: number, x2: number, y2: number,
  out: InkStroke[],
): void {
  const cx0 = Math.floor(Math.min(x1, x2) / GRID_CELL), cx1 = Math.floor(Math.max(x1, x2) / GRID_CELL);
  const cy0 = Math.floor(Math.min(y1, y2) / GRID_CELL), cy1 = Math.floor(Math.max(y1, y2) / GRID_CELL);
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
