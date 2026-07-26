import { describe, it, expect } from 'vitest';
import {
  getPressure,
  createPredictBuffer,
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

describe('getPressure', () => {
  it('returns pen pressure', () => {
    expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8);
  });
  it('guards zero pen pressure', () => {
    expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05);
  });
  it('returns 0.5 for mouse', () => {
    expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5);
  });
});

describe('createPredictBuffer', () => {
  it('factor 0 at smoothing 0', () => {
    expect(createPredictBuffer(0).factor).toBe(0);
  });
  it('factor 1 at smoothing 0.5', () => {
    expect(createPredictBuffer(0.5).factor).toBe(1);
  });
  it('factor 0.2 at smoothing 0.1', () => {
    expect(createPredictBuffer(0.1).factor).toBe(0.2);
  });
  it('factor 2 at smoothing 1', () => {
    expect(createPredictBuffer(1).factor).toBe(2);
  });
});

describe('mapPressureToSize', () => {
  it('returns baseSize when disabled', () => {
    expect(mapPressureToSize(0.1, 10, false)).toBe(10);
  });
  it('scales with pressure', () => {
    const full = mapPressureToSize(1, 10, true);
    const low = mapPressureToSize(0.05, 10, true);
    expect(low).toBeLessThan(full);
  });
});

describe('mapPressureToOpacity', () => {
  it('returns baseOpacity when disabled', () => {
    expect(mapPressureToOpacity(0.1, 0.8, false)).toBe(0.8);
  });
});

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
  });
});

describe('processSample (Apple Pencil prediction)', () => {
  const s1: PointerSample = { x: 10, y: 20, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 1 };
  const s2: PointerSample = { x: 30, y: 40, pressure: 0.6, tiltX: 0, tiltY: 0, timestamp: 2 };
  const s3: PointerSample = { x: 50, y: 60, pressure: 0.4, tiltX: 0, tiltY: 0, timestamp: 3 };

  it('first call returns single stamp', () => {
    const pb = createPredictBuffer(0.5);
    const r = processSample(pb, null, s1, defaultBrush);
    expect(r).toHaveLength(1);
    expect(r[0].x).toBe(10);
    expect(r[0].y).toBe(20);
  });

  it('with prediction factor > 0, output runs ahead of input', () => {
    const pb = createPredictBuffer(1); // factor = 2.0
    // First point establishes baseline
    const r1 = processSample(pb, null, s1, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
    const prev = r1[r1.length - 1];
    // Second point — velocity = (30-10, 40-20) = (20, 20), pred = 30 + 20*2 = 70
    const r2 = processSample(pb, prev, s2, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
    const last = r2[r2.length - 1];
    expect(last.x).toBe(70);
    expect(last.y).toBe(80);
  });

  it('factor 0 = raw input (no prediction)', () => {
    const pb = createPredictBuffer(0);
    const r1 = processSample(pb, null, s1, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
    const prev = r1[r1.length - 1];
    const r2 = processSample(pb, prev, s3, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
    const last = r2[r2.length - 1];
    // factor 0 → output = raw input = 50
    expect(last.x).toBe(50);
    expect(last.y).toBe(60);
  });

  it('default 10% smoothing = slight prediction', () => {
    const pb = createPredictBuffer(0.1); // factor = 0.2
    const r1 = processSample(pb, null, s1, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
    const prev = r1[r1.length - 1];
    const r2 = processSample(pb, prev, s2, { ...defaultBrush, pressureSize: false, pressureOpacity: false });
    const last = r2[r2.length - 1];
    // v=(20,20), pred = 30 + 20*0.2 = 34
    expect(last.x).toBeCloseTo(34, 0);
    expect(last.y).toBeCloseTo(44, 0);
  });
});
