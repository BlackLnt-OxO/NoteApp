/**
 * FlowGrid — generic "sticky-note style" flow layout with drag-to-reorder.
 *
 * Cards are laid out left→right with auto-wrap, each respecting a fixed
 * itemWidth/itemHeight (callers control the card chrome via renderCard). Dragging
 * uses hand-written pointer events (threshold-gated so a plain click still fires
 * onCardClick) and reorders by swapping the nearest neighbor's index.
 *
 * Position persistence is just the array order — callers persist the array.
 */

import React, { useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { useGlassEntrance } from './useGlassEntrance';
import { useCardDrag } from './useCardDrag';
import { useCardGridMotion } from './useCardGridMotion';
import { useSharedGlass } from './useSharedGlass';

const PAD = 28;

export interface FlowGridProps<T> {
  items: T[];
  itemWidth: number;
  itemHeight: number;
  gap: number;
  category?: string | null;
  getId: (item: T) => string;
  /** Renders one card; `hovered` toggles hover-action buttons. */
  renderCard: (item: T, index: number, hovered: boolean, dragState?: 'placeholder' | 'preview') => React.ReactNode;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onCardClick?: (item: T) => void;
  empty?: React.ReactNode;
}

export function FlowGrid<T>({
  items, itemWidth, itemHeight, gap, category, getId, renderCard, onReorder, onCardClick, empty,
}: FlowGridProps<T>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measureWidth = () => setContainerWidth(container.clientWidth);
    measureWidth();
    const observer = new ResizeObserver(measureWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const positions = useMemo(() => {
    const out: { x: number; y: number; row: number }[] = [];
    if (containerWidth === null) return out;

    let rowY = PAD, rowH = 0, colX = PAD, row = 0;
    const maxRight = containerWidth - PAD;
    for (let i = 0; i < items.length; i++) {
      if (colX + itemWidth > maxRight && i > 0) {
        row++;
        rowY += rowH + gap;
        colX = PAD;
        rowH = 0;
      }
      out.push({ x: colX, y: rowY, row });
      colX += itemWidth + gap;
      rowH = Math.max(rowH, itemHeight);
    }
    return out;
  }, [containerWidth, items.length, itemWidth, itemHeight, gap]);

  const glassGridRef = useGlassEntrance(positions.length > 0);

  const totalHeight = useMemo(() => {
    if (positions.length === 0) return PAD * 2;
    const last = positions[positions.length - 1];
    return last.y + itemHeight + PAD;
  }, [positions, itemHeight]);

  const reorder = useCallback((id: string, x: number, y: number) => {
    const srcIdx = items.findIndex(item => getId(item) === id);
    if (srcIdx === -1) return;
    // Find the nearest card center (excluding the dragged one).
    let targetIdx = items.length;
    let best = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (i === srcIdx) continue;
      const p = positions[i];
      const d = Math.hypot(x - (p.x + itemWidth / 2), y - (p.y + itemHeight / 2));
      if (d < best) { best = d; targetIdx = i; }
    }
    if (targetIdx < items.length && targetIdx !== srcIdx) onReorder(srcIdx, targetIdx);
  }, [items, getId, positions, itemWidth, itemHeight, onReorder]);

  const { preview, start, setGhost, landing, didDrag } = useCardDrag(containerRef, category ?? undefined, reorder);
  const cardPositions = useMemo(() => new Map(positions.map((pos, i) => [getId(items[i]), pos])), [positions, items, getId]);
  useCardGridMotion(containerRef, glassGridRef, category ?? undefined, cardPositions, preview?.id ?? null, landing);
  const sharedGlass = useSharedGlass(containerRef, glassGridRef);
  const ghostIndex = preview ? items.findIndex(item => getId(item) === preview.id) : -1;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <canvas ref={sharedGlass} className="shared-glass-layer" hidden aria-hidden="true" />
      <div ref={containerRef} data-glass-scroll-container data-grid-dragging={preview ? '' : undefined}
        style={{ position: 'relative', zIndex: 1, width: '100%', height: '100%', overflow: 'auto', scrollbarGutter: 'stable', touchAction: 'none' }}>
        <div ref={glassGridRef} style={{ position: 'relative', minHeight: totalHeight }}>
        {positions.map((pos, idx) => {
          const item = items[idx];
          const id = getId(item);
          const isDraggingCard = preview?.id === id;
          return (
            <div
              key={id}
              className="flow-card"
              data-grid-card-id={id}
              onPointerDown={e => {
                if (e.target instanceof Element && e.target.closest('button, a, input, select, textarea')) return;
                start(e, id, e.currentTarget);
              }}
              onMouseEnter={() => setHoverId(id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={e => {
                e.stopPropagation();
                if (!didDrag.current || e.detail === 0) onCardClick?.(item);
              }}
              style={{
                position: 'absolute', left: pos.x, top: pos.y,
                width: itemWidth, height: itemHeight,
                opacity: isDraggingCard ? 0.25 : 1,
                zIndex: isDraggingCard ? 0 : 2,
              }}
            >
              {renderCard(item, idx, hoverId === id, isDraggingCard ? 'placeholder' : undefined)}
            </div>
          );
        })}
        {items.length === 0 && empty}
        </div>
      </div>
      {preview && ghostIndex !== -1 && (
        <div ref={setGhost} aria-hidden="true" style={{
          position: 'absolute', left: 0, top: 0, width: preview.width, height: preview.height,
          zIndex: 9999, pointerEvents: 'none', willChange: 'transform',
        }}>
          {renderCard(items[ghostIndex], ghostIndex, false, 'preview')}
        </div>
      )}
    </div>
  );
}

export default FlowGrid;
