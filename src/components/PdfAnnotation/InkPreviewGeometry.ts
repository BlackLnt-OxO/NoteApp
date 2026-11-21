import { finishInkWork } from '../InkCooperativeWork';
/** Bounded lookahead keeps preview centreline and width error below a fraction
 * of one preview pixel. Full-resolution vectors and coverage never use this. */
export function* previewGeometryWork(points: { x: number; y: number }[], widths: number[], scale: number):
  Generator<void, { points: { x: number; y: number }[]; widths: number[] }, unknown> {
  if (points.length < 3) return { points, widths };
  const result = [points[0]], sizes = [widths[0]];
  const tolerance = .2 / scale, widthTolerance = .15 / scale;
  let start = 0;
  while (start < points.length - 1) {
    let end = Math.min(start + 16, points.length - 1);
    for (; end > start + 1; end--) {
      const a = points[start], b = points[end], dx = b.x - a.x, dy = b.y - a.y, length2 = dx*dx + dy*dy;
      let valid = true;
      for (let i = start + 1; i < end; i++) {
        yield;
        const p = points[i], t = length2 ? Math.max(0, Math.min(1, ((p.x-a.x)*dx + (p.y-a.y)*dy) / length2)) : 0;
        if (Math.hypot(p.x-a.x-dx*t, p.y-a.y-dy*t) > tolerance
          || Math.abs(widths[i] - (widths[start] + (widths[end]-widths[start])*t)) > widthTolerance) { valid = false; break; }
      }
      if (valid) break;
    }
    result.push(points[end]); sizes.push(widths[end]); start = end;
  }
  return { points: result, widths: sizes };
}
export function previewGeometry(points: { x: number; y: number }[], widths: number[], scale: number) {
  return finishInkWork(previewGeometryWork(points, widths, scale));
}
