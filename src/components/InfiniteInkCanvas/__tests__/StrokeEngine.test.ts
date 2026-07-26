import { describe, it, expect } from 'vitest';
import { getPressure, addRawPoint } from '../StrokeEngine';
import type { Stroke } from '../types';

function makeStroke(): Stroke {
  return { id: 's1', type: 'stroke', points: [], color: '#fff', size: 8, opacity: 1,
    compositeOperation: 'source-over', createdAt: 1 };
}

describe('getPressure', () => {
  it('pen', () => expect(getPressure({ pointerType: 'pen', pressure: 0.8 })).toBe(0.8));
  it('zero pen → 0.05', () => expect(getPressure({ pointerType: 'pen', pressure: 0 })).toBe(0.05));
  it('mouse → 0.5', () => expect(getPressure({ pointerType: 'mouse', pressure: 0 })).toBe(0.5));
});

describe('addRawPoint', () => {
  it('adds a point', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.8);
    expect(s.points).toHaveLength(1);
    expect(s.points[0]).toEqual({ x: 10, y: 20, pressure: 0.8 });
  });
  it('filters duplicates (< 0.01 px)', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.5);
    addRawPoint(s, 10.005, 20.003, 0.5);
    expect(s.points).toHaveLength(1);
  });
  it('allows distinct points', () => {
    const s = makeStroke();
    addRawPoint(s, 10, 20, 0.5);
    addRawPoint(s, 30, 40, 0.5);
    expect(s.points).toHaveLength(2);
  });
});
