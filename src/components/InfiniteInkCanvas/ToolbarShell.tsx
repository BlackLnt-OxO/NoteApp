/**
 * ToolbarShell — Draggable, resizable toolbar that snaps to left or right edge.
 *
 * - Drag the header strip to reposition or change dock side.
 * - While dragging, the canvas shows a dark overlay.
 * - Release near the left viewport edge → snap to LEFT side.
 * - Release near the right viewport edge → snap to RIGHT side.
 * - Release in the middle → stay on the current side at released position.
 * - Resize handle is always on the canvas-facing side.
 * - When collapsed, a small chevron button is visible on the docked edge.
 * - N key toggles expand / collapse.
 */

import React, { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { useToolbarStore } from './useToolbarStore';
import {
  MIN_TOOLBAR_WIDTH,
  MAX_TOOLBAR_WIDTH,
  RESIZE_HANDLE_WIDTH,
} from './constants';

// ---- Helpers ---------------------------------------------------------------

function shouldIgnoreShortcut(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

// ---- Props -----------------------------------------------------------------

interface Props {
  children: React.ReactNode;
}

// ---- Component -------------------------------------------------------------

const ToolbarShell: React.FC<Props> = ({ children }) => {
  const store = useToolbarStore();
  const {
    expanded, width, top, offset, side,
    toggle, collapse, expand,
    setWidth, setPosition, setSide,
    setIsDragging, setDragCursorX,
    clampPosition, loadState,
  } = store;

  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Minimum width that fits all the toolbar content (so buttons never overlap).
  // Measured from the panel body at its `min-content` size; also used as the
  // resize floor and the collapse trigger threshold.
  const [fitMinWidth, setFitMinWidth] = useState(MIN_TOOLBAR_WIDTH);

  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startOffset: number;
    startTop: number;
    pointerId: number;
  } | null>(null);

  const resizeRef = useRef<{
    startMouseX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const widthRef = useRef(width);
  widthRef.current = width;
  const sideRef = useRef(side);
  sideRef.current = side;

  // ---- Mount / resize ------------------------------------------------------

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    const onResize = () => clampPosition(window.innerWidth, window.innerHeight);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPosition]);

  useEffect(() => {
    if (shellRef.current) containerRef.current = shellRef.current.parentElement;
  }, []);

  // Measure the panel content's natural minimum width so tool buttons never
  // overlap. Re-measures whenever the panel becomes visible.
  const measureContentMin = useCallback((): number => {
    const body = bodyRef.current;
    if (!body) return MIN_TOOLBAR_WIDTH;
    const prevW = body.style.width;
    const prevMinW = body.style.minWidth;
    body.style.width = 'min-content';
    body.style.minWidth = 'min-content';
    const w = body.getBoundingClientRect().width;
    body.style.width = prevW;
    body.style.minWidth = prevMinW;
    return Math.max(MIN_TOOLBAR_WIDTH, Math.ceil(w) + 4);
  }, []);

  useLayoutEffect(() => {
    if (!expanded) return;
    setFitMinWidth(measureContentMin());
  }, [expanded, measureContentMin]);

  // ---- N-key toggle --------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (shouldIgnoreShortcut(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  // ---- Header drag (reposition + snap-to-edge) -----------------------------

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      setIsDragging(true);
      setDragCursorX(e.clientX); // initial cursor position for overlay

      dragRef.current = {
        startMouseX: e.clientX, startMouseY: e.clientY,
        startOffset: offset, startTop: top,
        pointerId: e.pointerId,
      };
    },
    [offset, top, setIsDragging],
  );

  const onHeaderPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.preventDefault(); e.stopPropagation();

      const vpW = containerRef.current?.clientWidth ?? window.innerWidth;
      const vpH = containerRef.current?.clientHeight ?? window.innerHeight;

      // Horizontal delta — sign depends on which side we're on
      let delta: number;
      if (sideRef.current === 'right') {
        // Mouse moving left = delta positive = offset increases
        delta = d.startMouseX - e.clientX;
      } else {
        // Mouse moving right = delta positive = offset increases
        delta = e.clientX - d.startMouseX;
      }

      const nextOffset = Math.max(-20, Math.min(d.startOffset + delta, vpW - 60));
      const nextTop = Math.max(4, Math.min(d.startTop + (e.clientY - d.startMouseY), Math.max(4, vpH - 36)));

      setPosition(nextTop, nextOffset);
      setDragCursorX(e.clientX); // update for real-time overlay zone
    },
    [setPosition, setDragCursorX],
  );

  const onHeaderPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.preventDefault(); e.stopPropagation();
      try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}

      const vpW = containerRef.current?.clientWidth ?? window.innerWidth;

      // Snap to whichever half the toolbar CENTER is over — must match the
      // canvas overlay highlight (center < vpW/2 → left). Read the live
      // offset/width from the store (latest pointer-move position).
      const st = useToolbarStore.getState();
      const tl = st.side === 'left' ? st.offset : vpW - st.offset - st.width;
      const tr = st.side === 'left' ? st.offset + st.width : vpW - st.offset;
      const newSide = (tl + tr) / 2 < vpW / 2 ? 'left' : 'right';
      setSide(newSide);
      // Snap flush: offset = 0 (right against the edge)
      setPosition(d.startTop + (e.clientY - d.startMouseY), 0);

      setIsDragging(false);
      setDragCursorX(0);
      dragRef.current = null;
    },
    [setSide, setPosition, setIsDragging, setDragCursorX],
  );

  // ---- Resize handle -------------------------------------------------------

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      resizeRef.current = {
        startMouseX: e.clientX,
        // Use the rendered width (min-width forces it to ≥ fitMinWidth even if
        // the stored width was persisted smaller).
        startWidth: Math.max(fitMinWidth, widthRef.current),
        pointerId: e.pointerId,
      };
    },
    [fitMinWidth],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rs = resizeRef.current;
      if (!rs || rs.pointerId !== e.pointerId) return;
      e.preventDefault(); e.stopPropagation();

      // Resize handle is always on the canvas-facing edge.
      // side='right' → handle on left → drag left = wider
      // side='left'  → handle on right → drag right = wider
      const delta = sideRef.current === 'right'
        ? rs.startMouseX - e.clientX   // right dock: handle on left
        : e.clientX - rs.startMouseX;  // left dock: handle on right

      let nextWidth = rs.startWidth + delta;

      // Below the content-fit minimum → collapse the toolbar.
      if (nextWidth < fitMinWidth) {
        collapse();
        resizeRef.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
        return;
      }

      nextWidth = Math.max(fitMinWidth, Math.min(MAX_TOOLBAR_WIDTH, nextWidth));
      setWidth(nextWidth);
    },
    [collapse, setWidth, fitMinWidth],
  );

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    e.preventDefault(); e.stopPropagation();
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(resizeRef.current.pointerId); } catch {}
    resizeRef.current = null;
  }, []);

  // ---- Event isolation -----------------------------------------------------

  const stopEvent = useCallback(
    (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => e.stopPropagation(),
    [],
  );

  // ---- RENDER --------------------------------------------------------------

  const isDragging = dragRef.current !== null;
  const isResizing = resizeRef.current !== null;
  const isLeft = side === 'left';

  // Chevron direction: always points toward canvas (away from docked edge)
  const chevron = isLeft ? '▷' : '◁';

  // CSS edge property
  const edgeStyle = isLeft
    ? { left: offset, right: undefined as number | undefined }
    : { left: undefined as number | undefined, right: offset };

  return (
    <>
      {/* ================================================================== */}
      {/* COLLAPSED CHEVRON BUTTON — stuck to the docked edge               */}
      {/* ================================================================== */}
      {!expanded && (
        <button
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top,
            ...(isLeft
              ? { left: 0, borderRadius: '0 6px 6px 0' }
              : { right: 0, borderRadius: '6px 0 0 6px' }),
            zIndex: 101,
            width: 16, height: 48,
            border: 0,
            background: 'rgba(30,30,48,0.94)',
            color: 'rgba(255,255,255,0.7)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '11px', fontWeight: 700, padding: 0,
            boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            ...(isLeft
              ? { borderRight: '1px solid rgba(255,255,255,0.08)' }
              : { borderLeft: '1px solid rgba(255,255,255,0.08)' }),
            transition: 'color 0.15s, background 0.15s, width 0.12s',
          }}
          onMouseEnter={(el) => {
            el.currentTarget.style.width = '22px';
            el.currentTarget.style.color = '#fff';
            el.currentTarget.style.background = 'rgba(50,50,75,0.96)';
          }}
          onMouseLeave={(el) => {
            el.currentTarget.style.width = '16px';
            el.currentTarget.style.color = 'rgba(255,255,255,0.7)';
            el.currentTarget.style.background = 'rgba(30,30,48,0.94)';
          }}
          title={`展开工具栏 (N) — 吸附在${isLeft ? '左' : '右'}侧`}
          aria-label="展开工具栏"
        >
          {chevron}
        </button>
      )}

      {/* ================================================================== */}
      {/* EXPANDED PANEL                                                     */}
      {/* ================================================================== */}
      {expanded && (
        <div
          ref={shellRef}
          className="canvas-toolbar-shell is-expanded"
          style={{
            position: 'absolute',
            top,
            ...edgeStyle,
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            pointerEvents: 'auto',
            width,
            minWidth: fitMinWidth,
            transition: isDragging || isResizing ? 'none' : 'width 160ms ease',
          }}
          onPointerDown={stopEvent}
          onPointerMove={stopEvent}
          onPointerUp={stopEvent}
          onWheel={stopEvent}
        >
          {/* Resize handle — always on the canvas-facing edge */}
          <div
            role="separator"
            className={`toolbar-resize-handle${isResizing ? ' is-resizing' : ''}`}
            style={{
              position: 'absolute',
              ...(isLeft ? { right: 0 } : { left: 0 }),
              top: 0, bottom: 0,
              width: RESIZE_HANDLE_WIDTH, cursor: 'ew-resize',
              touchAction: 'none', zIndex: 2,
              background: 'transparent',
            }}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
          />

          {/* Header strip (drag handle) */}
          <div
            style={{
              cursor: isDragging ? 'grabbing' : 'grab',
              userSelect: 'none',
              padding: '6px 14px 0 14px',
              display: 'flex', alignItems: 'center',
              position: 'sticky', top: 0, zIndex: 3,
              borderRadius: '10px 10px 0 0',
              background: isDragging ? 'rgba(100,130,200,0.15)' : 'transparent',
              transition: 'background 0.15s',
            }}
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={onHeaderPointerUp}
            onPointerCancel={onHeaderPointerUp}
            onMouseEnter={(e) => { if (!isDragging) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
            onMouseLeave={(e) => { if (!isDragging) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span style={{
              fontSize: '12px', fontWeight: 600,
              color: 'var(--text-secondary)',
              pointerEvents: 'none',
              userSelect: 'none',
            }}>
              笔刷工具
            </span>
          </div>

          {/* Panel body */}
          <div ref={bodyRef} style={{
            width: '100%', minWidth: 0,
            overflowY: 'auto', overflowX: 'hidden',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '10px',
            background: 'rgba(30,30,48,0.96)',
            backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.28)',
            maxHeight: 'calc(100vh - 36px)',
          }}>
            {children}
          </div>
        </div>
      )}
    </>
  );
};

export default ToolbarShell;
