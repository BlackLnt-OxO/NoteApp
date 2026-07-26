import { describe, it, expect } from 'vitest';
import {
  getPressure, initOneEuro,
  mapPressureToSize, mapPressureToOpacity,
  interpolateStamps, processSample,
} from '../StrokeEngine';
import type { StampPoint, PointerSample, BrushSettings } from '../types';

const b: BrushSettings = {
  size: 10, opacity: 1, hardness: 0.8, spacing: 0.3, smoothing: 0.5,
  color: '#000', pressureSize: true, pressureOpacity: false,
};

describe('getPressure', () => {
  it('pen pressure', () => expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8));
  it('zero pen → min', () => expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05));
  it('mouse → 0.5', () => expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5));
});

describe('1€ filter', () => {
  it('initOneEuro returns state', () => {
    const s = initOneEuro(10, 20, 0.5, 1000);
    expect(s.prevX).toBe(10);
    expect(s.prevY).toBe(20);
  });

  it('processSample returns stamps + state', () => {
    const sample: PointerSample = { x: 10, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1000 };
    const { stamps, state } = processSample(null, null, sample, b);
    expect(stamps).toHaveLength(1);
    expect(stamps[0].x).toBe(10);
    expect(state.prevX).toBe(10);
  });

  it('second call uses filter state', () => {
    const s1: PointerSample = { x: 10, y: 20, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1000 };
    const s2: PointerSample = { x: 30, y: 40, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1016 };
    const r1 = processSample(null, null, s1, { ...b, pressureSize: false, pressureOpacity: false });
    const prev = r1.stamps[r1.stamps.length - 1];
    const r2 = processSample(r1.state, prev, s2, { ...b, pressureSize: false, pressureOpacity: false });
    // With smoothing=0.5, cutoff≈0.5 Hz, dt=16ms → alpha small → smoothed output is near input
    const last = r2.stamps[r2.stamps.length - 1];
    expect(last.x).toBeGreaterThan(10); // moved toward 30
    expect(last.x).toBeLessThan(30);    // but lagged behind (filtered)
  });

  it('smoothing=0 → raw output', () => {
    const s: PointerSample = { x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1 };
    const bs: BrushSettings = { ...b, smoothing: 0, pressureSize: false, pressureOpacity: false };
    const r1 = processSample(null, null, s, bs);
    expect(r1.stamps[0].x).toBe(0);
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
