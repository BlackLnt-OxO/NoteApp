import { describe, it, expect, beforeEach } from 'vitest';
import { loadQuickSizes, saveQuickSizes, type QuickSizePresets } from '../inkToolPrefs';
import { useCanvasStore } from '../InfiniteInkCanvas/useCanvasStore';
import { usePdfStore } from '../PdfAnnotation/PdfStore';
import { DEFAULT_BRUSH } from '../InfiniteInkCanvas/constants';
import { DEFAULT_PDF_BRUSH } from '../PdfAnnotation/PdfStore';

const KEY = 'test-quick-sizes';
const FALLBACK: QuickSizePresets = { quickSizes: [8, 20, 40], eraserQuickSizes: [12, 20, 60] };

beforeEach(() => localStorage.clear());

describe('quick-size presets', () => {
  it('round-trips through localStorage', () => {
    saveQuickSizes(KEY, { quickSizes: [3, 17, 55], eraserQuickSizes: [7, 9, 11] });
    expect(loadQuickSizes(KEY, FALLBACK)).toEqual({ quickSizes: [3, 17, 55], eraserQuickSizes: [7, 9, 11] });
  });

  it('falls back when nothing is stored', () => {
    expect(loadQuickSizes(KEY, FALLBACK)).toEqual(FALLBACK);
  });

  it('falls back on corrupt or out-of-range records instead of showing a broken swatch', () => {
    for (const junk of ['garbage', '{}', 'null', '[]']) {
      localStorage.setItem(KEY, junk);
      expect(loadQuickSizes(KEY, FALLBACK)).toEqual(FALLBACK);
    }
    // Wrong length, non-numbers and missing halves are rejected wholesale.
    const badRecords: string[] = [
      JSON.stringify({ quickSizes: [8, 20] }),
      JSON.stringify({ quickSizes: [8, '20', 40] }),
      JSON.stringify({ quickSizes: [8, 20, null] }),
      JSON.stringify({ quickSizes: [8, 20, 40], eraserQuickSizes: [1, 2] }),
    ];
    for (const bad of badRecords) {
      localStorage.setItem(KEY, bad);
      expect(loadQuickSizes(KEY, FALLBACK)).toEqual(FALLBACK);
    }
  });

  it('clamps stored values into the swatches\' own slider range', () => {
    localStorage.setItem(KEY, JSON.stringify({ quickSizes: [0, 20, 900], eraserQuickSizes: [1, 2, 3] }));
    expect(loadQuickSizes(KEY, FALLBACK).quickSizes).toEqual([1, 20, 100]);
  });

  it('remembers a long-press size change made in the canvas toolbar', () => {
    useCanvasStore.getState().setBrushSettings({ quickSizes: [2, 30, 70] });
    // A fresh launch reads the stored presets back into the brush.
    expect(loadQuickSizes('stickynotes-inkcanvas-quick-sizes', DEFAULT_BRUSH).quickSizes).toEqual([2, 30, 70]);
    // …and the eraser's swatches are independent.
    expect(loadQuickSizes('stickynotes-inkcanvas-quick-sizes', DEFAULT_BRUSH).eraserQuickSizes)
      .toEqual(DEFAULT_BRUSH.eraserQuickSizes);
  });

  it('remembers a long-press size change made in the PDF toolbar, under its own key', () => {
    usePdfStore.getState().setBrush({ eraserQuickSizes: [5, 15, 25] });
    expect(loadQuickSizes('stickynotes-pdf-quick-sizes', DEFAULT_PDF_BRUSH).eraserQuickSizes).toEqual([5, 15, 25]);
    // The canvas surface is untouched.
    expect(loadQuickSizes('stickynotes-inkcanvas-quick-sizes', DEFAULT_BRUSH).eraserQuickSizes)
      .toEqual(DEFAULT_BRUSH.eraserQuickSizes);
  });

  it('does not write anything for brush edits that are not quick sizes', () => {
    useCanvasStore.getState().setBrushSettings({ size: 33 });
    expect(localStorage.getItem('stickynotes-inkcanvas-quick-sizes')).toBeNull();
  });
});
