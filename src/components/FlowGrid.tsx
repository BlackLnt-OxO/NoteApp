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

import React, { useState, useRef, useCallback, useMemo } from 'react';

const DRAG_THRESHOLD = 5;
const PAD = 28;

export interface FlowGridProps<T> {
  items: T[];
  itemWidth: number;
  itemHeight: number;
  gap: number;
  getId: (item: T) => string;
  /** Renders one card; `hovered` toggles hover-action buttons. */
  renderCard: (item: T, index: number, hovered: boolean) => React.ReactNode;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onCardClick?: (item: T) => void;
  empty?: React.ReactNode;
}

export function FlowGrid<T>({
  items, itemWidth, itemHeight, gap, getId, renderCard, onReorder, onCardClick, empty,
}: FlowGridProps<T>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{
    index: number; startX: number; startY: number; offsetX: number; offsetY: number; pointerId: number;
  } | null>(null);
  const [dragging, setDragging] = useState<{
    index: number; ghostX: number; ghostY: number; offsetX: number; offsetY: number;
  } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const didDragRef = useRef(false);

  const positions = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    let rowY = PAD, rowH = 0, colX = PAD;
    const maxRight = (containerRef.current?.clientWidth || 900) - PAD;
    for (let i = 0; i < items.length; i++) {
      if (colX + itemWidth > maxRight && i > 0) {
        rowY += rowH + gap;
        colX = PAD;
        rowH = 0;
      }
      out.push({ x: colX, y: rowY });
      colX += itemWidth + gap;
      rowH = Math.max(rowH, itemHeight);
    }
    return out;
  }, [items.length, itemWidth, itemHeight, gap]);

  const totalHeight = useMemo(() => {
    if (positions.length === 0) return PAD * 2;
    const last = positions[positions.length - 1];
    return last.y + itemHeight + PAD;
  }, [positions, itemHeight]);

  const onCardPointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const card = (e.currentTarget as HTMLElement).closest('.flow-card') as HTMLElement;
    const rect = card?.getBoundingClientRect();
    const offsetX = rect ? e.clientX - rect.left : itemWidth / 2;
    const offsetY = rect ? e.clientY - rect.top : 20;
    if (containerRef.current) containerRef.current.setPointerCapture(e.pointerId);
    setPending({ index, startX: e.clientX, startY: e.clientY, offsetX, offsetY, pointerId: e.pointerId });
  }, [itemWidth]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (pending && !dragging) {
      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        didDragRef.current = true;
        setDragging({
          index: pending.index,
          ghostX: e.clientX - pending.offsetX, ghostY: e.clientY - pending.offsetY,
          offsetX: pending.offsetX, offsetY: pending.offsetY,
        });
      }
      return;
    }
    if (dragging) {
      setDragging((prev) => prev ? { ...prev, ghostX: e.clientX - prev.offsetX, ghostY: e.clientY - prev.offsetY } : null);
    }
  }, [pending, dragging]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (containerRef.current && containerRef.current.hasPointerCapture(e.pointerId)) {
      containerRef.current.releasePointerCapture(e.pointerId);
    }
    if (pending && !dragging) { setPending(null); return; }
    if (!dragging) return;

    const srcIdx = dragging.index;
    const rect = containerRef.current?.getBoundingClientRect();
    const st = containerRef.current?.scrollTop ?? 0;
    const sl = containerRef.current?.scrollLeft ?? 0;
    const absX = rect ? e.clientX - rect.left + sl : 0;
    const absY = rect ? e.clientY - rect.top + st : 0;

    // Find the nearest card center (excluding the dragged one).
    let targetIdx = items.length;
    let best = Infinity;
    for (let i = 0; i < items.length; i++) {
      if (i === srcIdx) continue;
      const p = positions[i];
      const d = Math.hypot(absX - (p.x + itemWidth / 2), absY - (p.y + itemHeight / 2));
      if (d < best) { best = d; targetIdx = i; }
    }
    if (targetIdx < items.length && targetIdx !== srcIdx) onReorder(srcIdx, targetIdx);

    setDragging(null);
    setPending(null);
    // Let the click event (fired after pointerup) see the drag flag, then clear it.
    setTimeout(() => { didDragRef.current = false; }, 0);
  }, [pending, dragging, items, positions, itemWidth, itemHeight, onReorder]);

  const handleClick = useCallback((item: T) => {
    if (didDragRef.current) return;
    onCardClick?.(item);
  }, [onCardClick]);

  return (
    <div
      ref={containerRef}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', touchAction: 'none' }}
    >
      <div style={{ position: 'relative', minHeight: totalHeight }}>
        {items.map((item, idx) => {
          const pos = positions[idx] || { x: PAD, y: PAD };
          const isDraggingCard = dragging?.index === idx;
          const id = getId(item);
          return (
            <div
              key={id}
              className="flow-card"
              onPointerDown={(e) => onCardPointerDown(e, idx)}
              onMouseEnter={() => setHoverId(id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={(e) => { e.stopPropagation(); handleClick(item); }}
              style={{
                position: 'absolute', left: pos.x, top: pos.y,
                width: itemWidth, height: itemHeight,
                transition: 'left 0.25s ease, top 0.25s ease',
                opacity: isDraggingCard ? 0.25 : 1,
                zIndex: isDraggingCard ? 0 : 2,
              }}
            >
              {renderCard(item, idx, hoverId === id)}
            </div>
          );
        })}
        {items.length === 0 && empty}
      </div>
      {dragging && (() => {
        const ghost = items[dragging.index];
        return ghost ? (
          <div style={{
            position: 'fixed', left: dragging.ghostX, top: dragging.ghostY,
            width: itemWidth, height: itemHeight, zIndex: 9999, pointerEvents: 'none',
            opacity: 0.85, filter: 'drop-shadow(0 12px 32px rgba(0,0,0,0.4))',
          }}>
            {renderCard(ghost, dragging.index, false)}
          </div>
        ) : null;
      })()}
    </div>
  );
}

export default FlowGrid;
