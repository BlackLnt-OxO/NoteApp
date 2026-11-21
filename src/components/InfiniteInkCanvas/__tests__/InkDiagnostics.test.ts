import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { downloadInkDiagnostics, inkStrokeCoverage, inkTraceId, readInkDiagnostics, recordInkTrace, INK_TRACE_LIMIT } from '../../InkDiagnostics';
import { getCommittedStrokeBounds, getInkStrokeIndex } from '../../PdfAnnotation/InkStrokeIndex';
import { InkRenderBackend } from '../InkRenderBackend';
import { InkDisplayLayers, panBufferMargin } from '../../InkDisplayLayers';
import type { Stroke } from '../types';
import type { TileJob } from '../InkRenderProtocol';
import { disposeTiles } from '../InkTiles';

function stroke(): Stroke {
  return { id: 'diagnostic-stroke', type: 'stroke', color: '#123456', size: 8, opacity: 1, smoothing: 0,
    createdAt: 0, compositeOperation: 'source-over', points: [{ x: 20, y: 30, pressure: .7, t: 0 }, { x: 50, y: 30, pressure: .7, t: 17 }] };
}
function surface(): HTMLCanvasElement {
  const canvas = createCanvas(512, 512) as any; canvas.style = {}; return canvas;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('development ink evidence', () => {
  it('keeps the latest 512 ordered events and exports a detached snapshot', () => {
    const owner = {};
    for (let i = 0; i < 530; i++) recordInkTrace(owner, 'bounded', { index: i });
    const report = readInkDiagnostics();
    expect(report.events).toHaveLength(INK_TRACE_LIMIT);
    expect(report.events[0].data.index).toBe(18);
    expect(report.events.at(-1).data.index).toBe(529);
    expect(report.events.at(-1).sequence - report.events[0].sequence).toBe(511);
    report.events[0].data.index = -1;
    expect(readInkDiagnostics().events[0].data.index).toBe(18);
  });

  it('detects stale committed bounds without repairing the cache or recording point data', () => {
    const tiles = new Map<string, HTMLCanvasElement>(), s = stroke(), index = getInkStrokeIndex(tiles);
    Object.assign(s, { privateText: 'private-note-body', dataUrl: 'data:image/png;base64,private' });
    index.add(s);
    const before = getCommittedStrokeBounds(s);
    s.points.push({ x: 650, y: 30, pressure: .8, t: 34 });
    const coverage = inkStrokeCoverage(tiles, s);
    expect(coverage.expectedKeys).toEqual(['0:0', '1:0']);
    expect(coverage.indexedKeys).toEqual(['0:0']);
    expect(coverage.missingKeys).toEqual(['1:0']);
    expect(getCommittedStrokeBounds(s)).toBe(before);
    expect(index.grid.has('1:0')).toBe(false);
    recordInkTrace(tiles, 'coverage', coverage);
    const text = JSON.stringify(readInkDiagnostics());
    expect(text).not.toMatch(/"points"|"pressure"|"dataUrl"|private-note-body|base64/);
    expect(coverage.pointCount).toBe(3);
  });

  it('records why late, stale, protected, cancelled and disposed Worker results were rejected', async () => {
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((name: string) => name === 'canvas' ? surface() : original(name)) as any);
    const messages: any[] = [], worker = { postMessage: (message: any) => messages.push(message), terminate: vi.fn(), onmessage: null as any };
    const tiles = new Map<string, HTMLCanvasElement>(), s = stroke(), index = getInkStrokeIndex(tiles), protectedKeys = new Set<string>();
    index.add(s);
    const backend = new InkRenderBackend({ tiles: () => tiles, publish: vi.fn(), protectedKeys: () => protectedKeys, worker: worker as any });
    const source = inkTraceId(backend);
    const emit = (job: TileJob) => {
      const bitmap = surface() as any; bitmap.close = vi.fn();
      worker.onmessage({ data: { type: 'tile', job, bitmap, cacheHit: false, buildMs: 1, workerBytes: 0 } });
      return bitmap;
    };
    const latest = () => messages.filter(message => message.type === 'viewport').slice(-1)[0].jobs as TileJob[];
    try {
      backend.sync([s]); backend.requestViewport({ x: 0, y: 0, zoom: 1 }, 1000, 200, 1, false);
      const old = latest()[0];
      await new Promise(resolve => setTimeout(resolve, 15));
      const moved = { ...s, points: s.points.map(point => ({ ...point, x: point.x + 512 })) };
      index.remove(new Set([s.id])); index.add(moved); backend.retain(moved, [moved]);
      backend.requestViewport({ x: 0, y: 0, zoom: 1 }, 1000, 200, 1, false);
      expect(emit(old).close).toHaveBeenCalled();
      const current = latest()[0];
      expect(emit({ ...current, epoch: current.epoch - 1 }).close).toHaveBeenCalled();
      protectedKeys.add(current.key); expect(emit(current).close).toHaveBeenCalled(); protectedKeys.clear();
      backend.requestViewport({ x: -10000, y: 0, zoom: 1 }, 1000, 200, 1, false);
      expect(emit(current).close).toHaveBeenCalled();
      backend.requestViewport({ x: 0, y: 0, zoom: 1 }, 1000, 200, 1, false);
      const delayed = latest()[0];
      await new Promise(resolve => setTimeout(resolve, 15));
      emit(delayed);
      expect(tiles.has('1:0')).toBe(true);
      backend.dispose(); emit(delayed);
      const records = readInkDiagnostics().events.filter((event: any) => event.source === source);
      const results = records.filter((event: any) => event.type === 'worker-result');
      expect(results.map((event: any) => event.data.reason)).toEqual(['version', 'epoch', 'protected', 'not-requested', null, 'disposed']);
      expect(results[4].data.waitMs).toBeGreaterThanOrEqual(10);
      const ready = records.findIndex((event: any) => event.type === 'tile-ready');
      const publish = records.findIndex((event: any) => event.type === 'publish' && event.data.reason === 'tile-ready');
      expect(ready).toBeGreaterThan(-1); expect(publish).toBeGreaterThan(ready);
      expect(readInkDiagnostics().sources.some((entry: any) => entry.source === source)).toBe(false);
    } finally { backend.dispose(); disposeTiles(tiles); }
  });

  it('records actual dirty-tile painting and clearing of a now-empty tile', () => {
    const a = surface(), b = surface(), ink = surface(), layers = new InkDisplayLayers();
    b.getContext('2d')!.fillRect(20, 30, 30, 20);
    const p = { background: surface(), ink, tiles: new Map([['0:0', a], ['1:0', b]]), camera: { x: 0, y: 0, zoom: 1 },
      width: 1000, height: 300, dpr: 1, backgroundColor: '#fff', dotColor: '#eee', showDotGrid: false };
    try {
      layers.paint(p); layers.invalidate(new Set(['0:0'])); layers.paint(p);
      const source = inkTraceId(layers), margin = panBufferMargin(1000, 300, 1);
      expect(ink.getContext('2d')!.getImageData(margin + 540, margin + 40, 1, 1).data[3]).toBe(255);
      p.tiles.delete('1:0'); layers.invalidate(new Set(['1:0'])); layers.paint(p);
      expect(ink.getContext('2d')!.getImageData(margin + 540, margin + 40, 1, 1).data[3]).toBe(0);
      const paints = readInkDiagnostics().events.filter((event: any) => event.source === source && event.type === 'display-paint');
      expect(paints.at(-2).data).toMatchObject({ full: false, drawnCount: 1, drawn: [{ key: '0:0' }] });
      expect(paints.at(-1).data).toMatchObject({ full: false, requestedKeys: { items: ['1:0'] }, drawnCount: 0, drawn: [] });
    } finally { layers.dispose(); disposeTiles(p.tiles); }
  });

  it('downloads metadata as JSON and releases the download URL', () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      downloadInkDiagnostics();
      expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      expect((click.mock.instances[0] as HTMLAnchorElement).download).toMatch(/^ink-diagnostics-.*\.json$/);
      expect(document.querySelector('a[download]')).toBeNull();
      vi.advanceTimersByTime(1000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    } finally { vi.useRealTimers(); }
  });

  it('does not collect or export outside development mode', () => {
    const length = readInkDiagnostics().events.length;
    vi.stubEnv('DEV', false);
    recordInkTrace({}, 'should-not-record', {});
    expect(readInkDiagnostics()).toBeNull();
    downloadInkDiagnostics(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    expect(readInkDiagnostics().events).toHaveLength(length);
  });
});
