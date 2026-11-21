import type { PdfStroke } from './PdfAnnotation/PdfTypes';

export interface ShapePoint { x: number; y: number }
export type InkShapeGeometry =
  | { kind: 'line'; a: ShapePoint; b: ShapePoint }
  | { kind: 'circle'; center: ShapePoint; radius: number }
  | { kind: 'ellipse'; center: ShapePoint; rx: number; ry: number; rotation: number }
  | { kind: 'rectangle'; center: ShapePoint; width: number; height: number; rotation: number }
  | { kind: 'triangle'; vertices: [ShapePoint, ShapePoint, ShapePoint] };

export const SHAPE_NAMES: Record<InkShapeGeometry['kind'], string> = {
  line: '直线', circle: '圆', ellipse: '椭圆', rectangle: '矩形', triangle: '三角形',
};
export const MIN_SHAPE_SIZE = 0.1;
export const MAX_SHAPE_SIZE = 1_000_000;
export const distance = (a: ShapePoint, b: ShapePoint) => Math.hypot(a.x - b.x, a.y - b.y);
export function rotatePoint(p: ShapePoint, angle: number): ShapePoint {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}
export function shapeCenter(g: InkShapeGeometry): ShapePoint {
  if (g.kind === 'line') return { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
  if (g.kind === 'triangle') return {
    x: g.vertices.reduce((v, p) => v + p.x, 0) / 3,
    y: g.vertices.reduce((v, p) => v + p.y, 0) / 3,
  };
  return g.center;
}
export function rectangleVertices(g: Extract<InkShapeGeometry, { kind: 'rectangle' }>): ShapePoint[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
    const p = rotatePoint({ x: x * g.width / 2, y: y * g.height / 2 }, g.rotation);
    return { x: p.x + g.center.x, y: p.y + g.center.y };
  });
}
export function shapePathPoints(g: InkShapeGeometry): ShapePoint[] {
  if (g.kind === 'line') return [g.a, g.b];
  if (g.kind === 'triangle') return [...g.vertices, g.vertices[0]];
  if (g.kind === 'rectangle') { const v = rectangleVertices(g); return [...v, v[0]]; }
  const rx = g.kind === 'circle' ? g.radius : g.rx, ry = g.kind === 'circle' ? g.radius : g.ry;
  // These points support the spatial index/eraser and older readers. Rendering
  // uses an exact arc, never this approximation or pressure smoothing.
  const n = Math.min(4096, Math.max(64, Math.ceil(Math.PI * Math.sqrt(Math.max(rx, ry) / 0.1))));
  const points: ShapePoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * Math.PI * 2 / n;
    const p = rotatePoint({ x: rx * Math.cos(a), y: ry * Math.sin(a) }, g.kind === 'circle' ? 0 : g.rotation);
    points.push({ x: g.center.x + p.x, y: g.center.y + p.y });
  }
  return [...points, { ...points[0] }];
}
export function shapeBounds(g: InkShapeGeometry, pad = 0) {
  if (g.kind === 'circle' || g.kind === 'ellipse') {
    const rx = g.kind === 'circle' ? g.radius : g.rx, ry = g.kind === 'circle' ? g.radius : g.ry;
    const a = g.kind === 'circle' ? 0 : g.rotation;
    const dx = Math.hypot(rx * Math.cos(a), ry * Math.sin(a)) + pad;
    const dy = Math.hypot(rx * Math.sin(a), ry * Math.cos(a)) + pad;
    return { minX: g.center.x - dx, minY: g.center.y - dy, maxX: g.center.x + dx, maxY: g.center.y + dy };
  }
  const pts = g.kind === 'line' ? [g.a, g.b] : g.kind === 'triangle' ? g.vertices : rectangleVertices(g);
  return { minX: Math.min(...pts.map(p => p.x)) - pad, minY: Math.min(...pts.map(p => p.y)) - pad,
    maxX: Math.max(...pts.map(p => p.x)) + pad, maxY: Math.max(...pts.map(p => p.y)) + pad };
}
export function translateShape(g: InkShapeGeometry, dx: number, dy: number): InkShapeGeometry {
  const move = (p: ShapePoint) => ({ x: p.x + dx, y: p.y + dy });
  if (g.kind === 'line') return { ...g, a: move(g.a), b: move(g.b) };
  if (g.kind === 'triangle') return { ...g, vertices: g.vertices.map(move) as typeof g.vertices };
  return { ...g, center: move(g.center) };
}
export function scaleShape(g: InkShapeGeometry, factor: number): InkShapeGeometry {
  const c = shapeCenter(g);
  const b = shapeBounds(g), span = Math.max(b.maxX - b.minX, b.maxY - b.minY, MIN_SHAPE_SIZE);
  const f = Math.max(MIN_SHAPE_SIZE / span, Math.min(MAX_SHAPE_SIZE / span, factor));
  const scale = (p: ShapePoint) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f });
  switch (g.kind) {
    case 'line': return { ...g, a: scale(g.a), b: scale(g.b) };
    case 'triangle': return { ...g, vertices: g.vertices.map(scale) as typeof g.vertices };
    case 'circle': return { ...g, radius: Math.max(MIN_SHAPE_SIZE, g.radius * f) };
    case 'ellipse': return { ...g, rx: Math.max(MIN_SHAPE_SIZE, g.rx * f), ry: Math.max(MIN_SHAPE_SIZE, g.ry * f) };
    case 'rectangle': return { ...g, width: Math.max(MIN_SHAPE_SIZE, g.width * f), height: Math.max(MIN_SHAPE_SIZE, g.height * f) };
  }
}
export function rotateShape(g: InkShapeGeometry, delta: number): InkShapeGeometry {
  if (g.kind === 'circle') return g;
  if (g.kind === 'ellipse' || g.kind === 'rectangle') return { ...g, rotation: g.rotation + delta };
  const c = shapeCenter(g);
  const turn = (p: ShapePoint) => { const v = rotatePoint({ x: p.x - c.x, y: p.y - c.y }, delta); return { x: c.x + v.x, y: c.y + v.y }; };
  if (g.kind === 'line') return { ...g, a: turn(g.a), b: turn(g.b) };
  return { ...g, vertices: g.vertices.map(turn) as typeof g.vertices };
}
export function withShape<T extends PdfStroke>(stroke: T, geometry: InkShapeGeometry): T {
  return { ...stroke, geometry, points: shapePathPoints(geometry).map((p, i) => ({ ...p, pressure: 1, t: i * 16 })),
    renderVersion: undefined, style: 'marker', smoothing: 0, pressureOpacity: false, edgeFeather: false, featherSize: 0 };
}
/** Every legacy point-translation action must also translate semantic geometry. */
export function replaceStrokePoints<T extends PdfStroke>(stroke: T, points: T['points']): T {
  if (!stroke.geometry) return { ...stroke, points };
  const a = stroke.points[0], b = points[0];
  if (!a || !b || points.length !== stroke.points.length) return { ...stroke, points, geometry: undefined };
  const dx = b.x - a.x, dy = b.y - a.y;
  const translated = points.every((p, i) => Math.abs(p.x - stroke.points[i].x - dx) < 1e-6 && Math.abs(p.y - stroke.points[i].y - dy) < 1e-6);
  return { ...stroke, points, geometry: translated ? translateShape(stroke.geometry, dx, dy) : undefined };
}
export function drawInkShape(ctx: CanvasRenderingContext2D, stroke: PdfStroke, dx = 0, dy = 0): void {
  const g = stroke.geometry;
  if (!g) return;
  ctx.save();
  ctx.translate(dx, dy);
  ctx.globalCompositeOperation = stroke.compositeOperation;
  ctx.globalAlpha = stroke.opacity;
  ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.size;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (g.kind === 'circle') ctx.arc(g.center.x, g.center.y, g.radius, 0, Math.PI * 2);
  else if (g.kind === 'ellipse') ctx.ellipse(g.center.x, g.center.y, g.rx, g.ry, g.rotation, 0, Math.PI * 2);
  else {
    const pts = g.kind === 'line' ? [g.a, g.b] : g.kind === 'triangle' ? g.vertices : rectangleVertices(g);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  }
  if (g.kind !== 'line') ctx.closePath();
  ctx.stroke(); ctx.restore();
}

export function pointSegmentDistance(p: ShapePoint, a: ShapePoint, b: ShapePoint): number {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return distance(p, { x: a.x + dx * t, y: a.y + dy * t });
}
