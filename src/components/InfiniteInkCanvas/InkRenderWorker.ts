import { createInkCanvas, setWorkerInkCPU, reusableInkBytes } from '../InkCanvasSurface';
import { postInkTask } from '../InkCooperativeWork';
import { getInkStrokeIndex } from '../PdfAnnotation/InkStrokeIndex';
import { inkRasterCacheStats, registerTileScale, releaseDocumentInkCaches, cancelPendingInkRasters } from '../PdfAnnotation/InkRasterCache';
import { streamingInkStats, scratchInkBytes, clearInkScratch } from '../PdfAnnotation/StreamingInkStroke';
import { materializeTiles, disposeTiles, abandonBuilds, invalidateTileBuilds } from './InkTiles';
import { readTileCache, writeTileCache, deleteTileCache, INK_RENDER_VERSION } from './InkTileCache';
import type { RenderRequest, RenderReply, TileJob } from './InkRenderProtocol';

const port = self as unknown as { onmessage: ((event: MessageEvent<RenderRequest>) => void) | null; postMessage(message: RenderReply, transfer?: Transferable[]): void };
const tiles = new Map<string, HTMLCanvasElement>();
let index = getInkStrokeIndex(tiles);
let epoch = 0;
let jobs: TileJob[] = [];
let requestedJobs: TileJob[] = [];
let completeKeys: Set<string> | null = null;
let active: TileJob | null = null;
let ready = false;
let pumping = false;
let stopped = false;
let generation = 0;
const fingerprints = new WeakMap<object, string>();
// GPU commands outlive their CPU submission; leave headroom for the front canvas.
const pause = (quality: TileJob['quality']) => new Promise<void>(resolve => quality === 'preview' ? postInkTask(resolve) : setTimeout(resolve, 8));
const identity = (job: TileJob) => `${job.epoch}:${job.key}:${job.version}:${job.scale}:${job.quality}`;

