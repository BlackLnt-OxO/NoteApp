import { getStrokeBounds, boundsIntersectRect, hitTestStrokeBySegment, strokeEraserRadius, type Bounds } from './PdfEngine';
import type { PdfStroke } from './PdfTypes';

const committedBounds = new WeakMap<PdfStroke, Bounds>();
export function getCommittedStrokeBounds(stroke: PdfStroke): Bounds {
  let bounds = committedBounds.get(stroke);
  if (!bounds) { bounds = getStrokeBounds(stroke); committedBounds.set(stroke, bounds); }
  return bounds;
}
const HIT_CELL = 64;
const TILE = 512;
function keys(b: Bounds, size: number): string[] {
  const result: string[] = [];
  for (let y = Math.floor(b.minY / size); y <= Math.floor(b.maxY / size); y++) {
    for (let x = Math.floor(b.minX / size); x <= Math.floor(b.maxX / size); x++) result.push(`${x}:${y}`);
  }
  return result;
}
interface SegmentBlock { bounds: Bounds; start: number; end: number }

/** Incremental scene index: populated when ink is stamped/committed, not when
 * the eraser first touches the canvas. Tile buckets preserve document order;
 * the finer 64-unit grid and segment blocks are only for hit testing. */
export class InkStrokeIndex {
  readonly grid = new Map<string, PdfStroke[]>();
  readonly bounds = new Map<string, Bounds>();
  private hitGrid = new Map<string, PdfStroke[]>();
  private strokes = new Map<string, PdfStroke>();
  private order = new Map<string, number>();
  private serial = 0;
  private blocks = new Map<string, SegmentBlock[]>();

  add(stroke: PdfStroke): void {
    if (this.strokes.has(stroke.id)) return;
    const b = getCommittedStrokeBounds(stroke);
    this.bounds.set(stroke.id, b);
    this.strokes.set(stroke.id, stroke);
    this.order.set(stroke.id, this.serial++);
    for (const [grid, size] of [[this.grid, TILE], [this.hitGrid, HIT_CELL]] as const) {
      for (const key of keys(b, size)) {
        let list = grid.get(key);
        if (!list) { list = []; grid.set(key, list); }
        list.push(stroke);
      }
    }
    const blocks: SegmentBlock[] = [];
    const pts = stroke.points;
    for (let start = 0; start < pts.length; start += 32) {
      const end = Math.min(pts.length - 1, start + 32);
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = start; i <= end; i++) {
        box.minX = Math.min(box.minX, pts[i].x); box.maxX = Math.max(box.maxX, pts[i].x);
        box.minY = Math.min(box.minY, pts[i].y); box.maxY = Math.max(box.maxY, pts[i].y);
      }
      blocks.push({ bounds: box, start, end });
    }
    this.blocks.set(stroke.id, blocks);
  }

  collect(x1: number, y1: number, x2: number, y2: number): PdfStroke[] {
    const found = new Set<PdfStroke>();
    const b = { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
    for (const key of keys(b, HIT_CELL)) for (const s of this.hitGrid.get(key) ?? []) found.add(s);
    return [...found];
  }

  topmost(x: number, y: number): PdfStroke[] {
    return this.collect(x - 10, y - 10, x + 10, y + 10)
      .sort((a, b) => this.order.get(b.id)! - this.order.get(a.id)!);
  }

  /** `eraserDiameter` follows the toolbar's eraser size; the block prefilter and
   *  the exact test must use the same radius as the drawn cursor ring. */
  hit(stroke: PdfStroke, x1: number, y1: number, x2: number, y2: number, eraserDiameter?: number): boolean {
    const radius = strokeEraserRadius(stroke.size, eraserDiameter);
    for (const block of this.blocks.get(stroke.id) ?? []) {
      if (!boundsIntersectRect(block.bounds, Math.min(x1, x2) - radius, Math.min(y1, y2) - radius,
        Math.max(x1, x2) + radius, Math.max(y1, y2) + radius)) continue;
      if (hitTestStrokeBySegment(stroke, x1, y1, x2, y2, this.bounds.get(stroke.id), block.start, block.end, eraserDiameter)) return true;
    }
    return false;
  }

  remove(ids: Set<string>): void {
    const tileKeys = new Set<string>(), hitKeys = new Set<string>();
    for (const id of ids) {
      const b = this.bounds.get(id);
      if (b) { keys(b, TILE).forEach(k => tileKeys.add(k)); keys(b, HIT_CELL).forEach(k => hitKeys.add(k)); }
      this.strokes.delete(id); this.bounds.delete(id); this.order.delete(id); this.blocks.delete(id);
    }
    for (const [grid, touched] of [[this.grid, tileKeys], [this.hitGrid, hitKeys]] as const) {
      for (const key of touched) {
        const next = (grid.get(key) ?? []).filter(s => !ids.has(s.id));
        if (next.length) grid.set(key, next); else grid.delete(key);
      }
    }
  }
}

const scenes = new WeakMap<Map<string, HTMLCanvasElement>, InkStrokeIndex>();
export function getInkStrokeIndex(tiles: Map<string, HTMLCanvasElement>): InkStrokeIndex {
  let index = scenes.get(tiles);
  if (!index) { index = new InkStrokeIndex(); scenes.set(tiles, index); }
  return index;
}
