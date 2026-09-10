import { describe, it, expect } from 'vitest';
import { getPressure, addRawPoint, smoothingToMinCutoff, getStrokeBounds, hitTestStroke, boundsIntersectRect } from '../StrokeEngine';
import type { Stroke } from '../types';

function makeStroke(): Stroke {
  return { id: 's1', type: 'stroke', points: [], color: '#fff', size: 8, opacity: 1,
    smoothing: 0.35, compositeOperation: 'source-over', createdAt: 1 };
}

describe('getPressure', () => {
  it('pen', () => expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8));
  it('zero pen → 0.05', () => expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05));
  it('mouse → 0.5', () => expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5));
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
