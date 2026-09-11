/**
 * Edge feather must be ONE value per stroke.
 *
 * The tile stamp path hands drawVariableRibbon a 512-unit SLICE of a stroke, and
 * the feather used to be derived from whatever widths that slice carried — so a
 * stroke whose pressure varied picked a different blur per tile. Measured on one
 * stroke: 0.28px at one end rising to 1.75px at the other, with a visible step at
 * tile boundaries. The radius is now resolved once from the whole ribbon.
 *
 * Separately, the old cutoff (skip feather below 0.05 world px) sat ABOVE what a
 * lightly-pressed thin stroke derives — the width floor is ~0.15 world, so the
 * derived feather lands near 0.04 — which is why light strokes silently got none.
 */
import { describe, it, expect } from 'vitest';

import { resolveFeatherWorld, autoFeatherWorld, FEATHER_AUTO_MAX, FEATHER_MIN_WORLD } from '../InkMath';
import { prepareInkRibbon } from '../PdfBrushRenderers';
import type { PdfPoint, PdfStroke } from '../PdfTypes';

function makeStroke(size: number, pStart: number, pEnd: number, n = 600, over: Partial<PdfStroke> = {}): PdfStroke {
  const points: PdfPoint[] = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    points.push({ x: f * 3000, y: 0, pressure: pStart + (pEnd - pStart) * f, t: i * 8 });
  }
  return {
    id: 'feather-probe', type: 'stroke', points, color: '#000', size, opacity: 1,
    smoothing: 0.05, compositeOperation: 'source-over', createdAt: 0, ...over,
  };
}

describe('resolveFeatherWorld', () => {
  it('an explicit featherSize wins over the width-derived value', () => {
    expect(resolveFeatherWorld({ featherSize: 1.25 }, [8])).toBeCloseTo(1.25, 6);
    expect(resolveFeatherWorld({ featherSize: 0.1 }, [40])).toBeCloseTo(0.1, 6);
  });

  it('featherSize 0 turns the feather off', () => {
    expect(resolveFeatherWorld({ featherSize: 0 }, [40])).toBe(0);
  });

  it('the edgeFeather toggle overrides any size', () => {
    expect(resolveFeatherWorld({ edgeFeather: false, featherSize: 1.5 }, [40])).toBe(0);
    expect(resolveFeatherWorld({ edgeFeather: false }, [40])).toBe(0);
  });

  it('falls back to the width-derived value on legacy ink', () => {
    expect(resolveFeatherWorld({}, [8, 8, 8])).toBeCloseTo(autoFeatherWorld([8, 8, 8]), 6);
  });

  it('the width-derived feather is capped', () => {
    expect(autoFeatherWorld([200, 200])).toBeCloseTo(FEATHER_AUTO_MAX, 6);
  });

  it('a lightly-pressed thin stroke still gets a feather', () => {
    // The regression: this used to fall below the old 0.05 cutoff and render with
    // a hard edge, while a firmer stroke of the same size rendered soft.
    const light = autoFeatherWorld([0.181, 0.181, 0.181]);
    expect(light).toBeGreaterThan(FEATHER_MIN_WORLD);
    expect(light).toBeGreaterThan(0);
  });
});

describe('prepareInkRibbon feather', () => {
  it('carries ONE radius derived from the whole stroke', () => {
    const stroke = makeStroke(8, 0.02, 1.0);
    const ribbon = prepareInkRibbon(stroke)!;
    expect(ribbon.feather).toBeCloseTo(resolveFeatherWorld(stroke, ribbon.widths), 9);
  });

  it('does NOT use a slice-local average, which would vary tile to tile', () => {
    const stroke = makeStroke(8, 0.02, 1.0);
    const r = prepareInkRibbon(stroke)!;

    // Simulate what the tile path hands the renderer: the widths of one 512-unit
    // tile. Under the old per-slice rule each of these produced its own blur.
    const sliceAverages: number[] = [];
    for (let t = 0; t < 5; t++) {
      const lo = t * 512, hi = (t + 1) * 512;
      const widths: number[] = [];
      for (let i = 0; i < r.points.length; i++) {
        const q = r.points[i];
        if (q.x >= lo - r.pad && q.x <= hi + r.pad) widths.push(r.widths[i]);
      }
      if (widths.length) sliceAverages.push(autoFeatherWorld(widths));
    }

    // The slices really would have disagreed (so this is a meaningful guard)...
    expect(sliceAverages.length).toBeGreaterThan(1);
    expect(Math.max(...sliceAverages)).toBeGreaterThan(Math.min(...sliceAverages));
    // ...but every tile now uses the ribbon's single value.
    expect(r.feather).toBeCloseTo(resolveFeatherWorld(stroke, r.widths), 9);
  });

  it('a stroke drawn with an explicit size carries exactly that', () => {
    const r = prepareInkRibbon(makeStroke(8, 0.5, 0.5, 200, { featherSize: 1.1 }))!;
    expect(r.feather).toBeCloseTo(1.1, 6);
  });
});
