import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { drawInkShape, shapeBounds, shapePathPoints, rotateShape, translateShape, withShape, replaceStrokePoints, type InkShapeGeometry, type ShapePoint } from '../../InkShapeGeometry';
import { recognizeInkShape } from '../../InkShapeRecognition';
import { dragShapeHandle, setShapeDimension, shapeDimensions } from '../../InkShapeEditing';
import { InkShapeHold } from '../../useInkShapeGesture';
import { drawAnnotatedStroke } from '../../PdfAnnotation/PdfBrushRenderers';
import { getStrokeRaster, clearInkRasterCache, drawStrokeRaster } from '../../PdfAnnotation/InkRasterCache';
import type { Stroke } from '../types';

function raw(points: ShapePoint[]): Stroke {
  return { id: 'shape', type: 'stroke', points: points.map((p, i) => ({ ...p, pressure: i % 2 ? 0.2 : 0.9, t: i * 12 })), color: '#1267cb',
    size: 8, opacity: 0.5, renderVersion: 2, style: 'fountain', smoothing: 0.2, compositeOperation: 'source-over', createdAt: 0 };
}
const shapes: InkShapeGeometry[] = [
  { kind: 'line', a: { x: 30, y: 40 }, b: { x: 230, y: 90 } },
  { kind: 'circle', center: { x: 160, y: 170 }, radius: 90 },
  { kind: 'ellipse', center: { x: 180, y: 180 }, rx: 130, ry: 55, rotation: 0.6 },
  { kind: 'rectangle', center: { x: 180, y: 180 }, width: 200, height: 100, rotation: 0.4 },
  { kind: 'triangle', vertices: [{ x: 180, y: 60 }, { x: 290, y: 270 }, { x: 55, y: 260 }] },
];
function samples(g: InkShapeGeometry) {
  const path = shapePathPoints(g), out: ShapePoint[] = [];
  for (let i = 1; i < path.length; i++) for (let j = 0; j < 16; j++) {
    const t = j / 16;
    out.push({ x: path[i - 1].x * (1 - t) + path[i].x * t, y: path[i - 1].y * (1 - t) + path[i].y * t });
  }
  return [...out, path[path.length - 1]];
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); clearInkRasterCache(); });

describe('local shape recognition', () => {
  it.each(shapes)('recognizes $kind with uneven samples and small jitter', geometry => {
    const points = samples(geometry).flatMap((p, i) => Array.from({ length: i % 7 === 0 ? 4 : 1 }, () => ({ x: p.x + Math.sin(i * 1.7) * 0.65, y: p.y + Math.cos(i * 1.9) * 0.65 })));
    expect(recognizeInkShape(points)?.kind).toBe(geometry.kind);
  });
  it.each(shapes.filter(g => g.kind !== 'circle'))('preserves a rotated $kind', geometry => {
    const g = translateShape(rotateShape(geometry, 0.8), 320, 150);
    const result = recognizeInkShape(samples(g));
    expect(result?.kind).toBe(g.kind);
    expect(shapeBounds(result!).minX).toBeCloseTo(shapeBounds(g).minX, -1);
  });
  it('recognizes circles drawn at a lower zoom', () => {
    expect(recognizeInkShape(samples(shapes[1]).map(p => ({ x: p.x * 10, y: p.y * 10 })), 0.1)?.kind).toBe('circle');
  });
  it('does not convert dots, tiny shapes, open arcs or repeated scribbles', () => {
    expect(recognizeInkShape([{ x: 1, y: 1 }])).toBeNull();
    expect(recognizeInkShape([{ x: 1, y: 1 }, { x: 3, y: 1 }])).toBeNull();
    const circle = samples(shapes[1]);
    expect(recognizeInkShape(circle.slice(0, Math.floor(circle.length * 0.7)))).toBeNull();
    expect(recognizeInkShape([...circle, ...circle])).toBeNull();
    expect(recognizeInkShape(Array.from({ length: 100 }, (_, i) => ({ x: 100 + i * 2, y: 100 + (i % 2) * 70 })))).toBeNull();
  });
  it('does not mistake a rectangle started halfway along an edge for an ellipse', () => {
    const pts = samples(shapes[3]);
    const cut = 8;
    const shifted = [...pts.slice(cut, -1), ...pts.slice(0, cut + 1)];
    expect(recognizeInkShape(shifted)?.kind).toBe('rectangle');
  });
  it('fits a rounded triangle with a short gap at the seam', () => {
    const points = [[100, 96], [112, 102], [125, 124], [156, 175], [204, 247], [227, 286], [222, 292],
      [182, 295], [129, 294], [74, 283], [16, 278], [8, 271], [26, 228], [47, 191], [70, 140], [86, 113], [91, 105]];
    expect(recognizeInkShape(points.map(([x, y]) => ({ x, y })))?.kind).toBe('triangle');
  });
  it('fits a rough rectangle started mid-side even when its edges bow', () => {
    const points = [[100, 100], [160, 90], [210, 88], [266, 99], [278, 111], [283, 155], [278, 206], [267, 226],
      [218, 239], [158, 236], [111, 232], [90, 218], [82, 170], [88, 132], [97, 109]];
    expect(recognizeInkShape(points.map(([x, y]) => ({ x, y })))?.kind).toBe('rectangle');
  });
  it('keeps a narrow three-sided outline open even with nearby endpoints', () => {
    const points = [{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 25, y: 200 }, { x: 25, y: 0 }];
    expect(recognizeInkShape(points)).toBeNull();
  });
});

