/**
 * StrokeEngine — Pure-function brush pipeline with simple EMA smoothing.
 *
 * Uses a plain exponential moving average — fast, predictable, zero fuss.
 * default smoothing = 0.35 (65% raw / 35% old per frame).
 */

import type { StampPoint, PointerSample, BrushSettings } from './types';

// ---- EMA Smoother ------------------------------------------------------------

export interface SmoothPoint {
  x: number;
  y: number;
  pressure: number;
}

export class StrokeSmoother {
  private point: SmoothPoint | null = null;
  private readonly factor: number;

  constructor(smoothing: number) {
    // clamp 0-0.95 so at least 5% of raw input always comes through
    const s = Math.max(0, Math.min(0.95, smoothing));
    this.factor = 1 - s;
  }

  update(input: SmoothPoint): SmoothPoint {
    if (!this.point) {
      this.point = { ...input };
      return this.point;
    }

    this.point = {
      x: this.point.x + (input.x - this.point.x) * this.factor,
      y: this.point.y + (input.y - this.point.y) * this.factor,
      pressure: this.point.pressure + (input.pressure - this.point.pressure) * this.factor,
    };

    return { ...this.point };
  }

  reset() {
    this.point = null;
  }
}

// ---- Pressure extraction -----------------------------------------------------

export function getPressure(e: { pointerType: string; pressure: number }): number {
  if (e.pointerType === 'pen') return e.pressure > 0.01 ? e.pressure : 0.05;
  return 0.5;
}

// ---- Pressure mapping --------------------------------------------------------

export function mapPressureToSize(pressure: number, baseSize: number, enabled: boolean): number {
  if (!enabled) return baseSize;
  return baseSize * (0.15 + Math.max(0.05, Math.min(1, pressure)) * 0.85);
}

export function mapPressureToOpacity(pressure: number, baseOpacity: number, enabled: boolean): number {
  if (!enabled) return baseOpacity;
  return baseOpacity * (0.15 + Math.max(0.05, Math.min(1, pressure)) * 0.85);
}

// ---- Stamp interpolation -----------------------------------------------------

export function interpolateStamps(
  from: StampPoint,
  to: StampPoint,
  brushSettings: BrushSettings,
): StampPoint[] {
  const results: StampPoint[] = [];
  const avgSize = (from.size + to.size) / 2;
  const stepSize = Math.max(0.5, avgSize * brushSettings.spacing);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist <= stepSize) { results.push(to); return results; }

  const steps = Math.floor(dist / stepSize);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const pressure = from.pressure + (to.pressure - from.pressure) * t;
    results.push({
      x: from.x + dx * t,
      y: from.y + dy * t,
      size: mapPressureToSize(pressure, brushSettings.size, brushSettings.pressureSize),
      opacity: mapPressureToOpacity(pressure, brushSettings.opacity, brushSettings.pressureOpacity),
      pressure,
      tiltX: from.tiltX + (to.tiltX - from.tiltX) * t,
      tiltY: from.tiltY + (to.tiltY - from.tiltY) * t,
    });
  }
  return results;
}

// ---- Main entry point --------------------------------------------------------

export function processSample(
  smoother: StrokeSmoother,
  prevStamp: StampPoint | null,
  sample: PointerSample,
  brushSettings: BrushSettings,
): StampPoint[] {
  const smoothed = smoother.update({
    x: sample.x,
    y: sample.y,
    pressure: sample.pressure,
  });

  const stamp: StampPoint = {
    x: smoothed.x,
    y: smoothed.y,
    size: mapPressureToSize(smoothed.pressure, brushSettings.size, brushSettings.pressureSize),
    opacity: mapPressureToOpacity(smoothed.pressure, brushSettings.opacity, brushSettings.pressureOpacity),
    pressure: smoothed.pressure,
    tiltX: sample.tiltX,
    tiltY: sample.tiltY,
  };

  if (!prevStamp) return [stamp];

  return interpolateStamps(prevStamp, stamp, brushSettings);
}

export function stampCacheKey(size: number, color: string, hardness: number): string {
  return `${size.toFixed(1)}|${color}|${hardness.toFixed(2)}`;
}
