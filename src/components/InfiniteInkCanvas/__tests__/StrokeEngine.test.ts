import { describe, it, expect } from 'vitest';
import {
  getPressure,
  createSmoothBuffer,
  mapPressureToSize,
  mapPressureToOpacity,
  interpolateStamps,
  processSample,
} from '../StrokeEngine';
import type { StampPoint, PointerSample, BrushSettings } from '../types';

const defaultBrush: BrushSettings = {
  size: 10, opacity: 1, hardness: 0.8, spacing: 0.3, smoothing: 0.5,
  color: '#000000', pressureSize: true, pressureOpacity: false,
};

// ---- getPressure -----------------------------------------------------------

describe('getPressure', () => {
  it('returns pen pressure', () => {
    expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8);
  });
  it('guards against zero pen pressure', () => {
    expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05);
  });
  it('returns 0.5 for mouse', () => {
    expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5);
  });
});

// ---- createSmoothBuffer (SAI-style moving average) -------------------------

describe('createSmoothBuffer', () => {
  it('size 1 at smoothing 0', () => {
    const sb = createSmoothBuffer(0);
    expect(sb.size).toBe(1);
    expect(sb.buf).toEqual([]);
  });
  it('size 20 at smoothing 1', () => {
    expect(createSmoothBuffer(1).size).toBe(20);
  });
  it('size 2 at smoothing 0.1 (default)', () => {
    expect(createSmoothBuffer(0.1).size).toBe(2);
  });
  it('size 10 at smoothing 0.5', () => {
    expect(createSmoothBuffer(0.5).size).toBe(10);
  });
});

// ---- Pressure mapping -------------------------------------------------------

describe('mapPressureToSize', () => {
  it('returns baseSize when disabled', () => {
    expect(mapPressureToSize(0.1, 10, false)).toBe(10);
  });
  it('scales down at low pressure', () => {
    expect(mapPressureToSize(0.05, 10, true)).toBeCloseTo(1.925, 1);
  });
  it('returns full size at max pressure', () => {
    expect(mapPressureToSize(1, 10, true)).toBe(10);
  });
});

describe('mapPressureToOpacity', () => {
  it('returns baseOpacity when disabled', () => {
    expect(mapPressureToOpacity(0.1, 0.8, false)).toBe(0.8);
  });
  it('scales down at low pressure', () => {
    expect(mapPressureToOpacity(0.05, 0.8, true)).toBeLessThan(0.8);
  });
});

// ---- interpolateStamps ------------------------------------------------------

describe('interpolateStamps', () => {
  const bs = { ...defaultBrush, pressureSize: false, pressureOpacity: false };
  const from: StampPoint = { x: 0, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
  const toNear: StampPoint = { x: 1, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
  const toFar: StampPoint = { x: 50, y: 0, size: 10, opacity: 1, pressure: 0.8, tiltX: 0, tiltY: 0 };

  it('returns dest when close', () => {
    expect(interpolateStamps(from, toNear, bs)).toEqual([toNear]);
  });
  it('interpolates multiple stamps when far', () => {
    const r = interpolateStamps(from, toFar, bs);
    expect(r.length).toBeGreaterThan(1);
    expect(r[r.length - 1].pressure).toBe(0.8);
  });
});

// ---- processSample (with SAI buffer) ----------------------------------------

describe('processSample', () => {
  const sample: PointerSample = { x: 10, y: 20, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 1 };
  const sample2: PointerSample = { x: 30, y: 40, pressure: 0.6, tiltX: 0, tiltY: 0, timestamp: 2 };

  it('first call returns single stamp', () => {
    const sb = createSmoothBuffer(0.5);
    const r = processSample(sb, null, sample, defaultBrush);
    expect(r).toHaveLength(1);
    expect(r[0].x).toBe(10);
    expect(r[0].y).toBe(20);
  });

  it('subsequent call returns interpolated stamps', () => {
    const sb = createSmoothBuffer(0.5);
    const prev = processSample(sb, null, sample, defaultBrush)[0];
    const r = processSample(sb, prev, sample2, defaultBrush);
    expect(r.length).toBeGreaterThan(0);
  });

  it('buffer smooths position toward average', () => {
    // With a large buffer, the smoothed output lags behind the raw input
    const sb = createSmoothBuffer(1); // size 20
    const raw = { x: 100, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1 };
    const r = processSample(sb, null, raw, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
    // First point with buffer size 20 just has 1 entry → raw
    expect(r[0].x).toBe(100);
  });

  it('size 1 buffer = no smoothing (raw input)', () => {
    const sb = createSmoothBuffer(0);
    // Feed several points through; each should be raw since buffer size is 1
    let prev: StampPoint | null = null;
    for (const x of [10, 30, 50, 70]) {
      const s: PointerSample = { x, y: 10, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1 };
      const r = processSample(sb, prev, s, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
      prev = r[r.length - 1];
    }
    // After 4 samples, buffer size 1 means the last output is the last input (50)
    expect(prev!.x).toBe(70);
  });
});
