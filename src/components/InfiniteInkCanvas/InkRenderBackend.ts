import type { PdfStroke } from '../PdfAnnotation/PdfTypes';
import { postInkTask } from '../InkCooperativeWork';
import { getCommittedStrokeBounds, getInkStrokeIndex } from '../PdfAnnotation/InkStrokeIndex';
import { drawLiveAnnotatedStroke } from '../PdfAnnotation/PdfBrushRenderers';
import { drawDragPreview, type DragPreview } from '../PdfAnnotation/InkDragPreview';
import { registerTileScale, tileScaleOf, inkRasterCacheStats, trimInkRasters, cancelPendingInkRasters } from '../PdfAnnotation/InkRasterCache';
import { streamingInkStats, releaseStreamingInk, scratchInkBytes } from '../PdfAnnotation/StreamingInkStroke';
import { createInkCanvas, inkPixelTransform, INK_MEMORY_BUDGET, INK_WORKER_MEMORY_RESERVE, reusableInkBytes } from '../InkCanvasSurface';
import { reportInkFrame } from '../InkFrameStats';
import { inkTraceId, inkTraceList, inkStrokeCoverage, recordInkTrace, registerInkTrace, unregisterInkTrace, type InkTraceDetails } from '../InkDiagnostics';
import { materializeTiles, invalidateTileBuilds, setTargetBakeScale, inkTileBytes, inkTileBuildBytes } from './InkTiles';
import type { Camera } from './types';
import { tileKey, type TileJob, type RenderReply, type RenderRequest } from './InkRenderProtocol';

export function strokeTileKeys(stroke: PdfStroke): string[] {
  const b = getCommittedStrokeBounds(stroke), result: string[] = [];
  if (!stroke.points.length) return result;
  for (let ty = Math.floor(b.minY / 512); ty <= Math.floor(b.maxY / 512); ty++) {
    for (let tx = Math.floor(b.minX / 512); tx <= Math.floor(b.maxX / 512); tx++) result.push(tileKey(tx, ty));
  }
  return result;
}

export function protectInkSegment(keys: Set<string>, x: number, y: number, previous: { x: number; y: number } | undefined, pad: number): void {
  const a = previous ?? { x, y };
  for (let ty = Math.floor((Math.min(a.y, y) - pad) / 512); ty <= Math.floor((Math.max(a.y, y) + pad) / 512); ty++) {
    for (let tx = Math.floor((Math.min(a.x, x) - pad) / 512); tx <= Math.floor((Math.max(a.x, x) + pad) / 512); tx++) keys.add(tileKey(tx, ty));
  }
}

interface ReadyTile { version: number; scale: number; canvas: HTMLCanvasElement; quality: TileJob['quality'] }
interface PendingStroke { stroke: PdfStroke; versions: Map<string, number> }
interface PendingDrag { preview: DragPreview; dx: number; dy: number; ids: Set<string> }
interface TileTransition { previous: HTMLCanvasElement; current: HTMLCanvasElement; started: number }
const traceJob = (job: TileJob) => ({ key: job.key, epoch: job.epoch, version: job.version, scale: job.scale, quality: job.quality, priority: job.priority });
const TRANSITION_MS = 120;
const TRANSITION_BUDGET = 4 * 1048576;
const RESIDENT_TILE_BUDGET = 96 * 1048576;
export interface InkBackendOptions {
  surface?: 'canvas' | 'pdf';
  tiles: () => Map<string, HTMLCanvasElement>;
  publish: (keys?: ReadonlySet<string>) => void;
  protectedKeys: () => ReadonlySet<string>;
  fixedScale?: number;
  displayBytes?: () => number;
  /** Dependency injection for failure/race tests. null forces cooperative fallback. */
  worker?: Worker | null;
}

/** Background rendering is an accelerator; vectors and the local index stay authoritative. */
export class InkRenderBackend {
  private worker: Worker | null = null;
  private source: PdfStroke[] | null = null;
  private previous = new Map<string, PdfStroke>();
  private versions = new Map<string, number>();
  private ready = new Map<string, ReadyTile>();
  private pending = new Map<string, PendingStroke>();
  private pendingDrag: PendingDrag | null = null;
  private transitions = new Map<string, TileTransition>();
  private jobs: TileJob[] = [];
  private epoch = 1;
  private sending = 0;
  private transferPending = false;
  private resumeTransfer: (() => void) | null = null;
  private transferFirstKey: string | undefined;
  private initialized = false;
  private disposed = false;
  private workerBytes = 0;
  private viewportSignature = '';
  private traceViewportSignature = '';
  private tracedPending = new Map<string, string>();
  private prefetchDirection = { x: 0, y: 0 };
  private lastViewport: { cam: Camera; vw: number; vh: number; dpr: number; settled: boolean } | null = null;

