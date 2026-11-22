import { createInkCanvas, releaseReusableInkCanvases } from '../InkCanvasSurface';
import type { PdfStroke } from './PdfTypes';
import { drawAnnotatedStroke, drawInkRibbonSlice, prepareInkRibbon, prepareInkRibbonWork, drawInkRibbonSliceWork, drawPencilWork } from './PdfBrushRenderers';
import { getCommittedStrokeBounds, getInkStrokeIndex } from './InkStrokeIndex';
import {
  getStreamingInk, StreamingInkStroke, renderStrokeOnce, renderStrokePreview, clearStreamingInk, usesStreamingInk, usesOnePassInk,
  startStrokeOnceBuild, startStrokeOnceBuildWork, pumpStrokeOnceBuild, finishStrokeOnceBuild, type StrokeOnceBuild,
} from './StreamingInkStroke';
import { resolveFeatherWorld } from './InkMath';
import { drawInkShape } from '../InkShapeGeometry';
import { drawVariableRibbonWork } from './InkRibbonRenderer';
import { previewGeometryWork } from './InkPreviewGeometry';

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
const LIMIT = (typeof document === 'undefined' ? 16 : 160) * 1024 * 1024;
const owners = new WeakMap<PdfStroke, Map<string, Raster>>();
const lru = new Map<Raster, true>();
let bytes = 0, hits = 0, misses = 0;
/** Worst synchronous raster request since the last clear. Long historical
 * requests use the cooperative queue instead of this synchronous path. */
let worstMissMs = 0;

export function inkRasterCacheStats() {
  let buildingBytes = 0;
  for (const task of cooperativeQueue) buildingBytes += (task.canvas ? task.canvas.width * task.canvas.height * 4 : 0) + (task.extraBytes ?? 0);
  for (const task of rasterBuildQueue) buildingBytes += task.build.coverage.width * task.build.coverage.height * 4;
  return { bytes, buildingBytes, limit: LIMIT, hits, misses, entries: lru.size, worstMissMs: Math.round(worstMissMs * 10) / 10 };
}
export function trimInkRasters(budget: number): void {
  while (bytes > budget && lru.size) {
    const first = lru.keys().next().value!;
    bytes -= first.bytes; lru.delete(first); first.owner.delete(first.key); first.image.width = 0;
  }
}

// ---- Per-tile bake scale ------------------------------------------------------
//
// Each tile canvas records the scale it was rasterized at, because tiles at
// different scales coexist in normal use: the materialization chain, a pen-up
// stamp and a pan all create tiles while others are still at the previous
// density. Every writer must use the scale OF THE TILE IT IS WRITING INTO —
// the dirty-region repair computes its copy-back rectangle in that tile's pixel
// space, so a mismatched scale moves ink rather than blurring it.
//
// It cannot be a property of the tile MAP for the same reason. Lives here
// because this is the lowest module that creates tiles (see stampCachedStroke).

const tileScales = new WeakMap<HTMLCanvasElement, number>();

export function registerTileScale(canvas: HTMLCanvasElement, scale: number): void {
  tileScales.set(canvas, scale);
}

/** The scale a tile was rasterized at. Tiles made before the scale was tracked
 *  (or by a caller that does not track it) were baked at the legacy 3×. */
export function tileScaleOf(canvas: HTMLCanvasElement): number {
  return tileScales.get(canvas) ?? LEGACY_BAKE_SCALE;
}

/** The bake scale every tile used before it became adaptive, and still the
 *  fallback for surfaces that keep a fixed one (the PDF page). */
export const LEGACY_BAKE_SCALE = 3;

/**
 * Drop cached per-stroke rasters that were rendered for another bake scale.
 *
 * The cache key already includes the scale, so a stale raster can never be drawn
 * at the wrong size — but it IS still counted against the byte ceiling, so after
 * a re-bake two or three scales' worth of the same strokes compete for the same
 * budget and evict each other during a repair. A miss is cheap now (one pass),
 * so throwing them away on a scale change is strictly better than LRU thrash.
 */
