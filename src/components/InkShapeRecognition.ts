import { distance, pointSegmentDistance, rotatePoint, shapePathPoints, type InkShapeGeometry, type ShapePoint } from './InkShapeGeometry';

/** Equal arc-length samples prevent dwell jitter and pen speed from biasing fits. */
export function resampleShape(points: readonly ShapePoint[], count = 128): ShapePoint[] {
  const clean: ShapePoint[] = [];
  for (const p of points) if (Number.isFinite(p.x) && Number.isFinite(p.y) && (!clean.length || distance(clean[clean.length - 1], p) > 0.01)) clean.push({ x: p.x, y: p.y });
  if (clean.length < 2) return clean;
  const lengths = [0];
  for (let i = 1; i < clean.length; i++) lengths.push(lengths[i - 1] + distance(clean[i - 1], clean[i]));
  const total = lengths[lengths.length - 1], out = [clean[0]];
  let j = 1;
  for (let i = 1; i < count - 1; i++) {
    const target = total * i / (count - 1);
    while (j < clean.length - 1 && lengths[j] < target) j++;
    const t = (target - lengths[j - 1]) / (lengths[j] - lengths[j - 1]);
    out.push({ x: clean[j - 1].x + (clean[j].x - clean[j - 1].x) * t, y: clean[j - 1].y + (clean[j].y - clean[j - 1].y) * t });
  }
  return [...out, clean[clean.length - 1]];
}
function simplify(points: ShapePoint[], tolerance: number): ShapePoint[] {
  let furthest = 0, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointSegmentDistance(points[i], points[0], points[points.length - 1]);
    if (d > furthest) { furthest = d; index = i; }
  }
  if (furthest <= tolerance) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}
