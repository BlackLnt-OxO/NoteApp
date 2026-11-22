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
import { resolveFeatherWorld } from './InkMath';
import { drawStreamingPreview, usesOnePassInk } from './StreamingInkStroke';
import type { PdfStroke } from './PdfTypes';

export interface DragPreview {
  canvas: HTMLCanvasElement;
  /** World position of the raster's top-left corner. */
  x: number;
  y: number;
  /** Bake scale in pixels per world unit. Independent of the committed tiles. */
  scale: number;
}

export const PREVIEW_MAX_PIXELS = 4 * 1024 * 1024;
const MAX_DIMENSION = 4096;

/** Rasterize once, reducing preview density for wide selections to bound the bitmap. */
export function bakeDragPreview(strokes: PdfStroke[], scale: number): DragPreview | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    if (!s.points.length) continue;
    const b = getCommittedStrokeBounds(s);
    const pad = 2 + 3 * resolveFeatherWorld(s, [s.size]);
    minX = Math.min(minX, b.minX - pad); minY = Math.min(minY, b.minY - pad);
    maxX = Math.max(maxX, b.maxX + pad); maxY = Math.max(maxY, b.maxY + pad);
  }
  const width = maxX - minX, height = maxY - minY;
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0 || scale <= 0) return null;
  // Reserve room for the pixel rounding on each axis.
  scale = Math.min(scale, (MAX_DIMENSION - 1) / width, (MAX_DIMENSION - 1) / height,
    Math.sqrt((PREVIEW_MAX_PIXELS - 2 * MAX_DIMENSION) / width / height));

  const canvas = createInkCanvas();
  canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
  for (const stroke of strokes) {
    if (stroke.geometry || stroke.compositeOperation === 'destination-out' || !usesOnePassInk(stroke)) {
      drawAnnotatedStroke(ctx, stroke);
    } else drawStreamingPreview(ctx, stroke, scale);
  }
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