  constructor(private options: InkBackendOptions) {
    try {
      this.worker = options.worker !== undefined ? options.worker :
        typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
          ? new Worker(new URL('./InkRenderWorker.ts', import.meta.url), { type: 'module' }) : null;
      if (this.worker) {
        this.worker.onmessage = event => this.receive(event.data as RenderReply);
        this.worker.onerror = () => this.fallback();
        this.worker.onmessageerror = () => this.fallback();
      }
    } catch { this.worker = null; }
    if (import.meta.env.DEV) {
      registerInkTrace(this, () => this.traceState());
      this.trace('backend-open', { surface: options.surface ?? 'canvas', backend: this.worker ? 'worker' : 'fallback' });
    }
  }

  private trace(type: string, details: InkTraceDetails = {}): void {
    if (import.meta.env.DEV) recordInkTrace(this, type, { layer: inkTraceId(this.options.tiles()), epoch: this.epoch, ...details });
  }

  private traceState(): InkTraceDetails {
    const tiles = this.options.tiles(), index = getInkStrokeIndex(tiles), view = this.lastViewport;
    return { kind: 'backend', surface: this.options.surface ?? 'canvas', layer: inkTraceId(tiles), epoch: this.epoch,
      backend: this.worker ? 'worker' : 'fallback', sourceCount: this.source?.length ?? 0, indexedStrokeCount: index.bounds.size,
      transferPending: this.transferPending, transferFirstKey: this.transferFirstKey ?? null,
      viewport: view ? { camera: { ...view.cam }, width: view.vw, height: view.vh, dpr: view.dpr, settled: view.settled } : null,
      jobs: inkTraceList(this.jobs, traceJob), protectedKeys: inkTraceList(this.options.protectedKeys(), key => key),
      versions: inkTraceList(this.versions, ([key, version]) => ({ key, version })),
      ready: inkTraceList(this.ready, ([key, entry]) => ({ key, version: entry.version, scale: entry.scale, quality: entry.quality,
        canvas: inkTraceId(entry.canvas), currentCanvas: tiles.get(key) === entry.canvas, width: entry.canvas.width, height: entry.canvas.height })),
      pending: inkTraceList(this.pending, ([id, entry]) => ({ id, versions: inkTraceList(entry.versions, ([key, version]) => ({ key, version })) })),
    };
  }

  private publish(keys: ReadonlySet<string> | undefined, reason: string): void {
    if (import.meta.env.DEV) this.trace('publish', { reason, keys: keys ? inkTraceList(keys, key => key) : null });
    this.options.publish(keys);
  }

  private post(message: RenderRequest): void {
    if (import.meta.env.DEV) this.trace('worker-send', { message: message.type,
      ...('epoch' in message ? { messageEpoch: message.epoch } : {}),
      ...(message.type === 'changes' ? { addedCount: message.added.length, removedCount: message.removed.length, append: !!message.append } : {}),
      ...(message.type === 'order' ? { strokeCount: message.ids.length, completeKeys: message.completeKeys ?? null } : {}),
      ...(message.type === 'viewport' ? { jobs: inkTraceList(message.jobs, traceJob) } : {}),
    });
    try { this.worker?.postMessage(message); } catch { this.fallback(); }
  }

