import { createInkCanvas } from '../InkCanvasSurface';
/**
 * InkDragPreview — the raster of a drag-move selection, shared by both surfaces.
 *
 * While a selection is dragged, its strokes are drawn live on top of the tile
 * layer at the drag delta. Re-rendering them every frame is expensive twice over:
 * a legacy stroke re-runs its smoothing, width chain, resampling and fill per
 * frame (O(points)), and a version-2 stroke goes through the live coverage cache,
 * whose budget a multi-stroke selection blows — so each frame re-processed the
 * very point lists it had just evicted, at ~70 ms for a long stroke.
 *
 * None of that work changes during a drag: only the offset does. So the selection
 * is rasterized ONCE at drag start and blitted thereafter.
 */

import { drawAnnotatedStroke } from './PdfBrushRenderers';
import { getCommittedStrokeBounds } from './InkStrokeIndex';
import type { PdfStroke } from './PdfTypes';

export interface DragPreview {
  canvas: HTMLCanvasElement;
  /** World position of the raster's top-left corner. */
  x: number;
  y: number;
  /** Bake scale it was rendered at, in pixels per world unit. A caller that has
   *  re-baked the tile layer at another density must stop using this raster. */
  scale: number;
}

/** Refuse to bake a preview bigger than this. A selection spanning half the
 *  document would otherwise allocate hundreds of megabytes in one gesture. */
export const PREVIEW_MAX_PIXELS = 4 * 1024 * 1024;

/** Margin around the selection's bounds, in world units. The bounds already
 *  include each stroke's half width, and the feather fringe is capped at 0.6
 *  world px, so this cannot clip the ink. */
const PREVIEW_PAD = 2;

/** Rasterize `strokes` once at `scale`, or return null when that would be too
 *  large or there is nothing to draw — the caller then falls back to drawing the
 *  strokes directly, which is slower but always correct. */
export function bakeDragPreview(strokes: PdfStroke[], scale: number): DragPreview | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const b = getCommittedStrokeBounds(s);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!Number.isFinite(minX)) return null;
  minX -= PREVIEW_PAD; minY -= PREVIEW_PAD; maxX += PREVIEW_PAD; maxY += PREVIEW_PAD;
  const w = Math.ceil((maxX - minX) * scale), h = Math.ceil((maxY - minY) * scale);
  if (w <= 0 || h <= 0 || w * h > PREVIEW_MAX_PIXELS) return null;

  const canvas = createInkCanvas();
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
  for (const s of strokes) drawAnnotatedStroke(ctx, s);
  return { canvas, x: minX, y: minY, scale };
}

/** Blit a preview at the given drag delta, into a context already under the
 *  world transform. */
export function drawDragPreview(
  ctx: CanvasRenderingContext2D,
  preview: DragPreview,
  dx: number,
  dy: number,
): void {
  const { canvas, x, y, scale } = preview;
  ctx.drawImage(canvas, x + dx, y + dy, canvas.width / scale, canvas.height / scale);
}