function polygonVertices(points: ShapePoint[], tolerance: number): ShapePoint[] {
  // Split at the point furthest from the initial sample; a closed DP input
  // otherwise depends strongly on whether the user began at a corner or edge.
  let split = 1;
  for (let i = 2; i < points.length; i++) if (distance(points[0], points[i]) > distance(points[0], points[split])) split = i;
  let vertices = [...simplify(points.slice(0, split + 1), tolerance).slice(0, -1), ...simplify([...points.slice(split), points[0]], tolerance).slice(0, -1)];
  let changed = true;
  while (changed && vertices.length > 3) {
    changed = false;
    for (let i = 0; i < vertices.length; i++) {
      if (pointSegmentDistance(vertices[i], vertices[(i + vertices.length - 1) % vertices.length], vertices[(i + 1) % vertices.length]) < tolerance) {
        vertices.splice(i, 1); changed = true; break;
      }
    }
  }
  return vertices;
}
function fitError(points: ShapePoint[], g: InkShapeGeometry): number {
  const path = shapePathPoints(g);
  let sum = 0;
  for (const p of points) {
    let d = Infinity;
    for (let i = 1; i < path.length; i++) d = Math.min(d, pointSegmentDistance(p, path[i - 1], path[i]));
    sum += d * d;
  }
  return Math.sqrt(sum / points.length);
}
/** Pure local geometry fitting. Deliberately rejects open/ambiguous scribbles. */
export function recognizeInkShape(input: readonly ShapePoint[], zoom = 1): InkShapeGeometry | null {
  const pts = resampleShape(input);
  if (pts.length < 4) return null;
  const a = pts[0], b = pts[pts.length - 1];
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += distance(pts[i - 1], pts[i]);
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  const span = Math.hypot(maxX - minX, maxY - minY);
  if (span * zoom < 12 || length * zoom < 18) return null;
  const lineError = Math.sqrt(pts.reduce((s, p) => s + pointSegmentDistance(p, a, b) ** 2, 0) / pts.length);
  if (distance(a, b) / length >= 0.92 && lineError / span < 0.025) return { kind: 'line', a, b };
  if (distance(a, b) > span * 0.18 || length > span * 4.5) return null;
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const candidates: { geometry: InkShapeGeometry; error: number }[] = [];
  const vertices = polygonVertices(pts, span * 0.035);
  if (vertices.length === 3) {
    const area = Math.abs((vertices[1].x - vertices[0].x) * (vertices[2].y - vertices[0].y) - (vertices[1].y - vertices[0].y) * (vertices[2].x - vertices[0].x));
    if (area > span * span * 0.1) {
      const geometry: InkShapeGeometry = { kind: 'triangle', vertices: vertices as [ShapePoint, ShapePoint, ShapePoint] };
      candidates.push({ geometry, error: fitError(pts, geometry) / span });
    }
  }
  if (vertices.length === 4) {
    let c4 = 0, s4 = 0;
    for (let i = 0; i < 4; i++) {
      const p = vertices[i], q = vertices[(i + 1) % 4], angle = Math.atan2(q.y - p.y, q.x - p.x), weight = distance(p, q);
      c4 += Math.cos(angle * 4) * weight; s4 += Math.sin(angle * 4) * weight;
    }
    const rotation = Math.atan2(s4, c4) / 4;
    const local = pts.map(p => rotatePoint({ x: p.x - center.x, y: p.y - center.y }, -rotation));
    const loX = Math.min(...local.map(p => p.x)), hiX = Math.max(...local.map(p => p.x));
    const loY = Math.min(...local.map(p => p.y)), hiY = Math.max(...local.map(p => p.y));
    const offset = rotatePoint({ x: (loX + hiX) / 2, y: (loY + hiY) / 2 }, rotation);
    const geometry: InkShapeGeometry = { kind: 'rectangle', center: { x: center.x + offset.x, y: center.y + offset.y }, width: hiX - loX, height: hiY - loY, rotation };
    candidates.push({ geometry, error: fitError(pts, geometry) / span });
  }
  // Covariance orientation + rotated extents fits rotated ellipses without
  // turning rectangles into ovals. All models compete on boundary distance.
  const mean = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  let xx = 0, yy = 0, xy = 0;
  for (const p of pts) { xx += (p.x - mean.x) ** 2; yy += (p.y - mean.y) ** 2; xy += (p.x - mean.x) * (p.y - mean.y); }
  const rotation = Math.atan2(2 * xy, xx - yy) / 2;
  const local = pts.map(p => rotatePoint({ x: p.x - center.x, y: p.y - center.y }, -rotation));
  const loX = Math.min(...local.map(p => p.x)), hiX = Math.max(...local.map(p => p.x));
  const loY = Math.min(...local.map(p => p.y)), hiY = Math.max(...local.map(p => p.y));
  const rx = (hiX - loX) / 2, ry = (hiY - loY) / 2;
  if (Math.min(rx, ry) * zoom >= 5) {
    const offset = rotatePoint({ x: (loX + hiX) / 2, y: (loY + hiY) / 2 }, rotation);
    const c = { x: center.x + offset.x, y: center.y + offset.y };
    const geometry: InkShapeGeometry = Math.max(rx, ry) / Math.min(rx, ry) < 1.15
      ? { kind: 'circle', center: c, radius: (rx + ry) / 2 }
      : { kind: 'ellipse', center: c, rx, ry, rotation };
    // Full winding rejects doubled-back arcs and incomplete loops.
    let winding = 0;
    for (let i = 1; i < pts.length; i++) {
      let delta = Math.atan2(pts[i].y - c.y, pts[i].x - c.x) - Math.atan2(pts[i - 1].y - c.y, pts[i - 1].x - c.x);
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      winding += delta;
    }
    if (Math.abs(winding) > 5.3 && Math.abs(winding) < 7) candidates.push({ geometry, error: fitError(pts, geometry) / span });
  }
  candidates.sort((x, y) => x.error - y.error);
  const best = candidates[0];
  if (!best || best.error > 0.035) return null;
  if (candidates[1] && candidates[1].error - best.error < 0.004) return null;
  // Reject paths that visit the same fitted perimeter more than once.
  const path = shapePathPoints(best.geometry);
  let perimeter = 0;
  for (let i = 1; i < path.length; i++) perimeter += distance(path[i - 1], path[i]);
  return length > perimeter * 1.3 || length < perimeter * 0.75 ? null : best.geometry;
}
