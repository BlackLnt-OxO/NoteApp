import { useLayoutEffect, useState, type MutableRefObject, type RefObject } from 'react';

export const INK_EDITOR_NAV_HEIGHT = 44;

export interface InkViewportSize {
  width: number;
  height: number;
}

interface InkViewportOptions {
  container: RefObject<HTMLElement>;
  bounds: MutableRefObject<DOMRect | null>;
  capacity: MutableRefObject<InkViewportSize | null>;
  dpr: MutableRefObject<number>;
  uiScale: number;
  repaint: () => void;
  requestTiles: () => void;
}

/** Measure visual pixels for input and tile requests, reserving enough backing
 * space for the editor with its side rails closed and its compact header gone. */
export function useInkViewport({ container, bounds, capacity, dpr, uiScale, repaint, requestTiles }: InkViewportOptions) {
  const [extent, setExtent] = useState<InkViewportSize | null>(null);

  useLayoutEffect(() => {
    const editor = container.current;
    if (!editor) return;
    const workspace = editor.closest<HTMLElement>('[data-ink-workspace]');
    let previous: InkViewportSize | undefined;
    const measure = (force = false) => {
      const rect = editor.getBoundingClientRect();
      const frame = workspace?.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      const densityChanged = pixelRatio !== dpr.current;
      const viewportChanged = previous?.width !== rect.width || previous?.height !== rect.height;
      previous = rect;
      bounds.current = rect;
      dpr.current = pixelRatio;

      const width = Math.ceil(frame?.width ?? rect.width);
      const height = Math.ceil(frame ? Math.max(0, frame.height - INK_EDITOR_NAV_HEIGHT * uiScale) : rect.height);
      const sizeChanged = width !== capacity.current?.width || height !== capacity.current?.height;
      if (sizeChanged) {
        const size = { width, height };
        capacity.current = size;
        setExtent(size);
      }
      if (force || densityChanged || sizeChanged) repaint();
      if (force || densityChanged || viewportChanged) requestTiles();
    };
    const refresh = () => measure();
    measure(true);

    const observer = new ResizeObserver(refresh);
    observer.observe(editor);
    if (workspace) observer.observe(workspace);
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);

    // A move between monitors can change the density without changing the box.
    let density: MediaQueryList | undefined;
    const watchDensity = () => {
      density?.removeEventListener('change', onDensityChange);
      density = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      density?.addEventListener('change', onDensityChange);
    };
    const onDensityChange = () => { refresh(); watchDensity(); };
    watchDensity();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      density?.removeEventListener('change', onDensityChange);
    };
  }, [container, bounds, capacity, dpr, uiScale, repaint, requestTiles]);

  return extent;
}
