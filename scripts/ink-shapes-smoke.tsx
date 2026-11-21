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
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 720] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
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

// Synthetic input deliberately bypasses native pointer capture; actual pointer
// ownership/cancellation is covered by the integration suite.
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
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
        const control = [...document.querySelectorAll('[data-ink-shape-editor] svg title')].find(el => el.textContent === '调整半径')!.parentElement!;
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
      const outline = canvas.getContext('2d')!.getImageData(450, 184, 100, 5).data;
      let outlined = false;
      for (let i = 0; i < outline.length; i += 4) if (outline[i + 3] > 40 && outline[i] > 60 && outline[i] < 180 && outline[i + 1] > 50 && outline[i + 1] < 160 && outline[i + 2] > 160) { outlined = true; break; }
      check(outlined, view + ': selection-only update did not repaint the ink outline');
      await capture('selection-' + view);
      results[view] = { kinds, numericEdit: true, undoRedo: true, outlineDrag: true, controlPointDrag: true, crossTilePixels: true, saveReload: true,
        mixedSelection: { click: true, shiftAdd: true, ctrlSubtract: true, modifiedMarquee: true, transientDrag: true, undoRedo: true, saveReload: true, inkOutline: true },
        radiusAfterReload: edited.geometry?.kind === 'circle' ? edited.geometry.radius : null,
        bounds: shapeBounds(edited.geometry!), backend: readInkFrame().backend };
      root.unmount(); await frame();
    }
    (window as any).benchmarkResult = { ok: true, results };
  } catch (error) { (window as any).benchmarkResult = { error: String(error), stack: (error as Error).stack, results }; }
})();
