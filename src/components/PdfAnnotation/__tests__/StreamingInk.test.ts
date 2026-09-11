import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { StreamingInkStroke, getStreamingInk, releaseStreamingInk, clearStreamingInk, streamingInkStats } from '../StreamingInkStroke';
import { clearInkRasterCache, getStrokeRaster, inkRasterCacheStats } from '../InkRasterCache';
import { StreamingPencilGrain } from '../StreamingPencilGrain';
import { InkStrokeIndex } from '../InkStrokeIndex';
import { hitTestStrokeBySegment } from '../PdfEngine';
import { rebuildTiles, removeStrokesFromTiles } from '../../InfiniteInkCanvas/InkTiles';
import type { PdfStroke } from '../PdfTypes';

function line(id: string, count = 300, patch: Partial<PdfStroke> = {}): PdfStroke {
  return { id, type: 'stroke', renderVersion: 2, size: 8, color: '#1267cb', opacity: 0.5,
    smoothing: 0.05, compositeOperation: 'source-over', createdAt: 0,
    points: Array.from({ length: count }, (_, i) => ({
      x: 32 + (i % 64 <= 32 ? i % 64 : 64 - i % 64) * 12,
      y: 128, pressure: 1, t: i * 4,
    })), ...patch };
}
/** A stroke crossing ~20 streaming cells, for cache-budget tests. */
function diagonal(id: string): PdfStroke {
  return line(id, 120, { points: Array.from({ length: 120 }, (_, i) => ({
    x: 12 + i * 4.2, y: 12 + i * 3.1, pressure: 1, t: i * 4 })) });
}
function pixels(c: HTMLCanvasElement) { return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; }
function expectPixels(a: HTMLCanvasElement, b: HTMLCanvasElement) {
  const pa = pixels(a), pb = pixels(b);
  expect(pa.length).toBe(pb.length);
  let different = 0;
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) different++;
  expect(different).toBe(0);
}
function raster(ink: StreamingInkStroke) {
  const c = document.createElement('canvas'); c.width = c.height = 1536;
  const ctx = c.getContext('2d')!; ctx.scale(3, 3); ink.draw(ctx);
  return c;
}
beforeEach(() => {
  clearInkRasterCache();
  const original = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((name: string, options?: ElementCreationOptions) =>
    name === 'canvas' ? createCanvas(1, 1) : original(name, options)) as typeof document.createElement);
});
afterEach(() => { clearInkRasterCache(); clearStreamingInk(); vi.restoreAllMocks(); });

describe('continuous retracing marker', () => {
  it.each(['marker', 'pencil'] as const)('%s processes only new samples after a long prefix', style => {
    const s = line('long', 2048, { edgeFeather: false, style });
    const ink = new StreamingInkStroke(s); ink.update();
    expect(ink.stats.processedPoints).toBe(2047);
    const grainCandidates = ink.stats.grainCandidates;
    s.points.push(...line('tail', 4).points.map((p, i) => ({ ...p, t: (2048 + i) * 4 })));
    ink.update();
    expect(ink.stats.lastUpdatePoints).toBe(4);
    expect(ink.stats.processedPoints).toBe(2051);
    expect(ink.stats.refreshedTiles).toBeLessThan(10);
    if (style === 'pencil') {
      expect(grainCandidates).toBeGreaterThan(1000);
      expect(ink.stats.grainCandidates - grainCandidates).toBeLessThan(60);
    }
    ink.dispose();
  });

  it('never compounds a half-transparent stroke to opaque at self-overlap or cell seams', () => {
    const ink = new StreamingInkStroke(line('opacity', 600));
    const c = raster(ink), data = pixels(c);
    for (const x of [100, 128, 200, 256, 384]) {
      const alpha = data[((128 * 3) * 1536 + x * 3) * 4 + 3];
      expect(alpha).toBeGreaterThanOrEqual(126);
      expect(alpha).toBeLessThanOrEqual(129);
    }
    ink.dispose();
  });

  it.each(['marker', 'fountain', 'pencil'] as const)('%s is deterministic across input batching, commit and reload', style => {
    const whole = line('batch', 160, { style, pressureOpacity: true });
    whole.points.forEach((p, i) => { p.pressure = 0.1 + (i % 19) / 22; p.y += Math.sin(i * 0.3) * 10; });
    const liveStroke = { ...whole, points: [] } as PdfStroke;
    const live = new StreamingInkStroke(liveStroke);
    for (let i = 0; i < whole.points.length; i += 7) {
      liveStroke.points.push(...whole.points.slice(i, i + 7)); live.update();
    }
    const preview = raster(live);
    const restored = rebuildTiles([JSON.parse(JSON.stringify(whole)) as PdfStroke]);
    expectPixels(preview, restored.get('0:0')!);
    live.dispose();
  });
});

