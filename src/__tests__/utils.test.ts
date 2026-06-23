import { describe, it, expect } from 'vitest';
import { fs, fsn } from '../utils';

describe('fs', () => {
  it('returns base font size in px when globalSize equals 14', () => {
    expect(fs(14, 14)).toBe('14px');
    expect(fs(10, 14)).toBe('10px');
    expect(fs(20, 14)).toBe('20px');
  });

  it('scales proportionally when globalSize differs from base', () => {
    // globalSize=28 means 2x scaling: 14 → 28px
    expect(fs(14, 28)).toBe('28px');
    expect(fs(10, 28)).toBe('20px'); // 10 * 2 = 20
  });

  it('returns proportionally smaller values when globalSize < 14', () => {
    // globalSize=7 means 0.5x scaling: 14 → 7px
    expect(fs(14, 7)).toBe('7px');
    expect(fs(20, 7)).toBe('10px'); // 20 * 0.5 = 10
  });

  it('rounds to nearest integer', () => {
    // 10 * (15/14) ≈ 10.714 → rounds to 11
    expect(fs(10, 15)).toBe('11px');
  });
});

describe('fsn', () => {
  it('returns base value unchanged when globalSize equals 14', () => {
    expect(fsn(14, 14)).toBe(14);
    expect(fsn(100, 14)).toBe(100);
  });

  it('scales proportionally when globalSize differs', () => {
    expect(fsn(14, 28)).toBe(28);
    expect(fsn(50, 28)).toBe(100);
  });

  it('returns rounded number for fractional results', () => {
    expect(fsn(10, 15)).toBe(11);
  });
});
