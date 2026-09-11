import { boundsIntersectRect, type Bounds } from './PdfEngine';
import type { PdfStroke } from './PdfTypes';
import { getCommittedStrokeBounds } from './InkStrokeIndex';
import { getStrokeRaster, drawStrokeRaster } from './InkRasterCache';
export { getCommittedStrokeBounds } from './InkStrokeIndex';


// One reusable tile (about 9 MiB at 3x), shared by both editors. Render with the
// original tile transform and no path clip: clipping vector paths at a dirty
// rectangle can change their edge antialiasing. Copy only repaired pixels back.
let repairCanvas: HTMLCanvasElement | undefined;
function getRepairCanvas(width: number, height: number): HTMLCanvasElement {
  if (!repairCanvas) repairCanvas = document.createElement('canvas');
  if (repairCanvas.width !== width) repairCanvas.width = width;
  if (repairCanvas.height !== height) repairCanvas.height = height;
  return repairCanvas;
}

/** Repair only the removed ink's pixel rectangle within each affected tile.
 * Replaying in document order preserves translucent overlaps and free-eraser
 * carves. Everything outside the dirty rectangle stays in the raster cache.
 * Shared by the infinite canvas and PDF annotations. */
export function eraseStrokeRegions(
  tiles: Map<string, HTMLCanvasElement>,
  grid: Map<string, PdfStroke[]>,
  skipIds: Set<string>,
  removed: PdfStroke[],
  tileSize: number,
  scale: number,
  cachedBounds?: Map<string, Bounds>,
): void {
  const boundsOf = (s: PdfStroke): Bounds => {
    const bounds = cachedBounds?.get(s.id) ?? getCommittedStrokeBounds(s);
    cachedBounds?.set(s.id, bounds);
    return bounds;
  };
  // The brush blur is capped at 0.6 world px; leave room for its filter fringe
  // and antialiasing. Align repairs to baked pixels to avoid fractional copy seams.
  const pad = 3;
  const dirty = new Map<string, Bounds>();
  for (const stroke of removed) {
    const b = boundsOf(stroke);
    const tx0 = Math.floor((b.minX - pad) / tileSize), tx1 = Math.floor((b.maxX + pad) / tileSize);
    const ty0 = Math.floor((b.minY - pad) / tileSize), ty1 = Math.floor((b.maxY + pad) / tileSize);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx}:${ty}`;
        if (!tiles.has(key)) continue;
        const region = {
          minX: Math.max(tx * tileSize, Math.floor((b.minX - pad) * scale) / scale),
          minY: Math.max(ty * tileSize, Math.floor((b.minY - pad) * scale) / scale),
          maxX: Math.min((tx + 1) * tileSize, Math.ceil((b.maxX + pad) * scale) / scale),
          maxY: Math.min((ty + 1) * tileSize, Math.ceil((b.maxY + pad) * scale) / scale),
        };
        const previous = dirty.get(key);
        if (previous) {
          previous.minX = Math.min(previous.minX, region.minX);
          previous.minY = Math.min(previous.minY, region.minY);
          previous.maxX = Math.max(previous.maxX, region.maxX);
          previous.maxY = Math.max(previous.maxY, region.maxY);
        } else {
          dirty.set(key, region);
        }
      }
    }
  }

  for (const [key, region] of dirty) {
    const canvas = tiles.get(key)!;
    const target = canvas.getContext('2d');
    if (!target) continue;
    const survivors = (grid.get(key) ?? []).filter(s => !skipIds.has(s.id));
    if (survivors.length === 0) { tiles.delete(key); continue; }
    const scratch = getRepairCanvas(canvas.width, canvas.height);
    const ctx = scratch.getContext('2d')!;
    const sep = key.indexOf(':');
    const ox = Number(key.slice(0, sep)) * tileSize;
    const oy = Number(key.slice(sep + 1)) * tileSize;
    const x = Math.round((region.minX - ox) * scale);
    const y = Math.round((region.minY - oy) * scale);
    const width = Math.round((region.maxX - region.minX) * scale);
    const height = Math.round((region.maxY - region.minY) * scale);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
    for (const stroke of survivors) {
      if (!boundsIntersectRect(boundsOf(stroke), region.minX - pad, region.minY - pad, region.maxX + pad, region.maxY + pad)) continue;
      const raster = getStrokeRaster(stroke, ox / tileSize, oy / tileSize, tileSize, scale);
      drawStrokeRaster(ctx, stroke, raster, scale);
    }
    ctx.restore();
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
    target.imageSmoothingEnabled = false;
    target.clearRect(x, y, width, height);
    target.drawImage(scratch, x, y, width, height, x, y, width, height);
    target.restore();
  }
}
