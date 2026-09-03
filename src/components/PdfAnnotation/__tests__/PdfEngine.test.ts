import { describe, it, expect } from 'vitest';
import {
  getPressure,
  addRawPoint,
  smoothingToMinCutoff,
  applyOneEuro,
  getStrokeBounds,
  hitTestStroke,
  boundsIntersectRect,
  screenToWorld,
  worldToScreen,
  clampZoom,
  zoomAt,
  fitCamera,
  PDF_BAKE_SCALE,
  PDF_ERASER_RADIUS,
} from '../PdfEngine';
import type { PdfStroke } from '../PdfTypes';

function makeStroke(): PdfStroke {
  return {
    id: 's1', type: 'stroke', points: [], color: '#fff', size: 8, opacity: 1,
    smoothing: 0.35, compositeOperation: 'source-over', createdAt: 1,
  };
}

describe('constants', () => {
  it('exports bake scale and eraser radius', () => {
    expect(PDF_BAKE_SCALE).toBeGreaterThanOrEqual(1);
    expect(PDF_ERASER_RADIUS).toBeGreaterThan(0);
  });
});

describe('getPressure', () => {
  it('pen', () => expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8));
  it('zero pen → 0.05', () => expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05));
  it('mouse → 0.5', () => expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5));
  it('pen above 1 clamps to 1', () => expect(getPressure({ pointerType: 'pen', pressure: 1.4 })).toBe(1));
  it('pen negative → 0.05', () => expect(getPressure({ pointerType: 'pen', pressure: -2 })).toBe(0.05));
  it('pen NaN/Infinity → 0.05', () => {
    expect(getPressure({ pointerType: 'pen', pressure: Number.NaN })).toBe(0.05);
    expect(getPressure({ pointerType: 'pen', pressure: Number.POSITIVE_INFINITY })).toBe(0.05);
  });
});

describe('addRawPoint', () => {
  it('adds a point with timestamp', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.8, 1000);
    expect(s.points).toHaveLength(1);
    expect(s.points[0]).toEqual({ x: 10, y: 20, pressure: 0.8, t: 1000 });
  });
  it('filters duplicates (< 0.01 px)', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.5, 1000);
    addRawPoint(s, 10.005, 20.003, 0.5, 1001);
    expect(s.points).toHaveLength(1);
  });
  it('allows distinct points', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.5, 1000);
    addRawPoint(s, 30, 40, 0.5, 1016);
    expect(s.points).toHaveLength(2);
  });
});

describe('smoothingToMinCutoff', () => {
  it('maps 0 → 5 Hz', () => expect(smoothingToMinCutoff(0)).toBeCloseTo(5, 5));
  it('maps 1 → 0.05 Hz', () => expect(smoothingToMinCutoff(1)).toBeCloseTo(0.05, 5));
  it('is monotonic decreasing', () => {
    expect(smoothingToMinCutoff(0.3)).toBeGreaterThan(smoothingToMinCutoff(0.7));
  });
});

describe('applyOneEuro', () => {
  it('returns [] for empty input', () => {
    expect(applyOneEuro([], 5)).toEqual([]);
  });
  it('passes a single point through unchanged', () => {
    const out = applyOneEuro([{ x: 3, y: 4, pressure: 0.6, t: 1000 }], 5);
    expect(out).toEqual([{ x: 3, y: 4, p: 0.6 }]);
  });
  it('keeps the last point raw (live pen tip)', () => {
    const pts = [
      { x: 0, y: 0, pressure: 0.5, t: 1000 },
      { x: 10, y: 0, pressure: 0.5, t: 1016 },
      { x: 20, y: 5, pressure: 0.5, t: 1032 },
    ];
    const out = applyOneEuro(pts, 5);
    expect(out[out.length - 1]).toEqual({ x: 20, y: 5, p: 0.5 });
  });
});

describe('selection hit-testing', () => {
  it('getStrokeBounds computes padded bounds', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.5, 1000);
    addRawPoint(s, 30, 40, 0.5, 1016);
    const b = getStrokeBounds(s);
    expect(b.minX).toBeLessThanOrEqual(10);
    expect(b.maxX).toBeGreaterThanOrEqual(30);
    expect(b.minY).toBeLessThanOrEqual(20);
    expect(b.maxY).toBeGreaterThanOrEqual(40);
  });

  it('hitTestStroke hits near a point', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.5, 1000);
    addRawPoint(s, 30, 40, 0.5, 1016);
    expect(hitTestStroke(s, 10, 20)).toBe(true);
    expect(hitTestStroke(s, 500, 500)).toBe(false);
  });

  it('boundsIntersectRect detects overlap', () => {
    const b = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(boundsIntersectRect(b, 5, 5, 20, 20)).toBe(true);
    expect(boundsIntersectRect(b, 50, 50, 60, 60)).toBe(false);
  });
});

describe('coordinate transforms', () => {
  const cam = { x: 100, y: 50, zoom: 2 };

  it('screenToWorld / worldToScreen round-trip', () => {
    const w = screenToWorld(300, 210, cam);
    expect(w).toEqual({ x: 100, y: 80 });
    const s = worldToScreen(w.x, w.y, cam);
    expect(s.x).toBeCloseTo(300, 5);
    expect(s.y).toBeCloseTo(210, 5);
  });

  it('clampZoom clamps to [0.1, 8]', () => {
    expect(clampZoom(0.01)).toBe(0.1);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(2)).toBe(2);
  });

  it('zoomAt keeps the point under the cursor fixed', () => {
    const cam2 = zoomAt(cam, 300, 210, 4);
    const before = screenToWorld(300, 210, cam);
    const after = screenToWorld(300, 210, cam2);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });
});

describe('fitCamera', () => {
  it('centers a page in the viewport', () => {
    const cam = fitCamera(1000, 800, 1200, 1000, 24);
    // zoomed to fit height (1000-48)/800 vs width (1200-48)/1000 → width is smaller
    expect(cam.zoom).toBeCloseTo((1200 - 48) / 1000, 5);
    // page center == viewport center
    const cx = cam.x + (1000 * cam.zoom) / 2;
    expect(cx).toBeCloseTo(1200 / 2, 5);
    const cy = cam.y + (800 * cam.zoom) / 2;
    expect(cy).toBeCloseTo(1000 / 2, 5);
  });

  it('never zooms beyond clamp bounds', () => {
    const cam = fitCamera(10, 10, 100000, 100000, 0);
    expect(cam.zoom).toBeLessThanOrEqual(8);
  });
});
