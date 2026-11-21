import type { PdfStroke } from './PdfAnnotation/PdfTypes';
import { getStrokeBounds, type Bounds } from './PdfAnnotation/PdfEngine';
import { getInkStrokeIndex } from './PdfAnnotation/InkStrokeIndex';
import { readInkFrame, readFrameWindows } from './InkFrameStats';

export const INK_TRACE_LIMIT = 512;
export const INK_TRACE_DETAIL_LIMIT = 128;
const DETAIL_LIMIT = INK_TRACE_DETAIL_LIMIT;
type Value = string | number | boolean | null | undefined | Value[] | { [key: string]: Value };
export type InkTraceDetails = { [key: string]: Value };
interface InkTraceEvent { sequence: number; at: number; source: number; type: string; data: InkTraceDetails }
const events: InkTraceEvent[] = [];
const sources = new Map<object, () => InkTraceDetails>();
const identities = new WeakMap<object, number>();
let identity = 0, sequence = 0;

export function inkTraceId(object: object): number {
  if (!import.meta.env.DEV) return 0;
  let id = identities.get(object);
  if (!id) { id = ++identity; identities.set(object, id); }
  return id;
}

export function recordInkTrace(source: object, type: string, data: InkTraceDetails): void {
  if (!import.meta.env.DEV) return;
  events.push({ sequence: ++sequence, at: performance.now(), source: inkTraceId(source), type, data });
  if (events.length > INK_TRACE_LIMIT) events.shift();
}

export function registerInkTrace(source: object, snapshot: () => InkTraceDetails): void {
  if (import.meta.env.DEV) sources.set(source, snapshot);
}
export function unregisterInkTrace(source: object): void { sources.delete(source); }

/** Bound individual event payloads too; a huge selection must not grow the trace indefinitely. */
export function inkTraceList<T, R extends Value>(items: Iterable<T>, summarize: (item: T) => R): { count: number; items: R[] } {
  const result: R[] = [];
  let count = 0;
  for (const item of items) { if (count < DETAIL_LIMIT) result.push(summarize(item)); count++; }
  return { count, items: result };
}

function boundsKeys(bounds: Bounds | undefined): { count: number; items: string[] } {
  if (!bounds || ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return { count: 0, items: [] };
  const x0 = Math.floor(bounds.minX / 512), x1 = Math.floor(bounds.maxX / 512);
  const y0 = Math.floor(bounds.minY / 512), y1 = Math.floor(bounds.maxY / 512);
  const items: string[] = [], count = (x1 - x0 + 1) * (y1 - y0 + 1);
  for (let y = y0; y <= y1 && items.length < DETAIL_LIMIT; y++) {
    for (let x = x0; x <= x1 && items.length < DETAIL_LIMIT; x++) items.push(x + ':' + y);
  }
  return { count, items };
}

export function inkStrokeCoverage(tiles: Map<string, HTMLCanvasElement>, stroke: PdfStroke): InkTraceDetails {
  const index = getInkStrokeIndex(tiles);
  // Recompute without populating the committed-bounds cache: observing must not repair it.
  const fresh = stroke.points.length ? getStrokeBounds(stroke) : undefined;
  const indexed = index.bounds.get(stroke.id), expected = boundsKeys(fresh), cached = boundsKeys(indexed);
  const candidates = new Set([...expected.items, ...cached.items]);
  const indexedKeys = [...candidates].filter(key => index.grid.get(key)?.some(item => item.id === stroke.id));
  return { id: stroke.id, pointCount: stroke.points.length,
    freshBounds: fresh ? { ...fresh } : null, indexedBounds: indexed ? { ...indexed } : null,
    expectedKeys: expected.items, expectedKeyCount: expected.count, indexedKeys,
    missingKeys: expected.items.filter(key => !indexedKeys.includes(key)),
    extraKeys: indexedKeys.filter(key => !expected.items.includes(key)),
    truncated: expected.count > DETAIL_LIMIT || cached.count > DETAIL_LIMIT };
}

export function traceInkStrokes(type: string, tiles: Map<string, HTMLCanvasElement>, strokes: PdfStroke[], details: InkTraceDetails = {}): void {
  if (!import.meta.env.DEV) return;
  recordInkTrace(tiles, type, { ...details, layer: inkTraceId(tiles), strokeCount: strokes.length,
    strokes: strokes.slice(0, 32).map(stroke => inkStrokeCoverage(tiles, stroke)), truncated: strokes.length > 32 });
}

/** Metadata only. No vectors, text, file names, image data, or canvas readbacks. */
export function readInkDiagnostics() {
  if (!import.meta.env.DEV) return null;
  return JSON.parse(JSON.stringify({
    version: 1, capturedAt: new Date().toISOString(), timeOrigin: performance.timeOrigin, capacity: INK_TRACE_LIMIT,
    stats: readInkFrame(), frames: readFrameWindows(), events,
    sources: [...sources].map(([source, snapshot]) => ({ source: inkTraceId(source), state: snapshot() })),
  }));
}

export function downloadInkDiagnostics(): void {
  const report = readInkDiagnostics();
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'ink-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
