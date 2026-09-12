import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { StreamingInkStroke, getStreamingInk, releaseStreamingInk, clearStreamingInk, streamingInkStats, renderStrokeOnce } from '../StreamingInkStroke';
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
/**
 * Restoring a version-2 marker/fountain stroke paints it in ONE pass
 * (`renderStrokeOnce`) instead of rebuilding its incremental cell raster — the
 * cell surfaces are what made reopening a dense canvas take tens of seconds.
 *
 * The two agree everywhere except in a narrow band on the incremental
 * renderer's own CELL boundaries (every 128 world units), where it composites
 * each cell from that cell's pixels. Measured against the incremental raster
 * over a corpus of strokes — widths 1–43, opacities 0.15–1, feather on and
 * off, smoothing 0–0.2, and deliberate fast flicks that drop most samples — the
 * worst single pixel moves 14/255 and the mean moves 0.003/255, i.e. a handful
 * of antialiased edge pixels. Bounded here (with headroom) so it can never
 * silently grow into a visible change.
 */
const RESTORE_MAX_ALPHA_DRIFT = 16;  // /255, at any single pixel (corpus worst: 14)
const RESTORE_MAX_MEAN_DRIFT = 0.01; // /255, averaged over the raster (corpus worst: 0.003)
function expectPixelsRestored(a: HTMLCanvasElement, b: HTMLCanvasElement) {
  const pa = pixels(a), pb = pixels(b);
  expect(pa.length).toBe(pb.length);
  let worst = 0, sum = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const d = Math.abs(pa[i + 3] - pb[i + 3]);
    if (d > worst) worst = d;
    sum += d;
  }
  expect(worst).toBeLessThanOrEqual(RESTORE_MAX_ALPHA_DRIFT);
  expect(sum / (pa.length / 4)).toBeLessThan(RESTORE_MAX_MEAN_DRIFT);
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
    // Pencil still restores through the incremental raster (its grain is only
    // defined step by step), so it must stay bit-identical; marker/fountain are
    // repainted in one pass and hold to the documented bound instead.
    if (style === 'pencil') expectPixels(preview, restored.get('0:0')!);
    else expectPixelsRestored(preview, restored.get('0:0')!);
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

