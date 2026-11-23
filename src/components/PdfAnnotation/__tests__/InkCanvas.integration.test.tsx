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
import { readInkFrame, resetInkFrame } from '../../InkFrameStats';
import { readInkDiagnostics } from '../../InkDiagnostics';
import { useInkShapePreferences } from '../../InkShapePreferences';
import { withShape } from '../../InkShapeGeometry';
import { useNoteStore } from '../../../store';
import type { PdfItem } from '../PdfTypes';
import { InkLaserTrail } from '../../InkLaserTrail';

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
function pointer(canvas: Element, type: string, x: number, y: number, empty = false, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...modifiers });
  Object.defineProperties(event, {
    pointerId: { value: 1 }, pointerType: { value: 'pen' }, pressure: { value: 0.5 },
    getCoalescedEvents: { value: () => empty ? [] : [event] },
  });
  fireEvent(canvas, event);
}
function middle(target: Element | Window, type: string, x: number, y: number, buttons = 4) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 1, buttons });
  Object.defineProperties(event, { pointerId: { value: 2 }, pointerType: { value: 'mouse' } });
  fireEvent(target, event);
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
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
  } as unknown as CanvasRenderingContext2D, { get(target, key) { return Reflect.get(target, key) ?? (() => undefined); } }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); clearInkRasterCache(); clearStreamingInk(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('editable shape input', () => {
  async function mountShapeView(view: 'canvas' | 'pdf') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useInkShapePreferences.setState({ enabled: true, delay: 1000 });
    SVGElement.prototype.setPointerCapture = vi.fn();
    SVGElement.prototype.releasePointerCapture = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
    if (view === 'pdf') usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, numPages: 2, pageSizes: { 1: { width: 600, height: 800 }, 2: { width: 600, height: 800 } } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    act(() => {
      if (view === 'canvas') useCanvasStore.setState({ camera: { x: 0, y: 0, zoom: 1 } });
      else usePdfStore.setState({ camera: { x: 0, y: 0, zoom: 1 } });
    });
    frame();
    return { root, canvas: root.container.querySelector('canvas')!,
      items: () => view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1] ?? [] };
  }
  it.each(['canvas', 'pdf'] as const)('%s holds, edits dimensions, undoes and restores handwriting', async view => {
    const s = await mountShapeView(view);
    pointer(s.canvas, 'pointerdown', 100, 100);
    for (let i = 1; i <= 20; i++) pointer(s.canvas, 'pointermove', 100 + i * 10, 100 + Math.sin(i) * 0.3);
    frame(); act(() => vi.advanceTimersByTime(1001)); frame();
    expect(s.items()).toHaveLength(0); // preview does not persist/history-push
    pointer(s.canvas, 'pointerup', 300, 100); frame();
    let shape = s.items()[0] as PdfStroke;
    expect(shape.geometry?.kind).toBe('line');
    expect(s.root.getByRole('group', { name: '图形参数' })).toBeTruthy();
    const length = s.root.getByLabelText('长度');
    fireEvent.change(length, { target: { value: '240' } }); fireEvent.blur(length); frame();
    shape = s.items()[0] as PdfStroke;
    expect(shape.geometry).toMatchObject({ kind: 'line', a: { x: 100, y: 100 }, b: { x: 340, y: 100 } });
    const store = view === 'canvas' ? useCanvasStore : usePdfStore;
    act(() => store.getState().undo()); frame();
    expect((s.items()[0] as PdfStroke).geometry?.kind).toBe('line');
    act(() => store.getState().redo()); frame();
    expect((s.items()[0] as PdfStroke).geometry).toEqual(shape.geometry);
    fireEvent.click(s.root.getByText('恢复手绘')); frame();
    const restored = s.items()[0] as PdfStroke;
    expect(restored.geometry).toBeUndefined(); expect(restored.points.length).toBeGreaterThan(10);
    expect(restored.renderVersion).toBe(2);
  });
  it.each(['canvas', 'pdf'] as const)('%s skips recognition on normal lift and clears the editor on the next stroke', async view => {
    const s = await mountShapeView(view);
    draw(s.canvas); act(() => vi.advanceTimersByTime(1500));
    expect((s.items()[0] as PdfStroke).geometry).toBeUndefined();
    pointer(s.canvas, 'pointerdown', 100, 200); pointer(s.canvas, 'pointermove', 300, 200); frame();
    act(() => vi.advanceTimersByTime(1001)); pointer(s.canvas, 'pointerup', 300, 200); frame();
    expect(s.root.queryByRole('group', { name: '图形参数' })).toBeTruthy();
    pointer(s.canvas, 'pointerdown', 400, 300); frame();
    expect(s.root.queryByRole('group', { name: '图形参数' })).toBeNull();
    pointer(s.canvas, 'pointerup', 401, 300);
  });
  it.each(['canvas', 'pdf'] as const)('%s snaps rough three- and four-sided outlines during a hold', async view => {
    const s = await mountShapeView(view);
    const outlines = [
      { kind: 'triangle', points: [[150, 130], [164, 139], [200, 192], [242, 267], [236, 276],
        [183, 274], [120, 270], [70, 260], [75, 249], [104, 204], [132, 153], [144, 135]] },
      { kind: 'rectangle', points: [[340, 143], [389, 138], [439, 137], [480, 145], [497, 157],
        [501, 194], [498, 238], [489, 249], [450, 256], [406, 252], [354, 247], [330, 236], [321, 197], [326, 166], [335, 150]] },
    ];
    for (const { points, kind } of outlines) {
      const [[startX, startY], ...steps] = points;
      pointer(s.canvas, 'pointerdown', startX, startY);
      for (const [x, y] of steps) pointer(s.canvas, 'pointermove', x, y);
      frame();
      act(() => vi.advanceTimersByTime(1001));
      const [endX, endY] = steps[steps.length - 1];
      pointer(s.canvas, 'pointerup', endX, endY); frame();
      expect((s.items()[s.items().length - 1] as PdfStroke).geometry?.kind).toBe(kind);
    }
  });
  it.each(['canvas', 'pdf'] as const)('%s draws and fades laser trails without committing ink or history', async view => {
    const s = await mountShapeView(view);
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const paint = vi.spyOn(InkLaserTrail.prototype, 'draw');
    const append = vi.spyOn(InkLaserTrail.prototype, 'append');
    if (view === 'canvas') act(() => useCanvasStore.setState({ brush: 'laser' }));
    else act(() => usePdfStore.setState({ brushType: 'laser' }));
    vi.spyOn(s.canvas.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 1000, 600));
    pointer(s.canvas, 'pointerdown', 100, 150);
    expect(append).toHaveBeenLastCalledWith(90, 130, expect.any(Number));
    pointer(s.canvas, 'pointermove', 135, 170); frame();
    expect(paint).toHaveBeenLastCalledWith(expect.anything(), 1);
    pointer(s.canvas, 'pointerup', 160, 150);
    now += 900; frame();
    expect(paint).toHaveBeenLastCalledWith(expect.anything(), 0.5);
    paint.mockClear();
    now += 1000; frame();
    expect(paint).not.toHaveBeenCalled();
    expect(s.items()).toHaveLength(0);
    const length = view === 'canvas' ? useCanvasStore.getState().history.length : (usePdfStore.getState().history[1] ?? []).length;
    expect(length).toBe(0);
  });
  it.each(['canvas', 'pdf'] as const)('%s keeps geometry in sync when an existing selection is moved', async view => {
    const s = await mountShapeView(view);
    const circle = withShape({ id: 'saved-circle', type: 'stroke', points: [], color: '#1267cb', size: 4,
      opacity: 1, smoothing: 0, compositeOperation: 'source-over', createdAt: 0 } as PdfStroke,
    { kind: 'circle', center: { x: 200, y: 200 }, radius: 60 });
    act(() => {
      if (view === 'canvas') useCanvasStore.setState({ objects: [circle], activeTool: 'select', renderEpoch: 4 });
      else usePdfStore.setState({ items: { 1: [circle] }, activeTool: 'select', renderEpoch: 4 });
    }); frame();
    // Dispatch directly to the canvas to exercise the pre-existing group move
    // route as well as the shape editor's own outline-drag route.
    pointer(s.canvas, 'pointerdown', 260, 200); pointer(s.canvas, 'pointermove', 360, 250); frame(); pointer(s.canvas, 'pointerup', 360, 250); frame();
    expect((s.items()[0] as PdfStroke).geometry).toEqual({ kind: 'circle', center: { x: 300, y: 250 }, radius: 60 });
  });
  it('flushes a PDF hold to its original page before switching pages', async () => {
    const s = await mountShapeView('pdf');
    pointer(s.canvas, 'pointerdown', 100, 100); pointer(s.canvas, 'pointermove', 300, 100); frame();
    act(() => vi.advanceTimersByTime(1001));
    await act(async () => usePdfStore.getState().setCurrentPage(2));
    expect((usePdfStore.getState().items[1][0] as PdfStroke).geometry?.kind).toBe('line');
    expect(usePdfStore.getState().items[2] ?? []).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1500));
    expect(usePdfStore.getState().items[2] ?? []).toHaveLength(0);
  });
  it.each(['canvas', 'pdf'] as const)('%s previews control-point resizing without mutating the document', async view => {
    const s = await mountShapeView(view);
    const circle = withShape({ id: 'resize-circle', type: 'stroke', points: [], color: '#1267cb', size: 4,
      opacity: 1, smoothing: 0, compositeOperation: 'source-over', createdAt: 0 } as PdfStroke,
    { kind: 'circle', center: { x: 200, y: 200 }, radius: 60 });
    act(() => {
      if (view === 'canvas') useCanvasStore.setState({ objects: [circle], activeTool: 'select', selectedIds: [circle.id], renderEpoch: 4 });
      else usePdfStore.setState({ items: { 1: [circle] }, activeTool: 'select', selectedIds: [circle.id], renderEpoch: 4 });
    }); frame();
    const control = s.root.container.querySelector('svg g[aria-label="调整半径"]')!;
    pointer(control, 'pointerdown', 200, 140); pointer(control, 'pointerup', 200, 140); frame();
    expect(view === 'canvas' ? useCanvasStore.getState().history.length : (usePdfStore.getState().history[1] ?? []).length).toBe(0);
    const starting = s.items()[0];
    pointer(control, 'pointerdown', 200, 140); pointer(control, 'pointermove', 200, 100); frame();
    expect(s.items()[0]).toBe(starting);
    pointer(control, 'pointerup', 200, 100); frame();
    expect((s.items()[0] as PdfStroke).geometry).toEqual({ kind: 'circle', center: { x: 200, y: 200 }, radius: 100 });
    const store = view === 'canvas' ? useCanvasStore : usePdfStore;
    act(() => store.getState().undo()); frame();
    expect((s.items()[0] as PdfStroke).geometry).toEqual(circle.geometry);
  });
  it.each(['canvas', 'pdf'] as const)('%s keeps panel wheel input out of canvas zoom and flushes a focused size field', async view => {
    const s = await mountShapeView(view);
    pointer(s.canvas, 'pointerdown', 100, 100); pointer(s.canvas, 'pointermove', 300, 100); frame();
    act(() => vi.advanceTimersByTime(1001)); pointer(s.canvas, 'pointerup', 300, 100); frame();
    const store = view === 'canvas' ? useCanvasStore : usePdfStore;
    const camera = store.getState().camera;
    const panel = s.root.getByRole('group', { name: '图形参数' });
    fireEvent.wheel(panel, { deltaY: 100, bubbles: true, cancelable: true });
    expect(store.getState().camera).toBe(camera);
    const input = s.root.getByLabelText('长度');
    fireEvent.focus(input); (input as HTMLInputElement).focus();
    fireEvent.change(input, { target: { value: '260' } });
    act(() => window.dispatchEvent(new Event('ink:flush-gesture'))); frame();
    expect((s.items()[0] as PdfStroke).geometry).toMatchObject({ kind: 'line', b: { x: 360, y: 100 } });
  });
});

