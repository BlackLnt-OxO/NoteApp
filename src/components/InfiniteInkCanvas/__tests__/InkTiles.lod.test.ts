/**
 * Ink tile bake scale: the level-of-detail machinery.
 *
 * Ink used to be baked at a fixed 3× supersample. Baking at the density the ink
 * is DISPLAYED at is what removes the 5.6× per-frame downscale and the ~486 MiB
 * of visible-tile surfaces on a dense canvas — but it means tiles at different
 * scales coexist, which is the hazard these tests exist for: every writer has to
 * use the scale of the tile it writes into, or ink moves rather than blurs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  BAKE_STEPS, bakeStepAtLeast, bakeStepFor, indexInkStrokes, materializeTiles,
  removeStrokesFromTiles, stampStroke, evictDistantTiles, inkTileBytes, targetBakeScale,
  setTargetBakeScale,
} from '../InkTiles';
import { getInkStrokeIndex } from '../../PdfAnnotation/InkStrokeIndex';
import { inkRasterCacheStats, clearInkRasterCache } from '../../PdfAnnotation/InkRasterCache';
import { clearStreamingInk } from '../../PdfAnnotation/StreamingInkStroke';
import type { Stroke } from '../types';

const CAM = { x: 0, y: 0, zoom: 1 };
const VIEW = 1400; // world units of viewport — covers a 2x2 block of tiles + margin

/** A stroke that wanders across tile boundaries so tile buckets overlap. */
function stroke(id: string, seed = 0, patch: Partial<Stroke> = {}): Stroke {
  const points = [];
  for (let i = 0; i < 60; i++) {
    points.push({
      x: 40 + ((i * 17 + seed * 53) % 900),
      y: 40 + ((i * 31 + seed * 29) % 900),
      pressure: 0.2 + ((i * 7) % 17) / 20,
      t: i * 4,
    });
  }
  return {
    id, type: 'stroke', points, color: '#1267cb', size: 6 + (seed % 3) * 5,
    opacity: 0.6, smoothing: 0.05, compositeOperation: 'source-over', createdAt: 0,
    // Half version-2 (one-pass raster), half legacy (ribbon raster): both paths
    // must land at the same bake scale.
    renderVersion: seed % 2 ? 2 : undefined,
    ...patch,
  };
}

// These build whole tile layers and compare them pixel by pixel on a software
// canvas, which is slow — and slower still when the suite runs files in parallel.
vi.setConfig({ testTimeout: 120000 });

beforeEach(() => {
  clearInkRasterCache();
  clearStreamingInk();
  vi.spyOn(document, 'createElement').mockImplementation(((name: string) =>
    name === 'canvas' ? createCanvas(1, 1) : (undefined as any)) as typeof document.createElement);
});

/** Build a layer the way the editor does — index everything, then rasterize the
 *  view — running the frame chain to completion, since one pass is deliberately
 *  budget-bounded (a 3x tile is 9 MiB against a 12 MiB per-pass budget, i.e. one
 *  tile a frame). `passes` reports how many frames that took. */
function buildLayer(strokes: Stroke[], deviceScale: number, view = VIEW) {
  const tiles = new Map<string, HTMLCanvasElement>();
  indexInkStrokes(tiles, strokes);
  let res = materializeTiles(tiles, CAM, view, view, deviceScale);
  let passes = 1;
  while (res.remaining > 0 && passes < 200) {
    res = materializeTiles(tiles, CAM, view, view, deviceScale);
    passes++;
  }
  return { tiles, scale: res.scale, materialized: res.materialized, passes };
}

function tilePixels(c: HTMLCanvasElement): Uint8ClampedArray {
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
}

function expectSamePixels(a: HTMLCanvasElement, b: HTMLCanvasElement, what: string) {
  expect(a.width, `${what}: width`).toBe(b.width);
  expect(b.height, `${what}: height`).toBe(a.height);
  const pa = tilePixels(a), pb = tilePixels(b);
  let different = 0, worst = 0;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) {
      different++;
      if (i % 4 === 3) worst = Math.max(worst, Math.abs(pa[i] - pb[i]));
    }
  }
  expect(different, `${what}: differing bytes (worst alpha delta ${worst})`).toBe(0);
}

describe('bake step selection', () => {
  it('picks the coarsest step that still at least matches the display density', () => {
    expect(bakeStepAtLeast(0.2)).toBe(0.25);
    expect(bakeStepAtLeast(0.25)).toBe(0.25);
    expect(bakeStepAtLeast(0.3)).toBe(0.5);
    expect(bakeStepAtLeast(0.54)).toBe(1);
    expect(bakeStepAtLeast(1)).toBe(1);
    expect(bakeStepAtLeast(1.2)).toBe(2);
    expect(bakeStepAtLeast(2.5)).toBe(3);
    // Past the last step the ink is upsampled rather than baked larger.
    expect(bakeStepAtLeast(8)).toBe(BAKE_STEPS[BAKE_STEPS.length - 1]);
  });

  it('never re-bakes a display density that is only marginally different', () => {
    // Upgraded as soon as the display outgrows the bake…
    expect(bakeStepFor(1.2, 1)).toBe(2);
    expect(bakeStepFor(1.1, 1)).toBe(1); // …but not for a 10% nudge
    // …and downgraded only well below it, so hovering on a step boundary is stable.
    expect(bakeStepFor(1.0, 2)).toBe(2);
    expect(bakeStepFor(0.7, 2)).toBe(1);
    expect(bakeStepFor(1.0, 1)).toBe(1);
  });
});

