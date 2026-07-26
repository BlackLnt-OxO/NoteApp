/**
 * StrokeEngine — Pure-function brush pipeline with 1€ Filter smoothing.
 *
 * The 1€ Filter (Géry Casiez, 2012) is the gold standard for drawing apps:
 * - Slow strokes → heavy smoothing (removes hand wobble)
 * - Fast strokes → light smoothing (preserves sharp corners)
 * - Used by Photoshop, Procreate, Clip Studio Paint
 *
 * Parameters are mapped from a single 0-1 "smoothing" slider:
 *   smoothing 0   → minCutoff=1.0 Hz  (raw input)
 *   smoothing 0.1 → minCutoff=0.9 Hz  (slight stabilisation — default)
 *   smoothing 1   → minCutoff=0.01 Hz (maximum stabilisation)
 */

import type { StampPoint, PointerSample, BrushSettings } from './types';

// ---- 1€ Filter state ---------------------------------------------------------

export interface OneEuroState {
  prevX: number;
  prevY: number;
  prevP: number;
  prevTimestamp: number;
  dxHat: number; // smoothed derivative (velocity estimate)
  dyHat: number;
}

/** Create initial state at the first input point. */
export function initOneEuro(x: number, y: number, pressure: number, timestamp: number): OneEuroState {
  return { prevX: x, prevY: y, prevP: pressure, prevTimestamp: timestamp, dxHat: 0, dyHat: 0 };
}

// ---- 1€ Filter core ----------------------------------------------------------

const BETA = 0.007;   // speed coefficient (standard value from the paper)
const DCUTOFF = 1.0;  // derivative cutoff in Hz

function oneEuroFilter(
  state: OneEuroState,
  x: number,
  y: number,
  pressure: number,
  timestamp: number,
  minCutoff: number,
): { x: number; y: number; pressure: number; state: OneEuroState } {
  const dt = (timestamp - state.prevTimestamp) / 1000;
  if (dt <= 0 || dt > 1) {
    // First frame or huge gap — reset
    const fresh = initOneEuro(x, y, pressure, timestamp);
    return { x, y, pressure, state: fresh };
  }

  // Compute raw derivative (velocity)
  const dx = (x - state.prevX) / dt;
  const dy = (y - state.prevY) / dt;
  const speed = Math.sqrt(dx * dx + dy * dy);

  // Adapt cutoff: faster motion → higher cutoff → less smoothing
  const cutoff = minCutoff + BETA * speed;

  // Smoothing factor
  const tau = 1 / (2 * Math.PI * cutoff);
  const alpha = 1 / (1 + tau / dt);

  // Smooth position
  const sx = state.prevX + alpha * (x - state.prevX);
  const sy = state.prevY + alpha * (y - state.prevY);

  // Smooth derivative (for next frame's speed estimate)
  const dtau = 1 / (2 * Math.PI * DCUTOFF);
  const dalpha = 1 / (1 + dtau / dt);
  const sdx = state.dxHat + dalpha * (dx - state.dxHat);
  const sdy = state.dyHat + dalpha * (dy - state.dyHat);

  const sp = state.prevP + alpha * (pressure - state.prevP);

  const nextState: OneEuroState = {
    prevX: sx, prevY: sy, prevP: sp,
    prevTimestamp: timestamp,
    dxHat: sdx, dyHat: sdy,
  };

  return { x: sx, y: sy, pressure: sp, state: nextState };
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
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const pressure = from.pressure + (to.pressure - from.pressure) * t;
    results.push({
      x, y,
      size: mapPressureToSize(pressure, brushSettings.size, brushSettings.pressureSize),
      opacity: mapPressureToOpacity(pressure, brushSettings.opacity, brushSettings.pressureOpacity),
      pressure, tiltX: from.tiltX + (to.tiltX - from.tiltX) * t,
      tiltY: from.tiltY + (to.tiltY - from.tiltY) * t,
    });
  }
  return results;
}

// ---- Main entry point --------------------------------------------------------

/**
 * @param oeState — per-stroke 1€ filter state (use `initOneEuro` on first call)
 * @param prevStamp — last emitted stamp
 * @param sample — current raw sample in world coords
 */
export function processSample(
  oeState: OneEuroState | null,
  prevStamp: StampPoint | null,
  sample: PointerSample,
  brushSettings: BrushSettings,
): { stamps: StampPoint[]; state: OneEuroState } {
  // Map smoothing 0-1 → minCutoff 1.0-0.001 Hz
  const minCutoff = 1.0 - brushSettings.smoothing * 0.999;
  const ts = sample.timestamp || Date.now();

  let state: OneEuroState;
  let fx: number, fy: number, fp: number;

  if (!oeState) {
    state = initOneEuro(sample.x, sample.y, sample.pressure, ts);
    fx = sample.x; fy = sample.y; fp = sample.pressure;
  } else {
    const result = oneEuroFilter(oeState, sample.x, sample.y, sample.pressure, ts, minCutoff);
    state = result.state;
    fx = result.x; fy = result.y; fp = result.pressure;
  }

  const stamp: StampPoint = {
    x: fx, y: fy,
    size: mapPressureToSize(fp, brushSettings.size, brushSettings.pressureSize),
    opacity: mapPressureToOpacity(fp, brushSettings.opacity, brushSettings.pressureOpacity),
    pressure: fp,
    tiltX: sample.tiltX,
    tiltY: sample.tiltY,
  };

  if (!prevStamp) return { stamps: [stamp], state };

  return { stamps: interpolateStamps(prevStamp, stamp, brushSettings), state };
}

export function stampCacheKey(size: number, color: string, hardness: number): string {
  return `${size.toFixed(1)}|${color}|${hardness.toFixed(2)}`;
}
