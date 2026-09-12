import type { PdfStroke } from './PdfTypes';
import { drawAnnotatedStroke, drawInkRibbonSlice, prepareInkRibbon } from './PdfBrushRenderers';
import { getCommittedStrokeBounds, getInkStrokeIndex } from './InkStrokeIndex';
import { getStreamingInk, renderStrokeOnce, clearStreamingInk } from './StreamingInkStroke';

type Prepared = ReturnType<typeof prepareInkRibbon>;
interface Raster { image: HTMLCanvasElement; x: number; y: number; bytes: number; owner: Map<string, Raster>; key: string }
/**
 * Byte ceiling for cached per-stroke rasters. This is a CEILING, not an
 * allocation: a light document uses a few hundred KiB and never approaches it.
 *
 * It must be large enough to hold the rasters of every stroke overlapping the
 * region being repaired. Whole-stroke erase re-composites each overlapping
 * stroke, and a raster is cropped to that stroke's bounds — so a region of N
 * mutually-overlapping strokes needs ~N × bbox bytes. When the working set
 * exceeds the ceiling the LRU thrashes: every erase evicts what the next erase
 * needs, and each miss re-renders a stroke from raw points. Measured on 16 long
 * strokes overlapping one tile (~127 MiB of rasters), the old 64 MiB ceiling
 * cost 343 ms per erase (worst 1655 ms) against 11.5 ms once it fits.
 */
const LIMIT = 256 * 1024 * 1024;
const owners = new WeakMap<PdfStroke, Map<string, Raster>>();
const lru = new Map<Raster, true>();
let bytes = 0, hits = 0, misses = 0;

export function inkRasterCacheStats() { return { bytes, limit: LIMIT, hits, misses, entries: lru.size }; }

/**
 * Drop every pixel cache both ink surfaces share.
 *
 * A single dense canvas holds 268 MiB of rasters plus ~98 MiB of retained
 * streaming ink — all of it repaintable from the vector source, so worth
 * keeping while that document is open, and pure ballast once it is not. Called
 * when an editor leaves its document, so the next one starts from zero instead
 * of evicting hundreds of megabytes of useless surfaces while it allocates its
 * own (which is what made a small canvas slow right after a large one).
 */
export function releaseDocumentInkCaches(): void {
  clearInkRasterCache();
  clearStreamingInk();
}
export function clearInkRasterCache(): void {
  for (const entry of lru.keys()) { entry.owner.delete(entry.key); entry.image.width = 0; }
  lru.clear(); bytes = 0; hits = 0; misses = 0;
}

/** Cropped, already feathered pixels of ONE committed stroke in one tile.
 * Cache is shared by stamping and erasing, bounded to LIMIT bytes, with LRU
 * eviction. Source-over and destination-out are replayed in vector order. */
