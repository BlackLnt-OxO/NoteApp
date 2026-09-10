/**
 * inkPerf — dev-only timing for the whole-stroke eraser ("擦除笔画"). Answers where
 * the per-frame cost actually goes on a stroke-dense page — shared by both ink surfaces:
 *   1. hit-scan of nearby strokes (flushStrokeWipe),
 *   2. clearing + re-stamping tiles after each erase (applyVisualErase).
 *
 * Counters live for one pointer-down→up gesture and are logged on release.
 * Everything is a no-op unless Vite dev (import.meta.env.DEV), so prod builds
 * and vitest pay nothing.
 */

export interface EraserPerf {
  frames: number;      // flush frames that performed a hit-scan
  candidates: number;  // total strokes scanned by those frames
  targets: number;     // strokes visually erased
  scanMs: number;      // total hit-scan time
  restampMs: number;   // total tile clear/re-stamp time
  worstScanMs: number; // slowest single flush scan
}

export function createEraserPerf(): EraserPerf | null {
  if (!import.meta.env.DEV) return null;
  return { frames: 0, candidates: 0, targets: 0, scanMs: 0, restampMs: 0, worstScanMs: 0 };
}

export function addEraserScan(p: EraserPerf | null, frames: number, candidates: number, ms: number): void {
  if (!p) return;
  p.frames += frames;
  p.candidates += candidates;
  p.scanMs += ms;
  if (ms > p.worstScanMs) p.worstScanMs = ms;
}

export function addEraserRestamp(p: EraserPerf | null, targets: number, ms: number): void {
  if (!p) return;
  p.targets += targets;
  p.restampMs += ms;
}

export function logEraserPerf(p: EraserPerf | null, view: 'canvas' | 'pdf'): void {
  if (!p) return;
  if (p.frames === 0 && p.targets === 0) return;
  const n = Math.max(1, p.frames);
  const perErase = Math.max(1, p.targets);
  console.log(
    `[eraser:${view}] frames=${p.frames} scanned=${p.candidates} erased=${p.targets} ` +
    `avgScan=${(p.scanMs / n).toFixed(2)}ms/frame worstScan=${p.worstScanMs.toFixed(2)}ms ` +
    `restamp=${(p.restampMs / perErase).toFixed(2)}ms/erase totalRestamp=${p.restampMs.toFixed(1)}ms`,
  );
}