export function dropRastersNotAtScale(scale: number): void {
  for (const entry of [...lru.keys()]) {
    if (entry.key.endsWith(`:${scale}`)) continue;
    bytes -= entry.bytes; lru.delete(entry); entry.owner.delete(entry.key); entry.image.width = 0;
  }
}

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
  releaseReusableInkCanvases();
}
export function clearInkRasterCache(): void {
  for (const task of cooperativeQueue) { task.work.return(undefined as never); task.owner.delete(task.key); }
  cooperativeQueue.length = 0;
  for (const entry of lru.keys()) { entry.owner.delete(entry.key); entry.image.width = 0; }
  // In-flight builds hold live coverage canvases and would otherwise complete
  // into a cache the caller just emptied.
  for (const e of rasterBuildQueue) { e.buildOwner.delete(e.key); e.build.coverage.width = 0; }
  rasterBuildQueue.length = 0;
  lru.clear(); bytes = 0; hits = 0; misses = 0; worstMissMs = 0;
}

/** The crop rect (tile-canvas pixel space) of one stroke's raster in one tile,
 *  padded past the tile edge by the feather's 3σ footprint so the blur cannot
 *  starve at the boundary (the tile-seam bug). Shared by the synchronous and the
 *  sliced build paths — they must agree to the pixel. */
function cropFor(stroke: PdfStroke, tx: number, ty: number, tileSize: number, scale: number) {
  const b = getCommittedStrokeBounds(stroke);
  const ox = tx * tileSize, oy = ty * tileSize;
  const featherWorld = resolveFeatherWorld(stroke, [stroke.size]);
  // 3σ is where a Gaussian has effectively died out, and the blur's argument is a
  // standard deviation (CSS/Skia blur(Npx) ⇒ σ = N), not a radius.
  const blurPad = Math.ceil(featherWorld * scale * 3) + 2;
  const cropPad = Math.max(3, 3 / scale, featherWorld + 2 / scale);
  return {
    ox, oy,
    x0: Math.max(-blurPad, Math.floor((b.minX - ox - cropPad) * scale)),
    y0: Math.max(-blurPad, Math.floor((b.minY - oy - cropPad) * scale)),
    x1: Math.min(tileSize * scale + blurPad, Math.ceil((b.maxX - ox + cropPad) * scale)),
    y1: Math.min(tileSize * scale + blurPad, Math.ceil((b.maxY - oy + cropPad) * scale)),
  };
}

// ---- Sliced raster builds (the tile-build path) --------------------------------
//
// A stroke raster is the smallest unit the tile builder can wait for, and one
// monster stroke's raster measured 46 ms whole on a real dense document — a
// frame-blocking chunk no budget can slice, because the budget is checked
// BETWEEN strokes. But a raster's coverage is drawn one SEGMENT at a time, and
// each segment is an independent composite onto the same canvas in the same
// order — so the build pauses between segments and resumes on a later pass, and
// the finished raster is pixel-identical to a synchronous one (same code, pauses
// included). The colour-in/blur/alpha finishing stays atomic; it is one
// composite, not a loop.

interface InFlightBuild {
  /** Where the finished raster is registered (the stroke's raster cache). */
  rasterOwner: Map<string, Raster>;
  /** Where the in-flight build itself is registered, for cleanup. */
  buildOwner: Map<string, StrokeOnceBuild>;
  key: string;
  build: StrokeOnceBuild;
}
const rasterBuildOwners = new WeakMap<PdfStroke, Map<string, StrokeOnceBuild>>();
const rasterBuildQueue: InFlightBuild[] = [];
/** In-flight coverage canvases, bounded: each holds up to a tile's worth of
 *  pixels (9.4 MiB at a 3× bake). The oldest is dropped beyond the cap and
 *  restarts if its tile asks again. */
