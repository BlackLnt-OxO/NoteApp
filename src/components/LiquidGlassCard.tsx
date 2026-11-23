import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from 'react';
import { watchCardPointerResponse } from './buttonPointerResponse';
import { watchGlassCard } from './liquidGlassSurface';

interface Props extends ComponentPropsWithoutRef<'div'> {
  radius: number;
  dragState?: 'placeholder' | 'preview';
  frostPreview?: boolean;
  noteTint?: string;
}

export default function LiquidGlassCard({
  radius, dragState, frostPreview, noteTint, className, style, ...props
}: Props) {
  const card = useRef<HTMLDivElement>(null);
  const isPreview = dragState === 'preview';
  const skipPointer = Boolean(dragState || frostPreview);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    return watchGlassCard(element, radius, frostPreview ? 'preview' : 'workspace', isPreview);
  }, [isPreview, radius, frostPreview]);

  useLayoutEffect(() => {
    if (card.current && !skipPointer) return watchCardPointerResponse(card.current);
  }, [skipPointer]);

  return <div {...props} ref={card}
    className={className ? `liquid-glass-card ${className}` : 'liquid-glass-card'}
    style={{ ...style, borderRadius: radius, '--note-glass-tint': noteTint } as CSSProperties}
    data-drag-preview={isPreview || undefined}
    data-glass-placeholder={dragState === 'placeholder' || undefined}
    data-pointer-tint={skipPointer ? undefined : noteTint} />;
}
