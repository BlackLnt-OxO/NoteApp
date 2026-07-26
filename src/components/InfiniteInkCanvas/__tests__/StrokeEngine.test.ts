import { describe, it, expect } from 'vitest';
import {
  getPressure,
  smoothPoint,
  mapPressureToSize,
  mapPressureToOpacity,
  interpolateStamps,
  processSample,
} from '../StrokeEngine';
import type { StampPoint, PointerSample, BrushSettings } from '../types';

const defaultBrush: BrushSettings = {
  size: 10,
  opacity: 1,
  hardness: 0.8,
  spacing: 0.3,
  smoothing: 0.5,
  color: '#000000',
  pressureSize: true,
  pressureOpacity: false,
};

describe('getPressure', () => {
  it('returns pressure from pen events', () => {
    expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8);
  });

  it('guards against zero pressure for pen', () => {
    expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05);
  });

  it('returns fixed 0.5 for mouse', () => {
    expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5);
    expect(getPressure({ pointerType: 'mouse', pressure: 0.5 })).toBe(0.5);
  });
});

describe('smoothPoint', () => {
  const makePoint = (x: number, y: number, p: number): StampPoint => ({
    x, y, size: 10, opacity: 1, pressure: p, tiltX: 0, tiltY: 0,
  });

  it('returns raw point when no previous point', () => {
    const point = makePoint(100, 200, 0.8);
    const result = smoothPoint(null, point, 0.5);
    expect(result).toEqual(point);
  });

  it('returns raw point when smoothing is 0', () => {
    const prev = makePoint(0, 0, 0.5);
    const next = makePoint(100, 100, 0.9);
    const result = smoothPoint(prev, next, 0);
    expect(result.x).toBe(100);
    expect(result.y).toBe(100);
    expect(result.pressure).toBe(0.9);
  });

  it('smooths position when smoothing > 0', () => {
    const prev = makePoint(0, 0, 0.5);
    const next = makePoint(100, 100, 0.5);
    const result = smoothPoint(prev, next, 0.5);
    // With smoothing=0.5, t = 1 - 0.5 = 0.5, so halfway between
    expect(result.x).toBe(50);
    expect(result.y).toBe(50);
  });

  it('smooths pressure too', () => {
    const prev = makePoint(0, 0, 0.2);
    const next = makePoint(0, 0, 0.8);
    const result = smoothPoint(prev, next, 0.5);
    expect(result.pressure).toBe(0.5);
  });
});

describe('mapPressureToSize', () => {
  it('returns base size when disabled', () => {
    expect(mapPressureToSize(0.1, 10, false)).toBe(10);
    expect(mapPressureToSize(1, 10, false)).toBe(10);
  });

  it('returns full size at max pressure', () => {
    const result = mapPressureToSize(1, 10, true);
    expect(result).toBe(10);
  });

  it('returns reduced size at low pressure', () => {
    const full = mapPressureToSize(1, 10, true);
    const low = mapPressureToSize(0.05, 10, true);
    expect(low).toBeLessThan(full);
    // With p=0.05: 0.15 + 0.05 * 0.85 = 0.1925 → 1.925
    expect(low).toBeCloseTo(1.925, 1);
  });
});

describe('mapPressureToOpacity', () => {
  it('returns base opacity when disabled', () => {
    expect(mapPressureToOpacity(0.1, 0.8, false)).toBe(0.8);
  });

  it('returns full opacity at max pressure', () => {
    expect(mapPressureToOpacity(1, 0.8, true)).toBe(0.8);
  });

  it('returns reduced opacity at low pressure', () => {
    const result = mapPressureToOpacity(0.05, 0.8, true);
    expect(result).toBeLessThan(0.8);
  });
});

describe('interpolateStamps', () => {
  const bs: BrushSettings = {
    ...defaultBrush,
    size: 10,
    spacing: 0.3,
    pressureSize: false,
    pressureOpacity: false,
  };

  it('returns the destination when close together', () => {
    const from: StampPoint = { x: 0, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
    const to: StampPoint = { x: 1, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
    const result = interpolateStamps(from, to, bs);
    // dist=1, stepSize=10*0.3=3, so dist < stepSize
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(to);
  });

  it('interpolates stamps when distance is large', () => {
    const from: StampPoint = { x: 0, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
    const to: StampPoint = { x: 50, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
    const result = interpolateStamps(from, to, bs);
    // dist=50, stepSize=3, steps = floor(50/3) = 16
    expect(result).toHaveLength(16);
  });

  it('interpolates pressure between stamps', () => {
    const from: StampPoint = { x: 0, y: 0, size: 10, opacity: 1, pressure: 0.2, tiltX: 0, tiltY: 0 };
    const to: StampPoint = { x: 50, y: 0, size: 10, opacity: 1, pressure: 0.8, tiltX: 0, tiltY: 0 };
    const result = interpolateStamps(from, to, bs);
    expect(result[0].pressure).toBeGreaterThan(0.2);
    expect(result[result.length - 1].pressure).toBe(0.8);
  });
});

describe('processSample', () => {
  const sample: PointerSample = { x: 10, y: 20, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 1 };

  it('returns single stamp for first point', () => {
    const result = processSample(null, sample, defaultBrush);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(10);
    expect(result[0].y).toBe(20);
  });

  it('returns interpolated stamps for subsequent points', () => {
    const prevStamp: StampPoint = { x: 0, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
    const result = processSample(prevStamp, sample, defaultBrush);
    expect(result.length).toBeGreaterThan(0);
  });

  it('respects pressureSize setting', () => {
    const enabled = processSample(null, { ...sample, pressure: 0.1 }, {
      ...defaultBrush,
      pressureSize: true,
      size: 20,
    });
    const disabled = processSample(null, { ...sample, pressure: 0.1 }, {
      ...defaultBrush,
      pressureSize: false,
      size: 20,
    });
    // Enabled should produce a smaller stamp at low pressure
    expect(enabled[0].size).toBeLessThan(disabled[0].size);
  });
});