async function cacheKey(job: TileJob): Promise<string> {
  const parts: string[] = [INK_RENDER_VERSION, job.key, String(job.scale), job.quality];
  const hashes = await Promise.all((index.grid.get(job.key) ?? []).map(async stroke => {
    let fingerprint = fingerprints.get(stroke);
    if (!fingerprint) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stroke)));
      fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      fingerprints.set(stroke, fingerprint);
    }
    return fingerprint;
  }));
  parts.push(...hashes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function pump(): Promise<void> {
  if (pumping || !ready || stopped) return;
  pumping = true;
  try {
    while (ready && jobs.length && !stopped) {
      const job = jobs[0];
      if (setWorkerInkCPU(job.quality === 'preview')) clearInkScratch();
      active = job;
      const ticket = generation;
      const start = performance.now();
      const key = await cacheKey(job);
      if (ticket !== generation || !ready || stopped) continue;
      const cached = await readTileCache(key);
      if (ticket !== generation || !ready || stopped) continue;
      let cacheHit = false;
      let cachedBitmap: ImageBitmap | null = null;
      if (cached) {
        try {
          cachedBitmap = await createImageBitmap(cached);
          const size = Math.max(1, Math.round(512 * job.scale));
          if (cachedBitmap.width !== size || cachedBitmap.height !== size) { cachedBitmap.close(); cachedBitmap = null; }
        } catch { /* reconstruct from vectors */ }
        if (!cachedBitmap) void deleteTileCache(key);
      }
      if (cachedBitmap) {
        const bitmap = cachedBitmap;
        if (ticket !== generation || !ready || stopped) { bitmap.close(); continue; }
        const canvas = createInkCanvas();
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        bitmap.close();
        registerTileScale(canvas, job.scale);
        tiles.get(job.key)?.getContext('2d');
        const old = tiles.get(job.key); if (old) old.width = 0;
        tiles.set(job.key, canvas);
        cacheHit = true;
      } else {
        invalidateTileBuilds(tiles, new Set([job.key]));
        for (;;) {
          if (ticket !== generation || !ready || stopped || !jobs.some(j => identity(j) === identity(job))) break;
          const res = materializeTiles(tiles, { x: -job.tx * 512, y: -job.ty * 512, zoom: 1 }, 511.999, 511.999, job.scale, {
            margin: 0, fixedScale: job.scale, preview: job.quality === 'preview', budgetMs: job.quality === 'preview' ? 24 : 2,
            maxPoints: job.quality === 'preview' ? 32768 : 512,
            forceKeys: new Set([job.key]),
          });
          if (res.completed.includes(job.key) || res.remaining === 0) break;
          await pause(job.quality);
        }
      }
      if (ticket !== generation || !ready || stopped || !jobs.some(j => identity(j) === identity(job))) continue;
      const canvas = tiles.get(job.key);
      if (!canvas) { jobs = jobs.filter(j => identity(j) !== identity(job)); continue; }
      const bitmap = await createImageBitmap(canvas as unknown as OffscreenCanvas);
      if (ticket !== generation || !ready || stopped) { bitmap.close(); continue; }
      const workerBytes = inkRasterCacheStats().bytes + inkRasterCacheStats().buildingBytes + streamingInkStats().bytes + scratchInkBytes() + reusableInkBytes() + canvas.width * canvas.height * 4;
      port.postMessage({ type: 'tile', job, bitmap, cacheHit, buildMs: performance.now() - start, workerBytes }, [bitmap]);
      if (!cacheHit && job.quality === 'preview') {
        // Encode after publishing. Never hold the display behind cache IO.
        try { const blob = await (canvas as unknown as OffscreenCanvas).convertToBlob(); void writeTileCache(key, blob); } catch { /* expendable */ }
      }
      if (tiles.get(job.key) === canvas) { canvas.width = 0; tiles.delete(job.key); }
      jobs = jobs.filter(j => identity(j) !== identity(job));
      active = null;
      await pause(job.quality);
    }
  } catch (error) {
    port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    pumping = false;
    if (ready && jobs.length && !stopped) postInkTask(() => void pump());
    else if (!jobs.length && !stopped) {
      // Published tiles live in the renderer; keep no duplicate pixel caches while idle.
      disposeTiles(tiles); releaseDocumentInkCaches(); active = null;
      port.postMessage({ type: 'memory', epoch, workerBytes: 0 });
    }
  }
}

port.onmessage = ({ data }) => {
  if (data.type === 'dispose') { stopped = true; jobs = []; disposeTiles(tiles); releaseDocumentInkCaches(); return; }
  if (data.type === 'reset') {
    generation++; epoch = data.epoch; ready = false; jobs = []; requestedJobs = []; completeKeys = new Set();
    disposeTiles(tiles); releaseDocumentInkCaches(); index = getInkStrokeIndex(tiles);
    // The index belongs to the map identity; clear it too on reset.
    index.remove(new Set([...index.bounds.keys()]));
    return;
  }
  if (data.epoch !== epoch) return;
  if (data.type === 'changes') {
    if (!data.append) { generation++; ready = false; abandonBuilds(tiles); cancelPendingInkRasters(); }
    index.remove(new Set([...data.removed, ...data.added.map(s => s.id)]));
    for (const stroke of data.added) index.add(stroke);
  } else if (data.type === 'order') {
    const positions = new Map(data.ids.map((id, i) => [id, i]));
    for (const list of index.grid.values()) list.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
    completeKeys = data.completeKeys ? new Set(data.completeKeys) : null;
    jobs = requestedJobs.filter(job => !completeKeys || completeKeys.has(job.key)).sort((a, b) => a.priority - b.priority);
    ready = true; void pump();
  } else if (data.type === 'viewport') {
    requestedJobs = data.jobs;
    const eligible = data.jobs.filter(job => !completeKeys || completeKeys.has(job.key));
    if (active && !eligible.some(job => identity(job) === identity(active!))) {
      generation++; abandonBuilds(tiles); cancelPendingInkRasters();
    }
    jobs = eligible.slice().sort((a, b) => a.priority - b.priority);
    void pump();
  }
};
