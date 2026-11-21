import { describe, expect, it } from 'vitest';
import { previewGeometry, previewGeometryWork } from '../../PdfAnnotation/InkPreviewGeometry';
describe('bounded preview geometry', () => {
  it('reduces dense straight segments while retaining endpoints and yielding work', () => {
    const points = Array.from({ length: 16384 }, (_, x) => ({ x: x / 16, y: 20 }));
    const work = previewGeometryWork(points, points.map(() => 7), .25);
    let next = work.next(), yields = 0;
    while (!next.done) { yields++; next = work.next(); }
    expect(yields).toBeGreaterThan(10000);
    expect(next.value.points.length).toBeLessThan(points.length / 8);
    expect(next.value.points[0]).toBe(points[0]); expect(next.value.points[next.value.points.length - 1]).toBe(points[points.length - 1]);
  });
  it('keeps centreline and width deviations within preview pixel tolerances', () => {
    const points = Array.from({ length: 321 }, (_, x) => ({ x, y: Math.sin(x / 6) * 4 }));
    const widths = points.map((_, i) => 5 + Math.cos(i / 3) * 3), scale = .5;
    const simplified = previewGeometry(points, widths, scale);
    for (let segment = 1; segment < simplified.points.length; segment++) {
      const a = simplified.points[segment - 1], b = simplified.points[segment];
      const dx = b.x-a.x, dy = b.y-a.y, length2 = dx*dx+dy*dy;
      for (let i = a.x+1; i < b.x; i++) {
        const p = points[i], t = Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/length2));
        expect(Math.hypot(p.x-a.x-dx*t, p.y-a.y-dy*t)*scale).toBeLessThanOrEqual(.2 + 1e-9);
        expect(Math.abs(widths[i] - (simplified.widths[segment-1] + (simplified.widths[segment]-simplified.widths[segment-1])*t))*scale).toBeLessThanOrEqual(.15 + 1e-9);
      }
    }
  });
});