describe('mixed object selection', () => {
  const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9cAAAAASUVORK5CYII=';
  async function mountMixed(view: 'canvas' | 'pdf') {
    const originalScale = useNoteStore.getState().uiScale;
    useNoteStore.setState({ uiScale: 1 });
    const fixtures: PdfItem[] = [
      { id: 'ink', type: 'stroke', points: [{ x: 100, y: 100, pressure: 0.7, t: 0 }, { x: 160, y: 100, pressure: 0.7, t: 16 }], color: '#1267cb', size: 8, opacity: 1, smoothing: 0, compositeOperation: 'source-over', createdAt: 0 },
      { id: 'picture', type: 'image', x: 220, y: 80, width: 70, height: 70, dataUrl: imageData, createdAt: 0 },
      { id: 'card', type: 'text', x: 330, y: 80, width: 100, height: 60, content: 'Selection text', fontSize: 16, color: '#1267cb', backgroundColor: '#fff', createdAt: 0, updatedAt: 0 },
    ];
    const items = () => view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1] ?? [];
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const item = items().find(o => o.id === (this as HTMLElement).dataset.inkObjectId);
      return item && item.type !== 'stroke' ? new DOMRect(item.x, item.y, item.width, item.height) : new DOMRect(0, 0, 1000, 600);
    });
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    if (view === 'canvas') useCanvasStore.setState({ objects: fixtures, activeTool: 'select', selectionMode: 'box' });
    else usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, numPages: 2, pageSizes: { 1: { width: 600, height: 800 }, 2: { width: 600, height: 800 } },
      items: { 1: fixtures }, activeTool: 'select', selectionMode: 'box' });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    const store = view === 'canvas' ? useCanvasStore : usePdfStore;
    act(() => store.setState({ camera: { x: 0, y: 0, zoom: 1 } })); frame();
    return { root, store, items, fixtures, originalScale,
      canvas: root.container.querySelector('canvas')!,
      object: (id: string) => root.container.querySelector<HTMLElement>(`[data-ink-object-id="${id}"]`)! };
  }
  function click(target: Element, x: number, y: number, modifiers = {}) {
    pointer(target, 'pointerdown', x, y, false, modifiers); pointer(target, 'pointerup', x, y, false, modifiers); frame();
  }
  function box(canvas: Element, x1: number, y1: number, x2: number, y2: number, modifiers = {}) {
    pointer(canvas, 'pointerdown', x1, y1, false, modifiers); pointer(canvas, 'pointermove', x2, y2, false, modifiers); frame();
    pointer(canvas, 'pointerup', x2, y2, false, modifiers); frame();
  }
  it.each(['canvas', 'pdf'] as const)('%s selects object bodies and Shift adds / Ctrl subtracts without editing or moving', async view => {
    const s = await mountMixed(view);
    click(s.canvas, 120, 100);
    click(s.object('picture'), 240, 100, { shiftKey: true });
    click(s.object('card').firstElementChild!, 350, 100, { shiftKey: true });
    expect(s.store.getState().selectedIds).toEqual(['ink', 'picture', 'card']);
    expect(s.object('picture').dataset.inkSelected).toBe('true');
    expect(s.object('card').dataset.inkSelected).toBe('true');
    expect(s.store.getState().editingTextId).toBeNull();
    click(s.object('picture'), 240, 100, { ctrlKey: true });
    expect(s.store.getState().selectedIds).toEqual(['ink', 'card']);
    click(s.object('card'), 350, 100, { ctrlKey: true, shiftKey: true });
    expect(s.store.getState().selectedIds).toEqual(['ink']);
    click(s.canvas, 900, 500, { shiftKey: true });
    expect(s.store.getState().selectedIds).toEqual(['ink']);
    expect(s.items().find(o => o.id === 'picture')).toMatchObject({ x: 220, y: 80 });
    expect(view === 'canvas' ? useCanvasStore.getState().history.length : (usePdfStore.getState().history[1] ?? []).length).toBe(0);
    act(() => useNoteStore.setState({ uiScale: s.originalScale }));
  });
  it.each(['canvas', 'pdf'] as const)('%s applies modifiers to marquee selection across ink, images and text', async view => {
    const s = await mountMixed(view);
    box(s.canvas, 90, 60, 445, 170);
    expect(s.store.getState().selectedIds).toEqual(['ink', 'picture', 'card']);
    box(s.canvas, 205, 65, 300, 165, { ctrlKey: true });
    expect(s.store.getState().selectedIds).toEqual(['ink', 'card']);
    box(s.canvas, 205, 65, 300, 165, { shiftKey: true });
    expect(s.store.getState().selectedIds).toEqual(['ink', 'card', 'picture']);
    box(s.canvas, 800, 400, 850, 450, { ctrlKey: true });
    expect(s.store.getState().selectedIds).toHaveLength(3);
    box(s.canvas, 205, 65, 300, 165);
    expect(s.store.getState().selectedIds).toEqual(['picture']);
    act(() => useNoteStore.setState({ uiScale: s.originalScale }));
  });
  it.each(['canvas', 'pdf'] as const)('%s previews and atomically commits a mixed selection from an image body', async view => {
    const s = await mountMixed(view);
    act(() => s.store.getState().setSelectedIds(['ink', 'picture', 'card'])); frame();
    const baseline = s.items();
    pointer(s.object('picture'), 'pointerdown', 240, 100);
    pointer(s.object('picture'), 'pointermove', 300, 140); frame();
    expect(s.items()).toBe(baseline);
    expect(s.object('picture').style.translate).toBe('60px 40px');
    expect(s.object('card').style.translate).toBe('60px 40px');
    pointer(s.object('picture'), 'pointerup', 300, 140); frame();
    expect(s.object('picture').style.translate).toBe('');
    expect((s.items()[0] as PdfStroke).points[0]).toMatchObject({ x: 160, y: 140 });
    expect(s.items()[1]).toMatchObject({ x: 280, y: 120 });
    expect(s.items()[2]).toMatchObject({ x: 390, y: 120 });
    expect(view === 'canvas' ? useCanvasStore.getState().history.length : (usePdfStore.getState().history[1] ?? []).length).toBe(1);
    act(() => s.store.getState().undo()); frame();
    expect(s.items()).toBe(baseline);
    act(() => s.store.getState().redo()); frame();
    expect(s.items()[1]).toMatchObject({ x: 280, y: 120 });
    act(() => useNoteStore.setState({ uiScale: s.originalScale }));
  });
  it.each(['canvas', 'pdf'] as const)('%s restores DOM previews if undo interrupts a mixed drag and keeps text double-click editing', async view => {
    const s = await mountMixed(view);
    act(() => s.store.getState().setSelectedIds(['ink', 'picture', 'card'])); frame();
    pointer(s.object('card'), 'pointerdown', 350, 100); pointer(s.object('card'), 'pointermove', 400, 130); frame();
    expect(s.object('picture').style.translate).toBe('50px 30px');
    // A structural change cancels the transient gesture and clears DOM offsets.
    act(() => s.store.setState({ renderEpoch: s.store.getState().renderEpoch + 1 })); frame();
    expect(s.object('picture').style.translate).toBe('');
    fireEvent.doubleClick(s.object('card'));
    expect(s.store.getState().editingTextId).toBe('card');
    act(() => useNoteStore.setState({ uiScale: s.originalScale }));
  });
  it.each(['canvas', 'pdf'] as const)('%s keeps mixed drag coordinates correct with UI and camera scaling', async view => {
    const s = await mountMixed(view);
    act(() => {
      useNoteStore.setState({ uiScale: 2 });
      s.store.setState({ selectedIds: ['ink', 'picture', 'card'], camera: { x: 100, y: 40, zoom: 2 } });
    }); frame();
    pointer(s.object('picture'), 'pointerdown', 580, 240);
    pointer(s.object('picture'), 'pointermove', 640, 280); frame();
    expect(s.object('picture').style.translate).toBe('30px 20px');
    pointer(s.object('picture'), 'pointerup', 640, 280); frame();
    expect(s.items()[1]).toMatchObject({ x: 250, y: 100 });
    expect((s.items()[0] as PdfStroke).points[0]).toMatchObject({ x: 130, y: 120 });
    act(() => useNoteStore.setState({ uiScale: s.originalScale }));
  });
  it.each(['canvas', 'pdf'] as const)('%s creates, edits and drags a comment around mixed content', async view => {
    const s = await mountMixed(view);
    if (view === 'canvas') act(() => useCanvasStore.setState({ loaded: true, currentCanvasId: 'comment-test' }));
    fireEvent.keyDown(window, { key: 'c' });
    expect(s.items()).toHaveLength(3);
    box(s.canvas, 90, 60, 445, 170);
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'c', isComposing: true });
    expect(s.items()).toHaveLength(3);
    fireEvent.keyDown(window, { key: 'c' });
    const comment = s.items().find(item => item.type === 'comment')!;
    expect(comment).toMatchObject({ x: 80, y: 36, width: 366, height: 130 });
    let input = s.root.getByRole('textbox', { name: '注释标题' });
    expect(input).toBe(document.activeElement);
    fireEvent.change(input, { target: { value: '复习区' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(s.root.queryByRole('textbox', { name: '注释标题' })).toBe(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(s.items().find(item => item.type === 'comment')?.title).toBe('复习区');
    const header = s.root.getByRole('button', { name: '复习区' });
    const before = s.items();
    pointer(header, 'pointerdown', 240, 54); pointer(header, 'pointermove', 300, 84); frame();
    const fill = s.root.container.querySelector<HTMLElement>('[data-ink-comment-fill]')!;
    expect(fill.style.translate).toBe('60px 30px');
    expect(s.items()).toBe(before);
    pointer(header, 'pointercancel', 300, 84); frame();
    expect(fill.style.translate).toBe('');
    expect(s.items()).toBe(before);
    pointer(header, 'pointerdown', 240, 54); pointer(header, 'pointerup', 300, 84); frame();
    expect(s.items()[0]).toMatchObject({ points: [{ x: 160, y: 130 }, { x: 220, y: 130 }] });
    expect(s.items()[1]).toMatchObject({ x: 280, y: 110 });
    expect(s.items().find(item => item.type === 'comment')).toMatchObject({ x: 140, y: 66 });
    act(() => s.store.getState().undo()); frame();
    expect(s.items()).toBe(before);

    act(() => s.store.getState().setSelectedIds([comment.id])); frame();
    const edge = s.object(comment.id).querySelector('[data-ink-comment-resize="e"]')!;
    pointer(edge, 'pointerdown', 446, 100);
    pointer(s.canvas, 'pointermove', 500, 100); frame();
    expect(fill.style.width).toBe('420px');
    expect(s.items()).toBe(before);
    pointer(s.canvas, 'pointerup', 500, 100); frame();
    expect(s.items().find(item => item.type === 'comment')?.width).toBe(420);
    expect(s.items()[1]).toBe(before[1]);

    if (view === 'pdf') {
      fireEvent.doubleClick(header);
      input = s.root.getByRole('textbox', { name: '注释标题' });
      fireEvent.change(input, { target: { value: '第一页' } });
      await act(async () => usePdfStore.getState().setCurrentPage(2));
      expect(s.items().find(item => item.type === 'comment')?.title).toBe('第一页');
      expect(s.root.container.querySelector('[data-ink-comment-fill]')).toBeNull();
    }
    act(() => useNoteStore.setState({ uiScale: s.originalScale }));
  });
});