describe('restoring and repairing ink', () => {
  it('repairs a dense erase without building an incremental raster per stroke', () => {
    const strokes = Array.from({ length: 6 }, (_, i) => line(`keep${i}`, 60, { size: 10 }));
    const tiles = rebuildTiles(strokes);

    // Restoring a canvas must NOT build incremental rasters for its strokes: it
    // repaints them in one pass instead, which is what keeps opening a dense
    // canvas cheap. A stroke being written right now is the only thing that
    // keeps one (see PdfBrushRenderers.drawAnnotatedStroke).
    expect(streamingInkStats().entries).toBe(0);

    // Evict every cropped raster, then erase one stroke. The repair must MISS
    // the raster cache and repaint the survivors from their raw points — which
    // is only affordable because that repaint is one pass, not a cell rebuild.
    clearInkRasterCache();
    const index = new InkStrokeIndex();
    strokes.forEach(s => index.add(s));
    const removed = strokes[3];
    const missesBefore = inkRasterCacheStats().misses;
    removeStrokesFromTiles(tiles, index.grid, new Set([removed.id]), [removed], index.bounds);
    expect(inkRasterCacheStats().misses).toBeGreaterThan(missesBefore);
    expect(streamingInkStats().entries).toBe(0);
  });

  it('repaints a stroke from raw points in one pass, not per cell', () => {
    // A cell-spanning stroke is the worst case for the incremental raster: its
    // cells would each allocate a mask + image surface. The one-pass painter
    // must touch no incremental raster at all and still land the ink.
    const s = line('oneshot', 300);
    const raster = getStrokeRaster(s, 0, 0, 512, 3);
    expect(streamingInkStats().entries).toBe(0);
    let ink = 0;
    const data = pixels(raster.image);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    expect(ink).toBeGreaterThan(1000);
  });

  it('paints nothing — and builds nothing — for a tile the stroke only brackets', () => {
    // An "L": along the top (y=100) then down the right (x=1500). Its BOUNDING
    // BOX spans 9 tiles, but the path never enters the middle one — that tile
    // must come out empty without building an incremental raster to find out.
    const s = line('bracket', 3, {
      points: [
        { x: 100, y: 100, pressure: 1, t: 0 },
        { x: 1500, y: 100, pressure: 1, t: 200 },
        { x: 1500, y: 1500, pressure: 1, t: 400 },
      ],
    });
    const empty = getStrokeRaster(s, 1, 1, 512, 3);
    expect(streamingInkStats().entries).toBe(0);
    let ink = 0;
    const data = pixels(empty.image);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    expect(ink).toBe(0);
    // The tiles the path DOES cross still get their ink.
    for (const [tx, ty] of [[1, 0], [2, 1]]) {
      let crossed = 0;
      const d = pixels(getStrokeRaster(s, tx, ty, 512, 3).image);
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) crossed++;
      expect(crossed).toBeGreaterThan(100);
    }
    expect(streamingInkStats().entries).toBe(0);
  });

  it('holds the restore bound across widths, pressures, feather settings and fast flicks', () => {
    // One fixed stroke proves little: the one-pass painter slices the stroke to
    // the rect, and a FAST FLICK (a long segment between two distant samples)
    // can cross a rect with both endpoints outside it. Exercised here so a
    // regression shows up as dropped ink or an out-of-bound edge, not as a
    // surprise on the user's dense canvas.
    for (let i = 0; i < 12; i++) {
      const n = 20 + (i * 37) % 130;
      const span = 420 / n;
      const points = [];
      for (let k = 0; k < n; k++) {
        if (i % 5 === 0 && k % 12 !== 0) continue; // fast flick: most samples gone
        points.push({
          x: 30 + k * span, y: 150 + Math.sin(k * 0.2 + i) * (4 + (i % 7) * 4) + (i % 3) * 60,
          pressure: 0.05 + ((k * 7 + i) % 23) / 23, t: k * (3 + (i % 4)),
        });
      }
      const s: PdfStroke = {
        id: `sweep${i}`, type: 'stroke', renderVersion: 2, size: 1 + (i % 14) * 3,
        color: '#1267cb', opacity: 0.15 + ((i * 13) % 85) / 100, smoothing: [0, 0.05, 0.2][i % 3],
        compositeOperation: 'source-over', createdAt: 0,
        style: (['marker', 'fountain', undefined] as const)[i % 3],
        pressureOpacity: i % 2 === 0, edgeFeather: i % 7 !== 0,
        points,
      };
      const restored = renderStrokeOnce(s, 3, 0, 0, 512, 512);
      expect(restored).not.toBeNull(); // never drop the ink
      const live = { ...s, points: [] } as PdfStroke;
      const ink = new StreamingInkStroke(live);
      for (let k = 0; k < s.points.length; k += 7) { live.points.push(...s.points.slice(k, k + 7)); ink.update(); }
      const preview = raster(ink);
      ink.dispose();
      const target = createCanvas(1536, 1536) as unknown as HTMLCanvasElement;
      const tctx = target.getContext('2d')!;
      tctx.scale(3, 3);
      tctx.drawImage(restored!, 0, 0, restored!.width / 3, restored!.height / 3);
      expectPixelsRestored(preview, target);
    }
  }, 120000);

  it('does not depend on which tile is asked for first', () => {
    // A raster must be a function of (stroke, tile) alone — never of the order
    // tiles happened to be built in, or the same ink would look different
    // depending on where the user looked first.
    const s = line('order', 300);
    const a = getStrokeRaster(s, 0, 0, 512, 3);
    const second = getStrokeRaster(s, 0, 0, 512, 3); // now a cache hit
    expect(pixels(second.image)).toEqual(pixels(a.image));
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
