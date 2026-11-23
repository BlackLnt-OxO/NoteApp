export type InkToolbarEdge = 'top' | 'right' | 'bottom' | 'left';
export interface InkToolbarPosition {
  edge: InkToolbarEdge;
  offset: number;
}

export const DEFAULT_INK_TOOLBAR_POSITION: InkToolbarPosition = { edge: 'bottom', offset: .5 };

const edges: readonly InkToolbarEdge[] = ['top', 'right', 'bottom', 'left'];
const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function normalizeInkToolbarPosition(value: unknown, legacy?: unknown): InkToolbarPosition {
  const saved = value as Partial<InkToolbarPosition> | null | undefined;
  if (saved?.edge && edges.includes(saved.edge) && typeof saved.offset === 'number' && Number.isFinite(saved.offset)) {
    return { edge: saved.edge, offset: clamp(saved.offset) };
  }
  return legacy === 'top' ? { edge: 'top', offset: .5 } : DEFAULT_INK_TOOLBAR_POSITION;
}

export function nearestInkToolbarPosition(
  rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
  x: number, y: number, current: InkToolbarEdge, allowLeftDock = true,
): InkToolbarPosition {
  const distances = [Math.abs(y - rect.top), Math.abs(x - rect.right),
    Math.abs(y - rect.bottom), allowLeftDock ? Math.abs(x - rect.left) : Infinity];
  const closest = Math.min(...distances);
  const edge = distances[edges.indexOf(current)] === closest ? current : edges[distances.indexOf(closest)];
  const offset = edge === 'top' || edge === 'bottom'
    ? (x - rect.left) / Math.max(1, rect.width) : (y - rect.top) / Math.max(1, rect.height);
  return { edge, offset: clamp(offset) };
}
