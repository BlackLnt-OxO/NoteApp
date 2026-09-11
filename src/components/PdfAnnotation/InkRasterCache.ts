import type { PdfStroke } from './PdfTypes';
import { drawAnnotatedStroke, drawInkRibbonSlice, prepareInkRibbon } from './PdfBrushRenderers';
import { getCommittedStrokeBounds, getInkStrokeIndex } from './InkStrokeIndex';
import { getStreamingInk } from './StreamingInkStroke';

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
let scratch: HTMLCanvasElement | undefined;

export function inkRasterCacheStats() { return { bytes, limit: LIMIT, hits, misses, entries: lru.size }; }
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
  if (!scratch) scratch = document.createElement('canvas');
  const size = Math.round(tileSize * scale);
  if (scratch.width !== size) scratch.width = size;
  if (scratch.height !== size) scratch.height = size;
  const ctx = scratch.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
  if (stroke.renderVersion === 2) {
    getStreamingInk(stroke).draw(ctx, 0, 0, { minX: ox, minY: oy, maxX: ox + tileSize, maxY: oy + tileSize });
  } else {
    const ribbon = prepare ? prepare() : prepareInkRibbon(stroke);
    if (ribbon) drawInkRibbonSlice(ctx, { ...ribbon, composite: 'source-over' }, ox, oy, ox + tileSize, oy + tileSize);
    else drawAnnotatedStroke(ctx, { ...stroke, compositeOperation: 'source-over' });
  }
  const image = document.createElement('canvas');
  image.width = Math.max(1, x1 - x0); image.height = Math.max(1, y1 - y0);
  image.getContext('2d')!.drawImage(scratch, x0, y0, image.width, image.height, 0, 0, image.width, image.height);
  const value: Raster = { image, x: ox + x0 / scale, y: oy + y0 / scale, bytes: image.width * image.height * 4, owner, key };
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