const RASTER_BUILDS_MAX = 8;
/** Strokes at or below this many run segments build synchronously — a pass is
 *  ~0.03 ms per segment, so these cost ~1.5 ms at most, matching the moving
 *  frame's budget; slicing them would only delay the ordinary case by a frame. */
const SYNC_BUILD_MAX_SEGMENTS = typeof document === 'undefined' ? 512 : 48;
interface CooperativeRaster { owner: Map<string, CooperativeRaster>; key: string; stroke: PdfStroke; work: Generator<void, Raster, unknown>; canvas?: HTMLCanvasElement; extraBytes?: number }
const cooperativeOwners = new WeakMap<PdfStroke, Map<string, CooperativeRaster>>();
const cooperativeQueue: CooperativeRaster[] = [];
export function cancelPendingInkRasters(strokes?: ReadonlySet<PdfStroke>): void {
  for (let i = cooperativeQueue.length - 1; i >= 0; i--) {
    const task = cooperativeQueue[i];
    if (strokes && !strokes.has(task.stroke)) continue;
    task.work.return(undefined as never); task.owner.delete(task.key); cooperativeQueue.splice(i, 1);
  }
  for (let i = rasterBuildQueue.length - 1; i >= 0; i--) {
    const task = rasterBuildQueue[i];
    if (strokes && !strokes.has(task.build.stroke)) continue;
    task.build.coverage.width = 0; task.buildOwner.delete(task.key); rasterBuildQueue.splice(i, 1);
  }
}

/** Every expensive phase can pause, including sampling, legacy ribbons and pencil grain. */
function* buildCooperativeRaster(task: CooperativeRaster, stroke: PdfStroke, tx: number, ty: number, tileSize: number, scale: number,
  owner: Map<string, Raster>, key: string, preview: boolean): Generator<void, Raster, unknown> {
  const { ox, oy, x0, y0, x1, y1 } = cropFor(stroke, tx, ty, tileSize, scale);
  const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
  const minX = ox + x0 / scale, minY = oy + y0 / scale, maxX = minX + width / scale, maxY = minY + height / scale;
  let image: HTMLCanvasElement | null = null, handedOff = false;
  try {
    if (stroke.geometry) {
      image = createInkCanvas(); image.width = width; image.height = height; task.canvas = image;
      const ctx = image.getContext('2d')!;
      ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
      drawInkShape(ctx, { ...stroke, compositeOperation: 'source-over' });
    } else if (usesOnePassInk(stroke)) {
      const build = yield* startStrokeOnceBuildWork(stroke, scale, minX, minY, maxX, maxY);
      if (build) {
        task.canvas = build.coverage;
        if (preview) {
          const geometry = yield* previewGeometryWork(build.pts, build.widths, scale);
          yield* drawVariableRibbonWork(build.cctx, geometry.points, geometry.widths, '#000', 1, 'source-over', 0, 0, false);
        }
        else while (!pumpStrokeOnceBuild(build, 1).done) yield;
        image = finishStrokeOnceBuild(build); task.canvas = undefined;
      }
    } else {
      image = createInkCanvas(); image.width = width; image.height = height; task.canvas = image;
      const ctx = image.getContext('2d')!;
      ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
      if (usesStreamingInk(stroke)) {
        const bounds = { minX: minX - 1, minY: minY - 1, maxX: maxX + 1, maxY: maxY + 1 };
        const ink = new StreamingInkStroke(stroke, bounds);
        try {
          while (!ink.prepared) { ink.update(16, true); task.extraBytes = ink.memoryBytes; yield; }
          ink.draw(ctx, 0, 0, bounds);
        } finally { ink.dispose(); task.extraBytes = 0; }
      } else {
        const ribbon = yield* prepareInkRibbonWork(stroke);
        if (ribbon) yield* drawInkRibbonSliceWork(ctx, { ...ribbon, composite: 'source-over' }, minX, minY, maxX, maxY);
        else yield* drawPencilWork(ctx, { ...stroke, compositeOperation: 'source-over' }, 0, 0);
      }
    }
    if (!image) { image = createInkCanvas(); image.width = image.height = 1; }
    handedOff = true;
    return { image, x: minX, y: minY, bytes: image.width * image.height * 4, owner, key };
  } finally {
    if (!handedOff) { if (task.canvas) task.canvas.width = 0; if (image) image.width = 0; }
  }
}

