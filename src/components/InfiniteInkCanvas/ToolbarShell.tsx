/**
 * ToolbarShell — Draggable, resizable, right-edge auto-collapsing toolbar frame.
 *
 * - Docked to the right side of the canvas by default.
 * - Drag the header strip to reposition anywhere.
 * - Drag the left-edge resize handle to change width.
 * - Auto-collapses into a small 「<」button on the right edge when
 *   dragged to the viewport edge or narrowed below threshold.
 * - N key toggles expand / collapse.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { useToolbarStore } from './useToolbarStore';
import {
  MIN_TOOLBAR_WIDTH,
  MAX_TOOLBAR_WIDTH,
  TOOLBAR_COLLAPSE_WIDTH,
  AUTO_COLLAPSE_EDGE_PX,
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
  const {
    expanded,
    width,
    top,
    rightOffset,
    toggle,
    collapse,
    setWidth,
    setPosition,
    clampPosition,
    loadState,
  } = useToolbarStore();

  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startRight: number;
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

  // ---- Mount / resize ------------------------------------------------------

  useEffect(() => { loadState(); }, [loadState]);

  useEffect(() => {
    const onResize = () => clampPosition(window.innerWidth, window.innerHeight);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPosition]);

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

  useEffect(() => {
    if (shellRef.current) containerRef.current = shellRef.current.parentElement;
  }, []);

  // ---- Header drag ---------------------------------------------------------

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startMouseX: e.clientX, startMouseY: e.clientY,
        startRight: rightOffset, startTop: top,
        pointerId: e.pointerId,
      };
    },
    [rightOffset, top],
  );

  const onHeaderPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      e.preventDefault(); e.stopPropagation();

      const dx = d.startMouseX - e.clientX;
      const dy = e.clientY - d.startMouseY;
      const vpW = containerRef.current?.clientWidth ?? window.innerWidth;
      const vpH = containerRef.current?.clientHeight ?? window.innerHeight;

      let nextRight = d.startRight + dx;
      const nextTop = Math.max(4, Math.min(d.startTop + dy, Math.max(4, vpH - 36)));
      nextRight = Math.max(-20, Math.min(nextRight, vpW - 60));

      // Auto-collapse when dragged to right edge
      if (nextRight <= AUTO_COLLAPSE_EDGE_PX && expandedRef.current) {
        collapse();
        dragRef.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
        return;
      }

      setPosition(nextTop, nextRight);
    },
    [setPosition, collapse],
  );

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
    dragRef.current = null;
  }, []);

  // ---- Resize handle -------------------------------------------------------

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      resizeRef.current = {
        startMouseX: e.clientX, startWidth: widthRef.current,
        pointerId: e.pointerId,
      };
    },
    [],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rs = resizeRef.current;
      if (!rs || rs.pointerId !== e.pointerId) return;
      e.preventDefault(); e.stopPropagation();

      const delta = rs.startMouseX - e.clientX;
      let nextWidth = rs.startWidth + delta;

      if (nextWidth < TOOLBAR_COLLAPSE_WIDTH) {
        collapse();
        resizeRef.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
        return;
      }

      nextWidth = Math.max(MIN_TOOLBAR_WIDTH, Math.min(MAX_TOOLBAR_WIDTH, nextWidth));
      setWidth(nextWidth);
    },
    [collapse, setWidth],
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

  // ---- Render --------------------------------------------------------------

  const isDragging = dragRef.current !== null;
  const isResizing = resizeRef.current !== null;

  return (
    <>
      {/* ================================================================== */}
      {/* COLLAPSED 「<」 BUTTON  —  stuck to the right edge                 */}
      {/* ================================================================== */}
      {!expanded && (
        <button
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '50%',
            right: 0,
            transform: 'translateY(-50%)',
            zIndex: 101,
            width: 16,
            height: 56,
            border: 0,
            borderRadius: '6px 0 0 6px',
            background: 'rgba(30,30,48,0.94)',
            color: 'rgba(255,255,255,0.7)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            fontWeight: 700,
            padding: 0,
            boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            transition: 'color 0.15s, background 0.15s, width 0.12s',
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget;
            el.style.width = '22px';
            el.style.color = '#fff';
            el.style.background = 'rgba(50,50,75,0.96)';
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget;
            el.style.width = '16px';
            el.style.color = 'rgba(255,255,255,0.7)';
            el.style.background = 'rgba(30,30,48,0.94)';
          }}
          title="展开工具栏 (N)"
          aria-label="展开工具栏"
        >
          ◁
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
            right: rightOffset,
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            pointerEvents: 'auto',
            width,
            minWidth: MIN_TOOLBAR_WIDTH,
            transition: isDragging || isResizing ? 'none' : 'width 160ms ease, right 160ms ease',
          }}
          onPointerDown={stopEvent}
          onPointerMove={stopEvent}
          onPointerUp={stopEvent}
          onWheel={stopEvent}
        >
          {/* Resize handle (left edge) */}
          <div
            role="separator"
            className={`toolbar-resize-handle${isResizing ? ' is-resizing' : ''}`}
            style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: RESIZE_HANDLE_WIDTH, cursor: 'col-resize',
              touchAction: 'none', zIndex: 2,
              background: isResizing ? 'rgba(100,150,255,0.7)' : 'transparent',
              transition: 'background 0.15s',
            }}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            onMouseEnter={(e) => { if (!isResizing) (e.currentTarget as HTMLElement).style.background = 'rgba(100,150,255,0.35)'; }}
            onMouseLeave={(e) => { if (!isResizing) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          />

          {/* Header strip (drag handle, no decorative dots) */}
          <div
            style={{
              cursor: 'grab', userSelect: 'none',
              padding: '6px 10px 0 14px',
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
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', pointerEvents: 'none' }}>
              笔刷工具
            </span>
          </div>

          {/* Panel content */}
          <div style={{
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