describe('dense whole-stroke erase', () => {
  it.each(['marker', 'pencil'] as const)('reuses already feathered %s rasters and preserves free-eraser order', style => {
    const strokes = Array.from({ length: 30 }, (_, i) => line(`dense${i}`, 10, {
      style, renderVersion: i % 2 ? 2 : undefined, opacity: 0.15, size: 5,
    }));
    strokes.splice(10, 0, line('carve', 2, { renderVersion: undefined, compositeOperation: 'destination-out', size: 9, opacity: 1 }));
    const tiles = rebuildTiles(strokes);
    const index = new InkStrokeIndex(); strokes.forEach(s => index.add(s));
    const before = inkRasterCacheStats();
    const removed = strokes[15];
    removeStrokesFromTiles(tiles, index.grid, new Set([removed.id]), [removed], index.bounds);
    const after = inkRasterCacheStats();
    expect(after.misses).toBe(before.misses);
    expect(after.hits - before.hits).toBeGreaterThan(20);
    const expected = rebuildTiles(strokes.filter(s => s !== removed));
    expectPixels(tiles.get('0:0')!, expected.get('0:0')!);
  });

  it('bounds raster memory and can regenerate evicted pixels', () => {
    const stroke = (i: number) => line(`large${i}`, 2, { edgeFeather: false,
      points: [{ x: 0, y: 0, pressure: 1, t: 0 }, { x: 512, y: 512, pressure: 1, t: 4 }] });
    const first = stroke(0);
    const cached = getStrokeRaster(first, 0, 0, 512, 3);
    const expected = new Uint8ClampedArray(pixels(cached.image));
    releaseStreamingInk(first);
    // Enough full-tile strokes to exceed the ceiling, whatever the ceiling is.
    const perStroke = cached.image.width * cached.image.height * 4;
    const n = Math.ceil(inkRasterCacheStats().limit / perStroke) + 2;
    for (let i = 1; i < n; i++) { const s = stroke(i); getStrokeRaster(s, 0, 0, 512, 3); releaseStreamingInk(s); }
    expect(inkRasterCacheStats().bytes).toBeLessThanOrEqual(inkRasterCacheStats().limit);
    expect(inkRasterCacheStats().entries).toBeLessThan(n);
    const misses = inkRasterCacheStats().misses;
    const regenerated = getStrokeRaster(first, 0, 0, 512, 3);
    expect(inkRasterCacheStats().misses).toBe(misses + 1);
    const actual = pixels(regenerated.image);
    let different = 0; for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) different++;
    expect(different).toBe(0);
    releaseStreamingInk(first);
  });
});

