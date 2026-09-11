import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InfiniteInkCanvas from '../../InfiniteInkCanvas/InfiniteInkCanvas';
import PdfCanvas from '../PdfCanvas';
import { useCanvasStore } from '../../InfiniteInkCanvas/useCanvasStore';
import { usePdfStore } from '../PdfStore';
import { clearInkRasterCache } from '../InkRasterCache';
import { clearStreamingInk } from '../StreamingInkStroke';
import type { PdfStroke } from '../PdfTypes';

vi.mock('../PdfLoader', () => ({
  getPageSize: vi.fn().mockResolvedValue({ width: 600, height: 800 }),
  renderPageToCanvas: vi.fn().mockResolvedValue(undefined), cleanupPage: vi.fn(),
  loadPdfDocument: vi.fn(), abortActivePdfLoad: vi.fn(), resetPdfWorker: vi.fn(),
}));
vi.mock('../../InfiniteInkCanvas/Toolbar', () => ({ default: () => null }));
vi.mock('../../InfiniteInkCanvas/ToolbarShell', () => ({ default: () => null }));

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function frame() {
  act(() => {
    const batch = [...frames.entries()]; frames.clear();
    for (const [, callback] of batch) callback(performance.now());
  });
}
function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
  Object.defineProperties(event, {
    pointerId: { value: 1 }, pointerType: { value: 'pen' }, pressure: { value: 0.5 },
    getCoalescedEvents: { value: () => [event] },
  });
  fireEvent(canvas, event);
}
function draw(canvas: HTMLCanvasElement) {
  pointer(canvas, 'pointerdown', 100, 100);
  for (let i = 1; i <= 12; i++) {
    pointer(canvas, 'pointermove', 100 + i * 2, 100);
    if (i % 4 === 0) frame();
  }
  pointer(canvas, 'pointerup', 124, 100); frame();
}
const canvasInitial = useCanvasStore.getState();
const pdfInitial = usePdfStore.getState();
beforeEach(() => {
  clearInkRasterCache(); frames.clear();
  useCanvasStore.setState({ ...canvasInitial, objects: [], currentCanvasId: null, history: [], redoStack: [], activeTool: 'pen', brush: 'marker', camera: { x: 0, y: 0, zoom: 1 } }, true);
  usePdfStore.setState({ ...pdfInitial, items: {}, activeTool: 'pen', brushType: 'marker', camera: { x: 0, y: 0, zoom: 1 } }, true);
  // Wiring test only: real raster/alpha assertions live in StreamingInk.test.ts.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  } as unknown as CanvasRenderingContext2D, { get(target, key) { return Reflect.get(target, key) ?? (() => undefined); } }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); clearInkRasterCache(); clearStreamingInk(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('canvas input integration', () => {
  it.each([['canvas', 'marker'], ['pdf', 'marker'], ['canvas', 'pencil'], ['pdf', 'pencil']] as const)('%s %s commits versioned ink, erases the topmost stroke, and rebuilds its index on undo', async (view, style) => {
    useCanvasStore.setState({ brush: style });
    usePdfStore.setState({ brushType: style });
    if (view === 'pdf') usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, pageSizes: { 1: { width: 600, height: 800 } } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    act(() => {
      if (view === 'canvas') useCanvasStore.setState({ camera: { x: 0, y: 0, zoom: 1 } });
      else usePdfStore.setState({ camera: { x: 0, y: 0, zoom: 1 } });
    });
    frame();
    const canvas = root.container.querySelector('canvas')!;
    const strokes = () => (view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1] ?? []) as PdfStroke[];
    draw(canvas); draw(canvas);
    expect(strokes()).toHaveLength(2);
    expect(strokes().every(s => s.renderVersion === 2 && s.points.length === 13)).toBe(true);
    if (style === 'pencil') expect(strokes().every(s => s.style === 'pencil')).toBe(true);
    const firstId = strokes()[0].id;
    act(() => {
      if (view === 'canvas') useCanvasStore.setState({ activeTool: 'eraser', eraserMode: 'stroke' });
      else usePdfStore.setState({ activeTool: 'eraser', eraserMode: 'stroke' });
    });
    pointer(canvas, 'pointerdown', 112, 100); pointer(canvas, 'pointerup', 112, 100); frame();
    expect(strokes().map(s => s.id)).toEqual([firstId]);
    act(() => { if (view === 'canvas') useCanvasStore.getState().undo(); else usePdfStore.getState().undo(); });
    frame();
    expect(strokes()).toHaveLength(2);
    // A drag after undo must query the rebuilt index, removing both overlaps.
    pointer(canvas, 'pointerdown', 70, 100);
    pointer(canvas, 'pointermove', 150, 100); frame();
    pointer(canvas, 'pointerup', 150, 100); frame();
    expect(strokes()).toHaveLength(0);
  });
});
