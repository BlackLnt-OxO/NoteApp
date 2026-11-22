import { inkPositionWeight, RAW_SAMPLE_MIN_DIST, smoothingToMinCutoff } from './PdfAnnotation/PdfEngine';

export const LASER_LIFETIME = 1800;

/** Transient path. Only the newest point remains at the raw pointer position. */
export class InkLaserTrail {
  private readonly points: { x: number; y: number; t: number }[] = [];
  private readonly minCutoff: number;
  end?: number;

  constructor(private readonly color: string, private readonly size: number, smoothing: number) {
    this.minCutoff = smoothingToMinCutoff(smoothing);
  }

  append(x: number, y: number, t: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return;
    const tip = this.points[this.points.length - 1];
    if (tip && Math.hypot(x - tip.x, y - tip.y) < RAW_SAMPLE_MIN_DIST) return;
    const previous = this.points[this.points.length - 2];
    if (tip && previous) {
      const dt = (tip.t - previous.t) / 1000;
      if (dt > 0 && dt <= 1) {
        const dx = tip.x - previous.x;
        const dy = tip.y - previous.y;
        const weight = inkPositionWeight(this.minCutoff, dx, dy, dt);
        tip.x = previous.x + dx * weight;
        tip.y = previous.y + dy * weight;
      }
    }
    this.points.push({ x, y, t });
  }

  draw(ctx: CanvasRenderingContext2D, alpha: number): void {
    const first = this.points[0];
    if (!first || alpha <= 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
    ctx.lineWidth = this.size;
    ctx.globalAlpha = alpha;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    if (this.points.length === 1) {
      ctx.arc(first.x, first.y, this.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].x, this.points[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