/** The tile builder's entry point: the cached raster if it is READY, otherwise
 *  null — and a build started, to be advanced by pumpStrokeRasterBuilds. The
 *  caller must pause on null (drawing anything later in its tile would break
 *  z-order). Immediate local repairs keep using getStrokeRaster. Pen-up is
 *  handed off to background tiles. */
export function requestStrokeRaster(stroke: PdfStroke, tx: number, ty: number, tileSize: number, scale: number, preview = false): Raster | null {
  let owner = owners.get(stroke);
  if (!owner) { owner = new Map(); owners.set(stroke, owner); }
  const key = `${tx}:${ty}:${tileSize}:${scale}${preview ? ':preview' : ''}`;
  const cached = owner.get(key);
  if (cached) { hits++; lru.delete(cached); lru.set(cached, true); return cached; }

  if (!stroke.geometry && stroke.points.length > SYNC_BUILD_MAX_SEGMENTS) {
    let tasks = cooperativeOwners.get(stroke);
    if (!tasks) { tasks = new Map(); cooperativeOwners.set(stroke, tasks); }
    if (tasks.has(key)) return null;
    // Back pressure, never evict unfinished work: 9 visible tiles must not starve an 8-job queue.
    if (cooperativeQueue.length >= RASTER_BUILDS_MAX) return null;
    const task = { owner: tasks, key, stroke } as CooperativeRaster;
    task.work = buildCooperativeRaster(task, stroke, tx, ty, tileSize, scale, owner, key, preview);
    tasks.set(key, task); cooperativeQueue.push(task); misses++;
    return null;
  }

  // Cheap geometry (ribbons, pencil grain) and small runs build synchronously;
  // slicing them would delay every ordinary stroke by a frame for nothing.
  const small = !!stroke.geometry || !usesOnePassInk(stroke);
  if (small || preview) return getStrokeRaster(stroke, tx, ty, tileSize, scale, undefined, preview);

  let buildMap = rasterBuildOwners.get(stroke);
  if (buildMap?.has(key)) return null; // already cooking

  const crop = cropFor(stroke, tx, ty, tileSize, scale);
  const minX = crop.ox + crop.x0 / scale, minY = crop.oy + crop.y0 / scale;
  const maxX = crop.ox + crop.x1 / scale, maxY = crop.oy + crop.y1 / scale;
  const build = startStrokeOnceBuild(stroke, scale, minX, minY, maxX, maxY);
  misses++;
  if (!build) {
    // The stroke cannot reach this tile (an L-shape's empty corner) — the same
    // empty marker the synchronous path records.
    const canvas = createInkCanvas();
    canvas.width = canvas.height = 1;
    const value: Raster = { image: canvas, x: 0, y: 0, bytes: 4, owner, key };
    owner.set(key, value); lru.set(value, true); bytes += 4;
    return value;
  }
  if (build.count <= SYNC_BUILD_MAX_SEGMENTS) {
    const t0 = performance.now();
    pumpStrokeOnceBuild(build, Infinity);
    const image = finishStrokeOnceBuild(build);
    const ms = performance.now() - t0;
    if (ms > worstMissMs) worstMissMs = ms;
    const value: Raster = { image, x: minX, y: minY, bytes: build.width * build.height * 4, owner, key };
    while (bytes + value.bytes > LIMIT && lru.size) {
      const first = lru.keys().next().value!;
      bytes -= first.bytes; lru.delete(first); first.owner.delete(first.key); first.image.width = 0;
    }
    owner.set(key, value); lru.set(value, true); bytes += value.bytes;
    return value;
  }

  if (!buildMap) { buildMap = new Map(); rasterBuildOwners.set(stroke, buildMap); }
  buildMap.set(key, build);
  if (rasterBuildQueue.length >= RASTER_BUILDS_MAX) {
    const oldest = rasterBuildQueue.shift()!;
    oldest.buildOwner.delete(oldest.key);
    oldest.build.coverage.width = 0;
  }
  rasterBuildQueue.push({ rasterOwner: owner, buildOwner: buildMap, key, build });
  return null;
}

