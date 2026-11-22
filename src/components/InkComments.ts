import { v4 as uuid } from 'uuid';
import { readInkItemBounds } from './InkSelection';
import type { Bounds } from './PdfAnnotation/PdfEngine';
import type { PdfCamera, PdfItem } from './PdfAnnotation/PdfTypes';

export interface CommentFrame {
  type: 'comment';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  createdAt: number;
}

export const COMMENT_TITLE = '注释';
export const COMMENT_HEADER_HEIGHT = 28;
const PADDING = 16;
const MIN_WIDTH = 112;
const MIN_HEIGHT = COMMENT_HEADER_HEIGHT + 32;

export const COMMENT_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type CommentEdge = typeof COMMENT_EDGES[number];

export interface CommentSelection {
  items: readonly PdfItem[];
  selectedIds: readonly string[];
  camera: PdfCamera;
}

export function commentFromSelection(selection: CommentSelection, container: HTMLElement | null): CommentFrame | undefined {
  const { items, selectedIds, camera } = selection;
  if (selectedIds.length === 0) return;
  const selected = new Set(selectedIds);
  const readBounds = readInkItemBounds(container, camera);
  const total: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const item of items) {
    if (!selected.has(item.id)) continue;
    const bounds = readBounds(item);
    if (!validBounds(bounds)) continue;
    total.minX = Math.min(total.minX, bounds.minX);
    total.minY = Math.min(total.minY, bounds.minY);
    total.maxX = Math.max(total.maxX, bounds.maxX);
    total.maxY = Math.max(total.maxY, bounds.maxY);
  }
  if (!validBounds(total)) return;

  const width = Math.max(MIN_WIDTH, total.maxX - total.minX + 2 * PADDING);
  const height = Math.max(MIN_HEIGHT, total.maxY - total.minY + 2 * PADDING + COMMENT_HEADER_HEIGHT);
  return {
    type: 'comment', id: uuid(), title: COMMENT_TITLE, createdAt: Date.now(),
    x: (total.minX + total.maxX - width) / 2,
    y: total.minY - PADDING - COMMENT_HEADER_HEIGHT,
    width, height,
  };
}

function validBounds(bounds: Bounds): boolean {
  const { minX, minY, maxX, maxY } = bounds;
  return [minX, minY, maxX, maxY].every(Number.isFinite) && minX <= maxX && minY <= maxY;
}

/** Collect members from the boxes' bodies at pointer-down. A fully enclosed
 * nested frame's body is already inside the outer body. */
export function commentDragIds(selection: CommentSelection, container: HTMLElement | null): string[] {
  const { items, selectedIds, camera } = selection;
  const ids = new Set(selectedIds);
  const frames = items.filter((item): item is CommentFrame => item.type === 'comment' && ids.has(item.id));
  if (!frames.length) return [...ids];
  const readBounds = readInkItemBounds(container, camera);
  for (const item of items) {
    if (ids.has(item.id)) continue;
    const bounds = readBounds(item);
    if (!validBounds(bounds)) continue;
    if (frames.some(frame => bounds.minX >= frame.x
      && bounds.minY >= frame.y + COMMENT_HEADER_HEIGHT
      && bounds.maxX <= frame.x + frame.width
      && bounds.maxY <= frame.y + frame.height)) ids.add(item.id);
  }
  return [...ids];
}

export interface PendingCommentDrag {
  ids: string[];
  start: { x: number; y: number };
}

export function activateCommentDrag(
  pending: { current: PendingCommentDrag | null }, at: PendingCommentDrag['start'], zoom: number,
  start: (ids: string[], origin: PendingCommentDrag['start'], comment: boolean) => void,
): void {
  const drag = pending.current;
  if (!drag || Math.hypot(at.x - drag.start.x, at.y - drag.start.y) * zoom < 3) return;
  pending.current = null;
  start(drag.ids, drag.start, true);
}

export function resizeComment(frame: CommentFrame, edge: CommentEdge, dx: number, dy: number): CommentFrame {
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  let { x, y, width, height } = frame;
  if (edge.includes('w')) {
    x = Math.min(x + dx, right - MIN_WIDTH);
    width = right - x;
  }
  if (edge.includes('n')) {
    y = Math.min(y + dy, bottom - MIN_HEIGHT);
    height = bottom - y;
  }
  if (edge.includes('e')) width = Math.max(MIN_WIDTH, width + dx);
  if (edge.includes('s')) height = Math.max(MIN_HEIGHT, height + dy);
  return { ...frame, x, y, width, height };
}

export function commentChanged(previous: CommentFrame, next: CommentFrame): boolean {
  return previous.title !== next.title || previous.x !== next.x || previous.y !== next.y
    || previous.width !== next.width || previous.height !== next.height;
}
