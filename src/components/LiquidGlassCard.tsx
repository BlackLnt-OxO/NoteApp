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
  const isPreview = dragState === 'preview';
  const skipPointer = Boolean(dragState || frostPreview);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    return watchGlassCard(element, radius, frostPreview ? 'preview' : 'workspace', isPreview);
  }, [isPreview, radius, frostPreview]);

  return <div {...props} ref={card}
    className={className ? `liquid-glass-card ${className}` : 'liquid-glass-card'}
    style={{ ...style, borderRadius: radius }}
    data-drag-preview={isPreview || undefined}
    data-glass-placeholder={dragState === 'placeholder' || undefined}
    data-pointer-skip={skipPointer || undefined} />;
}