describe('wheel input', () => {
  // React registers `onWheel` as a PASSIVE listener at the root, where
  // preventDefault() is ignored (Chrome: "Unable to preventDefault inside passive
  // event listener") and the browser's own ctrl+wheel page zoom is not suppressed.
  // The canvas must therefore attach its own NON-passive listener — and exactly
  // one, or every wheel tick would zoom twice.
  it.each(['canvas', 'pdf'] as const)('%s zooms through a single non-passive listener', async (view) => {
    if (view === 'pdf') usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, pageSizes: { 1: { width: 600, height: 800 } } });
    // The listener lives on the CONTAINER, not the canvas: the DOM cards (images,
    // text) paint above the canvas and would otherwise swallow a wheel aimed at
    // them. React's own wheel delegation at the root is passive, so counting
    // NON-PASSIVE registrations is the invariant that matters — one event must
    // produce exactly one zoom step.
    const addSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    const canvas = root.container.querySelector('canvas')!;

    const wheelRegistrations = addSpy.mock.calls.filter(
      (c) => c[0] === 'wheel' && (c[2] as AddEventListenerOptions)?.passive === false);
    expect(wheelRegistrations).toHaveLength(1);
    expect(wheelRegistrations[0][0]).not.toBe(canvas); // the container owns it

    const camera = () => (view === 'canvas' ? useCanvasStore.getState() : usePdfStore.getState()).camera;
    // The PDF fits the page to its container on load, and jsdom's container is
    // 0x0 — which clamps to MIN_ZOOM. Start from a known zoom.
    act(() => {
      if (view === 'canvas') useCanvasStore.setState({ camera: { x: 0, y: 0, zoom: 1 } });
      else usePdfStore.setState({ camera: { x: 0, y: 0, zoom: 1 } });
    });
    act(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    });
    // One event, one zoom step: 1 * (1 - 100*0.001) = 0.9.
    expect(camera().zoom).toBeCloseTo(0.9, 5);
  });
});