describe('geometry editing', () => {
  it('keeps exact geometry and index points together during translation', () => {
    const stroke = withShape(raw([]), shapes[1]);
    const moved = replaceStrokePoints(stroke, stroke.points.map(p => ({ ...p, x: p.x + 600, y: p.y - 20 })));
    expect(moved.geometry).toEqual(translateShape(shapes[1], 600, -20));
    const expected = shapePathPoints(moved.geometry!);
    expect(expected).toHaveLength(moved.points.length);
    moved.points.forEach((p, i) => { expect(p.x).toBeCloseTo(expected[i].x, 8); expect(p.y).toBeCloseTo(expected[i].y, 8); });
    expect(stroke.geometry).toEqual(shapes[1]);
    expect(replaceStrokePoints(stroke, stroke.points.slice(1)).geometry).toBeUndefined();
  });
  it('changes line length without changing its width or anchor', () => {
    const stroke = withShape(raw([]), shapes[0]);
    const next = withShape(stroke, setShapeDimension(stroke.geometry!, 'length', 80)!);
    expect(next.size).toBe(8);
    expect(next.geometry?.kind === 'line' && next.geometry.a).toEqual(shapes[0].kind === 'line' && shapes[0].a);
    expect(shapeDimensions(next.geometry!)[0].value).toBeCloseTo(80);
  });
  it('keeps circles circular and rectangle opposite corners fixed', () => {
    const circle = dragShapeHandle(shapes[1], 'e', { x: 360, y: 170 }, { x: 250, y: 170 });
    expect(circle).toMatchObject({ kind: 'circle', center: { x: 160, y: 170 }, radius: 200 });
    const rect: InkShapeGeometry = { kind: 'rectangle', center: { x: 100, y: 100 }, width: 100, height: 80, rotation: 0 };
    const resized = dragShapeHandle(rect, 'se', { x: 220, y: 190 }, { x: 150, y: 140 });
    expect(shapeBounds(resized)).toEqual({ minX: 50, minY: 60, maxX: 220, maxY: 190 });
  });
  it('rejects invalid dimensions and leaves other triangle vertices fixed', () => {
    expect(setShapeDimension(shapes[1], 'radius', NaN)).toBeNull();
    expect(setShapeDimension(shapes[1], 'radius', -2)).toBeNull();
    const triangle = dragShapeHandle(shapes[4], 'v0', { x: 200, y: 40 }, { x: 180, y: 60 });
    expect(triangle.kind === 'triangle' && triangle.vertices.slice(1)).toEqual(shapes[4].kind === 'triangle' && shapes[4].vertices.slice(1));
  });
});

