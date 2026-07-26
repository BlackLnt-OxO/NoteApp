/**
 * StrokeEngine — Pure-function brush pipeline.
 *
 * Responsibilities:
 * 1. Extract pressure from PointerEvent
 * 2. Smooth raw points to reduce jitter
 * 3. Interpolate stamps between points based on brush spacing
 * 4. Map pressure → size / opacity
 *
 * No React, no DOM, no side effects.
 */

import type { StampPoint, PointerSample, BrushSettings } from './types';

// ---- Pressure extraction -----------------------------------------------------

/** Return a sensible pressure value for any pointer type. */
export function getPressure(e: { pointerType: string; pressure: number }): number {
  if (e.pointerType === 'pen') {
    // Digitizer pens report 0–1; guard against 0 which makes strokes invisible
    return e.pressure > 0.01 ? e.pressure : 0.05;
  }
  // Mouse: no real pressure → fixed midpoint
  return 0.5;
}

// ---- Smoothing ---------------------------------------------------------------

/**
 * Smooth a new point toward the previous point.
 * `amount` is 0–1, where 0 = no smoothing (raw), 1 = maximum smoothing.
 */
export function smoothPoint(
  previous: StampPoint | null,
  next: StampPoint,
  amount: number,
): StampPoint {
  if (!previous) return next;
  const t = 1 - amount; // blend factor toward next (t=1 → raw, t=0 → frozen)
  return {
    ...next,
    x: previous.x + (next.x - previous.x) * t,
    y: previous.y + (next.y - previous.y) * t,
    pressure: previous.pressure + (next.pressure - previous.pressure) * t,
  };
}

// ---- Pressure mapping --------------------------------------------------------

/**
 * Map raw pressure (0–1) to a computed brush size.
 * When disabled, returns baseSize unchanged.
 */
export function mapPressureToSize(
  pressure: number,
  baseSize: number,
  enabled: boolean,
): number {
  if (!enabled) return baseSize;
  const p = Math.max(0.05, Math.min(1, pressure));
  return baseSize * (0.15 + p * 0.85);
}

/**
 * Map raw pressure (0–1) to a computed opacity multiplier.
 * When disabled, returns baseOpacity unchanged.
 */
export function mapPressureToOpacity(
  pressure: number,
  baseOpacity: number,
  enabled: boolean,
): number {
  if (!enabled) return baseOpacity;
  const p = Math.max(0.05, Math.min(1, pressure));
  return baseOpacity * (0.15 + p * 0.85);
}

// ---- Stamp interpolation -----------------------------------------------------

/**
 * Generate stamp points between `from` and `to` such that consecutive stamps
 * are spaced by `brushSize * spacing` world units.
 *
 * Returns an array of StampPoint including the final `to` position
 * (but NOT the `from` position — the caller already added it).
 */
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
    // Close enough — just emit the destination point
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

    const size = mapPressureToSize(
      pressure,
      brushSettings.size,
      brushSettings.pressureSize,
    );
    const opacity = mapPressureToOpacity(
      pressure,
      brushSettings.opacity,
      brushSettings.pressureOpacity,
    );

    results.push({ x, y, size, opacity, pressure, tiltX, tiltY });
  }

  return results;
}

// ---- Main processing entry point ---------------------------------------------

/**
 * Process a raw pointer sample into one or more stamp-ready points.
 *
 * Call this for each coalesced pointer event during a stroke.
 * `prevStamp` is the last emitted stamp (or null for the first point).
 * `sample` is the current raw (world-coordinate) pointer sample.
 *
 * Returns an array of StampPoint ready to be appended to the stroke.
 */
export function processSample(
  prevStamp: StampPoint | null,
  sample: PointerSample,
  brushSettings: BrushSettings,
): StampPoint[] {
  // Compute size & opacity for the raw point
  const rawSize = mapPressureToSize(
    sample.pressure,
    brushSettings.size,
    brushSettings.pressureSize,
  );
  const rawOpacity = mapPressureToOpacity(
    sample.pressure,
    brushSettings.opacity,
    brushSettings.pressureOpacity,
  );

  const rawStamp: StampPoint = {
    x: sample.x,
    y: sample.y,
    size: rawSize,
    opacity: rawOpacity,
    pressure: sample.pressure,
    tiltX: sample.tiltX,
    tiltY: sample.tiltY,
  };

  // Smooth the raw stamp toward the previous stamp
  const smoothed = smoothPoint(prevStamp, rawStamp, brushSettings.smoothing);

  if (!prevStamp) {
    // First point of the stroke — just emit it
    return [smoothed];
  }

  // Interpolate stamps between prevStamp and smoothed
  return interpolateStamps(prevStamp, smoothed, brushSettings);
}

// ---- Utility: stamp hash for off-screen caching -------------------------------

export function stampCacheKey(
  size: number,
  color: string,
  hardness: number,
): string {
  return `${size.toFixed(1)}|${color}|${hardness.toFixed(2)}`;
}