describe('canvas input integration', () => {
  it('moves an image outside the select tool with one history entry on release', async () => {
    const image = { id: 'photo', type: 'image' as const, x: 100, y: 100, width: 90, height: 60, dataUrl: 'data:image/gif;base64,', createdAt: 0 };
    useCanvasStore.setState({ objects: [image], loaded: true });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(<InfiniteInkCanvas />); });
    const element = root.container.querySelector<HTMLElement>('[data-ink-object-id="photo"]')!;
    element.setPointerCapture = vi.fn();
    pointer(element, 'pointerdown', 105, 110);
    pointer(element, 'pointermove', 175, 130);
    pointer(element, 'pointermove', 215, 140);
    expect(useCanvasStore.getState().objects[0]).toBe(image);
    expect(useCanvasStore.getState().history).toHaveLength(0);
    expect(element.style.translate).toBe('');
    frame();
    const [x, y] = element.style.translate.split(' ').map(Number.parseFloat);
    const scale = useNoteStore.getState().uiScale;
    expect(x).toBeCloseTo(110 / scale);
    expect(y).toBeCloseTo(30 / scale);
    pointer(element, 'pointerup', 225, 144);
    expect(useCanvasStore.getState().objects[0]).toMatchObject({ x: 220, y: 134 });
    expect(useCanvasStore.getState().history).toHaveLength(1);
    expect(element.style.translate).toBe('');
    act(() => useCanvasStore.getState().undo());
    expect(useCanvasStore.getState().objects[0]).toBe(image);
  });

  it.each(['canvas', 'pdf'] as const)('%s records old and new tile coverage for a cross-tile drag', async view => {
    const s: PdfStroke = { id: 'trace-drag', type: 'stroke', color: '#000', size: 8, opacity: 1, smoothing: 0,
      createdAt: 0, compositeOperation: 'source-over', points: [{ x: 450, y: 100, pressure: .5, t: 0 }, { x: 600, y: 100, pressure: .5, t: 17 }] };
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
    if (view === 'canvas') useCanvasStore.setState({ objects: [s], loaded: true });
    else usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, pageSizes: { 1: { width: 600, height: 800 } }, items: { 1: [s] } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    const store = view === 'canvas' ? useCanvasStore : usePdfStore;
    act(() => store.setState({ camera: { x: 0, y: 0, zoom: 1 }, activeTool: 'select', selectedIds: [s.id] })); frame();
    const canvas = root.container.querySelector('canvas')!;
    pointer(canvas, 'pointerdown', 480, 100); pointer(canvas, 'pointermove', 580, 100); frame(); pointer(canvas, 'pointerup', 580, 100); frame();
    const records = readInkDiagnostics().events.filter((event: any) => event.data.surface === view && ['drag-start', 'drag-end'].includes(event.type));
    const start = records.findLast((event: any) => event.type === 'drag-start').data;
    const end = records.findLast((event: any) => event.type === 'drag-end').data;
    expect(start.strokes[0]).toMatchObject({ expectedKeys: ['0:0', '1:0'], indexedKeys: ['0:0', '1:0'], missingKeys: [] });
    expect(end).toMatchObject({ dx: 100, dy: 0 });
    expect(end.strokes[0]).toMatchObject({ expectedKeys: ['1:0'], indexedKeys: ['1:0'], missingKeys: [] });
    expect(end.strokes[0].freshBounds.minX - start.strokes[0].freshBounds.minX).toBe(100);
  });
  it.each(['canvas', 'pdf'] as const)('%s batches high-rate pan input once per frame and flushes the final position on release', async view => {
    if (view === 'pdf') usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, pageSizes: { 1: { width: 600, height: 800 } } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    const store = view === 'canvas' ? useCanvasStore : usePdfStore;
    act(() => store.setState({ camera: { x: 0, y: 0, zoom: 1 } })); frame();
    const updates = vi.fn(); const unsubscribe = store.subscribe((state, previous) => { if (state.camera !== previous.camera) updates(state.camera); });
    const canvas = root.container.querySelector('canvas')!;
    middle(canvas, 'pointerdown', 100, 100);
    for (let i = 1; i <= 4; i++) middle(canvas, 'pointermove', 100 + i * 5, 100 + i * 3);
    expect(updates).not.toHaveBeenCalled(); frame();
    expect(updates).toHaveBeenCalledTimes(1); expect(store.getState().camera).toMatchObject({ x: 20, y: 12 });
    middle(canvas, 'pointermove', 130, 120); middle(canvas, 'pointerup', 130, 120, 0);
    expect(store.getState().camera).toMatchObject({ x: 30, y: 20 });
    middle(canvas, 'pointermove', 160, 140, 0); frame();
    expect(store.getState().camera).toMatchObject({ x: 30, y: 20 }); unsubscribe();
  });
  it('flushes a pending pan before wheel zoom so the camera cannot jump back on the next frame', async () => {
    let root!: ReturnType<typeof render>; await act(async () => { root = render(<InfiniteInkCanvas />); });
    const canvas = root.container.querySelector('canvas')!;
    middle(canvas, 'pointerdown', 100, 100); middle(canvas, 'pointermove', 120, 110);
    fireEvent(canvas, new WheelEvent('wheel', { deltaY: 100, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
    expect(useCanvasStore.getState().camera).toEqual({ x: 18, y: 9, zoom: .9 });
    frame(); expect(useCanvasStore.getState().camera).toEqual({ x: 18, y: 9, zoom: .9 });
  });
  it.each(['canvas', 'pdf'] as const)('%s keeps the latest wheel camera when middle dragging begins or continues', async view => {
    if (view === 'pdf') usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, pageSizes: { 1: { width: 600, height: 800 } } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    const store = view === 'canvas' ? useCanvasStore : usePdfStore;
    act(() => store.setState({ camera: { x: 0, y: 0, zoom: 1 } })); frame();
    const canvas = root.container.querySelector('canvas')!;
    middle(canvas, 'pointerdown', 100, 100);
    fireEvent(canvas, new WheelEvent('wheel', { deltaY: 100, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    const zoomed = { ...store.getState().camera };
    middle(canvas, 'pointermove', 100, 100); frame();
    expect(store.getState().camera).toEqual(zoomed);
    // Flush pending movement before the next wheel, then keep its new origin.
    middle(canvas, 'pointermove', 120, 110);
    fireEvent(canvas, new WheelEvent('wheel', { deltaX: 6, deltaY: 9, ctrlKey: true, clientX: 120, clientY: 110, bubbles: true, cancelable: true }));
    const scrolled = { ...store.getState().camera };
    expect(scrolled).toEqual({ ...zoomed, x: zoomed.x + 20 - 6, y: zoomed.y + 10 - 9 });
    middle(canvas, 'pointermove', 120, 110); frame();
    expect(store.getState().camera).toEqual(scrolled);
    middle(canvas, 'pointermove', 130, 125); frame();
    expect(store.getState().camera).toEqual({ ...scrolled, x: scrolled.x + 10, y: scrolled.y + 15 });
    middle(canvas, 'pointerup', 130, 125, 0);
  });
  it.each(['canvas', 'pdf'] as const)('%s shows existing ink on a StrictMode cold mount without any pointer input', async view => {
    resetInkFrame();
    const old: PdfStroke = { id: 'existing', type: 'stroke', color: '#123abc', opacity: .5, size: 8, smoothing: .35,
      compositeOperation: 'source-over', renderVersion: 2, points: [{ x:100, y:100, pressure:.5, t:0 }, { x:140, y:100, pressure:.5, t:4 }], createdAt:0 };
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 400));
    if (view === 'canvas') useCanvasStore.setState({ objects:[old], loaded:true });
    else usePdfStore.setState({ pdfDoc:{} as never, currentPage:1, pageSizes:{1:{width:600,height:800}}, items:{1:[old]} });
    await act(async () => { render(<React.StrictMode>{view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />}</React.StrictMode>); });
    for (let i=0; i<40 && !readInkFrame().visibleTiles; i++) frame();
    expect(readInkFrame().visibleTiles).toBeGreaterThan(0);
  });
  it('stops a middle-button pan on release and also releases a pan outside the canvas', async () => {
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(<InfiniteInkCanvas />); });
    const canvas = root.container.querySelector('canvas')!;
    middle(canvas, 'pointerdown', 100, 100); middle(canvas, 'pointermove', 120, 110); frame();
    expect(useCanvasStore.getState().camera).toMatchObject({ x:20, y:10 });
    middle(canvas, 'pointerup', 120, 110, 0); middle(canvas, 'pointermove', 140, 120, 0);
    expect(useCanvasStore.getState().camera).toMatchObject({ x:20, y:10 });
    middle(canvas, 'pointerdown', 100, 100); middle(canvas, 'pointermove', 120, 110); frame();
    middle(window, 'pointerup', 120, 110, 0); middle(canvas, 'pointermove', 140, 120, 0);
    expect(useCanvasStore.getState().camera).toMatchObject({ x:40, y:20 });
    middle(canvas, 'pointerdown', 100, 100); middle(canvas, 'pointermove', 120, 110); frame();
    fireEvent(window, new Event('blur')); middle(canvas, 'pointermove', 140, 120, 0);
    expect(useCanvasStore.getState().camera).toMatchObject({ x:60, y:30 });
    middle(canvas, 'pointerdown', 100, 100); middle(canvas, 'pointermove', 120, 110); frame();
    // Releasing middle while another mouse button is held need not emit pointerup.
    middle(canvas, 'pointermove', 140, 120, 1);
    expect(useCanvasStore.getState().camera).toMatchObject({ x:80, y:40 });
    expect(useCanvasStore.getState().objects).toHaveLength(0);
  });
  it.each(['canvas', 'pdf'] as const)('%s commits all queued samples when unmounted during a gesture', async view => {
    if (view === 'pdf') usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, pageSizes: { 1: { width: 600, height: 800 } } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    act(() => { if (view === 'canvas') useCanvasStore.setState({ camera: { x: 0, y: 0, zoom: 1 } }); else usePdfStore.setState({ camera: { x: 0, y: 0, zoom: 1 } }); });
    frame(); const canvas = root.container.querySelector('canvas')!;
    pointer(canvas, 'pointerdown', 100, 100, true);
    pointer(canvas, 'pointermove', 110, 100, true);
    pointer(canvas, 'pointermove', 120, 100, true);
    root.unmount();
    const items = (view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1]) as PdfStroke[];
    expect(items).toHaveLength(1); expect(items[0].points.map(point => point.x)).toEqual([100, 110, 120]);
  });
  it('finishes an active PDF gesture on its original page before changing pages', async () => {
    usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, numPages: 2, pageSizes: { 1: { width: 600, height: 800 } } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(<PdfCanvas />); });
    act(() => usePdfStore.setState({ camera: { x: 0, y: 0, zoom: 1 } })); frame();
    const canvas = root.container.querySelector('canvas')!;
    pointer(canvas, 'pointerdown', 100, 100, true); pointer(canvas, 'pointermove', 110, 100, true);
    act(() => usePdfStore.getState().setCurrentPage(2));
    expect((usePdfStore.getState().items[1][0] as PdfStroke).points.map(point => point.x)).toEqual([100, 110]);
    expect(usePdfStore.getState().items[2] ?? []).toHaveLength(0);
  });
  it.each([
    ['canvas', 'marker'], ['pdf', 'marker'], ['canvas', 'fountain'],
    ['pdf', 'fountain'], ['canvas', 'pencil'], ['pdf', 'pencil'],
  ] as const)('%s %s commits versioned ink, erases the topmost stroke, and rebuilds its index on undo', async (view, style) => {
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
    const version = style === 'marker' ? 2 : 5;
    expect(strokes().every(s => s.renderVersion === version && s.points.length === 13)).toBe(true);
    if (style !== 'marker') expect(strokes().every(s => s.style === style)).toBe(true);
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
  it.each(['canvas', 'pdf'] as const)('%s preserves empty coalesced events and the final up sample without duplicate loss-of-capture commits', async view => {
    if (view === 'pdf') usePdfStore.setState({ pdfDoc: {} as never, currentPage: 1, pageSizes: { 1: { width: 600, height: 800 } } });
    let root!: ReturnType<typeof render>;
    await act(async () => { root = render(view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />); });
    act(() => { if (view === 'canvas') useCanvasStore.setState({ camera: { x: 0, y: 0, zoom: 1 } }); else usePdfStore.setState({ camera: { x: 0, y: 0, zoom: 1 } }); });
    frame(); const canvas = root.container.querySelector('canvas')!;
    pointer(canvas, 'pointerdown', 100, 100, true);
    pointer(canvas, 'pointermove', 110, 100, true);
    pointer(canvas, 'pointerup', 120, 100, true);
    pointer(canvas, 'lostpointercapture', 0, 0, true); frame();
    const items = (view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1]) as PdfStroke[];
    expect(items).toHaveLength(1); expect(items[0].points.map(point => point.x)).toEqual([100, 110, 120]);
    pointer(canvas, 'pointerdown', 150, 100, true); pointer(canvas, 'pointermove', 160, 100, true);
    pointer(canvas, 'pointercancel', 0, 0, true); pointer(canvas, 'lostpointercapture', 0, 0, true); frame();
    const after = (view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1]) as PdfStroke[];
    expect(after).toHaveLength(2); expect(after[1].points.map(point => point.x)).toEqual([150, 160]);
  });

});