describe('retained streaming ink', () => {
  it('keeps committed tiles so a dense erase re-composites instead of re-processing', () => {
    const strokes = Array.from({ length: 6 }, (_, i) => line(`keep${i}`, 60, { size: 10 }));
    const tiles = rebuildTiles(strokes);

    // Committing a stroke must no longer throw its streaming tiles away — that
    // release is what made every raster-cache miss re-process a whole stroke.
    expect(streamingInkStats().entries).toBeGreaterThan(0);
    const processed = strokes.map(s => getStreamingInk(s).stats.processedPoints);
    expect(processed.every(p => p > 0)).toBe(true);

    // Evict every cropped raster, then erase one stroke. The repair must MISS
    // the raster cache and re-composite the survivors from their live streaming
    // tiles rather than re-processing them from their raw points.
    clearInkRasterCache();
    const index = new InkStrokeIndex();
    strokes.forEach(s => index.add(s));
    const removed = strokes[3];
    const missesBefore = inkRasterCacheStats().misses;
    removeStrokesFromTiles(tiles, index.grid, new Set([removed.id]), [removed], index.bounds);
    expect(inkRasterCacheStats().misses).toBeGreaterThan(missesBefore);

    const survivors = strokes.filter(s => s !== removed);
    expect(survivors.map(s => getStreamingInk(s).stats.processedPoints))
      .toEqual(processed.filter((_, i) => i !== 3));
  });

  it('bounds retained streaming ink, evicting least-recently-used strokes', () => {
    // ~11.7MiB of streaming tiles each, so 12 clearly exceeds the 96MiB budget.
    const strokes = Array.from({ length: 12 }, (_, i) => diagonal(`diag${i}`));
    rebuildTiles(strokes);
    const stats = streamingInkStats();
    expect(stats.entries).toBeLessThan(strokes.length);
    expect(stats.bytes).toBeLessThanOrEqual(stats.limit);
  });
});

describe('persistent eraser index', () => {
  it('queries fine cells, preserves topmost order, and removes strokes from both grids', () => {
    const index = new InkStrokeIndex();
    const strokes = Array.from({ length: 256 }, (_, i) => line(`s${i}`, 1, {
      points: [{ x: (i % 16) * 30 + 15, y: Math.floor(i / 16) * 30 + 15, pressure: 0.5, t: 0 }] }));
    strokes.forEach(s => index.add(s));
    expect(index.collect(10, 10, 20, 20).length).toBeLessThan(10);
    const top = { ...strokes[0], id: 'top' }; index.add(top);
    expect(index.topmost(15, 15)[0].id).toBe('top');
    index.remove(new Set(['top', 's0']));
    expect(index.collect(10, 10, 20, 20).some(s => s.id === 'top' || s.id === 's0')).toBe(false);
    expect(index.grid.get('0:0')!.length).toBe(255);
  });

  it('block hit tests agree with full scans for both swipe directions and block boundaries', () => {
    const s = line('scan', 2048); const index = new InkStrokeIndex(); index.add(s);
    for (const [x1, y1, x2, y2] of [[600, 128, 0, 128], [0, 128, 600, 128], [256, 0, 256, 256],
      [256, 256, 256, 0], [20, 160, 460, 160], [416, 128, 416, 128]]) {
      expect(index.hit(s, x1, y1, x2, y2)).toBe(hitTestStrokeBySegment(s, x1, y1, x2, y2));
    }
  });
});