/** Advance the in-flight builds, oldest first (the tile that has waited longest
 *  unblocks first), within the caller's deadline and points quota — the same
 *  quota the tile builder draws from, so a pass stays bounded as a whole. */
export function pumpStrokeRasterBuilds(deadline: number, quota: { points: number }, chunk = 16): void {
  while (cooperativeQueue.length && quota.points > 0 && performance.now() < deadline) {
    const task = cooperativeQueue[0], step = task.work.next(); quota.points--;
    if (step.done) {
      const value = step.value;
      while (bytes + value.bytes > LIMIT && lru.size) {
        const first = lru.keys().next().value!;
        bytes -= first.bytes; lru.delete(first); first.owner.delete(first.key); first.image.width = 0;
      }
      value.owner.set(value.key, value); lru.set(value, true); bytes += value.bytes;
      task.owner.delete(task.key); cooperativeQueue.shift();
    }
  }
  while (rasterBuildQueue.length > 0 && quota.points > 0 && performance.now() < deadline) {
    const entry = rasterBuildQueue[0];
    const { done, drawn } = pumpStrokeOnceBuild(entry.build, Math.min(quota.points, chunk));
    quota.points -= drawn;
    if (done) {
      const t0 = performance.now();
      const image = finishStrokeOnceBuild(entry.build);
      const ms = performance.now() - t0;
      if (ms > worstMissMs) worstMissMs = ms;
      const b = entry.build;
      const value: Raster = { image, x: b.minX, y: b.minY, bytes: b.width * b.height * 4, owner: entry.rasterOwner, key: entry.key };
      while (bytes + value.bytes > LIMIT && lru.size) {
        const first = lru.keys().next().value!;
        bytes -= first.bytes; lru.delete(first); first.owner.delete(first.key); first.image.width = 0;
      }
      entry.rasterOwner.set(entry.key, value); lru.set(value, true); bytes += value.bytes;
      entry.buildOwner.delete(entry.key);
      rasterBuildQueue.shift();
    }
  }
}

/** Builds that have started but not finished. The tile chain must keep calling
 *  materializeTiles while this is non-zero, or a paused tile never resumes. */
export function pendingRasterBuilds(): number {
  return rasterBuildQueue.length + cooperativeQueue.length;
}

/** Cropped, already feathered pixels of ONE committed stroke in one tile.
 * Cache is shared by stamping and erasing, bounded to LIMIT bytes, with LRU
 * eviction. Source-over and destination-out are replayed in vector order. */
