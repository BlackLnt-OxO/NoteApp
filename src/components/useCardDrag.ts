import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useNoteStore } from '../store';

export type GridDrop = { id: string; x: number; y: number };

interface CardSize { id: string; width: number; height: number }
interface Gesture extends CardSize {
  pointer: number;
  scale: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  active: boolean;
}

const DRAG_THRESHOLD = 5;

export function useCardDrag(
  viewportRef: RefObject<HTMLDivElement>,
  scope: string | undefined,
  onDrop: (id: string, pointerX: number, pointerY: number) => void,
  onStart?: () => void,
) {
  const [preview, setPreview] = useState<CardSize | null>(null);
  const scale = useNoteStore(state => state.uiScale);
  const callbacks = useRef({ onStart, onDrop });
  const session = useRef<{ dispose: (resetPreview?: boolean) => void }>();
  const ghost = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture>();
  const landing = useRef<GridDrop | null>(null);
  const didDrag = useRef(false);

  useLayoutEffect(() => { callbacks.current = { onStart, onDrop }; }, [onStart, onDrop]);
  useLayoutEffect(() => {
    session.current?.dispose();
  }, [scope, scale]);
  useLayoutEffect(() => () => session.current?.dispose(false), []);

  const paint = useCallback(() => {
    const drag = gesture.current;
    if (!drag?.active || !ghost.current) return;
    const x = (drag.x - drag.originX) / drag.scale;
    const y = (drag.y - drag.originY) / drag.scale;
    ghost.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  const setGhost = useCallback((node: HTMLDivElement | null) => {
    ghost.current = node;
    if (node) {
      node.inert = true;
      paint();
    }
  }, [paint]);

  const start = useCallback((event: React.PointerEvent, id: string, card: HTMLElement) => {
    const target = viewportRef.current;
    if (event.button !== 0 || !target || session.current) return;
    const viewport: HTMLDivElement = target;

    const bounds = card.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    const drag: Gesture = {
      id, width: card.offsetWidth, height: card.offsetHeight,
      pointer: event.pointerId, scale: useNoteStore.getState().uiScale,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      originX: area.left + event.clientX - bounds.left,
      originY: area.top + event.clientY - bounds.top,
      active: false,
    };
    gesture.current = drag;
    didDrag.current = false;
    let frame: number | undefined;

    const dispose = (resetPreview = true) => {
      if (gesture.current !== drag) return;
      gesture.current = undefined;
      session.current = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', blur);
      viewport.removeEventListener('lostpointercapture', cancel);
      if (viewport.hasPointerCapture(drag.pointer)) viewport.releasePointerCapture(drag.pointer);
      if (resetPreview && drag.active) setPreview(null);
    };
    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== drag.pointer) return;
      drag.x = pointer.clientX;
      drag.y = pointer.clientY;
      if (!drag.active) {
        if (Math.max(Math.abs(drag.x - drag.startX), Math.abs(drag.y - drag.startY)) <= DRAG_THRESHOLD) return;
        drag.active = true;
        didDrag.current = true;
        viewport.setPointerCapture(drag.pointer);
        // Mount the preview before the first frame that crosses the threshold.
        flushSync(() => {
          callbacks.current.onStart?.();
          setPreview({ id, width: drag.width, height: drag.height });
        });
        return;
      }
      if (frame === undefined) frame = requestAnimationFrame(() => {
        frame = undefined;
        paint();
      });
    }
    function release(pointer: PointerEvent) {
      if (pointer.pointerId !== drag.pointer) return;
      if (!drag.active) {
        dispose();
        return;
      }
      const area = viewport.getBoundingClientRect();
      const scrollX = viewport.scrollLeft;
      const scrollY = viewport.scrollTop;
      landing.current = {
        id,
        x: (pointer.clientX - drag.originX) / drag.scale + scrollX,
        y: (pointer.clientY - drag.originY) / drag.scale + scrollY,
      };
      const x = (pointer.clientX - area.left) / drag.scale + scrollX;
      const y = (pointer.clientY - area.top) / drag.scale + scrollY;
      dispose(false);
      flushSync(() => {
        callbacks.current.onDrop(id, x, y);
        setPreview(null);
      });
    }
    function cancel(pointer: PointerEvent) {
      if (pointer.pointerId === drag.pointer) dispose();
    }
    const blur = () => dispose();
    session.current = { dispose };
    window.addEventListener('pointermove', move, { capture: true, passive: true });
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', blur);
    viewport.addEventListener('lostpointercapture', cancel);
  }, [paint, viewportRef]);

  return { preview, setGhost, start, landing, didDrag };
}
