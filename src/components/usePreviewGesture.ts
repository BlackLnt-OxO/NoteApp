import { useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';

interface PreviewGesture {
  paint: (dx: number, dy: number) => void;
  finish: (dx: number, dy: number, event: PointerEvent) => void;
  reset: () => void;
}

export function boxResizePreview(
  element: HTMLElement,
  dimensions: (dx: number, dy: number) => { width: number; height: number },
  scale: number,
  commit: (width: number, height: number) => void,
): PreviewGesture {
  const { width, height } = element.style;
  return {
    paint(dx, dy) {
      const size = dimensions(dx, dy);
      element.style.width = `${size.width * scale}px`;
      element.style.height = `${size.height * scale}px`;
    },
    finish(dx, dy) {
      const size = dimensions(dx, dy);
      commit(size.width, size.height);
    },
    reset() { element.style.width = width; element.style.height = height; },
  };
}

/** Coalesce a local object preview and publish only the final pointer position. */
export function usePreviewGesture(scope?: string | number | boolean) {
  const cancelGesture = useRef<() => void>();
  useLayoutEffect(() => () => cancelGesture.current?.(), [scope]);

  return useCallback((event: ReactPointerEvent<HTMLElement>, preview: PreviewGesture) => {
    if (event.button !== 0 || cancelGesture.current) return false;
    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let dx = 0;
    let dy = 0;
    let frame: number | undefined;
    const cleanup = () => {
      cancelGesture.current = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cleanup);
      handle.removeEventListener('lostpointercapture', cancel);
      if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
      preview.reset();
    };
    function move(sample: PointerEvent) {
      if (sample.pointerId !== pointer) return;
      dx = sample.clientX - startX;
      dy = sample.clientY - startY;
      if (frame === undefined) frame = requestAnimationFrame(() => {
        frame = undefined;
        preview.paint(dx, dy);
      });
    }
    function release(sample: PointerEvent) {
      if (sample.pointerId !== pointer) return;
      const x = sample.clientX - startX;
      const y = sample.clientY - startY;
      cleanup();
      if (x || y) flushSync(() => preview.finish(x, y, sample));
    }
    function cancel(sample: PointerEvent) {
      if (sample.pointerId === pointer) cleanup();
    }

    cancelGesture.current = cleanup;
    handle.setPointerCapture?.(pointer);
    window.addEventListener('pointermove', move, { capture: true, passive: true });
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cleanup);
    handle.addEventListener('lostpointercapture', cancel);
    return true;
  }, []);
}