export function getStrokeRaster(stroke: PdfStroke, tx: number, ty: number, tileSize: number, scale: number, prepare?: () => Prepared): Raster {
  let owner = owners.get(stroke);
  if (!owner) { owner = new Map(); owners.set(stroke, owner); }
  const key = `${tx}:${ty}:${tileSize}:${scale}`;
  const cached = owner.get(key);
  if (cached) { hits++; lru.delete(cached); lru.set(cached, true); return cached; }
  misses++;
  const b = getCommittedStrokeBounds(stroke), ox = tx * tileSize, oy = ty * tileSize;
  const x0 = Math.max(0, Math.floor((b.minX - ox - 3) * scale));
  const y0 = Math.max(0, Math.floor((b.minY - oy - 3) * scale));
  const x1 = Math.min(tileSize * scale, Math.ceil((b.maxX - ox + 3) * scale));
  const y1 = Math.min(tileSize * scale, Math.ceil((b.maxY - oy + 3) * scale));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  // World-space rect this raster covers — what the renderers slice to.
  const minX = ox + x0 / scale, minY = oy + y0 / scale;
  const maxX = ox + (x0 + w) / scale, maxY = oy + (y0 + h) / scale;
  // Which renderer paints a stroke is decided by the STROKE, never by what
  // happens to be in a cache: a raster must not depend on the order tiles were
  // built in, or the same ink would look different depending on where the user
  // looked first.
  //
  // Version-2 marker/fountain is painted in ONE pass — the per-cell surfaces the
  // incremental raster allocates are what made opening a dense canvas take tens
  // of seconds, and a committed stroke has nothing incremental about it. Pencil
  // keeps the incremental raster (its grain is only defined step by step), and
  // everything older keeps the ribbon renderer it was drawn with.
  let image: HTMLCanvasElement | null = null;
  let empty = false;
  if (stroke.renderVersion === 2 && stroke.style !== 'pencil') {
    image = renderStrokeOnce(stroke, scale, minX, minY, maxX, maxY);
    if (!image) {
      // The bounding box covers a tile the path never actually enters (an
      // L-shaped stroke, say), so this tile gets nothing from it. Recorded as an
      // empty raster — NOT by falling through to the incremental raster, which
      // would build a whole stroke's coverage in order to paint nothing.
      empty = true;
      image = document.createElement('canvas');
      image.width = image.height = 1;
    }
  }
  if (!image) {
    // Render into a canvas cropped to this stroke's dirty rect (a full tile is
    // 1536² = 9.4 MiB at 3×; a typical stroke needs a few hundred KiB).
    image = document.createElement('canvas');
    image.width = w; image.height = h;
    const ctx = image.getContext('2d')!;
    ctx.setTransform(scale, 0, 0, scale, -ox * scale - x0, -oy * scale - y0);
    if (stroke.renderVersion === 2) {
      getStreamingInk(stroke).draw(ctx, 0, 0, { minX: minX - 1, minY: minY - 1, maxX: maxX + 1, maxY: maxY + 1 });
    } else {
      const ribbon = prepare ? prepare() : prepareInkRibbon(stroke);
      if (ribbon) drawInkRibbonSlice(ctx, { ...ribbon, composite: 'source-over' }, minX, minY, maxX, maxY);
      else drawAnnotatedStroke(ctx, { ...stroke, compositeOperation: 'source-over' });
    }
  }
  const value: Raster = {
    image, x: ox + x0 / scale, y: oy + y0 / scale,
    bytes: empty ? 4 : w * h * 4, owner, key,
  };
  while (bytes + value.bytes > LIMIT && lru.size) {
    const first = lru.keys().next().value!;
    bytes -= first.bytes; lru.delete(first); first.owner.delete(first.key); first.image.width = 0;
  }
  owner.set(key, value); lru.set(value, true); bytes += value.bytes;
  return value;
}

export function drawStrokeRaster(ctx: CanvasRenderingContext2D, stroke: PdfStroke, raster: Raster, scale: number): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = stroke.compositeOperation;
  ctx.drawImage(raster.image, raster.x, raster.y, raster.image.width / scale, raster.image.height / scale);
  ctx.restore();
}

export function stampCachedStroke(tiles: Map<string, HTMLCanvasElement>, stroke: PdfStroke, tileSize: number, scale: number): void {
  getInkStrokeIndex(tiles).add(stroke);
  if (!stroke.points.length) return;
  const b = getCommittedStrokeBounds(stroke);
  let ribbon: Prepared | undefined;
  const prepare = () => { if (ribbon === undefined) ribbon = prepareInkRibbon(stroke); return ribbon; };
  for (let ty = Math.floor(b.minY / tileSize); ty <= Math.floor(b.maxY / tileSize); ty++) {
    for (let tx = Math.floor(b.minX / tileSize); tx <= Math.floor(b.maxX / tileSize); tx++) {
      const key = `${tx}:${ty}`;
      let tile = tiles.get(key);
      if (!tile) {
        tile = document.createElement('canvas'); tile.width = tile.height = Math.round(tileSize * scale); tiles.set(key, tile);
      }
      const raster = getStrokeRaster(stroke, tx, ty, tileSize, scale, prepare);
      const ctx = tile.getContext('2d')!;
      ctx.setTransform(scale, 0, 0, scale, -tx * tileSize * scale, -ty * tileSize * scale);
      drawStrokeRaster(ctx, stroke, raster, scale);
    }
  }
  // Streaming ink is deliberately NOT released here. Keeping it lets a later
  // raster-cache miss re-composite this stroke (~1ms) instead of re-processing
  // its raw points (~70ms); StreamingInkStroke self-bounds with its own LRU.
  // Releasing here is what made a stroke-dense erase spike to hundreds of ms.
}