export function getStrokeRaster(stroke: PdfStroke, tx: number, ty: number, tileSize: number, scale: number, prepare?: () => Prepared, preview = false): Raster {
  let owner = owners.get(stroke);
  if (!owner) { owner = new Map(); owners.set(stroke, owner); }
  const key = `${tx}:${ty}:${tileSize}:${scale}${preview ? ':preview' : ''}`;
  const cached = owner.get(key);
  if (cached) { hits++; lru.delete(cached); lru.set(cached, true); return cached; }
  misses++;
  const { ox, oy, x0, y0, x1, y1 } = cropFor(stroke, tx, ty, tileSize, scale);
  // (The crop extends past the tile edge by the feather's 3σ footprint — see
  // cropFor. A raster cropped flush with the edge dimmed the ink there: a thin
  // dark line on every tile boundary a feathered stroke crossed.)
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  // World-space rect this raster covers — what the renderers slice to.
  const minX = ox + x0 / scale, minY = oy + y0 / scale;
  const maxX = ox + (x0 + w) / scale, maxY = oy + (y0 + h) / scale;
  // Which renderer paints a stroke is decided by the STROKE, never by what
  // happens to be in a cache: a raster must not depend on the order tiles were
  // built in, or the same ink would look different depending on where the user
  // looked first.
  //
  // Solid streaming ink is painted in ONE pass — the per-cell surfaces the
  // incremental raster allocates are what made opening a dense canvas take tens
  // of seconds, and a committed stroke has nothing incremental about it. Earlier
  // textured pencils keep their incremental raster, and
  // everything older keeps the ribbon renderer it was drawn with.
  const missStart = performance.now();
  let image: HTMLCanvasElement | null = null;
  let empty = false;
  if (!stroke.geometry && usesOnePassInk(stroke)) {
    image = (preview ? renderStrokePreview : renderStrokeOnce)(stroke, scale, minX, minY, maxX, maxY);
    if (!image) {
      // The bounding box covers a tile the path never actually enters (an
      // L-shaped stroke, say), so this tile gets nothing from it. Recorded as an
      // empty raster — NOT by falling through to the incremental raster, which
      // would build a whole stroke's coverage in order to paint nothing.
      empty = true;
      image = createInkCanvas();
      image.width = image.height = 1;
    }
  }
  if (!image) {
    // Render into a canvas cropped to this stroke's dirty rect (a full tile is
    // 1536² = 9.4 MiB at 3×; a typical stroke needs a few hundred KiB).
    image = createInkCanvas();
    image.width = w; image.height = h;
    const ctx = image.getContext('2d')!;
    ctx.setTransform(scale, 0, 0, scale, -ox * scale - x0, -oy * scale - y0);
    if (stroke.geometry) {
      drawInkShape(ctx, { ...stroke, compositeOperation: 'source-over' });
    } else if (usesStreamingInk(stroke)) {
      getStreamingInk(stroke).draw(ctx, 0, 0, { minX: minX - 1, minY: minY - 1, maxX: maxX + 1, maxY: maxY + 1 });
    } else {
      const ribbon = prepare ? prepare() : prepareInkRibbon(stroke);
      if (ribbon) drawInkRibbonSlice(ctx, { ...ribbon, composite: 'source-over' }, minX, minY, maxX, maxY);
      else drawAnnotatedStroke(ctx, { ...stroke, compositeOperation: 'source-over' });
    }
  }
  const missMs = performance.now() - missStart;
  if (missMs > worstMissMs) worstMissMs = missMs;
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
        tile = createInkCanvas();
        tile.width = tile.height = Math.round(tileSize * scale);
        registerTileScale(tile, scale);
        tiles.set(key, tile);
      }
      // An EXISTING tile keeps its own density: writing into it at another scale
      // would place this stroke at the wrong size within the tile. It gets
      // upgraded as a whole by the materialization chain, not piecemeal here.
      const s = tileScaleOf(tile);
      const raster = getStrokeRaster(stroke, tx, ty, tileSize, s, prepare);
      const ctx = tile.getContext('2d')!;
      ctx.setTransform(s, 0, 0, s, -tx * tileSize * s, -ty * tileSize * s);
      drawStrokeRaster(ctx, stroke, raster, s);
    }
  }
  // Streaming ink is deliberately NOT released here. Keeping it lets a later
  // raster-cache miss re-composite this stroke (~1ms) instead of re-processing
  // its raw points (~70ms); StreamingInkStroke self-bounds with its own LRU.
  // Releasing here is what made a stroke-dense erase spike to hundreds of ms.
}
