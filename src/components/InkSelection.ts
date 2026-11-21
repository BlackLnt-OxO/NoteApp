import type React from 'react';
import type { PdfCamera, PdfItem } from './PdfAnnotation/PdfTypes';
import { boundsIntersectRect, hitTestStroke } from './PdfAnnotation/PdfEngine';
import { getCommittedStrokeBounds } from './PdfAnnotation/InkStrokeIndex';
import { replaceStrokePoints } from './InkShapeGeometry';
import { setPointerHold } from './inkInputActivity';

export type SelectionOperation = 'replace' | 'add' | 'subtract';
export function selectionOperation(event: { shiftKey: boolean; ctrlKey: boolean }): SelectionOperation {
  return event.ctrlKey ? 'subtract' : event.shiftKey ? 'add' : 'replace';
}
export function combineSelection(current: readonly string[], hits: readonly string[], operation: SelectionOperation): string[] {
  if (operation === 'replace') return [...new Set(hits)];
  const hitSet = new Set(hits);
  return operation === 'subtract' ? current.filter(id => !hitSet.has(id)) : [...new Set([...current, ...hits])];
}
export function moveSelectedItem<T extends PdfItem>(item: T, dx: number, dy: number): T {
  if (item.type === 'stroke') return replaceStrokePoints(item, item.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }))) as T;
  return { ...item, x: item.x + dx, y: item.y + dy, ...(item.type === 'text' ? { updatedAt: Date.now() } : {}) };
}
export function hitSelectable(items: readonly PdfItem[], x: number, y: number, preferredId?: string): PdfItem | undefined {
  if (preferredId) return items.find(item => item.id === preferredId);
  // DOM cards cover ink; match their visible stacking order when the event was
  // dispatched straight to the canvas (including pen/testing fallbacks).
  for (const type of ['text', 'image', 'stroke'] as const) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type !== type) continue;
      const b = item.type === 'stroke' ? getCommittedStrokeBounds(item)
        : { minX: item.x, minY: item.y, maxX: item.x + item.width, maxY: item.y + item.height };
      const pad = item.type === 'stroke' ? 6 : 0;
      if (x < b.minX - pad || x > b.maxX + pad || y < b.minY - pad || y > b.maxY + pad) continue;
      if (item.type !== 'stroke' || hitTestStroke(item, x, y)) return item;
    }
  }
}
function objectElements(container: HTMLElement | null): Map<string, HTMLElement> {
  return new Map([...container?.querySelectorAll<HTMLElement>('[data-ink-object-id]') ?? []]
    .map(element => [element.dataset.inkObjectId!, element]));
}
export function boxSelectableIds(items: readonly PdfItem[], rect: { x1: number; y1: number; x2: number; y2: number }, container: HTMLElement | null, camera: PdfCamera): string[] {
  const elements = objectElements(container), origin = container?.getBoundingClientRect();
  return items.filter(item => {
    if (item.type === 'stroke') return boundsIntersectRect(getCommittedStrokeBounds(item), rect.x1, rect.y1, rect.x2, rect.y2);
    const r = elements.get(item.id)?.getBoundingClientRect();
    const b = r?.width && r.height && origin ? {
      minX: (r.left - origin.left - camera.x) / camera.zoom, minY: (r.top - origin.top - camera.y) / camera.zoom,
      maxX: (r.right - origin.left - camera.x) / camera.zoom, maxY: (r.bottom - origin.top - camera.y) / camera.zoom,
    } : { minX: item.x, minY: item.y, maxX: item.x + item.width, maxY: item.y + item.height };
    return boundsIntersectRect(b, rect.x1, rect.y1, rect.x2, rect.y2);
  }).map(item => item.id);
}

