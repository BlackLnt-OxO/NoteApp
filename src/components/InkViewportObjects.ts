import type { PdfStroke } from './PdfAnnotation/PdfTypes';
const strokeLists = new WeakMap<object, PdfStroke[]>();
/** Immutable store arrays let both editors share one filtered list across frames. */
export function inkStrokesOnly<T extends { type: string }>(objects: T[]): PdfStroke[] {
  let list = strokeLists.get(objects);
  if (!list) { list = objects.filter(object => object.type === 'stroke') as unknown as PdfStroke[]; strokeLists.set(objects, list); }
  return list;
}
export function inkObjectVisible(object: { id: string; x: number; y: number; width: number; height: number },
  camera: { x: number; y: number; zoom: number }, width: number, height: number, pinned: readonly string[]): boolean {
  if (pinned.includes(object.id)) return true;
  const x = object.x * camera.zoom + camera.x, y = object.y * camera.zoom + camera.y;
  const margin = 128;
  return x + object.width * camera.zoom >= -margin && y + object.height * camera.zoom >= -margin
    && x <= width + margin && y <= height + margin;
}
