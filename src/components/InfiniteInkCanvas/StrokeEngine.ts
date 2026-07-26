/**
 * StrokeEngine — Pure-function brush pipeline with SAI-style stabiliser.
 *
 * Smoothing uses a moving-average ring buffer (like PaintTool SAI's stabilizer):
 * the output trails behind the input like it's on a string.  Lower smoothing =
 * smaller buffer = tighter tracking.
 */

import type { StampPoint, PointerSample, BrushSettings } from './types';

// ---- Smoothing buffer (SAI-style moving average) ----------------------------

export interface SmoothBuffer {
  buf: { x: number; y: number; pressure: number }[];
  size: number;
}

/** Create a per-stroke smoothing buffer.  smoothing 0 = off (size 1), 1 = max (size 20). */
export function createSmoothBuffer(smoothing: number): SmoothBuffer {
  return {
    buf: [],
    size: Math.max(1, Math.round(smoothing * 20)),
  };
}

function smoothWithBuffer(
  sb: SmoothBuffer,
  p: { x: number; y: number; pressure: number },
): { x: number; y: number; pressure: number } {
  sb.buf.push(p);
  if (sb.buf.length > sb.size) sb.buf.shift();

  if (sb.buf.length === 1) return p;

  let sx = 0, sy = 0, sp = 0;
  for (const b of sb.buf) {
    sx += b.x; sy += b.y; sp += b.pressure;
  }
  const n = sb.buf.length;
  return { x: sx / n, y: sy / n, pressure: sp / n };
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

/**
 * Process a raw pointer sample into stamp-ready points.
 *
 * `smoothBuf` is the per-stroke SAI-style moving-average buffer (created
 * via `createSmoothBuffer` at the start of each stroke).
 * `prevStamp` is the last *emitted* stamp (may be null for the first call).
 */
export function processSample(
  smoothBuf: SmoothBuffer,
  prevStamp: StampPoint | null,
  sample: PointerSample,
  brushSettings: BrushSettings,
): StampPoint[] {
  // Feed the raw world position into the SAI stabiliser
  const smoothed = smoothWithBuffer(smoothBuf, {
    x: sample.x,
    y: sample.y,
    pressure: sample.pressure,
  });

  const size = mapPressureToSize(smoothed.pressure, brushSettings.size, brushSettings.pressureSize);
  const opacity = mapPressureToOpacity(smoothed.pressure, brushSettings.opacity, brushSettings.pressureOpacity);

  const stamp: StampPoint = {
    x: smoothed.x,
    y: smoothed.y,
    size,
    opacity,
    pressure: smoothed.pressure,
    tiltX: sample.tiltX,
    tiltY: sample.tiltY,
  };

  if (!prevStamp) return [stamp];

  return interpolateStamps(prevStamp, stamp, brushSettings);
}

// ---- Utility -----------------------------------------------------------------

export function stampCacheKey(size: number, color: string, hardness: number): string {
  return `${size.toFixed(1)}|${color}|${hardness.toFixed(2)}`;
}
