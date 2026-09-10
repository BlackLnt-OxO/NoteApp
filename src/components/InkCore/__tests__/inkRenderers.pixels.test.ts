/**
 * Real-pixel regression tests for the shared brush renderer.
 *
 * jsdom has no canvas, so these use @napi-rs/canvas (a real native 2D
 * rasterizer) to verify the ACTUAL pixels that matter:
 *  - a stroke that turns back and covers its own interior must be OPAQUE in the
 *    overlap (no transparent "dug out" hole) — the regression that a single
 *    self-intersecting outline used to cause;
 *  - marker AND fountain both pass;
 *  - tips stay round/opaque (no hollow);
 *  - rendering is deterministic (live preview re-draw == final tile re-draw);
 *  - the destination-out eraser path is unaffected.
 */
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';

import { drawAnnotatedStroke, prepareInkRibbon, drawInkRibbonSlice } from '../inkRenderers';
import type { InkStroke } from '../inkTypes';

function makeStroke(
  points: { x: number; y: number; pressure: number; t: number }[],
  overrides: Partial<InkStroke> = {},
): InkStroke {
  return {
    id: 's_px',
    type: 'stroke',
    points,
    color: '#000000',
    size: 12,
    opacity: 1,
    smoothing: 0,
    compositeOperation: 'source-over',
    style: undefined,
    createdAt: 0,
    ...overrides,
  };
}

interface Raster {
  ctx: CanvasRenderingContext2D;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function rasterize(stroke: InkStroke, width: number, height: number): Raster {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  drawAnnotatedStroke(ctx, stroke);
  const img = ctx.getImageData(0, 0, width, height);
  return { ctx, data: img.data, width, height };
}

/** Opaque-black coverage at (x, y): true when alpha is essentially full. */
function isOpaque(r: Raster, x: number, y: number): boolean {
  return r.data[(y * r.width + x) * 4 + 3] > 200;
}

/** Whether there is ANY drawn ink near (x, y) — used to find holes. */
function isInked(r: Raster, x: number, y: number): boolean {
  return r.data[(y * r.width + x) * 4 + 3] > 0;
}

/** ASCII coverage map of a region (useful to see where a hole is). */
function describeRows(r: Raster, x0: number, x1: number, y0: number, y1: number): string {
  const lines: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let row = `y${y}: `;
    for (let x = x0; x <= x1; x++) {
      row += isInked(r, x, y) ? '#' : '.';
    }
    lines.push(row);
  }
  return lines.join(' | ');
}

/**
 * A stroke that writes right, then turns around and returns INSIDE the part it
 * already drew (the classic reproducer for the transparent self-overlap hole).
 * The two passes are slightly offset vertically so they overlap like real
 * handwriting instead of being a single degenerate line.
 */
function retracePoints(dt = 8): { x: number; y: number; pressure: number; t: number }[] {
  const pts: { x: number; y: number; pressure: number; t: number }[] = [];
  let t = 0;
  const yOut = 30;
  const yBack = 33; // return pass runs inside the first pass's stroke
  for (let x = 20; x <= 140; x += 5) {
    pts.push({ x, y: yOut, pressure: 1, t });
    t += dt;
  }
  for (let x = 138; x >= 40; x -= 5) {
    pts.push({ x, y: yBack, pressure: 1, t });
    t += dt;
  }
  return pts;
}

