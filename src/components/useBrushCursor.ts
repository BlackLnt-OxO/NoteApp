import { useCallback, useLayoutEffect, useRef } from 'react';

/** Move only the cursor element; high-rate pen samples must not render the
 * canvas component, traverse all its objects, or reconcile its toolbar. */
export function useBrushCursor(uiScale: number, enabled: boolean) {
  const ringRef = useRef<HTMLDivElement>(null);
  const position = useRef<{ x: number; y: number } | null>(null);
  const config = useRef({ uiScale, enabled });

  const paint = useCallback(() => {
    const el = ringRef.current;
    if (!el) return;
    const p = position.current;
    el.style.visibility = p && config.current.enabled ? 'visible' : 'hidden';
    if (p) {
      const scale = config.current.uiScale;
      el.style.transform = `translate(${p.x / scale}px, ${p.y / scale}px) translate(-50%, -50%)`;
    }
  }, []);

  useLayoutEffect(() => {
    config.current = { uiScale, enabled };
    paint();
  }, [uiScale, enabled, paint]);

  const moveCursor = useCallback((x: number, y: number) => {
    position.current = { x, y };
    paint();
  }, [paint]);
  const hideCursor = useCallback(() => {
    position.current = null;
    paint();
  }, [paint]);
  return { ringRef, moveCursor, hideCursor };
}
