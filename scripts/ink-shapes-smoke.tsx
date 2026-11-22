import React from 'react';
import { createRoot } from 'react-dom/client';
import InfiniteInkCanvas from '../src/components/InfiniteInkCanvas/InfiniteInkCanvas';
import PdfCanvas from '../src/components/PdfAnnotation/PdfCanvas';
import { useCanvasStore } from '../src/components/InfiniteInkCanvas/useCanvasStore';
import { usePdfStore } from '../src/components/PdfAnnotation/PdfStore';
import { useNoteStore } from '../src/store';
import { useInkShapePreferences } from '../src/components/InkShapePreferences';
import { shapePathPoints, shapeBounds, type InkShapeGeometry, type ShapePoint } from '../src/components/InkShapeGeometry';
import { readInkFrame } from '../src/components/InkFrameStats';
import { COMMENT_HEADER_HEIGHT, type CommentFrame } from '../src/components/InkComments';
import type { PdfStroke, PdfItem } from '../src/components/PdfAnnotation/PdfTypes';
import '../src/styles/global.css';

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function waitFor(test: () => boolean, message: string, timeout = 15000) {
  const start = performance.now();
  while (!test()) { if (performance.now() - start > timeout) throw new Error(message); await frame(); }
}
async function settle() {
  const start = performance.now();
  do { await frame(); if (performance.now() - start > 15000) throw new Error('Visible tile handoff timed out'); }
  while (performance.now() - start < 450 || readInkFrame().queuedTiles > 0);
}
function blankPdf() {
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 720] /Resources << >> /Contents 4 0 R >>';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    page, '<< /Length 0 >>\nstream\n\nendstream', page];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer;
}
function pen(target: Element, type: string, p: ShapePoint, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  target.dispatchEvent(new PointerEvent(type, { pointerId: 43, pointerType: 'pen', button: 0,
    buttons: type === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y, pressure: 0.7, bubbles: true, ...modifiers }));
}
function expanded(g: InkShapeGeometry) {
  const points = shapePathPoints(g), out: ShapePoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const count = g.kind === 'circle' || g.kind === 'ellipse' ? 1 : 16;
    for (let j = 0; j < count; j++) { const t = j / count; out.push({ x: points[i - 1].x * (1 - t) + points[i].x * t, y: points[i - 1].y * (1 - t) + points[i].y * t }); }
  }
  return [...out, points[points.length - 1]];
}
async function setNumber(label: string, value: number) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  check(input, 'Missing shape field ' + label); input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await frame();
  (window as any).shapeFieldDebug = { value: input.value, attribute: input.getAttribute('value'), active: document.activeElement === input };
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.blur();
  await frame();
}
async function capture(name: string) {
  (window as any).shapeCapture = name;
  await waitFor(() => (window as any).shapeCaptureDone === name, 'Screenshot timed out');
}

const nativeSetPointerCapture = Element.prototype.setPointerCapture;
const nativeReleasePointerCapture = Element.prototype.releasePointerCapture;
function useSyntheticPen() {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
function center(element: Element) {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}
const mouseEvent = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', position: ShapePoint, clickCount = 1) => ({
  type, ...position, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount,
});
let mouseRequest = 0;
async function mouse(...events: ReturnType<typeof mouseEvent>[]) {
  const id = ++mouseRequest;
  (window as any).inkSmokeMouse = { id, events };
  await waitFor(() => (window as any).inkSmokeMouseDone === id, 'Native pointer input timed out');
  await frame();
}
function key(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
}