describe('self-overlap must be OPAQUE (no winding-0 holes) — real pixels', () => {
  it.each([
    ['marker', { dt: 8, size: 12 }],
    ['fountain', { dt: 24, size: 20 }], // slow + large → clearly fat overlap band
  ] as const)('%s: retrace overlapping itself has no transparent hole in the overlap band', (style, p) => {
    const stroke = makeStroke(retracePoints(p.dt), {
      style: style === 'marker' ? undefined : 'fountain',
      size: p.size,
      inkSpeed: 0.5,
      pressureOpacity: false,
    });
    const r = rasterize(stroke, 220, 80);

    // Overlap region where BOTH passes definitely exist (interior, safely inside
    // the union silhouette). Scan every pixel: NOT ONE may be fully transparent.
    let inked = 0;
    const holes: string[] = [];
    for (let y = 28; y <= 35; y++) {
      for (let x = 52; x <= 128; x++) {
        if (isInked(r, x, y)) inked++;
        else holes.push(`${x},${y}`);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(holes, `hole map: ${describeRows(r, 44, 80, 26, 37)}`).toEqual([]);
    // ...and the overlap must actually be drawn (sanity: a real opaque mass).
    expect(inked).toBeGreaterThan(400);
    // Center of the overlap is solid opaque (union, not 2× semi-transparent).
    expect(isOpaque(r, 90, 30)).toBe(true);
  });

  it('round tips (start/end discs) are opaque — no hollow cap', () => {
    const stroke = makeStroke(retracePoints(), { pressureOpacity: false });
    const r = rasterize(stroke, 220, 80);
    const head = stroke.points[0];
    const tail = stroke.points[stroke.points.length - 1];
    // Inside the head/tail discs (radius ≈ size/2 = 6): fully inked.
    expect(isOpaque(r, head.x, head.y)).toBe(true);
    expect(isOpaque(r, tail.x, tail.y)).toBe(true);
    // And just inside the round edge there is ink (not a hollow ring).
    expect(isInked(r, Math.round(head.x + 4), Math.round(head.y))).toBe(true);
  });

  it('rendering is deterministic: two draws of the same stroke are pixel-identical', () => {
    const stroke = makeStroke(retracePoints(), { style: 'fountain', inkSpeed: 0.5 });
    const a = rasterize(stroke, 220, 80);
    const b = rasterize(stroke, 220, 80);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('tile slice is pixel-identical to the whole stroke inside the tile', () => {
    const W = 340, H = 90;
    const stroke = makeStroke(
      [
        { x: 20, y: 45, pressure: 1, t: 0 },
        { x: 90, y: 44, pressure: 0.6, t: 16 },
        { x: 180, y: 46, pressure: 1, t: 32 },
        { x: 300, y: 45, pressure: 0.8, t: 48 },
      ],
      { size: 14, pressureOpacity: false },
    );

    // Whole-stroke reference (what the old stampStroke produced).
    const ref = rasterize(stroke, W, H);

    // "Tile" that intersects the middle of the stroke: rect x[110,150] y[30,60].
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    ctx.beginPath();
    ctx.rect(110, 30, 40, 30);
    ctx.clip();
    const ribbon = prepareInkRibbon(stroke);
    expect(ribbon).not.toBeNull();
    if (ribbon) drawInkRibbonSlice(ctx, ribbon, 110, 30, 150, 60);
    const sliced = ctx.getImageData(0, 0, W, H).data;

    // Compare the stroke's SOLID interior well inside the rect (away from blur /
    // clip margins) — the slice must be pixel-identical there (no gap, no seam).
    let opaque = 0;
    for (let y = 41; y < 49; y++) {
      for (let x = 118; x < 142; x++) {
        const i = (y * W + x) * 4;
        if (sliced[i + 3] > 200) opaque++;
        for (let c = 0; c < 4; c++) {
          expect(sliced[i + c]).toBe(ref.data[i + c]);
        }
      }
    }
    expect(opaque).toBeGreaterThan((142 - 118) * (49 - 41) * 0.8); // real ink, not empty
  });
});

describe('destination-out eraser is unaffected — real pixels', () => {
  it('erases through previously committed ink only in its own path', () => {
    const canvas = createCanvas(120, 60);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;

    // Commit an opaque horizontal marker line first.
    const marker = makeStroke(
      [
        { x: 10, y: 30, pressure: 1, t: 0 },
        { x: 110, y: 30, pressure: 1, t: 8 },
      ],
      { size: 12, pressureOpacity: false },
    );
    drawAnnotatedStroke(ctx, marker);

    // Now erase a vertical band through the middle.
    const eraser = makeStroke(
      [
        { x: 60, y: 15, pressure: 1, t: 0 },
        { x: 60, y: 45, pressure: 1, t: 8 },
      ],
      { compositeOperation: 'destination-out', size: 20, opacity: 1 },
    );
    drawAnnotatedStroke(ctx, eraser);

    const data = ctx.getImageData(0, 0, 120, 60).data;
    const alphaAt = (x: number, y: number) => data[(y * 120 + x) * 4 + 3];

    // Inside the erased band the ink is gone; beside it the ink remains.
    expect(alphaAt(60, 30)).toBe(0);
    expect(alphaAt(25, 30)).toBeGreaterThan(200);
  });
});
