import { describe, it, expect } from 'vitest';
import {
  getPressure, StrokeSmoother,
  mapPressureToSize, mapPressureToOpacity,
  interpolateStamps, processSample,
} from '../StrokeEngine';
import type { StampPoint, PointerSample, BrushSettings } from '../types';

const b: BrushSettings = {
  size: 10, opacity: 1, hardness: 0.8, spacing: 0.3, smoothing: 0.35,
  color: '#000', pressureSize: true, pressureOpacity: false,
};

describe('getPressure', () => {
  it('pen', () => expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8));
  it('zero pen → 0.05', () => expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05));
  it('mouse → 0.5', () => expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5));
});

describe('StrokeSmoother', () => {
  it('first update returns raw input', () => {
    const s = new StrokeSmoother(0.35);
    const r = s.update({ x: 10, y: 20, pressure: 0.5 });
    expect(r).toEqual({ x: 10, y: 20, pressure: 0.5 });
  });

  it('second update blends toward old value', () => {
    const s = new StrokeSmoother(0.35); // factor = 0.65
    s.update({ x: 0, y: 0, pressure: 0.5 });
    const r = s.update({ x: 100, y: 100, pressure: 0.5 });
    // 65% toward new: 0 + 100*0.65 = 65
    expect(r.x).toBe(65);
    expect(r.y).toBe(65);
  });

  it('smoothing 0 = raw (factor 1)', () => {
    const s = new StrokeSmoother(0);
    s.update({ x: 0, y: 0, pressure: 0.5 });
    const r = s.update({ x: 100, y: 0, pressure: 0.5 });
    expect(r.x).toBe(100);
  });

  it('smoothing 1 → clamped to 0.95 (factor 0.05)', () => {
    const s = new StrokeSmoother(1);
    s.update({ x: 0, y: 0, pressure: 0.5 });
    const r = s.update({ x: 100, y: 0, pressure: 0.5 });
    expect(r.x).toBeCloseTo(5, 0);
  });

  it('reset clears state', () => {
    const s = new StrokeSmoother(0.5);
    s.update({ x: 10, y: 10, pressure: 0.5 });
    s.update({ x: 50, y: 50, pressure: 0.5 });
    s.reset();
    const r = s.update({ x: 30, y: 30, pressure: 0.5 });
    // After reset, first update is raw
    expect(r.x).toBe(30);
  });

  it('returns a copy, not internal reference', () => {
    const s = new StrokeSmoother(0.5);
    const r1 = s.update({ x: 10, y: 10, pressure: 0.5 });
    const r2 = s.update({ x: 20, y: 20, pressure: 0.5 });
    // r1 should not have been mutated
    expect(r1.x).toBe(10);
    expect(r2.x).not.toBe(10);
  });
});

describe('mapPressureToSize', () => {
  it('disabled → base', () => expect(mapPressureToSize(0.1, 10, false)).toBe(10));
  it('low pressure → small', () => expect(mapPressureToSize(0.05, 10, true)).toBeLessThan(10));
});

describe('mapPressureToOpacity', () => {
  it('disabled → base', () => expect(mapPressureToOpacity(0.1, 0.8, false)).toBe(0.8));
});

describe('interpolateStamps', () => {
  const bs = { ...b, pressureSize: false, pressureOpacity: false };
  const from: StampPoint = { x: 0, y: 0, size: 10, opacity: 1, pressure: 0.5, tiltX: 0, tiltY: 0 };
  const to: StampPoint = { x: 50, y: 0, size: 10, opacity: 1, pressure: 0.8, tiltX: 0, tiltY: 0 };
  it('interpolates', () => expect(interpolateStamps(from, to, bs).length).toBeGreaterThan(1));
});

describe('processSample', () => {
  const s1: PointerSample = { x: 10, y: 20, pressure: 0.8, tiltX: 0, tiltY: 0, timestamp: 1 };
  const s2: PointerSample = { x: 30, y: 40, pressure: 0.6, tiltX: 0, tiltY: 0, timestamp: 2 };

  it('first call returns single stamp', () => {
    const sm = new StrokeSmoother(0.35);
    const r = processSample(sm, null, s1, b);
    expect(r).toHaveLength(1);
    expect(r[0].x).toBe(10);
  });

  it('second call returns interpolated stamps', () => {
    const sm = new StrokeSmoother(0.35);
    const r1 = processSample(sm, null, s1, b);
    const r2 = processSample(sm, r1[r1.length - 1], s2, b);
    expect(r2.length).toBeGreaterThanOrEqual(1);
  });
});