useSyntheticPen();
useNoteStore.setState({ uiScale: 1 });
useInkShapePreferences.setState({ enabled: true, delay: 500 });
(async () => {
  const results: Record<string, unknown> = {};
  try {
    for (const view of ['canvas', 'pdf'] as const) {
      if (view === 'canvas') useCanvasStore.setState({ objects: [], history: [], redoStack: [], loaded: true, currentCanvasId: 'shape-smoke',
        camera: { x: 0, y: 0, zoom: 1 }, activeTool: 'pen', brush: 'marker', showDotGrid: false });
      else {
        await usePdfStore.getState().loadPdfFromBuffer(blankPdf(), 'Shapes smoke', { itemId: 'shape-smoke-pdf' });
        check(usePdfStore.getState().pdfDoc, usePdfStore.getState().error ?? 'PDF did not load');
      }
      const root = createRoot(document.getElementById('root')!);
      root.render(<React.StrictMode>{view === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />}</React.StrictMode>);
      await waitFor(() => !!document.querySelector('canvas'), 'Canvas did not mount');
      if (view === 'pdf') await waitFor(() => !usePdfStore.getState().loading, 'PDF background did not finish');
      const store = view === 'canvas' ? useCanvasStore : usePdfStore;
      store.setState({ camera: { x: 0, y: 0, zoom: 1 }, activeTool: 'pen', showDotGrid: false });
      const settings = { color: '#13c96b', size: 8, opacity: 1, smoothing: 0, edgeFeather: false, featherSize: 0 };
      if (view === 'canvas') useCanvasStore.getState().setBrushSettings(settings);
      else usePdfStore.getState().setBrush(settings);
      await frame(); await frame();
      const canvas = document.querySelector('canvas')!;
      const items = () => (view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1] ?? []).filter((s): s is PdfStroke => s.type === 'stroke');
      const green = (x: number, y: number) => [canvas, document.querySelector<HTMLCanvasElement>('[data-ink-layer="committed"]')!].some(c => {
        const r = c.getBoundingClientRect(), p = c.getContext('2d')!.getImageData(Math.round((x - r.left) * c.width / r.width), Math.round((y - r.top) * c.height / r.height), 1, 1).data;
        return p[3] > 100 && p[1] > 100 && p[0] < 80 && p[2] > 40 && p[2] < 160;
      });
      const fixtures: InkShapeGeometry[] = [
        { kind: 'line', a: { x: 300, y: 100 }, b: { x: 700, y: 100 } },
        { kind: 'circle', center: { x: 650, y: 330 }, radius: 85 },
        { kind: 'ellipse', center: { x: 430, y: 350 }, rx: 110, ry: 45, rotation: 0.3 },
        { kind: 'rectangle', center: { x: 380, y: 520 }, width: 140, height: 90, rotation: -0.15 },
        { kind: 'triangle', vertices: [{ x: 650, y: 460 }, { x: 740, y: 615 }, { x: 560, y: 605 }] },
      ];
      const kinds: string[] = [];
      for (const geometry of fixtures) {
        const points = expanded(geometry), count = items().length;
        pen(canvas, 'pointerdown', points[0]);
        // Do not pause a half-drawn straight edge for a hidden window's rAF:
        // that would intentionally satisfy the draw-and-hold gesture mid-shape.
        for (let i = 1; i < points.length; i++) { pen(canvas, 'pointermove', points[i]); if (i % 8 === 0) await sleep(1); }
        await sleep(550);
        check(items().length === count, 'Hold preview committed before lift');
        pen(canvas, 'pointerup', points[points.length - 1]); await frame(); await settle();
        const stroke = items()[items().length - 1];
        check(stroke.geometry?.kind === geometry.kind, `${view}: expected ${geometry.kind}, got ${stroke.geometry?.kind}`);
        kinds.push(stroke.geometry!.kind);
        if (geometry.kind === 'line') {
          check(green(400, 100) && green(600, 100), view + ': cross-tile shape missing');
          await setNumber('长度', 420); await settle();
          check(stroke.id === items()[0].id && items()[0].geometry?.kind === 'line' && Math.abs(items()[0].points[1].x - 720) < 0.01, view + ': numeric edit failed ' + JSON.stringify({ geometry: items()[0].geometry, field: (window as any).shapeFieldDebug, history: useCanvasStore.getState().history.length }));
          check(green(710, 100), view + ': edited line missing after worker handoff');
          store.getState().undo(); await frame(); await settle(); check(!green(710, 100), view + ': undo left new pixels');
          store.getState().redo(); await frame(); await settle(); check(green(710, 100), view + ': redo lost edited line');
          const outline = document.querySelector<SVGPathElement>('[data-ink-shape-editor] svg path')!;
          pen(outline, 'pointerdown', { x: 400, y: 100 }); pen(outline, 'pointermove', { x: 500, y: 160 }); await frame(); pen(outline, 'pointerup', { x: 500, y: 160 });
          await frame(); await settle();
          check(!green(400, 100) && !green(600, 100) && green(500, 160) && green(800, 160), view + ': shape move left ghosts or lost pixels');
        }
      }
      const before = JSON.stringify(items());
      if (view === 'canvas') {
        check(await useCanvasStore.getState().saveCanvasData(), 'Canvas save failed');
        useCanvasStore.setState(s => ({ objects: [], renderEpoch: s.renderEpoch + 1 })); await frame();
        await useCanvasStore.getState().loadCanvasData('shape-smoke');
      } else {
        check((await usePdfStore.getState().saveAnnotations()).ok, 'PDF annotations save failed');
        usePdfStore.setState(s => ({ items: {}, renderEpoch: s.renderEpoch + 1 })); await frame();
        await usePdfStore.getState().loadAnnotations('shape-smoke-pdf');
      }
      await frame(); await settle();
      check(JSON.stringify(items()) === before, view + ': geometry changed after saving/reopening');
      const circle = items().find(s => s.geometry?.kind === 'circle')!;
      store.setState({ activeTool: 'select', selectedIds: [circle.id] }); await frame();
      const circleGeometry = circle.geometry!;
      check(circleGeometry.kind === 'circle', 'Saved circle geometry missing');
      if (circleGeometry.kind === 'circle') {
        const control = document.querySelector('[data-ink-shape-editor] svg [aria-label="调整半径"]')!;
        check(control, view + ': radius control did not render');
        const start = { x: circleGeometry.center.x, y: circleGeometry.center.y - circleGeometry.radius };
        const end = { ...start, y: start.y - 10 };
        pen(control, 'pointerdown', start); pen(control, 'pointermove', end); await frame();
        check(items().find(s => s.id === circle.id) === circle, view + ': control drag mutated the document before drop');
        pen(control, 'pointerup', end); await frame(); await settle();
        const resized = items().find(s => s.id === circle.id)!.geometry!;
        check(resized.kind === 'circle' && Math.abs(resized.radius - circleGeometry.radius - 10) < 0.01, view + ': radius control did not resize');
      }
      await setNumber('半径', 95); await settle();
      const edited = items().find(s => s.id === circle.id)!;
      check(edited.geometry?.kind === 'circle' && edited.geometry.radius === 95, view + ': reopened radius is not editable');
      check(green(744, 330) && !green(734, 330) && green(500, 160), view + ': radius edit left stale/removed pixels');
      await capture(view);
      const line = items().find(s => s.geometry?.kind === 'line')!;
      const pictureCanvas = document.createElement('canvas'); pictureCanvas.width = 120; pictureCanvas.height = 80;
      const pictureContext = pictureCanvas.getContext('2d')!;
      pictureContext.fillStyle = '#215fbd'; pictureContext.fillRect(0, 0, 120, 80);
      pictureContext.fillStyle = '#90c9f9'; pictureContext.beginPath(); pictureContext.arc(90, 20, 10, 0, Math.PI * 2); pictureContext.fill();
      pictureContext.fillStyle = '#63a0df'; pictureContext.beginPath(); pictureContext.moveTo(0, 80); pictureContext.lineTo(45, 22); pictureContext.lineTo(100, 80); pictureContext.fill();
      const extras: PdfItem[] = [
        { id: 'selection-image', type: 'image', x: 80, y: 250, width: 130, height: 100, dataUrl: pictureCanvas.toDataURL(), createdAt: 0 },
        { id: 'selection-text', type: 'text', x: 70, y: 430, width: 180, height: 90, content: 'Shift 加选\nCtrl 减选\n图片、文本、笔迹一起移动', fontSize: 16, color: '#215fbd', backgroundColor: '#e5f1ff', createdAt: 0, updatedAt: 0 },
      ];
      if (view === 'canvas') useCanvasStore.setState(s => ({ objects: [...s.objects, ...extras], selectedIds: [], renderEpoch: s.renderEpoch + 1 }));
      else usePdfStore.setState(s => ({ items: { ...s.items, 1: [...s.items[1], ...extras] }, selectedIds: [], renderEpoch: s.renderEpoch + 1 }));
      await frame(); await settle();
      const allItems = () => view === 'canvas' ? useCanvasStore.getState().objects : usePdfStore.getState().items[1];
      const object = (id: string) => document.querySelector<HTMLElement>(`[data-ink-object-id="${id}"]`)!;
      const click = async (target: Element, x: number, y: number, modifiers = {}) => { pen(target, 'pointerdown', { x, y }, modifiers); pen(target, 'pointerup', { x, y }, modifiers); await frame(); };
      const marquee = async (modifiers: { shiftKey?: boolean; ctrlKey?: boolean }) => {
        pen(canvas, 'pointerdown', { x: 40, y: 210 }, modifiers); pen(canvas, 'pointermove', { x: 230, y: 370 }, modifiers);
        await frame(); pen(canvas, 'pointerup', { x: 230, y: 370 }, modifiers); await frame();
      };
      await click(canvas, 500, 160); await settle();
      check(green(500, 160), view + ': selection click erased ink');
      await click(object('selection-image'), 100, 270, { shiftKey: true });
      await click(object('selection-text'), 100, 455, { shiftKey: true });
      check(store.getState().selectedIds.length === 3 && !store.getState().editingTextId, view + ': mixed Shift click failed');
      await click(object('selection-image'), 100, 270, { ctrlKey: true });
      check(!store.getState().selectedIds.includes('selection-image') && store.getState().selectedIds.length === 2, view + ': Ctrl subtract failed');
      await click(object('selection-image'), 100, 270, { shiftKey: true });
      await marquee({ ctrlKey: true });
      check(store.getState().selectedIds.length === 2 && !store.getState().selectedIds.includes('selection-image'), view + ': Ctrl marquee failed');
      await marquee({ shiftKey: true });
      check(store.getState().selectedIds.length === 3, view + ': Shift marquee failed');
      const baseline = allItems();
      pen(object('selection-image'), 'pointerdown', { x: 100, y: 270 });
      pen(object('selection-image'), 'pointermove', { x: 140, y: 300 }); await frame();
      check(allItems() === baseline && object('selection-text').style.translate === '40px 30px', view + ': mixed drag was not a transient preview');
      pen(object('selection-image'), 'pointerup', { x: 140, y: 300 }); await frame(); await settle();
      check(allItems().find(o => o.id === 'selection-image')?.type === 'image', 'Image missing after mixed drag');
      check(allItems().find(o => o.id === 'selection-text')?.type === 'text', 'Text missing after mixed drag');
      check(!green(500, 160) && green(500, 190) && green(800, 190) && green(744, 330), view + ': mixed drag left ghosts or changed unselected ink');
      store.getState().undo(); await frame(); await settle(); check(allItems() === baseline && green(500, 160), view + ': mixed undo failed');
      store.getState().redo(); await frame(); await settle(); check(green(500, 190), view + ': mixed redo failed');
      const mixedSaved = JSON.stringify(allItems());
      if (view === 'canvas') { await useCanvasStore.getState().saveCanvasData(); await useCanvasStore.getState().loadCanvasData('shape-smoke'); }
      else { await usePdfStore.getState().saveAnnotations(); await usePdfStore.getState().loadAnnotations('shape-smoke-pdf'); }
      await frame(); await settle(); check(JSON.stringify(allItems()) === mixedSaved, view + ': mixed selection positions did not survive reload');
      store.setState({ selectedIds: [line.id, 'selection-image', 'selection-text'] }); await frame();
      await frame();
      const dpr = window.devicePixelRatio;
      const outline = canvas.getContext('2d')!.getImageData(450 * dpr, 184 * dpr, 100 * dpr, 5 * dpr).data;
      let outlined = false;
      for (let i = 0; i < outline.length; i += 4) if (outline[i + 3] > 40 && outline[i] > 60 && outline[i] < 180 && outline[i + 1] > 50 && outline[i + 1] < 160 && outline[i + 2] > 160) { outlined = true; break; }
      check(outlined, view + ': selection-only update did not repaint the ink outline');
      await capture('selection-' + view);

      const frames = () => allItems().filter((item): item is CommentFrame => item.type === 'comment');
      const title = (id: string) => document.querySelector<HTMLElement>(`[data-ink-comment-title="${id}"]`)!;
      const fill = (id: string) => document.querySelector<HTMLElement>(`[data-ink-comment-fill="${id}"]`)!;
      const titleInput = () => document.querySelector<HTMLInputElement>('input[aria-label="注释标题"]');
      const find = (id: string) => allItems().find(item => item.id === id);
      const changeTitle = (value: string, action: 'Enter' | 'Escape') => {
        const editor = titleInput()!;
        check(editor === document.activeElement, view + ': title field did not receive focus');
        editor.value = value;
        key('c', { isComposing: true }, editor);
        key(action, {}, editor);
      };
      key('c', { ctrlKey: true });
      key('c', { isComposing: true });
      check(!frames().length, view + ': copy or IME created a frame');
      key('c');
      await waitFor(() => !!titleInput(), view + ': C did not open a title');
      const inner = frames()[0];
      const picture = object('selection-image').getBoundingClientRect();
      const labelBounds = object('selection-text').getBoundingClientRect();
      const box = fill(inner.id).getBoundingClientRect();
      check(box.left < picture.left && box.right > labelBounds.right && box.bottom > labelBounds.bottom
        && inner.y + COMMENT_HEADER_HEIGHT < 190, view + ': mixed selection was not enclosed');
      check(document.elementFromPoint(picture.left + 15, picture.top + 15)?.closest('[data-ink-object-id]') === object('selection-image'),
        view + ': comment body intercepted content');
      changeTitle('手写和资料', 'Enter');
      await frame();
      check(frames()[0].title === '手写和资料' && frames().length === 1, view + ': failed to commit title');
      key('c');
      await waitFor(() => !!titleInput(), view + ': could not wrap an existing comment');
      const outer = frames()[1];
      changeTitle('本章整理', 'Enter');
      await frame();

      Element.prototype.setPointerCapture = nativeSetPointerCapture;
      Element.prototype.releasePointerCapture = nativeReleasePointerCapture;
      const titleCenter = center(title(outer.id));
      await mouse(mouseEvent('mousePressed', titleCenter), mouseEvent('mouseReleased', titleCenter),
        mouseEvent('mousePressed', titleCenter, 2), mouseEvent('mouseReleased', titleCenter, 2));
      await waitFor(() => !!titleInput(), view + ': double-click did not rename');
      changeTitle('取消这次改名', 'Escape');
      await frame();
      check((find(outer.id) as CommentFrame).title === '本章整理', view + ': Escape saved a title draft');

      const asset: PdfItem = { type: 'asset', id: 'comment-test-asset', assetId: 'fixture', x: 840, y: 385, width: 90, height: 42, createdAt: 0 };
      if (view === 'canvas') useCanvasStore.setState(s => ({ objects: [...s.objects, asset] }));
      else usePdfStore.setState(s => ({ items: { ...s.items, 1: [...s.items[1], asset] } }));
      await frame();
      const dragHistory = () => view === 'canvas' ? useCanvasStore.getState().history.length : usePdfStore.getState().history[1].length;
      const beforeCommentMove = allItems();
      const previousHistory = dragHistory();
      const target = { x: titleCenter.x + 40, y: titleCenter.y + 24 };
      await mouse(mouseEvent('mousePressed', titleCenter), mouseEvent('mouseMoved', target));
      await waitFor(() => fill(inner.id).style.translate === '40px 24px', view + ': nested frame did not preview the drag');
      check(allItems() === beforeCommentMove && object('selection-text').style.translate === '40px 24px',
        view + ': comment drag wrote the store before drop');
      await mouse(mouseEvent('mouseReleased', target));
      await settle();
      check(dragHistory() === previousHistory + 1 && (find(inner.id) as CommentFrame).x === inner.x + 40
        && find(asset.id) === asset && green(540, 214) && !green(500, 190), view + ': comment move or membership incorrect');
      store.getState().undo(); await frame(); await settle();
      check(allItems() === beforeCommentMove && green(500, 190), view + ': comment move did not undo in one step');
      store.getState().redo(); await frame(); await settle();
      check((find(outer.id) as CommentFrame).x === outer.x + 40 && green(540, 214), view + ': comment move did not redo');

      // An object placed in the box after creation joins the next title drag.
      if (view === 'canvas') useCanvasStore.getState().commitSelectionMove([asset.id], -160, 0);
      else usePdfStore.getState().commitSelectionMove(1, [asset.id], -160, 0);
      await frame();
      const secondStart = center(title(outer.id));
      const secondEnd = { x: secondStart.x + 12, y: secondStart.y + 8 };
      await mouse(mouseEvent('mousePressed', secondStart), mouseEvent('mouseMoved', secondEnd), mouseEvent('mouseReleased', secondEnd));
      check((find(asset.id) as typeof asset).x === 692, view + ': newly enclosed file card did not move');

      const rootElement = document.getElementById('root')!;
      rootElement.style.transformOrigin = '0 0';
      rootElement.style.transform = 'scale(1.25)';
      useNoteStore.setState({ uiScale: 1.25 });
      store.setState({ camera: { x: 30, y: 20, zoom: 0.8 }, selectedIds: [outer.id] });
      await frame(); await frame();
      const current = find(outer.id) as CommentFrame;
      const edge = object(outer.id).querySelector('[data-ink-comment-resize="e"]')!;
      const edgeStart = center(edge);
      check(document.elementFromPoint(edgeStart.x, edgeStart.y) === edge, view + ': scaled resize handle missed');
      const edgeEnd = { x: edgeStart.x + 32, y: edgeStart.y };
      const oldImage = find('selection-image');
      const originalWidth = fill(outer.id).getBoundingClientRect().width;
      await mouse(mouseEvent('mousePressed', edgeStart), mouseEvent('mouseMoved', edgeEnd));
      await waitFor(() => fill(outer.id).getBoundingClientRect().width > originalWidth + 30, view + ': scaled resize did not display a preview', 3000);
      check(find(outer.id) === current, view + ': resize committed before the pointer was lifted');
      await mouse(mouseEvent('mouseReleased', edgeEnd));
      check(Math.abs((find(outer.id) as CommentFrame).width - current.width - 40) < 0.01 && find('selection-image') === oldImage,
        view + ': scaled resize changed content or used incorrect world units');
      await capture('comment-' + view);

      const savedComments = JSON.stringify(allItems());
      if (view === 'canvas') {
        check(await useCanvasStore.getState().saveCanvasData(), 'Comment canvas save failed');
        useCanvasStore.setState(s => ({ objects: [], renderEpoch: s.renderEpoch + 1 })); await frame();
        await useCanvasStore.getState().loadCanvasData('shape-smoke');
      } else {
        check((await usePdfStore.getState().saveAnnotations()).ok, 'Comment PDF save failed');
        usePdfStore.getState().setCurrentPage(2);
        await waitFor(() => !document.querySelector('[data-ink-comment-fill]'), 'Comment leaked to a different PDF page');
        usePdfStore.setState(s => ({ items: {}, renderEpoch: s.renderEpoch + 1 }));
        await usePdfStore.getState().loadAnnotations('shape-smoke-pdf');
        usePdfStore.getState().setCurrentPage(1);
      }
      await frame();
      check(JSON.stringify(allItems()) === savedComments && !!title(outer.id), view + ': saved comment did not reload');
      store.setState({ activeTool: 'select', selectedIds: [outer.id] });
      await frame();
      if (view === 'canvas') key('Delete'); else usePdfStore.getState().deleteSelected();
      await frame();
      check(!find(outer.id) && !!find(inner.id) && !!find('selection-image') && !!find(asset.id), view + ': deleting a frame removed members');
      store.getState().undo(); await frame();
      check(!!find(outer.id), view + ': deletion did not undo');
      useSyntheticPen();
      rootElement.style.transform = '';
      useNoteStore.setState({ uiScale: 1 });

      results[view] = { kinds, numericEdit: true, undoRedo: true, outlineDrag: true, controlPointDrag: true, crossTilePixels: true, saveReload: true,
        mixedSelection: { click: true, shiftAdd: true, ctrlSubtract: true, modifiedMarquee: true, transientDrag: true, undoRedo: true, saveReload: true, inkOutline: true },
        comments: { mixedSelection: true, rename: true, nestedDrag: true, dynamicMembers: true, resizeAtUiScale: true, saveReload: true, delete: true, dpr },
        radiusAfterReload: edited.geometry?.kind === 'circle' ? edited.geometry.radius : null,
        bounds: shapeBounds(edited.geometry!), backend: readInkFrame().backend };
      root.unmount(); await frame();
    }
    (window as any).benchmarkResult = { ok: true, results };
  } catch (error) { (window as any).benchmarkResult = { error: String(error), stack: (error as Error).stack, results }; }
})();
