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
  return [...simplify(points.slice(0, split + 1), tolerance).slice(0, -1),
    ...simplify([...points.slice(split), points[0]], tolerance).slice(0, -1)];
}

function removeWeakestCorner(vertices: ShapePoint[], tolerance: number): boolean {
  let weakest = -1;
  let error = tolerance;
  for (let i = 0; i < vertices.length; i++) {
    const before = vertices[(i + vertices.length - 1) % vertices.length];
    const after = vertices[(i + 1) % vertices.length];
    const deviation = pointSegmentDistance(vertices[i], before, after);
    if (deviation < error) {
      weakest = i;
      error = deviation;
    }
  }
  if (weakest < 0) return false;
  vertices.splice(weakest, 1);
  return true;
}

function fitPolygon(vertices: ShapePoint[], points: ShapePoint[], span: number, zoom: number): InkShapeGeometry | null {
  if (vertices.length === 3) {
    const [a, b, c] = vertices;
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area2 < span * span * 0.065 || area2 / span * zoom < 5) return null;
    return { kind: 'triangle', vertices: [a, b, c] };
  }
  let c4 = 0;
  let s4 = 0;
  let turn = 0;
  const edges = vertices.map((p, i) => {
    const q = vertices[(i + 1) % 4];
    return { x: q.x - p.x, y: q.y - p.y };
  });
  for (let i = 0; i < 4; i++) {
    const a = edges[i];
    const b = edges[(i + 1) % 4];
    const length = Math.hypot(a.x, a.y);
    const cross = a.x * b.y - a.y * b.x;
    if (cross === 0 || (turn && Math.sign(cross) !== turn)
      || Math.abs(a.x * b.x + a.y * b.y) > 0.5 * length * Math.hypot(b.x, b.y)) return null;
    turn = Math.sign(cross);
    const angle = Math.atan2(a.y, a.x);
    c4 += Math.cos(angle * 4) * length;
    s4 += Math.sin(angle * 4) * length;
  }
  const rotation = Math.atan2(s4, c4) / 4;
  const local = points.map(p => rotatePoint(p, -rotation));
  // A stray sample at the seam should not move the fitted sides outwards.
  const xs = local.map(p => p.x).sort((a, b) => a - b);
  const ys = local.map(p => p.y).sort((a, b) => a - b);
  const trim = Math.floor(points.length * 0.025);
  const hi = points.length - 1 - trim;
  const width = xs[hi] - xs[trim];
  const height = ys[hi] - ys[trim];
  if (Math.min(width, height) * zoom < 5) return null;
  const center = rotatePoint({ x: (xs[trim] + xs[hi]) / 2, y: (ys[trim] + ys[hi]) / 2 }, rotation);
  return { kind: 'rectangle', center, width, height, rotation };
}

function hasDrawnSides(points: ShapePoint[], path: ShapePoint[], span: number): boolean {
  // Check the original polyline without connecting the seam. The endpoint gap
  // may be small on a tall rectangle that is missing an entire short side.
  return path.slice(1).every((end, index) => {
    const start = path[index];
    const length = distance(start, end);
    const limit = Math.min(span * 0.065, length * 0.22);
    return [0.25, 0.75].some(t => {
      const probe = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
      return points.some((p, i) => {
        if (i === 0 || pointSegmentDistance(probe, points[i - 1], p) > limit) return false;
        const prev = points[i - 1];
        const along = (p.x - prev.x) * (end.x - start.x) + (p.y - prev.y) * (end.y - start.y);
        return Math.abs(along) >= 0.75 * length * distance(p, prev);
      });
    });
  });
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
  const candidates: { geometry: InkShapeGeometry; error: number; complete: boolean }[] = [];
  const vertices = polygonVertices(pts, span * 0.025);
  // Rounding and pen lifts at the seam often leave a small extra corner.
  // Test both vertex counts as minor deviations are removed.
  do {
    if (vertices.length !== 3 && vertices.length !== 4) continue;
    const geometry = fitPolygon(vertices, pts, span, zoom);
    if (!geometry) continue;
    const error = fitError(pts, geometry) / span;
    if (error <= 0.046) candidates.push({ geometry, error, complete: hasDrawnSides(pts, shapePathPoints(geometry), span) });
  } while (vertices.length > 3 && removeWeakestCorner(vertices, span * 0.095));
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
    const error = fitError(pts, geometry) / span;
    if (Math.abs(winding) > 5.3 && Math.abs(winding) < 7 && error <= 0.035) candidates.push({ geometry, error, complete: true });
  }
  candidates.sort((x, y) => x.error - y.error);
  const best = candidates[0];
  if (!best?.complete) return null;
  if (candidates[1] && candidates[1].error - best.error < 0.004) return null;
  // Reject paths that visit the same fitted perimeter more than once.
  const path = shapePathPoints(best.geometry);
  let perimeter = 0;
  for (let i = 1; i < path.length; i++) perimeter += distance(path[i - 1], path[i]);
  return length > perimeter * 1.3 || length < perimeter * 0.75 ? null : best.geometry;
}