describe('streaming pencil appearance', () => {
  function straight(id: string, pressure = 0.5, opacity = 0.5, y = 128) {
    return line(id, 140, { style: 'pencil', edgeFeather: false, opacity,
      points: Array.from({ length: 140 }, (_, i) => ({ x: 32 + i * 2, y, pressure, t: i * 4 })) });
  }
  it('retains seeded grain distinct from the core and reproduces it after reload', () => {
    const a = straight('seed-a', 0), b = straight('seed-b', 0);
    const inkA = new StreamingInkStroke(a), inkB = new StreamingInkStroke(b);
    const imageA = raster(inkA), pa = pixels(imageA), pb = pixels(raster(inkB));
    let changed = 0, grainOutsideCore = 0;
    for (let y = 119 * 3; y <= 137 * 3; y++) for (let x = 60 * 3; x < 280 * 3; x++) {
      const i = (y * 1536 + x) * 4 + 3;
      if (pa[i] !== pb[i]) changed++;
      if (Math.abs(y / 3 - 128) > 1.5 && pa[i] > 0) grainOutsideCore++;
    }
    expect(changed).toBeGreaterThan(50);
    expect(grainOutsideCore).toBeGreaterThan(20);
    const restored = rebuildTiles([JSON.parse(JSON.stringify(a)) as PdfStroke]);
    expectPixels(imageA, restored.get('0:0')!);
    inkA.dispose(); inkB.dispose();
  });

  it('keeps pressure-sensitive narrow lead, the pencil opacity, and clean short-stroke tips', () => {
    const inks = [0, 1].map(p => new StreamingInkStroke(straight('pressure', p)));
    const widths = inks.map(ink => {
      const data = pixels(raster(ink)); let width = 0;
      for (let y = 112 * 3; y < 144 * 3; y++) if (data[(y * 1536 + 180 * 3) * 4 + 3] >= 100) width++;
      return width;
    });
    expect(widths[1]).toBeGreaterThan(widths[0] * 1.8);
    for (const ink of inks) ink.dispose();
    const short = straight('short'); short.points = short.points.slice(0, 3);
    const shortInk = new StreamingInkStroke(short), shortData = pixels(raster(shortInk));
    const alpha = shortData[(128 * 3 * 1536 + 34 * 3) * 4 + 3];
    expect(alpha).toBeGreaterThanOrEqual(107); expect(alpha).toBeLessThanOrEqual(109); // .5 * .85
    const grain = new StreamingPencilGrain(short);
    expect(grain.preview(short.points[0], short.points[2])).toHaveLength(0);
    shortInk.dispose();
  });

  it('does not darken core or grain to opaque during repeated retracing, including cell seams', () => {
    const ink = new StreamingInkStroke(line('retrace-pencil', 1000, { style: 'pencil' }));
    const data = pixels(raster(ink));
    let maxAlpha = 0;
    for (let i = 3; i < data.length; i += 4) maxAlpha = Math.max(maxAlpha, data[i]);
    expect(maxAlpha).toBeGreaterThan(107);
    expect(maxAlpha).toBeLessThanOrEqual(122); // .425 + .08 * (1 - .425), plus quantization
    for (const x of [128, 256, 384]) expect(data[(128 * 3 * 1536 + x * 3) * 4 + 3]).toBeGreaterThan(107);
    ink.dispose();
  });

  it('keeps graphite streaks longer than tiny input steps without escaping stroke bounds', () => {
    const s = straight('short-steps'); s.size = 12;
    const grain = new StreamingPencilGrain(s);
    const marks = [];
    for (let i = 1; i <= 150; i++) marks.push(...grain.advance({ x: i - 1, y: 128 }, { x: i, y: 128 }));
    expect(marks.some(mark => Math.hypot(mark.b.x - mark.a.x, mark.b.y - mark.a.y) > 2)).toBe(true);
    for (const mark of marks) for (const point of [mark.a, mark.b]) {
      expect(point.x - grain.width / 2).toBeGreaterThanOrEqual(-s.size / 2);
      expect(point.x + grain.width / 2).toBeLessThanOrEqual(150 + s.size / 2);
      expect(Math.abs(point.y - 128) + grain.width / 2).toBeLessThanOrEqual(s.size / 2);
    }
  });

  it('retains only a short grain tail and does not consume seed state for a temporary tip', () => {
    const s = straight('tail'); const grain = new StreamingPencilGrain(s);
    for (let i = 1; i < 4096; i++) {
      const a = { x: (i - 1) * 8, y: 128 }, b = { x: i * 8, y: 128 };
      grain.advance(a, b);
      const stats = { ...grain.stats };
      expect(grain.preview(b, { x: b.x + 20, y: 128 })).toEqual(grain.preview(b, { x: b.x + 20, y: 128 }));
      expect(grain.stats).toEqual(stats);
      expect(grain.stats.pending).toBeLessThan(10);
    }
    expect(grain.stats.candidates).toBeGreaterThan(10000);
  });
});
