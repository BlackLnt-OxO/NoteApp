import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type PointerEvent } from 'react';
import { watchGlassCard } from './liquidGlassSurface';

interface Props extends ComponentPropsWithoutRef<'div'> {
  radius: number;
  dragState?: 'placeholder' | 'preview';
  frostPreview?: boolean;
}

export default function LiquidGlassCard({
  radius, dragState, frostPreview, className, style, onPointerMove, onPointerLeave, ...props
}: Props) {
  const card = useRef<HTMLDivElement>(null);
  const frame = useRef<number>();
  const pointer = useRef({ x: 0, y: 0 });
  const reducedMotion = useRef<MediaQueryList | undefined>();

  useLayoutEffect(() => {
    const element = card.current;
    if (!element || dragState === 'placeholder') return;
    reducedMotion.current = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const unwatch = watchGlassCard(element, radius, frostPreview ? 'preview' : 'workspace');
    return () => {
      clearLight(element);
      unwatch?.();
    };
  }, [dragState, radius, frostPreview]);

  function clearLight(element: HTMLDivElement) {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    delete element.dataset.glassLight;
    element.style.removeProperty('--glass-light-x');
    element.style.removeProperty('--glass-light-y');
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    onPointerMove?.(event);
    const element = event.currentTarget;
    if (event.pointerType !== 'mouse' || reducedMotion.current?.matches || dragState) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (frame.current !== undefined) return;

    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.max(0, Math.min(1, (pointer.current.x - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (pointer.current.y - rect.top) / rect.height));
      element.style.setProperty('--glass-light-x', `${(x * 100).toFixed(1)}%`);
      element.style.setProperty('--glass-light-y', `${(y * 100).toFixed(1)}%`);
      element.dataset.glassLight = 'true';
    });
  }

  return <div {...props} ref={card}
    className={className ? `liquid-glass-card ${className}` : 'liquid-glass-card'}
    style={{ ...style, borderRadius: radius }}
    data-drag-preview={dragState === 'preview' || undefined}
    onPointerMove={move}
    onPointerLeave={event => {
      clearLight(event.currentTarget);
      onPointerLeave?.(event);
    }} />;
}
