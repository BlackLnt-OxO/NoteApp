import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { InkRenderBackend } from '../InkRenderBackend';
import { indexInkStrokes, disposeTiles } from '../InkTiles';
import { clearInkRasterCache, tileScaleOf } from '../../PdfAnnotation/InkRasterCache';
import { clearStreamingInk } from '../../PdfAnnotation/StreamingInkStroke';
import type { Stroke } from '../types';
import type { TileJob } from '../InkRenderProtocol';
import { readInkFrame, resetInkFrame } from '../../InkFrameStats';
import { INK_MEMORY_BUDGET } from '../../InkCanvasSurface';
const camera = { x: 0, y: 0, zoom: 1 };
function stroke(id: string): Stroke { return { id, type: 'stroke', points: [{ x: 20, y: 30, pressure: .7, t: 0 }, { x: 50, y: 30, pressure: .7, t: 17 }], color: '#000', size: 8, opacity: .5, smoothing: .35, createdAt: 0, compositeOperation: 'source-over', renderVersion: 2 }; }
function fakeWorker() {
  const messages: any[] = [];
  const worker = { postMessage: (data: any) => messages.push(data), terminate: vi.fn(), onmessage: null as any, onerror: null as any };
  return { worker: worker as unknown as Worker, messages, emit: (job: TileJob, color?: string) => {
    const bitmap = createCanvas(Math.round(512 * job.scale), Math.round(512 * job.scale)) as any; bitmap.close = vi.fn();
    if (color) { const ctx = bitmap.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, bitmap.width, bitmap.height); }
    worker.onmessage({ data: { type: 'tile', job, bitmap, cacheHit: false, buildMs: 2, workerBytes: 1024 } }); return bitmap;
  } };
}
beforeEach(() => {
  clearInkRasterCache(); clearStreamingInk();
  vi.spyOn(document, 'createElement').mockImplementation(((name: string) => name === 'canvas' ? createCanvas(1, 1) : undefined) as any);
});
afterEach(() => { vi.restoreAllMocks(); clearInkRasterCache(); clearStreamingInk(); });
describe('versioned background tiles', () => {
  it('pauses old source before a new-version viewport can overtake its deferred stroke data', async () => {
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'), worker = fakeWorker();
    indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(), worker: worker.worker });
    try {
      backend.sync([a]); backend.requestViewport(camera, 100, 100, 1, false);
      await new Promise(resolve => setTimeout(resolve, 15));
      const initial = worker.messages.filter(message => message.type === 'viewport').slice(-1)[0].jobs[0];
      worker.emit(initial);
      worker.messages.length = 0;
      const b = stroke('b'); indexInkStrokes(tiles, [b]); backend.retain(b, [a, b]);
      backend.requestViewport(camera, 100, 100, 1, false);
      // The empty change pauses the existing Worker; the actual vectors stay deferred.
      expect(worker.messages[0]).toMatchObject({ type: 'changes', epoch: initial.epoch, added: [], removed: [] });
      expect(worker.messages.some(message => message.type === 'changes' && message.added.length)).toBe(false);
      expect(worker.messages[1].type).toBe('viewport');
      expect(worker.messages[1].jobs[0].version).toBe(initial.version + 1);
      await new Promise(resolve => setTimeout(resolve, 15));
      expect(worker.messages.filter(message => message.type === 'changes').flatMap(message => message.added)).toEqual([b]);
      expect(worker.messages.slice(-1)[0].type).toBe('order');
    } finally { backend.dispose(); disposeTiles(tiles); }
  });
  it('reclaims distant tiles under pressure, preserves visible/gesture tiles, and reports idle Worker bytes', () => {
    resetInkFrame();
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'), worker = fakeWorker(), protectedKeys = new Set(['11:0']);
    indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => protectedKeys,
      displayBytes: () => INK_MEMORY_BUDGET, worker: worker.worker });
    backend.sync([a]); backend.requestViewport(camera, 100, 100, 1, false);
    const job = worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs[0]; worker.emit(job);
    for (const key of ['10:0', '11:0']) tiles.set(key, createCanvas(512, 512) as any);
    backend.requestViewport(camera, 100, 100, 1, false);
    expect([...tiles.keys()].sort()).toEqual(['0:0', '11:0']);
    (worker.worker as any).onmessage({ data: { type: 'memory', epoch: job.epoch, workerBytes: 0 } });
    expect(readInkFrame().workerBytes).toBe(0);
    (worker.worker as any).onmessage({ data: { type: 'memory', epoch: job.epoch - 1, workerBytes: 999999 } });
    expect(readInkFrame().workerBytes).toBe(0);
    backend.dispose(); disposeTiles(tiles);
  });
  it('skips optional prefetch when display surfaces already consume the memory budget', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), worker = fakeWorker();
    const strokes = [0, 1].map(x => ({ ...stroke('s'+x), points: [{ x: x*512+20, y: 30, pressure: .5, t: 0 }] }));
    indexInkStrokes(tiles, strokes);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(),
      displayBytes: () => INK_MEMORY_BUDGET, worker: worker.worker });
    backend.sync(strokes); backend.requestViewport(camera, 100, 100, 1, false);
    const jobs = worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs;
    expect(jobs.map((job: TileJob) => job.key)).toEqual(['0:0']); backend.dispose(); disposeTiles(tiles);
  });
  it('skips prefetch that the tile cache cannot retain beside visible PDF ink', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), worker = fakeWorker();
    const strokes = [0, 4].map(x => ({ ...stroke('s'+x), points: [{ x: x*512+20, y: 30, pressure: .5, t: 0 }] }));
    indexInkStrokes(tiles, strokes);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(),
      fixedScale: 3, worker: worker.worker });
    backend.sync(strokes); backend.requestViewport({ ...camera, zoom: .5 }, 1000, 720, 1, false);
    const jobs = worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs;
    expect(jobs.map((job: TileJob) => job.key)).toEqual(['0:0']);
    backend.dispose(); disposeTiles(tiles);
  });
  it.each([false, true])('keeps pen-up handoff sharp even on a previously missing tile (%s)', (loaded) => {
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'), worker = fakeWorker();
    indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(), worker: worker.worker });
    const job = () => worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs[0] as TileJob;
    backend.sync([a]);
    if (loaded) {
      backend.requestViewport(camera, 100, 100, 1, false); worker.emit(job());
      backend.requestViewport(camera, 100, 100, 1, true); worker.emit(job());
    }
    const before = tiles.get('0:0');
    const b = stroke('b'); indexInkStrokes(tiles, [a, b]); backend.retain(b, [a, b]);
    backend.requestViewport(camera, 100, 100, 1, false);
    expect(job()).toMatchObject({ quality: 'complete', scale: 1 });
    expect(tiles.get('0:0')).toBe(before);
    worker.emit(job());
    expect(tileScaleOf(tiles.get('0:0')!)).toBe(1);
    // A revision handoff is atomic: it must not blend the old and new contents.
    const ctx = createCanvas(512, 512).getContext('2d');
    const draw = vi.spyOn(ctx, 'drawImage'); backend.drawTile(ctx as any, '0:0', tiles.get('0:0')!, 0, 0, 512, 512);
    expect(draw).toHaveBeenCalledTimes(1);
    backend.dispose(); disposeTiles(tiles);
  });
  it('blends quality upgrades without dimming translucent ink and frees the previous LOD', () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'), worker = fakeWorker(), publish = vi.fn();
    indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish, protectedKeys: () => new Set(), worker: worker.worker });
    const job = () => worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs[0] as TileJob;
    backend.sync([a]); backend.requestViewport(camera, 100, 100, 1, false); worker.emit(job(), 'rgba(20, 60, 160, 0.5)');
    const previous = tiles.get('0:0')!;
    const release = vi.spyOn(previous, 'width', 'set');
    backend.requestViewport(camera, 100, 100, 1, true); worker.emit(job(), 'rgba(20, 60, 160, 0.5)');
    now = 160;
    const ctx = createCanvas(512, 512).getContext('2d'), draw = vi.spyOn(ctx, 'drawImage');
    backend.drawTile(ctx as any, '0:0', tiles.get('0:0')!, 0, 0, 512, 512);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(ctx.getImageData(250, 250, 1, 1).data[3]).toBeGreaterThanOrEqual(126);
    expect(ctx.getImageData(250, 250, 1, 1).data[3]).toBeLessThanOrEqual(129);
    expect(ctx.globalCompositeOperation).toBe('source-over');
    now = 221; expect(backend.requestViewport(camera, 100, 100, 1, true)).toBe(0);
    expect(publish).toHaveBeenLastCalledWith(new Set(['0:0']));
    draw.mockClear(); backend.drawTile(ctx as any, '0:0', tiles.get('0:0')!, 0, 0, 512, 512);
    expect(draw).toHaveBeenCalledTimes(1);
    // Native test canvas resets width=0 to a default; browser canvas frees it.
    expect(release).toHaveBeenCalledWith(0);
    backend.dispose(); disposeTiles(tiles);
  });
  it('cancels an in-progress LOD blend when ink is edited', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'), worker = fakeWorker(); indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(), worker: worker.worker });
    const job = () => worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs[0] as TileJob;
    backend.sync([a]); backend.requestViewport(camera, 100, 100, 1, false); worker.emit(job());
    backend.requestViewport(camera, 100, 100, 1, true); worker.emit(job());
    backend.sync([{ ...a, opacity: .1 }]);
    const ctx = createCanvas(512, 512).getContext('2d'), draw = vi.spyOn(ctx, 'drawImage');
    backend.drawTile(ctx as any, '0:0', tiles.get('0:0')!, 0, 0, 512, 512);
    expect(draw).toHaveBeenCalledTimes(1);
    backend.requestViewport(camera, 100, 100, 1, false);
    expect(job()).toMatchObject({ quality: 'complete', scale: 1 });
    backend.dispose(); disposeTiles(tiles);
  });
  it('prefetches the direction of movement after visible missing tiles', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), worker = fakeWorker();
    const strokes = [0, 1, 2].map(x => ({ ...stroke(`tile-${x}`), points: [{ x: x*512+100, y: 30, pressure: .7, t: 0 }] }));
    indexInkStrokes(tiles, strokes);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(), worker: worker.worker });
    backend.sync(strokes); backend.requestViewport(camera, 200, 100, 1, false);
    backend.requestViewport({ ...camera, x: -512 }, 200, 100, 1, false);
    const jobs: TileJob[] = worker.messages.filter(message => message.type === 'viewport').slice(-1)[0].jobs;
    expect(jobs.find(job => job.key === '1:0')!.priority).toBeLessThan(10000);
    expect(jobs.find(job => job.key === '2:0')!.priority).toBeLessThan(jobs.find(job => job.key === '0:0')!.priority);
    backend.dispose(); disposeTiles(tiles);
  });
  it('completes a first visible bucket before transferring distant objects', async () => {
    const first = stroke('first'), outside = Array.from({ length: 600 }, (_, i) => ({ ...stroke(`far-${i}`),
      points: [{ x: 2000, y: 2000, pressure: .7, t: 0 }] }));
    const tiles = new Map<string, HTMLCanvasElement>(), worker = fakeWorker(); indexInkStrokes(tiles, [first, ...outside]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(), worker: worker.worker });
    backend.sync([first, ...outside]); backend.requestViewport(camera, 100, 100, 1, false);
    await new Promise(resolve => setTimeout(resolve, 10));
    const initial = worker.messages.filter(message => message.type === 'changes');
    expect(initial.flatMap(message => message.added.map((item: Stroke) => item.id))).toEqual(['first']);
    expect(worker.messages.find(message => message.type === 'order')?.completeKeys).toEqual(['0:0']);
    const job = worker.messages.filter(message => message.type === 'viewport').slice(-1)[0].jobs[0];
    worker.emit(job); await new Promise(resolve => setTimeout(resolve, 20));
    expect(worker.messages.filter(message => message.type === 'changes').flatMap(message => message.added)).toHaveLength(601);
    expect(worker.messages.filter(message => message.type === 'order').slice(-1)[0].completeKeys).toBeUndefined();
    backend.dispose(); disposeTiles(tiles);
  });
  it('rejects results after an edit, during a gesture, and after disposal, releasing bitmaps', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'), worker = fakeWorker(), protectedKeys = new Set<string>();
    indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => protectedKeys, worker: worker.worker });
    backend.sync([a]); backend.requestViewport(camera, 100, 100, 1, false);
    const job = worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs[0];
    backend.sync([{ ...a, opacity: .8 }]); expect(worker.emit(job).close).toHaveBeenCalled(); expect(tiles.size).toBe(0);
    backend.requestViewport(camera, 100, 100, 1, false);
    const current = worker.messages.filter(m => m.type === 'viewport').slice(-1)[0].jobs[0];
    protectedKeys.add(current.key); expect(worker.emit(current).close).toHaveBeenCalled(); expect(tiles.size).toBe(0);
    protectedKeys.clear(); worker.emit(current); expect(tiles.has(current.key)).toBe(true);
    backend.dispose(); expect(worker.emit(current).close).toHaveBeenCalled(); disposeTiles(tiles);
  });
  it('shows a complete preview before final quality and preserves other final tiles', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'); indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(), worker: null });
    backend.sync([a]);
    for (let i = 0; i < 100 && !tiles.size; i++) backend.requestViewport(camera, 100, 100, 1, false);
    expect(tileScaleOf(tiles.get('0:0')!)).toBe(.25);
    for (let i = 0; i < 100 && tileScaleOf(tiles.get('0:0')!) < 1; i++) backend.requestViewport(camera, 100, 100, 1, true);
    expect(tileScaleOf(tiles.get('0:0')!)).toBeGreaterThanOrEqual(1);
    const b = { ...stroke('b'), points: [{ x: 600, y: 20, pressure: .7, t: 0 }] };
    indexInkStrokes(tiles, [a, b]); backend.sync([a, b]);
    for (let i = 0; i < 100 && !tiles.has('1:0'); i++) backend.requestViewport(camera, 700, 100, 1, false);
    expect(tileScaleOf(tiles.get('0:0')!)).toBeGreaterThanOrEqual(1);
    expect(tileScaleOf(tiles.get('1:0')!)).toBe(.25); backend.dispose(); disposeTiles(tiles);
  });
  it('falls back when the worker crashes and continues reconstructing source ink', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), a = stroke('a'), worker = fakeWorker(); indexInkStrokes(tiles, [a]);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => new Set(), worker: worker.worker });
    backend.sync([a]); (worker.worker as any).onerror();
    for (let i = 0; i < 100 && !tiles.size; i++) backend.requestViewport(camera, 100, 100, 1, false);
    expect(worker.worker.terminate).toHaveBeenCalled(); expect(tiles.size).toBeGreaterThan(0); backend.dispose(); disposeTiles(tiles);
  });
});
