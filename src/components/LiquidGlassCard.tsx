import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react';
import { watchGlassCard } from './liquidGlassSurface';

interface Props extends ComponentPropsWithoutRef<'div'> {
  radius: number;
  dragState?: 'placeholder' | 'preview';
  frostPreview?: boolean;
}

export default function LiquidGlassCard({
  radius, dragState, frostPreview, className, style, ...props
}: Props) {
  const card = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element || dragState === 'placeholder') return;
    return watchGlassCard(element, radius, frostPreview ? 'preview' : 'workspace');
  }, [dragState, radius, frostPreview]);

  return <div {...props} ref={card}
    className={className ? `liquid-glass-card ${className}` : 'liquid-glass-card'}
    style={{ ...style, borderRadius: radius }}
    data-drag-preview={dragState === 'preview' || undefined}
    data-pointer-skip={Boolean(dragState || frostPreview) || undefined} />;
}