describe('hold gesture', () => {
  function setup() {
    vi.useFakeTimers();
    let stroke: Stroke = raw(samples(shapes[0]));
    let scope = 'page1';
    const repaint = vi.fn(), flush = vi.fn();
    const hold = new InkShapeHold(() => ({ scope, getScope: () => scope, enabled: true, delay: 1000, zoom: 1,
      getStroke: () => stroke, setStroke: s => { stroke = s; }, repaint, flush }));
    return { hold, get stroke() { return stroke; }, setScope: (s: string) => { scope = s; }, repaint, flush };
  }
  it('fires without pointermove events, tolerates jitter and restores handwriting', () => {
    const s = setup(), original = s.stroke;
    s.hold.begin({ x: 230, y: 90 }, 'pen');
    vi.advanceTimersByTime(800); s.hold.move({ x: 232, y: 91 }, { x: 232, y: 91 });
    vi.advanceTimersByTime(201);
    expect(s.stroke.geometry?.kind).toBe('line'); expect(s.flush).toHaveBeenCalledOnce();
    s.hold.restore(); expect(s.stroke.points).toEqual(original.points); expect(s.stroke.geometry).toBeUndefined();
    vi.advanceTimersByTime(2000); expect(s.stroke.geometry).toBeUndefined();
  });
  it('resets on movement, cancels on early lift and refuses a different page', () => {
    const s = setup(); s.hold.begin({ x: 230, y: 90 }, 'pen');
    vi.advanceTimersByTime(800); s.hold.move({ x: 245, y: 90 }, { x: 245, y: 90 });
    vi.advanceTimersByTime(300); expect(s.stroke.geometry).toBeUndefined();
    s.hold.finish(s.stroke); vi.advanceTimersByTime(1200); expect(s.stroke.geometry).toBeUndefined();
    s.hold.begin({ x: 245, y: 90 }, 'pen'); s.setScope('page2'); vi.advanceTimersByTime(1200);
    expect(s.stroke.geometry).toBeUndefined();
  });
  it('resizes a snapped stroke without appending raw samples and returns the original on commit', () => {
    const s = setup(), original = s.stroke;
    s.hold.begin({ x: 230, y: 90 }, 'pen'); vi.advanceTimersByTime(1001);
    expect(s.hold.move({ x: 330, y: 100 }, { x: 330, y: 100 })).toBe(true);
    expect(s.stroke.geometry).toMatchObject({ kind: 'line', b: { x: 330, y: 100 } });
    expect(s.stroke.points).toHaveLength(2);
    expect(s.hold.finish(s.stroke)?.points).toEqual(original.points);
  });
  it('does not activate from touch input', () => {
    const s = setup(); s.hold.begin({ x: 230, y: 90 }, 'touch'); vi.advanceTimersByTime(1200); expect(s.stroke.geometry).toBeUndefined();
  });
});

describe('exact shape rasterization', () => {
  it.each(shapes)('uses the same $kind path in live and cached tile rendering', geometry => {
    vi.spyOn(document, 'createElement').mockImplementation(((name: string) => name === 'canvas' ? createCanvas(1, 1) : undefined) as never);
    const stroke = withShape(raw([]), geometry);
    const live = createCanvas(512, 512), cached = createCanvas(512, 512);
    drawAnnotatedStroke(live.getContext('2d') as unknown as CanvasRenderingContext2D, stroke);
    const raster = getStrokeRaster(stroke, 0, 0, 512, 1);
    drawStrokeRaster(cached.getContext('2d') as unknown as CanvasRenderingContext2D, stroke, raster, 1);
    expect(cached.getContext('2d').getImageData(0, 0, 512, 512).data).toEqual(live.getContext('2d').getImageData(0, 0, 512, 512).data);
  });
  it('does not darken the closure of a translucent circle', () => {
    const canvas = createCanvas(400, 400), stroke = withShape(raw([]), shapes[1]);
    drawInkShape(canvas.getContext('2d') as unknown as CanvasRenderingContext2D, stroke);
    const alpha = (x: number, y: number) => canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
    expect(alpha(249, 170)).toBeCloseTo(alpha(160, 259), 0);
    expect(alpha(249, 170)).toBeGreaterThanOrEqual(127); expect(alpha(249, 170)).toBeLessThanOrEqual(129);
  });
});
