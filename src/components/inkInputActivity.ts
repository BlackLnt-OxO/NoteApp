import { useEffect, type RefObject } from 'react';

// Automatic persistence must not serialize an entire document while the pen is
// down. Keep this outside React/Zustand so input does not notify subscribers.
const activeInputs = new Set<symbol>();
let lastInputEnd = -Infinity;
/** Pointer holds the canvas's own listeners never see (a middle-button pan is
 *  intercepted by the container's capture-phase listener, so no pointerdown
 *  reaches the canvas) — persistence must defer for them all the same. */
let holdCount = 0;

export const INK_STROKE_START = 'ink:stroke-start';

export function notifyInkStrokeStart(pointerId: number): void {
  window.dispatchEvent(new CustomEvent(INK_STROKE_START, { detail: pointerId }));
}

export function isInkPointerActive(): boolean {
  return activeInputs.size > 0 || holdCount > 0;
}

export function isInkInputBusy(): boolean {
  return isInkPointerActive() || performance.now() - lastInputEnd < 200;
}

/** Claim/release a pointer hold for gestures the canvas's input listeners miss. */
export function setPointerHold(active: boolean): void {
  holdCount = Math.max(0, holdCount + (active ? 1 : -1));
  if (!active) lastInputEnd = performance.now();
}

export function useInkInputActivity(canvasRef: RefObject<HTMLCanvasElement>): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const token = Symbol('ink input');
    const pointers = new Set<number>();
    const start = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      activeInputs.add(token);
    };
    const end = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size === 0) activeInputs.delete(token);
      lastInputEnd = performance.now();
    };
    const blur = () => {
      if (pointers.size === 0) return;
      pointers.clear();
      activeInputs.delete(token);
      lastInputEnd = performance.now();
    };
    window.addEventListener('blur', blur);
    canvas.addEventListener('pointerdown', start, true);
    canvas.addEventListener('lostpointercapture', end);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    return () => {
      activeInputs.delete(token);
      window.removeEventListener('blur', blur);
      canvas.removeEventListener('pointerdown', start, true);
      canvas.removeEventListener('lostpointercapture', end);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
    };
  }, [canvasRef]);
}