describe('baking at the display density', () => {
  it('bakes a smaller tile when the view is zoomed out, and the ink still lands', () => {
    const strokes = [stroke('a'), stroke('b', 1), stroke('c', 2)];
    const near = buildLayer(strokes, 3);
    const far = buildLayer(strokes, 0.5);

    expect(near.scale).toBe(3);
    expect(far.scale).toBe(0.5);
    expect(far.tiles.size).toBe(near.tiles.size); // same coverage, cheaper pixels
    const nearBytes = inkTileBytes(near.tiles), farBytes = inkTileBytes(far.tiles);
    expect(farBytes).toBeLessThan(nearBytes / 20); // (3/0.5)² = 36x fewer pixels
    for (const c of far.tiles.values()) expect(c.width).toBe(256);

    let ink = 0;
    for (const c of far.tiles.values()) {
      const d = tilePixels(c);
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
    }
    expect(ink).toBeGreaterThan(500); // the strokes are actually in there
  });

  it('re-bakes a tile in place when the display outgrows it, identically to a fresh build', () => {
    const strokes = [stroke('a'), stroke('b', 1), stroke('c', 2), stroke('d', 3)];
    // Built small first (as if the user opened zoomed out)…
    const upgraded = buildLayer(strokes, 0.5).tiles;
    expect([...upgraded.values()][0].width).toBe(256);
    // …then zoomed in until the bake has to catch up.
    let res = materializeTiles(upgraded, { ...CAM, zoom: 3 }, VIEW, VIEW, 1);
    expect(res.scale).toBe(3);
    let guard = 0;
    while (res.remaining > 0 && guard++ < 200) {
      res = materializeTiles(upgraded, { ...CAM, zoom: 3 }, VIEW, VIEW, 1);
    }

    const fresh = buildLayer(strokes, 3).tiles;
    expect(fresh.size).toBe(upgraded.size);
    for (const [key, expected] of fresh) {
      expectSamePixels(upgraded.get(key)!, expected, `re-baked tile ${key}`);
    }
  });

  it('keeps the target scale per layer, and defaults to the legacy 3x', () => {
    const layer = new Map<string, HTMLCanvasElement>();
    expect(targetBakeScale(layer)).toBe(3); // surfaces that do not opt in
    expect(setTargetBakeScale(layer, 0.5)).toBe(0.5);
    expect(targetBakeScale(layer)).toBe(0.5);
  });
});

describe('writers use the scale of the tile they write into', () => {
  it('repairs an erase at a non-legacy bake scale exactly like a fresh build', () => {
    const strokes = [stroke('a'), stroke('b', 1), stroke('c', 2), stroke('d', 3), stroke('e', 4)];
    const removed = strokes[2];

    const tiles = buildLayer(strokes, 1).tiles;
    const index = getInkStrokeIndex(tiles);
    const before = inkRasterCacheStats();
    removeStrokesFromTiles(tiles, index.grid, new Set([removed.id]), [removed], index.bounds);
    // The repair re-composited from the raster cache rather than re-rendering
    // nothing: a scale mismatch would have produced a shifted copy-back rect,
    // i.e. duplicated or deleted bands of ink.
    expect(inkRasterCacheStats().hits).toBeGreaterThanOrEqual(before.hits);

    const expected = buildLayer(strokes.filter((s) => s !== removed), 1).tiles;
    for (const [key, want] of expected) {
      const got = tiles.get(key);
      if (!got) continue; // the repair deleted a tile it emptied — nothing to compare
      expectSamePixels(got, want, `repaired tile ${key}`);
    }
  });

  it('stamps a new stroke into an existing tile at that tile\'s scale, not the target', () => {
    const strokes = [stroke('a'), stroke('b', 1)];
    const tiles = buildLayer(strokes, 1).tiles;
    const key = [...tiles.keys()][0];
    const before = tiles.get(key)!;
    const widthBefore = before.width;

    // The layer's target moves up, but this tile is already baked at 1x: a stamp
    // must go in at 1x, because the tile's pixels are what is on screen.
    setTargetBakeScale(tiles, 3);
    stampStroke(tiles, stroke('late', 9));
    expect(tiles.get(key)!.width).toBe(widthBefore);
  });
});