export interface ObjectDragPreview { ids: Set<string>; elements: Map<string, { element: HTMLElement; translate: string }> }
export function createObjectDragPreview(items: readonly PdfItem[], ids: readonly string[], container: HTMLElement | null): ObjectDragPreview {
  const selected = new Set(ids), preview: ObjectDragPreview = { ids: new Set(items.filter(item => item.type !== 'stroke' && selected.has(item.id)).map(item => item.id)), elements: new Map() };
  refreshObjectDragElements(preview, container);
  return preview;
}
function refreshObjectDragElements(preview: ObjectDragPreview, container: HTMLElement | null) {
  if (preview.elements.size >= preview.ids.size) return;
  for (const [id, element] of objectElements(container)) if (preview.ids.has(id) && !preview.elements.has(id)) preview.elements.set(id, { element, translate: element.style.translate });
}
export function drawObjectDragPreview(preview: ObjectDragPreview, container: HTMLElement | null, dx: number, dy: number, zoom: number, uiScale: number) {
  refreshObjectDragElements(preview, container);
  const translate = `${dx * zoom / uiScale}px ${dy * zoom / uiScale}px`;
  for (const { element } of preview.elements.values()) element.style.translate = translate;
}
export function clearObjectDragPreview(preview: ObjectDragPreview | undefined) {
  if (preview) for (const { element, translate } of preview.elements.values()) element.style.translate = translate;
}

export interface SelectionCapture { target: Element; pointerId: number; external: boolean }
type CaptureRef = React.MutableRefObject<SelectionCapture | null>;
export function beginSelectionCapture(ref: CaptureRef, target: Element, pointerId: number, canvas: HTMLCanvasElement) {
  const external = target !== canvas;
  ref.current = { target, pointerId, external };
  if (external) setPointerHold(true);
  target.setPointerCapture?.(pointerId);
}
export function endSelectionCapture(ref: CaptureRef): Element | null {
  const capture = ref.current; ref.current = null;
  if (capture?.external) setPointerHold(false);
  return capture?.target ?? null;
}
export function cancelSelectionCapture(ref: CaptureRef, owner: React.MutableRefObject<number | null>) {
  const capture = ref.current;
  if (!capture) return;
  endSelectionCapture(ref);
  if (owner.current === capture.pointerId) owner.current = null;
  try { capture.target.releasePointerCapture?.(capture.pointerId); } catch { /* capture already lost */ }
}
type InkPointer = React.PointerEvent<HTMLCanvasElement>;
/** Route object-body events before their independent drag/edit handlers. Keep
 * capture on the DOM object so double-click and context-menu routes survive. */
export function inkSelectionCaptureHandlers(options: {
  enabled: () => boolean; canvas: React.RefObject<HTMLCanvasElement>; capture: CaptureRef;
  owner: React.MutableRefObject<number | null>; shapeId: React.MutableRefObject<string | null>;
  down: (event: InkPointer, preferredId?: string, target?: Element) => void;
  move: (event: InkPointer) => void; up: (event: InkPointer) => void;
}) {
  const forward = (event: React.PointerEvent<HTMLElement>, callback: (event: InkPointer) => void) => {
    if (!options.capture.current || options.owner.current !== event.pointerId || event.target === options.canvas.current) return;
    event.stopPropagation(); callback(event as unknown as InkPointer);
  };
  return {
    onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !options.enabled()) return;
      const target = event.target as Element;
      if (target.closest('button,input,textarea,[contenteditable="true"],[data-lightbox],[data-ink-shape-panel]')) return;
      if (target.closest('[data-ink-object-control]') && !event.shiftKey && !event.ctrlKey) return;
      const object = target.closest('[data-ink-object-id]');
      const shape = (event.shiftKey || event.ctrlKey) && target.closest('[data-ink-shape-editor] svg');
      const id = object?.getAttribute('data-ink-object-id') ?? (shape ? options.shapeId.current : null);
      if (!id) return;
      event.stopPropagation(); options.down(event as unknown as InkPointer, id, object ?? options.canvas.current!);
    },
    onPointerMoveCapture: (event: React.PointerEvent<HTMLElement>) => forward(event, options.move),
    onPointerUpCapture: (event: React.PointerEvent<HTMLElement>) => forward(event, options.up),
    onPointerCancelCapture: (event: React.PointerEvent<HTMLElement>) => forward(event, options.up),
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => {
      if (options.capture.current?.target === event.target) forward(event, options.up);
    },
  };
}
