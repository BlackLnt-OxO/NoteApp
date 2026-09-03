/**
 * Tests for the shared brush renderer (PdfBrushRenderers).
 *
 * Two layers:
 *  - pure geometry helpers (resampling, width curves) asserted directly;
 *  - rasterizers asserted through drawAnnotatedStroke against a recording mock
 *    2D context (jsdom has no real canvas): single-fill semantics, round end
 *    caps only at the tips, resampling subdivision, determinism, and the
 *    destination-out eraser regression path.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  drawAnnotatedStroke,
  computeMarkerWidths,
  computeFountainWidths,
  computePencilCoreWidths,
  resampleForRibbon,
  resampleSpacing,
  smoothWidths,
  averagePressure,
  sanitizePoints,
} from '../PdfBrushRenderers';
import type { PdfStroke } from '../PdfTypes';

// ---- Recording mock 2D context --------------------------------------------------

interface Op {
  type: string;
  args: unknown[];
}
interface MockCtx {
  ctx: Record<string, unknown>;
  ops: Op[];
}

function makeCtx(): MockCtx {
  const ops: Op[] = [];
  const ctx: Record<string, unknown> = {};

  const methods = [
    'save', 'restore', 'beginPath', 'closePath', 'fill', 'stroke',
    'moveTo', 'lineTo', 'arc', 'rect', 'translate', 'rotate', 'setTransform',
  ] as const;
  for (const m of methods) {
    ctx[m] = vi.fn((...args: unknown[]) => {
      ops.push({ type: m, args });
    });
  }

  // Capture assignments so tests can assert alpha / composite / styles.
  const props = ['globalAlpha', 'globalCompositeOperation', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin'];
  for (const p of props) {
    let v: unknown = p === 'globalAlpha' ? 1 : p === 'lineWidth' ? 1 : '';
    Object.defineProperty(ctx, p, {
      configurable: true,
      enumerable: true,
      get: () => v,
      set: (nv: unknown) => {
        v = nv;
        ops.push({ type: `set:${p}`, args: [nv] });
      },
    });
  }
  return { ctx, ops };
}

const ctx2d = (c: MockCtx): CanvasRenderingContext2D =>
  c.ctx as unknown as CanvasRenderingContext2D;

const calls = (c: MockCtx, type: string): Op[] => c.ops.filter((o) => o.type === type);
const setValues = (c: MockCtx, prop: string): unknown[] =>
  c.ops.filter((o) => o.type === `set:${prop}`).map((o) => o.args[0]);

// ---- Stroke factory -------------------------------------------------------------

function makeStroke(
  points: { x: number; y: number; pressure: number; t: number }[],
  overrides: Partial<PdfStroke> = {},
): PdfStroke {
  return {
    id: 's_test',
    type: 'stroke',
    points,
    color: 'rgba(255,255,255,0.95)',
    size: 8,
    opacity: 1,
    smoothing: 0.35,
    compositeOperation: 'source-over',
    style: undefined,
    createdAt: 0,
    ...overrides,
  };
}

// ---- Pure geometry ---------------------------------------------------------------

describe('resampleForRibbon (fast large gaps)', () => {
  it('subdivides a far-apart pair so no long flat chord survives', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 500, y: 0 },
    ];
    const widths = [10, 10];
    const out = resampleForRibbon(points, widths, resampleSpacing(widths));
    // 500 / (10*0.4) = 125 steps → well over 60 inserted samples.
    expect(out.points.length).toBeGreaterThan(60);
    expect(out.widths.length).toBe(out.points.length);
    // Interpolation is linear + endpoints preserved.
    expect(out.points[0].x).toBeCloseTo(0, 3);
    expect(out.points[out.points.length - 1].x).toBeCloseTo(500, 3);
    expect(out.points[out.points.length - 1].y).toBeCloseTo(0, 3);
    for (let i = 1; i < out.points.length; i++) {
      expect(out.points[i].x).toBeGreaterThan(out.points[i - 1].x); // monotonic along x
      expect(out.widths[i]).toBeCloseTo(10, 3); // width carried through
    }
  });

  it('is deterministic for identical input', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 37, y: 12 },
      { x: 90, y: -8 },
      { x: 210, y: 5 },
    ];
    const widths = [6, 8, 7, 9];
    const spacing = resampleSpacing(widths);
    const a = resampleForRibbon(points, widths, spacing);
    const b = resampleForRibbon(points, widths, spacing);
    expect(a).toEqual(b);
  });

  it('dedupes coincident points but always keeps the real endpoints', () => {
    const points = [
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 40, y: 10 },
    ];
    const widths = [4, 4, 4, 4];
    const out = resampleForRibbon(points, widths, resampleSpacing(widths));
    expect(out.points[0].x).toBeCloseTo(10, 3);
    expect(out.points[out.points.length - 1].x).toBeCloseTo(40, 3);
    expect(out.points[out.points.length - 1].y).toBeCloseTo(10, 3);
  });
});

describe('fountain widths (pressure + speed)', () => {
  it('writes faster than it is thinner, at equal pressure', () => {
    const slow = [
      { x: 0, y: 0, p: 0.8, t: 0 },
      { x: 50, y: 0, p: 0.8, t: 100 },
      { x: 100, y: 0, p: 0.8, t: 200 },
    ];
    const fast = slow.map((pt, i) => ({ ...pt, t: i * 20 }));
    const slowW = computeFountainWidths(slow, 8, 0.5);
    const fastW = computeFountainWidths(fast, 8, 0.5);
    expect(slowW[1]).toBeGreaterThan(fastW[1]);
  });

  it('higher pressure is wider, at equal speed', () => {
    const light = [
      { x: 0, y: 0, p: 0.15, t: 0 },
      { x: 50, y: 0, p: 0.15, t: 50 },
      { x: 100, y: 0, p: 0.15, t: 100 },
    ];
    const heavy = light.map((pt) => ({ ...pt, p: 0.9 }));
    const lightW = computeFountainWidths(light, 8, 0.5);
    const heavyW = computeFountainWidths(heavy, 8, 0.5);
    expect(heavyW[1]).toBeGreaterThan(lightW[1]);
  });

  it('never returns NaN and stays bounded for pathological timestamps', () => {
    const pts = [
      { x: 0, y: 0, p: 0.8, t: 0 },
      { x: 50, y: 0, p: 0.8, t: 0 }, // equal t → dt <= 0
      { x: 100, y: 0, p: 0.8, t: 0 },
    ];
    const widths = computeFountainWidths(pts, 8, 0.5);
    for (const w of widths) {
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe('marker widths', () => {
  it('are bounded within [0.5, size] and finite even for NaN/Inf pressure', () => {
    const pts = [{ p: 0 }, { p: 0.5 }, { p: 1 }, { p: NaN }, { p: Infinity }];
    const widths = computeMarkerWidths(pts, 12);
    for (const w of widths) {
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0.5);
      expect(w).toBeLessThanOrEqual(12);
    }
  });
});

describe('pencil core widths', () => {
  it('stay thin (0.28–0.70 × size) and respond to pressure', () => {
    const widths = computePencilCoreWidths([{ p: 0 }, { p: 0.5 }, { p: 1 }], 10);
    expect(widths[0]).toBeCloseTo(10 * 0.28, 3);
    expect(widths[2]).toBeCloseTo(10 * 0.7, 3);
    expect(widths[2]).toBeGreaterThan(widths[0]);
    expect(widths[2]).toBeLessThanOrEqual(10 * 0.7 + 1e-9);
  });
});

describe('helpers', () => {
  it('averagePressure treats non-finite samples as neutral 0.5', () => {
    expect(averagePressure([{ p: 0.2 }, { p: 0.6 }, { p: NaN }])).toBeCloseTo((0.2 + 0.6 + 0.5) / 3, 5);
  });
  it('smoothWidths preserves length and bounds', () => {
    const w = smoothWidths([8, 2, 8, 8]);
    expect(w).toHaveLength(4);
    for (const x of w) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThanOrEqual(8);
    }
  });
  it('sanitizePoints fixes non-finite fields', () => {
    const out = sanitizePoints([
      { x: 1, y: 2, pressure: NaN, t: 0 },
      { x: NaN, y: Infinity, pressure: 3, t: 1 },
    ]);
    expect(Number.isFinite(out[0].x)).toBe(true);
    expect(out[0].pressure).toBeCloseTo(0.5, 5);
    expect(out[1].x).toBeCloseTo(1, 5); // falls back to previous valid x
    expect(out[1].pressure).toBe(1);
  });
});

// ---- Rasterization through drawAnnotatedStroke (mock ctx) -----------------------

describe('drawAnnotatedStroke — marker single-fill ribbon', () => {
  it('fills the whole stroke exactly once, with round caps only at the two ends', () => {
    const raw = [
      { x: 0, y: 0, pressure: 1, t: 0 },
      { x: 60, y: 20, pressure: 0.6, t: 16 },
      { x: 130, y: -5, pressure: 1, t: 32 },
    ];
    const c = makeCtx();
    drawAnnotatedStroke(
      ctx2d(c),
      makeStroke(raw, { size: 8, opacity: 1, pressureOpacity: false }),
    );

    expect(calls(c, 'fill')).toHaveLength(1); // ONE fill for the whole stroke
    expect(calls(c, 'stroke')).toHaveLength(0); // no per-segment stroking at all

    // Exactly two semicircular cap arcs, centered on the first & last samples —
    // there must be NO per-point circle in the middle (the old dot source).
    const arcs = calls(c, 'arc');
    expect(arcs).toHaveLength(2);
    const centers = arcs.map((a) => ({ x: a.args[0] as number, y: a.args[1] as number }));
    const first = raw[0];
    const last = raw[raw.length - 1];
    const nearFirst = centers.some(
      (p) => Math.abs(p.x - first.x) < 1e-3 && Math.abs(p.y - first.y) < 1e-3,
    );
    const nearLast = centers.some(
      (p) => Math.abs(p.x - last.x) < 1e-3 && Math.abs(p.y - last.y) < 1e-3,
    );
    expect(nearFirst).toBe(true);
    expect(nearLast).toBe(true);
  });

  it('subdivides a fast far-apart pair instead of one huge quad', () => {
    const raw = [
      { x: 0, y: 0, pressure: 1, t: 0 },
      { x: 500, y: 0, pressure: 1, t: 1000 },
    ];
    const c = makeCtx();
    drawAnnotatedStroke(ctx2d(c), makeStroke(raw, { size: 10, pressureOpacity: false }));
    expect(calls(c, 'lineTo').length).toBeGreaterThan(60);
  });

  it('draws a single point as one disc', () => {
    const c = makeCtx();
    drawAnnotatedStroke(
      ctx2d(c),
      makeStroke([{ x: 10, y: 10, pressure: 1, t: 0 }], { size: 8, pressureOpacity: false }),
    );
    const arcs = calls(c, 'arc');
    expect(arcs).toHaveLength(1);
    const a = arcs[0].args;
    expect(a[0]).toBeCloseTo(10, 3);
    expect(a[1]).toBeCloseTo(10, 3);
    expect(a[2]).toBeCloseTo(8 / 2, 3); // radius = width/2 = 4
    expect(calls(c, 'fill')).toHaveLength(1);
  });

  it('pressure→opacity toggle ON scales whole-stroke alpha by average pressure', () => {
    const c = makeCtx();
    drawAnnotatedStroke(
      ctx2d(c),
      makeStroke(
        [
          { x: 0, y: 0, pressure: 0.3, t: 0 },
          { x: 40, y: 0, pressure: 0.3, t: 16 },
          { x: 90, y: 5, pressure: 0.3, t: 32 },
        ],
        { opacity: 1, pressureOpacity: true },
      ),
    );
    const alphas = setValues(c, 'globalAlpha');
    expect(alphas[alphas.length - 1] as number).toBeCloseTo(0.2 + 0.8 * 0.3, 5);
  });
});

describe('drawAnnotatedStroke — eraser (destination-out) regression', () => {
  it('still routes through the per-segment destination-out path (unchanged)', () => {
    const c = makeCtx();
    drawAnnotatedStroke(
      ctx2d(c),
      makeStroke(
        [
          { x: 0, y: 0, pressure: 1, t: 0 },
          { x: 40, y: 0, pressure: 1, t: 16 },
          { x: 90, y: 0, pressure: 1, t: 32 },
        ],
        { compositeOperation: 'destination-out', smoothing: 0, size: 20 },
      ),
    );
    expect(calls(c, 'stroke').length).toBeGreaterThanOrEqual(2); // per-segment
    expect(setValues(c, 'globalCompositeOperation')).toContain('destination-out');
    expect(calls(c, 'fill')).toHaveLength(0); // not the marker single-fill model
  });
});

describe('drawAnnotatedStroke — determinism (live preview == tile rebuild)', () => {
  it.each(['marker', 'fountain'] as const)('%s draws identical output twice', (style) => {
    const raw = [
      { x: 0, y: 0, pressure: 1, t: 0 },
      { x: 60, y: 20, pressure: 0.7, t: 16 },
      { x: 130, y: -5, pressure: 1, t: 32 },
    ];
    const stroke = makeStroke(raw, {
      style: style === 'marker' ? undefined : 'fountain',
      inkSpeed: 0.5,
      pressureOpacity: false,
    });
    const c1 = makeCtx();
    const c2 = makeCtx();
    drawAnnotatedStroke(ctx2d(c1), stroke);
    drawAnnotatedStroke(ctx2d(c2), stroke);
    expect(c1.ops).toEqual(c2.ops);
  });

  it('pencil is deterministic per stroke.id and different for different ids', () => {
    const raw: { x: number; y: number; pressure: number; t: number }[] = [];
    for (let i = 0; i < 40; i++) {
      raw.push({ x: i * 12, y: Math.sin(i * 0.4) * 8, pressure: 0.5 + 0.4 * ((i % 3) / 3), t: i * 16 });
    }
    const s1 = makeStroke(raw, { id: 'pencil_a', style: 'pencil' });
    const s2 = makeStroke(raw, { id: 'pencil_b', style: 'pencil' });

    const a1 = makeCtx();
    const a2 = makeCtx();
    drawAnnotatedStroke(ctx2d(a1), s1);
    drawAnnotatedStroke(ctx2d(a2), s1);
    expect(a1.ops).toEqual(a2.ops); // same id → identical grain

    const b = makeCtx();
    drawAnnotatedStroke(ctx2d(b), s2);
    expect(b.ops).not.toEqual(a1.ops); // different id → different (but stable) grain
  });

  it('pencil draws a single ribbon fill + one batched grain stroke', () => {
    const raw: { x: number; y: number; pressure: number; t: number }[] = [];
    for (let i = 0; i < 40; i++) {
      raw.push({ x: i * 12, y: Math.sin(i * 0.4) * 8, pressure: 0.8, t: i * 16 });
    }
    const c = makeCtx();
    drawAnnotatedStroke(ctx2d(c), makeStroke(raw, { style: 'pencil' }));
    expect(calls(c, 'fill')).toHaveLength(1); // lead core ribbon
    expect(calls(c, 'stroke').length).toBeGreaterThanOrEqual(1); // grain batched once
  });
});