describe('a materialization pass is bounded and resumable', () => {
  it('never exposes a partially rasterized tile, and finishes it across passes', () => {
    // Enough strokes in one tile that the per-stroke time check inside the build
    // is actually reached. This is the case that used to freeze the frame: a
    // dense tile rasterized in one go costs as long as it costs.
    const many = Array.from({ length: 40 }, (_, i) => stroke(`m${i}`, i, {
      points: Array.from({ length: 40 }, (_, k) => ({
        x: 60 + ((i * 13 + k * 7) % 380), y: 60 + ((i * 29 + k * 11) % 380),
        pressure: 0.4, t: k * 4,
      })),
    }));
    const tiles = new Map<string, HTMLCanvasElement>();
    indexInkStrokes(tiles, many);
    setTargetBakeScale(tiles, 1);

    // A pass with no time budget advances the build but must not publish it: what
    // is on screen has to stay a complete tile (the old one, or nothing).
    const starved = materializeTiles(tiles, CAM, VIEW, VIEW, 1, { budgetMs: 0 });
    expect(starved.materialized).toBe(0);
    expect(starved.remaining).toBeGreaterThan(0);
    for (const c of tiles.values()) {
      // Anything present must be a finished tile, never a partial raster.
      expect(c.width).toBe(512);
    }

    // Given frames to work with, it finishes — and lands the same pixels as an
    // unbudgeted build.
    let res = starved, guard = 0;
    while (res.remaining > 0 && guard++ < 2000) {
      res = materializeTiles(tiles, CAM, VIEW, VIEW, 1, { budgetMs: 4 });
    }
    expect(res.remaining).toBe(0);
    const reference = buildLayer(many, 1).tiles;
    expect(tiles.size).toBe(reference.size);
    for (const [key, want] of reference) {
      expectSamePixels(tiles.get(key)!, want, `resumed tile ${key}`);
    }
  });
});

describe('rebuilding is always allowed to discard tiles', () => {
  it('does not resurrect strokes the caller has suppressed', () => {
    const strokes = [stroke('a'), stroke('b', 1), stroke('c', 2)];
    const tiles = new Map<string, HTMLCanvasElement>();
    indexInkStrokes(tiles, strokes);
    setTargetBakeScale(tiles, 1);

    // Every stroke suppressed (a wipe in progress): nothing may be built, and the
    // chain must not be told there is work left forever.
    const all = new Set(strokes.map((s) => s.id));
    const blocked = materializeTiles(tiles, CAM, VIEW, VIEW, 1, { skipIds: all });
    expect(blocked.materialized).toBe(0);
    expect(blocked.remaining).toBe(0);
    expect(tiles.size).toBe(0);

    // Partially suppressed: the rest of the ink still lands. A single pass is
    // deliberately budget-bounded and may finish no tile at all, so run the chain
    // the way the editor does.
    const skip = new Set(['a', 'b']);
    let res = materializeTiles(tiles, CAM, VIEW, VIEW, 1, { skipIds: skip });
    let guard = 0;
    while (res.remaining > 0 && guard++ < 500) {
      res = materializeTiles(tiles, CAM, VIEW, VIEW, 1, { skipIds: skip });
    }
    expect(tiles.size).toBeGreaterThan(0);

    // …and what landed must contain the kept strokes but no suppressed one: piece
    // the tiles back together and compare against a build that never had them.
    const kept = buildLayer(strokes.filter((s) => !skip.has(s.id)), 1).tiles;
    for (const [key, want] of kept) {
      const got = tiles.get(key);
      if (!got) continue;
      expectSamePixels(got, want, `tile ${key} built with two strokes suppressed`);
    }
  });

  it('rebuilds an evicted tile identically', () => {
    const strokes = [stroke('a'), stroke('b', 1), stroke('c', 2), stroke('d', 3)];
    const first = buildLayer(strokes, 1).tiles;

    // Pan far away so the original tiles fall outside the keep radius, then force
    // reclamation with a tiny budget.
    const away = { x: -20 * 512, y: -20 * 512, zoom: 1 };
    const evicted = evictDistantTiles(first, away, VIEW, VIEW, 1);
    expect(evicted).toBeGreaterThan(0);
    expect(first.size).toBe(0);

    // Back to where we started: the same pixels, byte for byte.
    const rebuilt = new Map<string, HTMLCanvasElement>();
    indexInkStrokes(rebuilt, strokes);
    let res = materializeTiles(rebuilt, CAM, VIEW, VIEW, 1);
    let guard = 0;
    while (res.remaining > 0 && guard++ < 200) res = materializeTiles(rebuilt, CAM, VIEW, VIEW, 1);
    expect(rebuilt.size).toBeGreaterThan(0);
    const reference = buildLayer(strokes, 1).tiles;
    for (const [key, want] of reference) {
      expectSamePixels(rebuilt.get(key)!, want, `rebuilt tile ${key}`);
    }
  });
});
