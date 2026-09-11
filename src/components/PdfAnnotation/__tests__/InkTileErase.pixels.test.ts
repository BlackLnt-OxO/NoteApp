import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rebuildTiles, removeStrokesFromTiles } from '../../InfiniteInkCanvas/InkTiles';
import { getStrokeBounds, type Bounds } from '../PdfEngine';
import type { PdfStroke } from '../PdfTypes';
import { clearInkRasterCache, inkRasterCacheStats } from '../InkRasterCache';
import { clearStreamingInk } from '../StreamingInkStroke';

function stroke(id: string, x: number, y: number, patch: Partial<PdfStroke> = {}): PdfStroke {
  return {
    id, type: 'stroke', color: '#1267cb', size: 8, opacity: 0.65,
    smoothing: 0.05, createdAt: 0, compositeOperation: 'source-over',
    points: Array.from({ length: 12 }, (_, i) => ({
      x: x + i * 2, y: y + Math.sin(i * 0.8) * 5,
      pressure: 0.25 + i * 0.05, t: i * 8,
    })),
    ...patch,
  };
}

function index(strokes: PdfStroke[]) {
  const grid = new Map<string, PdfStroke[]>();
  const bounds = new Map<string, Bounds>();
  for (const s of strokes) {
    const b = getStrokeBounds(s);
    bounds.set(s.id, b);
    for (let ty = Math.floor(b.minY / 512); ty <= Math.floor(b.maxY / 512); ty++) {
      for (let tx = Math.floor(b.minX / 512); tx <= Math.floor(b.maxX / 512); tx++) {
        const key = `${tx}:${ty}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(s);
      }
    }
  }
  return { grid, bounds };
}

function expectSamePixels(actual: Map<string, HTMLCanvasElement>, expected: Map<string, HTMLCanvasElement>) {
  for (const key of new Set([...actual.keys(), ...expected.keys()])) {
    const a = actual.get(key), b = expected.get(key);
    const pixels = (canvas?: HTMLCanvasElement) => canvas
      ? canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      : new Uint8ClampedArray(1536 * 1536 * 4);
    // Compare complete tiles, including pixels outside the repair region.
    const ap = pixels(a), bp = pixels(b);
    let differences = 0;
    for (let i = 0; i < ap.length; i++) if (ap[i] !== bp[i]) differences++;
    const examples: object[] = [];
    for (let i = 0; i < ap.length && examples.length < 8; i++) if (ap[i] !== bp[i]) examples.push({ x: Math.floor(i / 4) % 1536, y: Math.floor(i / 4 / 1536), channel: i % 4, actual: ap[i], expected: bp[i] });
    expect(differences, key + JSON.stringify(examples)).toBe(0);
  }
}

beforeEach(() => {
  clearInkRasterCache();
  const original = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((name: string, options?: ElementCreationOptions) =>
    name === 'canvas' ? createCanvas(1, 1) : original(name, options)) as typeof document.createElement);
});
afterEach(() => { clearInkRasterCache(); clearStreamingInk(); vi.restoreAllMocks(); });

describe('whole-stroke erase dirty regions (real pixels)', () => {
  it.each(['marker', 'fountain', 'pencil'] as const)('preserves overlapping translucent %s ink and free-eraser order', (style) => {
    const strokes = [
      stroke('under', 100, 100, { style }),
      stroke('removed', 105, 103),
      stroke('carve', 106, 104, { size: 6, opacity: 1, compositeOperation: 'destination-out' }),
      stroke('above', 102, 102, { style, color: '#ef8c2d', pressureOpacity: true }),
      stroke('distant', 380, 380, { style }),
    ];
    const tiles = rebuildTiles(strokes);
    const { grid, bounds } = index(strokes);
    removeStrokesFromTiles(tiles, grid, new Set(['removed']), [strokes[1]], bounds);
    expectSamePixels(tiles, rebuildTiles(strokes.filter(s => s.id !== 'removed')));
  });

  it('preserves feathered ink across positive and negative tile boundaries', () => {
    const strokes = [
      stroke('negative', -14, -2), stroke('neighbor', -8, 2, { style: 'fountain' }),
      stroke('edge', 500, 508), stroke('edge-neighbor', 503, 512),
    ];
    const tiles = rebuildTiles(strokes);
    const { grid, bounds } = index(strokes);
    const skip = new Set(['negative', 'edge']);
    removeStrokesFromTiles(tiles, grid, skip, [strokes[0], strokes[2]], bounds);
    expectSamePixels(tiles, rebuildTiles(strokes.filter(s => !skip.has(s.id))));
  });

  it('does not resurrect earlier removals and drops tiles with no survivors', () => {
    const strokes = [stroke('a', 100, 100), stroke('b', 105, 105)];
    const tiles = rebuildTiles(strokes);
    const { grid, bounds } = index(strokes);
    const skip = new Set(['a']);
    removeStrokesFromTiles(tiles, grid, skip, [strokes[0]], bounds);
    skip.add('b');
    removeStrokesFromTiles(tiles, grid, skip, [strokes[1]], bounds);
    expect(tiles.size).toBe(0);
  });

  it('replays only nearby ink in a dense tile, with identical final pixels', () => {
    const strokes = Array.from({ length: 400 }, (_, i) => stroke(`s${i}`, 10 + (i % 20) * 24, 12 + Math.floor(i / 20) * 24, { size: 3, edgeFeather: false }));
    const tiles = rebuildTiles(strokes);
    const { grid, bounds } = index(strokes);
    const before = inkRasterCacheStats();
    const removed = strokes[210];
    removeStrokesFromTiles(tiles, grid, new Set([removed.id]), [removed], bounds);
    expect(inkRasterCacheStats().hits - before.hits).toBeLessThan(10);
    expect(inkRasterCacheStats().misses).toBe(before.misses);
    expectSamePixels(tiles, rebuildTiles(strokes.filter(s => s !== removed)));
  });
});
