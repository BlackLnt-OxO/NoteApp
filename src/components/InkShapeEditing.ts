import { distance, rotatePoint, rotateShape, shapeBounds, shapeCenter, translateShape, MIN_SHAPE_SIZE, MAX_SHAPE_SIZE, type InkShapeGeometry, type ShapePoint } from './InkShapeGeometry';

export interface ShapeHandle extends ShapePoint { key: string; label: string }
export function shapeHandles(g: InkShapeGeometry, zoom: number): ShapeHandle[] {
  let handles: ShapeHandle[];
  if (g.kind === 'line') return [{ ...g.a, key: 'a', label: '起点' }, { ...g.b, key: 'b', label: '终点' }];
  if (g.kind === 'triangle') handles = g.vertices.map((p, i) => ({ ...p, key: `v${i}`, label: `顶点 ${i + 1}` }));
  else {
    const w = g.kind === 'circle' ? g.radius * 2 : g.kind === 'ellipse' ? g.rx * 2 : g.width;
    const h = g.kind === 'circle' ? g.radius * 2 : g.kind === 'ellipse' ? g.ry * 2 : g.height;
    const positions: [string, number, number][] = [['n', 0, -1], ['e', 1, 0], ['s', 0, 1], ['w', -1, 0]];
    if (g.kind === 'rectangle') positions.push(['nw', -1, -1], ['ne', 1, -1], ['se', 1, 1], ['sw', -1, 1]);
    handles = positions.map(([key, x, y]) => {
      const p = rotatePoint({ x: x * w / 2, y: y * h / 2 }, g.kind === 'circle' ? 0 : g.rotation);
      return { x: g.center.x + p.x, y: g.center.y + p.y, key, label: g.kind === 'circle' ? '调整半径' : '调整尺寸' };
    });
  }
  if (g.kind !== 'circle') {
    const b = shapeBounds(g), c = shapeCenter(g);
    handles.push({ x: c.x, y: b.minY - 28 / zoom, key: 'rotate', label: '旋转' });
  }
  return handles;
}
export function dragShapeHandle(g: InkShapeGeometry, key: string, at: ShapePoint, start: ShapePoint): InkShapeGeometry {
  if (key === 'move') return translateShape(g, at.x - start.x, at.y - start.y);
  if (key === 'rotate') {
    const c = shapeCenter(g);
    return rotateShape(g, Math.atan2(at.y - c.y, at.x - c.x) - Math.atan2(start.y - c.y, start.x - c.x));
  }
  if (g.kind === 'line') return distance(at, key === 'a' ? g.b : g.a) < MIN_SHAPE_SIZE ? g : { ...g, [key]: at };
  if (g.kind === 'circle') return { ...g, radius: Math.min(MAX_SHAPE_SIZE, Math.max(MIN_SHAPE_SIZE, distance(g.center, at))) };
  if (g.kind === 'triangle') {
    const vertices = [...g.vertices] as typeof g.vertices;
    vertices[Number(key.slice(1))] = at;
    const area = Math.abs((vertices[1].x - vertices[0].x) * (vertices[2].y - vertices[0].y) - (vertices[1].y - vertices[0].y) * (vertices[2].x - vertices[0].x));
    return area < 0.01 ? g : { ...g, vertices };
  }
  const p = rotatePoint({ x: at.x - g.center.x, y: at.y - g.center.y }, -g.rotation);
  const w = g.kind === 'ellipse' ? g.rx * 2 : g.width, h = g.kind === 'ellipse' ? g.ry * 2 : g.height;
  const sx = key.includes('e') ? 1 : key.includes('w') ? -1 : 0, sy = key.includes('s') ? 1 : key.includes('n') ? -1 : 0;
  const fixedX = -sx * w / 2, fixedY = -sy * h / 2;
  const nx = sx ? fixedX + sx * Math.min(MAX_SHAPE_SIZE, Math.max(MIN_SHAPE_SIZE, sx * (p.x - fixedX))) : p.x;
  const ny = sy ? fixedY + sy * Math.min(MAX_SHAPE_SIZE, Math.max(MIN_SHAPE_SIZE, sy * (p.y - fixedY))) : p.y;
  const width = sx ? Math.abs(nx - fixedX) : w, height = sy ? Math.abs(ny - fixedY) : h;
  const offset = rotatePoint({ x: sx ? (nx + fixedX) / 2 : 0, y: sy ? (ny + fixedY) / 2 : 0 }, g.rotation);
  const center = { x: g.center.x + offset.x, y: g.center.y + offset.y };
  return g.kind === 'ellipse' ? { ...g, center, rx: width / 2, ry: height / 2 } : { ...g, center, width, height };
}
export type ShapeDimension = 'length' | 'angle' | 'radius' | 'rx' | 'ry' | 'width' | 'height';
export function shapeDimensions(g: InkShapeGeometry): { key: ShapeDimension; label: string; value: number }[] {
  const angle = (r: number) => (r * 180 / Math.PI + 540) % 360 - 180;
  if (g.kind === 'line') return [{ key: 'length', label: '长度', value: distance(g.a, g.b) }, { key: 'angle', label: '角度 °', value: angle(Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x)) }];
  if (g.kind === 'circle') return [{ key: 'radius', label: '半径', value: g.radius }];
  if (g.kind === 'ellipse') return [{ key: 'rx', label: '半轴 X', value: g.rx }, { key: 'ry', label: '半轴 Y', value: g.ry }, { key: 'angle', label: '角度 °', value: angle(g.rotation) }];
  const b = shapeBounds(g);
  return [{ key: 'width', label: '宽', value: g.kind === 'rectangle' ? g.width : b.maxX - b.minX },
    { key: 'height', label: '高', value: g.kind === 'rectangle' ? g.height : b.maxY - b.minY },
    { key: 'angle', label: '角度 °', value: angle(g.kind === 'rectangle' ? g.rotation : Math.atan2(g.vertices[1].y - g.vertices[0].y, g.vertices[1].x - g.vertices[0].x)) }];
}
export function setShapeDimension(g: InkShapeGeometry, key: ShapeDimension, value: number): InkShapeGeometry | null {
  if (!Number.isFinite(value) || (key !== 'angle' && (value < MIN_SHAPE_SIZE || value > MAX_SHAPE_SIZE))) return null;
  if (key === 'angle') {
    const radians = ((value % 360) * Math.PI / 180);
    if (g.kind === 'line') { const length = distance(g.a, g.b); return { ...g, b: { x: g.a.x + Math.cos(radians) * length, y: g.a.y + Math.sin(radians) * length } }; }
    if (g.kind === 'circle') return g;
    if (g.kind !== 'triangle') return { ...g, rotation: radians };
    return rotateShape(g, radians - Math.atan2(g.vertices[1].y - g.vertices[0].y, g.vertices[1].x - g.vertices[0].x));
  }
  if (g.kind === 'line' && key === 'length') {
    const angle = Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x);
    return { ...g, b: { x: g.a.x + Math.cos(angle) * value, y: g.a.y + Math.sin(angle) * value } };
  }
  if (g.kind === 'circle' && key === 'radius') return { ...g, radius: value };
  if (g.kind === 'ellipse' && (key === 'rx' || key === 'ry')) return { ...g, [key]: value };
  if (g.kind === 'rectangle' && (key === 'width' || key === 'height')) return { ...g, [key]: value };
  if (g.kind === 'triangle' && (key === 'width' || key === 'height')) {
    const b = shapeBounds(g), c = shapeCenter(g), axis = key === 'width' ? 'x' : 'y';
    const factor = value / Math.max(MIN_SHAPE_SIZE, key === 'width' ? b.maxX - b.minX : b.maxY - b.minY);
    return { ...g, vertices: g.vertices.map(p => ({ ...p, [axis]: c[axis] + (p[axis] - c[axis]) * factor })) as typeof g.vertices };
  }
  return null;
}