  sync(strokes: PdfStroke[]): void {
    if (this.disposed || strokes === this.source) return;
    this.source = strokes;
    const next = new Map(strokes.map(stroke => [stroke.id, stroke]));
    const added = strokes.filter(stroke => this.previous.get(stroke.id) !== stroke);
    const removed = [...this.previous.keys()].filter(id => !next.has(id));
    const commonBefore = [...this.previous.keys()].filter(id => next.has(id));
    const commonAfter = strokes.filter(stroke => this.previous.has(stroke.id));
    const orderChanged = commonBefore.some((id, i) => commonAfter[i]?.id !== id);
    if (this.initialized && !added.length && !removed.length && !orderChanged) return;
    cancelPendingInkRasters(new Set([...added.map(stroke => this.previous.get(stroke.id)), ...removed.map(id => this.previous.get(id))].filter((stroke): stroke is PdfStroke => !!stroke)));
    const affected = new Set<string>();
    for (const stroke of added) {
      const old = this.previous.get(stroke.id);
      if (old) {
        // An undo can replace a stroke without removing its id. Its previous
        // destination may now be empty and will never acknowledge the old ink.
        this.suppress([stroke.id]);
        for (const key of strokeTileKeys(old)) affected.add(key);
      }
      for (const key of strokeTileKeys(stroke)) affected.add(key);
    }
    for (const id of removed) {
      for (const key of strokeTileKeys(this.previous.get(id)!)) affected.add(key);
      this.suppress([id]);
    }
    if (orderChanged) for (const key of getInkStrokeIndex(this.options.tiles()).grid.keys()) affected.add(key);
    const canceledFades = new Set<string>();
    for (const key of affected) {
      if (this.transitions.has(key)) canceledFades.add(key);
      this.dropTransition(key); this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
    invalidateTileBuilds(this.options.tiles(), affected);
    if (import.meta.env.DEV) this.trace('source-sync', { sourceCount: strokes.length, addedCount: added.length, removedCount: removed.length,
      orderChanged, affected: inkTraceList(affected, key => ({ key, version: this.versions.get(key) ?? 0 })) });
    if (canceledFades.size) this.publish(canceledFades, 'cancel-fade');
    this.previous = next;
    const first = !this.initialized;
    this.initialized = true;
    if (this.worker) {
      const ticket = ++this.sending;
      this.resumeTransfer = null; this.transferFirstKey = undefined;
      // A newer edit during a large open restarts a bounded transfer, never a partial scene.
      const sendAll = first || this.transferPending || added.length > 256;
      this.transferPending = true;
      if (sendAll) { this.epoch++; this.post({ type: 'reset', epoch: this.epoch }); }
      // Pause old vectors before a new-version viewport can overtake the deferred edit.
      else this.post({ type: 'changes', epoch: this.epoch, added: [], removed: [] });
      let changes = sendAll ? strokes : added;
      const ids = strokes.map(stroke => stroke.id);
      let firstEnd = 0, firstKey: string | undefined;
      const send = (offset: number) => {
        if (ticket !== this.sending || this.disposed || !this.worker) return;
        if (offset === 0 && sendAll) {
          firstKey = this.jobs.filter(job => job.priority < 10000).sort((a, b) => a.priority - b.priority)[0]?.key;
          const firstIds = new Set((firstKey ? getInkStrokeIndex(this.options.tiles()).grid.get(firstKey) : [])?.map(stroke => stroke.id));
          const first = strokes.filter(stroke => firstIds.has(stroke.id));
          firstEnd = first.length;
          changes = [...first, ...strokes.filter(stroke => !firstIds.has(stroke.id))];
        }
        const end = Math.min(changes.length, offset + 256, offset < firstEnd ? firstEnd : Infinity);
        this.post({ type: 'changes', epoch: this.epoch, added: changes.slice(offset, end),
          removed: offset === 0 && !sendAll ? removed : [], append: sendAll && firstEnd > 0 && offset >= firstEnd });
        if (end === firstEnd && firstKey) this.post({ type: 'order', epoch: this.epoch, ids, completeKeys: [firstKey] });
        if (end < changes.length && end === firstEnd && firstKey) {
          // Let one complete tile publish before indexing the rest of a large scene.
          this.transferFirstKey = firstKey;
          const resume = () => {
            if (this.resumeTransfer !== resume) return;
            this.resumeTransfer = null; this.transferFirstKey = undefined;
            postInkTask(() => send(end));
          };
          this.resumeTransfer = resume;
          setTimeout(resume, 250);
        } else if (end < changes.length) postInkTask(() => send(end));
        else {
          this.transferPending = false;
          this.post({ type: 'order', epoch: this.epoch, ids });
          if (this.lastViewport) this.requestViewport(this.lastViewport.cam, this.lastViewport.vw, this.lastViewport.vh, this.lastViewport.dpr, this.lastViewport.settled);
        }
      };
      postInkTask(() => send(0));
    }
  }

  retain(stroke: PdfStroke, strokes: PdfStroke[]): void {
    this.retainMany([stroke], strokes);
  }

  retainMany(moved: PdfStroke[], strokes: PdfStroke[], drag?: Omit<PendingDrag, 'ids'>): void {
    this.sync(strokes);
    if (drag) {
      this.releasePendingDrag();
      this.pendingDrag = { ...drag, ids: new Set(moved.map(stroke => stroke.id)) };
    }
    for (const stroke of moved) {
      const versions = new Map(strokeTileKeys(stroke).map(key => [key, this.versions.get(key) ?? 0]));
      this.pending.set(stroke.id, { stroke, versions });
      if (import.meta.env.DEV && moved.length === 1) this.trace('stroke-commit', { ...inkStrokeCoverage(this.options.tiles(), stroke),
        versions: inkTraceList(versions, ([key, version]) => ({ key, version })) });
    }
  }

  private releasePendingDrag(): void {
    if (this.pendingDrag) this.pendingDrag.preview.canvas.width = 0;
    this.pendingDrag = null;
  }

  suppress(ids: Iterable<string>, repairedTiles?: Iterable<string>): void {
    // The old side of a LOD blend still has the pixels removed by a local repair.
    if (repairedTiles) for (const key of repairedTiles) this.dropTransition(key);
    for (const id of ids) {
      if (this.pendingDrag?.ids.has(id)) this.releasePendingDrag();
      const pending = this.pending.get(id);
      if (pending) releaseStreamingInk(pending.stroke);
      this.pending.delete(id);
      this.tracedPending.delete(id);
    }
  }

  requestViewport(cam: Camera, vw: number, vh: number, dpr: number, settled: boolean): number {
    if (this.disposed) return 0;
    const previousView = this.lastViewport;
    if (previousView && (cam.x !== previousView.cam.x || cam.y !== previousView.cam.y)) {
      this.prefetchDirection = { x: previousView.cam.x - cam.x, y: previousView.cam.y - cam.y };
    }
    this.lastViewport = { cam, vw, vh, dpr, settled };
    const tiles = this.options.tiles();
    const target = this.options.fixedScale ?? setTargetBakeScale(tiles, cam.zoom * dpr);
    const tx0 = Math.floor(-cam.x / cam.zoom / 512), ty0 = Math.floor(-cam.y / cam.zoom / 512);
    const tx1 = Math.floor((vw - cam.x) / cam.zoom / 512), ty1 = Math.floor((vh - cam.y) / cam.zoom / 512);
    const protectedKeys = this.options.protectedKeys();
    const upgrade = settled && protectedKeys.size === 0;
    const grid = getInkStrokeIndex(tiles).grid;
    const jobs: TileJob[] = [];
    const viewBytes = (tx1 - tx0 + 1) * (ty1 - ty0 + 1) * (512 * target) ** 2 * 4;
    const previewBytes = (tx1 - tx0 + 3) * (ty1 - ty0 + 3) * (512 * Math.min(target, .25)) ** 2 * 4;
    // Prefetch that trim immediately evicts churns GPU work and strands the queue.
    const prefetch = viewBytes + previewBytes < RESIDENT_TILE_BUDGET
      && viewBytes + previewBytes + (this.options.displayBytes?.() ?? 0) + INK_WORKER_MEMORY_RESERVE < INK_MEMORY_BUDGET;
    const handoffKeys = new Set<string>();
    for (const pending of this.pending.values()) for (const key of pending.versions.keys()) handoffKeys.add(key);
    for (let ty = ty0 - 1; ty <= ty1 + 1; ty++) for (let tx = tx0 - 1; tx <= tx1 + 1; tx++) {
      const key = tileKey(tx, ty);
      if (!grid.has(key) || protectedKeys.has(key)) continue;
      const version = this.versions.get(key) ?? 0;
      const entry = this.ready.get(key);
      const valid = entry?.version === version && entry.canvas === tiles.get(key);
      const visible = tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1;
      if (!visible && !prefetch) continue;
      // Map insertion order is the tile LRU; visible tiles become most recently used.
      const canvas = tiles.get(key);
      if (visible && canvas) { tiles.delete(key); tiles.set(key, canvas); }
      if (valid && ((entry.scale === target && entry.quality === 'complete') || !upgrade || !visible)) continue;
      // An edit must never turn a sharp tile into a blurry preview. A handed-off
      // stroke stays on the live layer until a full-quality result can replace it.
      const preserve = !valid && (handoffKeys.has(key) || (!!canvas && entry?.quality === 'complete'));
      const scale = !valid ? preserve ? Math.max(entry?.scale ?? 0, target) : Math.min(target, 0.25) : target;
      const quality = !valid && !preserve ? 'preview' : 'complete';
      const distance = Math.hypot(tx - (tx0 + tx1) / 2, ty - (ty0 + ty1) / 2);
      const directionLength = Math.hypot(this.prefetchDirection.x, this.prefetchDirection.y);
      const ahead = !visible && directionLength && distance
        ? ((tx - (tx0 + tx1) / 2) * this.prefetchDirection.x + (ty - (ty0 + ty1) / 2) * this.prefetchDirection.y) / (directionLength * distance) : 0;
      const previous = this.jobs.find(job => job.key === key && job.version === version && job.scale === scale && job.epoch === this.epoch && job.quality === quality);
      jobs.push({ key, tx, ty, scale, version, epoch: this.epoch, quality,
        priority: (visible ? valid ? 10000 : 0 : 20000) + distance - ahead * .75, requestedAt: previous?.requestedAt ?? performance.now() });
    }
    this.jobs = jobs;
    if (import.meta.env.DEV) {
      const details = { camera: { ...cam }, width: vw, height: vh, dpr, target, settled, prefetch,
        jobs: inkTraceList(jobs, traceJob), protectedKeys: inkTraceList(protectedKeys, key => key), transferPending: this.transferPending };
      const signature = JSON.stringify(details);
      if (signature !== this.traceViewportSignature) { this.traceViewportSignature = signature; this.trace('viewport', details); }
    }
    if (this.transferFirstKey && !jobs.some(job => job.key === this.transferFirstKey)) this.resumeTransfer?.();
    if (this.worker) {
      const signature = `${this.epoch}:${jobs.map(job => `${job.key}/${job.scale}/${job.version}/${job.priority}/${job.quality}`).join('|')}`;
      if (signature !== this.viewportSignature) { this.viewportSignature = signature; this.post({ type: 'viewport', epoch: this.epoch, jobs }); }
      reportInkFrame({ backend: 'worker', queuedTiles: jobs.length, workerBytes: this.workerBytes });
    } else {
      // A preview must never downscale an unrelated final tile.
      const job = jobs.slice().sort((a, b) => a.priority - b.priority)[0];
      if (job) {
        const res = materializeTiles(tiles, { x: -job.tx * 512, y: -job.ty * 512, zoom: 1 }, 511.999, 511.999, job.scale,
          { fixedScale: job.scale, preview: job.quality === 'preview', rebake: true, forceKeys: new Set([job.key]), protectedKeys,
            margin: 0, budgetMs: settled && protectedKeys.size === 0 ? 4 : 1.5, maxPoints: 2048 });
        for (const key of res.completed) {
          const canvas = tiles.get(key);
          if (canvas) this.ready.set(key, { canvas, scale: tileScaleOf(canvas), version: this.versions.get(key) ?? 0, quality: job.quality });
        }
        if (res.completed.length) {
          if (import.meta.env.DEV) this.trace('fallback-complete', { keys: res.completed });
          this.publish(new Set(res.completed), 'fallback-complete');
        }
      }
      reportInkFrame({ backend: 'fallback', queuedTiles: jobs.length, matMs: 0 });
    }
    const fading = new Set<string>();
    for (const [key, fade] of this.transitions) {
      if (performance.now() - fade.started >= TRANSITION_MS) this.dropTransition(key);
      fading.add(key);
    }
    if (fading.size) this.publish(fading, 'lod-fade');
    this.trim();
    return jobs.length + this.transitions.size;
  }

  private receive(reply: RenderReply): void {
    if (reply.type === 'error') { this.trace('worker-error'); this.fallback(); return; }
    if (reply.type === 'memory') {
      if (this.disposed || reply.epoch !== this.epoch) return;
      this.workerBytes = reply.workerBytes; reportInkFrame({ workerBytes: this.workerBytes }); this.trim();
      return;
    }
    const { job, bitmap } = reply;
    if (job.epoch === this.epoch && job.key === this.transferFirstKey) this.resumeTransfer?.();
    const reason = this.disposed ? 'disposed' : job.epoch !== this.epoch ? 'epoch'
      : job.version !== (this.versions.get(job.key) ?? 0) ? 'version'
      : this.options.protectedKeys().has(job.key) ? 'protected'
      : !this.jobs.some(j => j.key === job.key && j.scale === job.scale && j.version === job.version && j.quality === job.quality) ? 'not-requested' : null;
    if (import.meta.env.DEV) this.trace('worker-result', { job: traceJob(job), accepted: reason === null, reason,
      currentVersion: this.versions.get(job.key) ?? 0, waitMs: performance.now() - job.requestedAt, cacheHit: reply.cacheHit, buildMs: reply.buildMs });
    if (reason) {
      bitmap.close(); return;
    }
    const canvas = createInkCanvas();
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close();
    registerTileScale(canvas, job.scale);
    const tiles = this.options.tiles(), old = tiles.get(job.key), previous = this.ready.get(job.key);
    this.dropTransition(job.key);
    // Fade only identical document content between LODs. Mixing different
    // revisions would fade a new stroke or resurrect a just-erased one.
    const fade = old && previous?.version === job.version && previous.scale !== job.scale
      && old.width * old.height * 4 + this.transitionBytes() <= TRANSITION_BUDGET;
    tiles.set(job.key, canvas);
    if (fade) this.transitions.set(job.key, { previous: old, current: canvas, started: performance.now() });
    else if (old) old.width = 0;
    this.ready.set(job.key, { version: job.version, scale: job.scale, canvas, quality: job.quality });
    if (import.meta.env.DEV) this.trace('tile-ready', { job: traceJob(job), canvas: inkTraceId(canvas), width: canvas.width, height: canvas.height });
    this.workerBytes = reply.workerBytes;
    this.jobs = this.jobs.filter(j => j.key !== job.key);
    reportInkFrame({ tileBuildMs: reply.buildMs, tileWaitMs: performance.now() - job.requestedAt,
      cacheHits: reply.cacheHit ? 1 : 0, workerBytes: this.workerBytes });
    this.publish(new Set([job.key]), 'tile-ready');
  }

  /** Clip each hand-off stroke to tiles that have not yet acknowledged its revision. */
  drawPending(ctx: CanvasRenderingContext2D): void {
    const drag = this.pendingDrag, dragKeys = new Set<string>();
    for (const [id, pending] of this.pending) {
      const missing = [...pending.versions].filter(([key, version]) => {
        const ready = this.ready.get(key);
        return !ready || ready.version < version || ready.canvas !== this.options.tiles().get(key);
      });
      if (!missing.length) {
        this.trace('handoff-complete', { id });
        this.pending.delete(id); this.tracedPending.delete(id); releaseStreamingInk(pending.stroke); continue;
      }
      if (drag?.ids.has(id)) {
        for (const [key] of missing) dragKeys.add(key);
        continue;
      }
      if (import.meta.env.DEV) {
        const signature = missing.map(([key, version]) => key + '/' + version).join('|');
        if (signature !== this.tracedPending.get(id)) {
          this.tracedPending.set(id, signature);
          this.trace('pending-draw', { id, missing: inkTraceList(missing, ([key, version]) => ({ key, version })) });
        }
      }
      this.drawInPendingTiles(ctx, missing.map(([key]) => key), () => drawLiveAnnotatedStroke(ctx, pending.stroke));
    }
    if (drag) {
      if (dragKeys.size) this.drawInPendingTiles(ctx, dragKeys, () => drawDragPreview(ctx, drag.preview, drag.dx, drag.dy));
      else this.releasePendingDrag();
    }
  }

  private drawInPendingTiles(ctx: CanvasRenderingContext2D, keys: Iterable<string>, paint: () => void): void {
    ctx.save(); ctx.beginPath();
    const transform = inkPixelTransform(ctx);
    if (transform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    let visible = false;
    for (const key of keys) {
      const [tx, ty] = key.split(':').map(Number);
      if (transform) {
        // Match the committed tile edge while a neighbor has already landed.
        const left = Math.round(tx * 512 * transform.a + transform.e);
        const top = Math.round(ty * 512 * transform.d + transform.f);
        const right = Math.round((tx + 1) * 512 * transform.a + transform.e);
        const bottom = Math.round((ty + 1) * 512 * transform.d + transform.f);
        if (right <= 0 || bottom <= 0 || left >= ctx.canvas.width || top >= ctx.canvas.height) continue;
        ctx.rect(left, top, right - left, bottom - top);
      } else ctx.rect(tx * 512, ty * 512, 512, 512);
      visible = true;
    }
    if (visible) {
      ctx.clip();
      if (transform) ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
      paint();
    }
    ctx.restore();
  }

  /** Draw onto an already-cleared, snapped tile rectangle. Additive premultiplied
   * blending keeps translucent ink at constant opacity through a quality change. */
  drawTile(ctx: CanvasRenderingContext2D, key: string, canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): void {
    const fade = this.transitions.get(key);
    if (!fade || fade.current !== canvas) { ctx.drawImage(canvas, x, y, w, h); return; }
    const progress = Math.min(1, Math.max(0, (performance.now() - fade.started) / TRANSITION_MS));
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.globalAlpha = 1 - progress; ctx.drawImage(fade.previous, x, y, w, h);
    ctx.globalAlpha = progress; ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(canvas, x, y, w, h);
    ctx.restore();
  }
  private transitionBytes(): number {
    let bytes = 0; for (const fade of this.transitions.values()) bytes += fade.previous.width * fade.previous.height * 4; return bytes;
  }
  private dropTransition(key: string): void {
    const fade = this.transitions.get(key);
    if (fade) { fade.previous.width = 0; this.transitions.delete(key); }
  }

  private trim(): void {
    const view = this.lastViewport;
    if (!view) return;
    const tiles = this.options.tiles(), cam = view.cam;
    const protectedKeys = this.options.protectedKeys();
    const visible = (key: string) => {
      const [tx, ty] = key.split(':').map(Number);
      return (tx + 1) * 512 * cam.zoom + cam.x >= 0 && tx * 512 * cam.zoom + cam.x <= view.vw
        && (ty + 1) * 512 * cam.zoom + cam.y >= 0 && ty * 512 * cam.zoom + cam.y <= view.vh;
    };
    // Reserve headroom for in-flight worker surfaces and transferred bitmaps, before arrival.
    const workerReservation = this.worker ? Math.max(this.workerBytes, this.jobs.length || this.transferPending ? INK_WORKER_MEMORY_RESERVE : 0) : 0;
    const dragCanvas = this.pendingDrag?.preview.canvas;
    const other = streamingInkStats().bytes + scratchInkBytes() + reusableInkBytes() + this.transitionBytes() + inkTileBuildBytes(tiles)
      + inkRasterCacheStats().buildingBytes + (this.options.displayBytes?.() ?? 0)
      + (dragCanvas ? dragCanvas.width * dragCanvas.height * 4 : 0) + 32 * 1048576;
    let visibleBytes = 0;
    for (const [key, canvas] of tiles) if (visible(key) || protectedKeys.has(key)) visibleBytes += canvas.width * canvas.height * 4;
    trimInkRasters(Math.max(0, INK_MEMORY_BUDGET - workerReservation - other - visibleBytes));
    const available = Math.max(0, INK_MEMORY_BUDGET - workerReservation - other - inkRasterCacheStats().bytes);
    let bytes = inkTileBytes(tiles);
    for (const [key, canvas] of tiles) {
      if (bytes <= Math.min(RESIDENT_TILE_BUDGET, available)) break;
      if (visible(key) || protectedKeys.has(key)) continue;
      this.trace('tile-evicted', { key });
      bytes -= canvas.width * canvas.height * 4; canvas.width = 0; tiles.delete(key); this.ready.delete(key); this.dropTransition(key);
    }
    for (const [key, entry] of this.ready) if (tiles.get(key) !== entry.canvas) this.ready.delete(key);
    reportInkFrame({ totalInkBytes: bytes + this.workerBytes + other - 32 * 1048576 + inkRasterCacheStats().bytes });
  }

  private fallback(): void {
    this.worker?.terminate(); this.worker = null; this.workerBytes = 0;
    this.trace('backend-fallback');
    reportInkFrame({ backend: 'fallback' }); this.publish(undefined, 'worker-fallback');
  }

  dispose(): void {
    this.trace('backend-dispose');
    unregisterInkTrace(this);
    this.disposed = true; this.sending++; this.worker?.terminate(); this.worker = null;
    this.resumeTransfer = null;
    this.releasePendingDrag();
    for (const pending of this.pending.values()) releaseStreamingInk(pending.stroke);
    for (const key of this.transitions.keys()) this.dropTransition(key);
    this.pending.clear(); this.tracedPending.clear(); this.ready.clear(); this.previous.clear(); this.jobs = [];
  }
}
