import { useEffect, type RefObject } from 'react';

// Automatic persistence must not serialize an entire document while the pen is
// down. Keep this outside React/Zustand so input does not notify subscribers.
const activeInputs = new Set<symbol>();
let lastInputEnd = -Infinity;

export function isInkInputBusy(): boolean {
  return activeInputs.size > 0 || performance.now() - lastInputEnd < 200;
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
