/**
 * StrokeEngine — Pure-function brush pipeline with Apple Pencil-style
 * input prediction.
 *
 * Instead of lag-inducing smoothing, we use a 3-point velocity buffer to
 * predict where the pen *will be* 1-2 frames ahead and render there.
 * Result: zero-latency feel — the line runs ahead of the pen tip slightly,
 * like Apple Pencil on iPad.
 */

import type { StampPoint, PointerSample, BrushSettings } from './types';

// ---- Prediction buffer (Apple Pencil style) ----------------------------------

export interface PredictBuffer {
  buf: { x: number; y: number; pressure: number }[];
  /** Multiplier applied to velocity for forward prediction (0-2). */
  factor: number;
}

/** Create a per-stroke prediction buffer.  smoothing 0 = off, 1 = max predict. */
export function createPredictBuffer(smoothing: number): PredictBuffer {
  return {
    buf: [],
    factor: smoothing * 2, // 10% → 0.2x, 50% → 1.0x, 100% → 2.0x
  };
}

/**
 * Apple Pencil-style prediction:
 * 1. Keep last 3 raw points
 * 2. Compute velocity from last 2 points
 * 3. Extrapolate forward: output = current + velocity * factor
 *
 * The line runs AHEAD of the pen tip, compensating for display latency.
 */
function predict(
  pb: PredictBuffer,
  p: { x: number; y: number; pressure: number },
): { x: number; y: number; pressure: number } {
  pb.buf.push(p);
  if (pb.buf.length > 3) pb.buf.shift();

  if (pb.buf.length < 2 || pb.factor <= 0) return p;

  const prev = pb.buf[pb.buf.length - 2];
  const curr = pb.buf[pb.buf.length - 1];

  const vx = curr.x - prev.x;
  const vy = curr.y - prev.y;
  const vp = curr.pressure - prev.pressure;

  return {
    x: curr.x + vx * pb.factor,
    y: curr.y + vy * pb.factor,
    pressure: Math.max(0.05, Math.min(1, curr.pressure + vp * pb.factor)),
  };
}

// ---- Pressure extraction -----------------------------------------------------

export function getPressure(e: { pointerType: string; pressure: number }): number {
  if (e.pointerType === 'pen') {
    return e.pressure > 0.01 ? e.pressure : 0.05;
  }
  return 0.5;
}

// ---- Pressure mapping --------------------------------------------------------

export function mapPressureToSize(
  pressure: number, baseSize: number, enabled: boolean,
): number {
  if (!enabled) return baseSize;
  const p = Math.max(0.05, Math.min(1, pressure));
  return baseSize * (0.15 + p * 0.85);
}

export function mapPressureToOpacity(
  pressure: number, baseOpacity: number, enabled: boolean,
): number {
  if (!enabled) return baseOpacity;
  const p = Math.max(0.05, Math.min(1, pressure));
  return baseOpacity * (0.15 + p * 0.85);
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

  if (dist <= stepSize) {
    results.push(to);
    return results;
  }

  const steps = Math.floor(dist / stepSize);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const pressure = from.pressure + (to.pressure - from.pressure) * t;
    const tiltX = from.tiltX + (to.tiltX - from.tiltX) * t;
    const tiltY = from.tiltY + (to.tiltY - from.tiltY) * t;

    const size = mapPressureToSize(pressure, brushSettings.size, brushSettings.pressureSize);
    const opacity = mapPressureToOpacity(pressure, brushSettings.opacity, brushSettings.pressureOpacity);

    results.push({ x, y, size, opacity, pressure, tiltX, tiltY });
  }

  return results;
}

// ---- Main processing entry point ---------------------------------------------

export function processSample(
  predBuf: PredictBuffer,
  prevStamp: StampPoint | null,
  sample: PointerSample,
  brushSettings: BrushSettings,
): StampPoint[] {
  // Apple Pencil prediction: output runs ahead of input
  const pred = predict(predBuf, {
    x: sample.x,
    y: sample.y,
    pressure: sample.pressure,
  });

  const size = mapPressureToSize(pred.pressure, brushSettings.size, brushSettings.pressureSize);
  const opacity = mapPressureToOpacity(pred.pressure, brushSettings.opacity, brushSettings.pressureOpacity);

  const stamp: StampPoint = {
    x: pred.x,
    y: pred.y,
    size,
    opacity,
    pressure: pred.pressure,
    tiltX: sample.tiltX,
    tiltY: sample.tiltY,
  };

  if (!prevStamp) return [stamp];

  return interpolateStamps(prevStamp, stamp, brushSettings);
}

export function stampCacheKey(size: number, color: string, hardness: number): string {
  return `${size.toFixed(1)}|${color}|${hardness.toFixed(2)}`;
}
