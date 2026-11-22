import { afterEach, describe, expect, it } from 'vitest';
import { createToolbarStore } from '../useToolbarStore';

afterEach(() => localStorage.clear());

describe('alternate pen preference', () => {
  it('starts with fountain unless a known alternate was saved', () => {
    expect(createToolbarStore('canvas-pen').getState().alternatePen).toBe('fountain');
    localStorage.setItem('canvas-pen', 'unknown');
    expect(createToolbarStore('canvas-pen').getState().alternatePen).toBe('fountain');
  });

  it('restores the choice without changing the other editor', () => {
    const canvas = createToolbarStore('canvas-pen');
    canvas.getState().setAlternatePen('pencil');
    expect(createToolbarStore('canvas-pen').getState().alternatePen).toBe('pencil');
    expect(createToolbarStore('pdf-pen').getState().alternatePen).toBe('fountain');
  });
});
