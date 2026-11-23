import { useLayoutEffect, useRef, type RefObject } from 'react';
import { prepareGlassCards } from './liquidGlassSurface';
import type { GridDrop } from './useCardDrag';
import { GLASS_LAYOUT_START } from './useSharedGlass';
import { finishNoteMeasure, startNoteMeasure } from './noteMotionMetrics';

type Point = { x: number; y: number };
type CardPosition = Point & { row?: number };
type Move = { element: HTMLElement; from: Point };
type PendingMoves = { arrivals: HTMLElement[]; moves: Move[]; cancel?: () => void };

export const GRID_MOVE_DURATION = 200;

export function useCardGridMotion(
  scrollRef: RefObject<HTMLDivElement>, gridRef: RefObject<HTMLDivElement>,
  tag: string | undefined, positions: ReadonlyMap<string, CardPosition>, draggingId: string | null,
  dropRef: { current: GridDrop | null },
  mountedIds?: ReadonlySet<string>,
) {
  const previous = useRef<{ tag: string | undefined; positions: ReadonlyMap<string, CardPosition>; mountedIds?: ReadonlySet<string> }>();
  const animations = useRef(new Map<HTMLElement, Animation>());
  const pending = useRef<PendingMoves>();

  useLayoutEffect(() => {
    const grid = gridRef.current;
    return () => {
      pending.current?.cancel?.();
      pending.current = undefined;
      for (const animation of animations.current.values()) animation.cancel();
      animations.current.clear();
      if (grid) {
        delete grid.dataset.gridSettling;
        delete grid.dataset.glassLayoutPending;
      }
    };
  }, [gridRef]);

  useLayoutEffect(() => {
    const last = previous.current;
    if (!last && !positions.size) return;
    previous.current = { tag, positions, mountedIds };
    const scroll = scrollRef.current;
    const grid = gridRef.current;
    if (!last || !scroll || !grid) return;

    const drop = draggingId === null ? dropRef.current : null;
    if (drop) dropRef.current = null;
    const tagChanged = last.tag !== tag;
    const lastOrder = [...last.positions.keys()];
    const orderChanged = lastOrder.length !== positions.size
      || [...positions.keys()].some((id, index) => id !== lastOrder[index]);
    const sidebarReflow = !tagChanged && !orderChanged && !drop;
    if (sidebarReflow && (!Array.from(positions).some(([id, point]) => point.row !== last.positions.get(id)?.row)
      || !scroll.closest('[data-ink-workspace]')?.querySelector('.workspace-sidebar-track')?.getAnimations?.().length)) return;

    const measure = mountedIds && startNoteMeasure();
    const waiting = pending.current;
    waiting?.cancel?.();
    pending.current = undefined;
    const stillArriving = new Set(waiting?.arrivals);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const moves: Move[] = [];
    const arrivals: HTMLElement[] = [];
    const surfaces: Element[] = [];
    const elements = Array.from(grid.querySelectorAll<HTMLElement>('[data-grid-card-id]'));
    const minY = scroll.scrollTop;
    const maxY = minY + scroll.clientHeight;
    const minX = scroll.scrollLeft;
    const maxX = minX + scroll.clientWidth;

    // Read positions and current animation offsets before writing any transforms.
    for (const element of elements) {
      const id = element.dataset.gridCardId!;
      const next = positions.get(id)!;
      const old = !last.mountedIds || last.mountedIds.has(id) ? last.positions.get(id) : undefined;
      if (sidebarReflow && old?.row === next.row && !animations.current.has(element)) continue;
      const comesFromDrop = drop?.id === id;
      const from = comesFromDrop ? drop : old;
      const width = parseFloat(element.style.width);
      const height = parseFloat(element.style.height);
      const visible = (point: Point) => point.x < maxX && point.x + width > minX
        && point.y < maxY && point.y + height > minY;
      const isVisible = visible(next);
      const crossesViewport = isVisible || (from !== undefined && visible(from));
      const isArriving = ((tagChanged && !old) || stillArriving.has(element)) && isVisible;
      const surface = element.firstElementChild;
      if (!mountedIds && surface && ((tagChanged && isVisible) || (drop && crossesViewport))) surfaces.push(surface);
      if (isArriving) {
        arrivals.push(element);
        if (!reduce) moves.push({ element, from: { x: 0, y: 8 } });
        continue;
      }
      if (reduce || !from || !crossesViewport) continue;
      const transform = !comesFromDrop && (animations.current.has(element) || element.style.transform)
        ? getComputedStyle(element).transform : 'none';
      const offset = transform === 'none' ? null : new DOMMatrixReadOnly(transform);
      const x = from.x - next.x + (offset?.m41 ?? 0);
      const y = from.y - next.y + (offset?.m42 ?? 0);
      if (Math.abs(x) >= .5 || Math.abs(y) >= .5) moves.push({ element, from: { x, y } });
    }

    grid.toggleAttribute('data-glass-layout-pending', !mountedIds && moves.length > 0);
    if (moves.length) grid.dispatchEvent(new Event(GLASS_LAYOUT_START));
    for (const [element, animation] of animations.current) {
      animation.cancel();
      delete element.dataset.gridLayoutMoving;
    }
    animations.current.clear();
    for (const { element } of waiting?.moves ?? []) element.style.removeProperty('transform');
    for (const element of stillArriving) element.style.removeProperty('visibility');
    if (surfaces.length) for (const element of arrivals) element.style.visibility = 'hidden';
    for (const { element, from } of moves) {
      element.style.transform = `translate(${from.x}px, ${from.y}px)`;
    }

    const batch: PendingMoves = { arrivals, moves };
    pending.current = batch;
    const reveal = () => {
      if (pending.current !== batch) return;
      pending.current = undefined;
      delete grid.dataset.glassLayoutPending;
      for (const element of arrivals) element.style.removeProperty('visibility');
      if (moves.length) grid.dataset.gridSettling = '';
      else delete grid.dataset.gridSettling;
      for (const { element, from } of moves) {
        element.style.removeProperty('transform');
        const animation = element.animate(
          [{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: 'none' }],
          { duration: GRID_MOVE_DURATION, easing: 'cubic-bezier(.2,.7,.25,1)' },
        );
        element.dataset.gridLayoutMoving = '';
        animations.current.set(element, animation);
        animation.onfinish = () => {
          if (animations.current.get(element) !== animation) return;
          animations.current.delete(element);
          delete element.dataset.gridLayoutMoving;
          if (!animations.current.size) delete grid.dataset.gridSettling;
        };
      }
    };
    batch.cancel = surfaces.length ? prepareGlassCards(surfaces, reveal) : undefined;
    if (!surfaces.length) reveal();
    finishNoteMeasure('note-grid-motion', measure);
  }, [tag, positions, draggingId, dropRef, gridRef, scrollRef, mountedIds]);
}
