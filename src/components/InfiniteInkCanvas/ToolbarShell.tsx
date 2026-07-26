/**
 * ToolbarShell — Draggable, resizable, right-edge auto-collapsing toolbar frame.
 *
 * - Docked to the right side of the canvas by default.
 * - Drag the header bar to reposition anywhere.
 * - Drag the left-edge resize handle to change width.
 * - Dragging the toolbar near (within ~30 px of) the viewport right edge
 *   auto-collapses it into a thin strip.
 * - When collapsed, a 6-px tab strip is visible on the right edge;
 *   click or drag it inward to expand.
 * - N key toggles expand / collapse.
 * - All pointer events are stopped so they never reach the canvas.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { useToolbarStore } from './useToolbarStore';
import {
  MIN_TOOLBAR_WIDTH,
  MAX_TOOLBAR_WIDTH,
  COLLAPSED_TAB_SIZE,
  AUTO_COLLAPSE_EDGE_PX,
  RESIZE_HANDLE_WIDTH,
} from './constants';

// ---- Helpers ------------------------------------------------------------------

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

// ---- Props --------------------------------------------------------------------

interface Props {
  children: React.ReactNode;
}

// ---- Shared inline styles -----------------------------------------------------

const resizeHandleBase: React.CSSProperties = {
  flex: `0 0 ${RESIZE_HANDLE_WIDTH}px`,
  width: RESIZE_HANDLE_WIDTH,
  cursor: 'col-resize',
  touchAction: 'none',
  background: 'transparent',
  transition: 'background 0.15s',
};

const panelBase: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '10px',
  background: 'rgba(30,30,48,0.96)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.28)',
  maxHeight: 'calc(100vh - 36px)',
};

const collapsedTabBase: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  width: COLLAPSED_TAB_SIZE,
  height: '100%',
  background: 'rgba(100,120,180,0.35)',
  borderRadius: '4px 0 0 4px',
  cursor: 'ew-resize',
  transition: 'width 0.12s, background 0.15s',
};

// ---- Component ----------------------------------------------------------------

const ToolbarShell: React.FC<Props> = ({ children }) => {
  const {
    expanded,
    width,
    lastExpandedWidth,
    top,
    rightOffset,
    side,
    toggle,
    collapse,
    setWidth,
    setPosition,
    clampPosition,
    loadState,
  } = useToolbarStore();

  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  // ---- Drag / resize state refs ------------------------------------------------

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

  // Keep a ref to the current expanded state so callbacks don't stale.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const widthRef = useRef(width);
  widthRef.current = width;

  // ---- Load persisted state on mount -------------------------------------------

  useEffect(() => {
    loadState();
  }, [loadState]);

  // ---- Clamp on window resize --------------------------------------------------

  useEffect(() => {
    const onResize = () => clampPosition(window.innerWidth, window.innerHeight);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPosition]);

  // ---- N-key toggle ------------------------------------------------------------

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

  // ---- Find the canvas container for coordinate reference ----------------------

  useEffect(() => {
    // Walk up to find the canvas container (the parent div in InfiniteInkCanvas)
    if (shellRef.current) {
      containerRef.current = shellRef.current.parentElement;
    }
  }, []);

  // =============================================================================
  // HEADER DRAG  (reposition the whole toolbar)
  // =============================================================================

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      dragRef.current = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startRight: rightOffset,
        startTop: top,
        pointerId: e.pointerId,
      };
    },
    [rightOffset, top],
  );

  const onHeaderPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;

      e.preventDefault();
      e.stopPropagation();

      const dx = d.startMouseX - e.clientX; // right-offset increases when moving LEFT
      const dy = e.clientY - d.startMouseY;

      const container = containerRef.current;
      const vpW = container?.clientWidth ?? window.innerWidth;
      const vpH = container?.clientHeight ?? window.innerHeight;

      let nextRight = d.startRight + dx;
      const nextTop = Math.max(4, Math.min(d.startTop + dy, Math.max(4, vpH - 36)));

      // Clamp right offset
      nextRight = Math.max(-20, Math.min(nextRight, vpW - 60));

      // Check: should we auto-collapse when dragged near the right viewport edge?
      // When `nextRight` is very small (toolbar right edge is at or beyond the viewport right edge),
      // we auto-collapse.
      if (nextRight <= AUTO_COLLAPSE_EDGE_PX && expandedRef.current) {
        collapse();
        dragRef.current = null;
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        } catch {}
        return;
      }

      // If collapsed and we're dragging far enough inward, expand
      if (!expandedRef.current && nextRight > AUTO_COLLAPSE_EDGE_PX + 40) {
        useToolbarStore.getState().expand();
      }

      setPosition(nextTop, nextRight);
    },
    [setPosition, collapse],
  );

  const onHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {}
    dragRef.current = null;
  }, []);

  // =============================================================================
  // RESIZE HANDLE  (left edge of toolbar — drag to change width)
  // =============================================================================

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      resizeRef.current = {
        startMouseX: e.clientX,
        startWidth: widthRef.current,
        pointerId: e.pointerId,
      };
    },
    [],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rs = resizeRef.current;
      if (!rs || rs.pointerId !== e.pointerId) return;

      e.preventDefault();
      e.stopPropagation();

      // side === 'right': resize handle is on the left edge → dragging left = wider
      const delta = rs.startMouseX - e.clientX;
      let nextWidth = rs.startWidth + delta;

      if (nextWidth < MIN_TOOLBAR_WIDTH / 2) {
        // Collapse
        collapse();
        resizeRef.current = null;
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        } catch {}
        return;
      }

      nextWidth = Math.max(MIN_TOOLBAR_WIDTH, Math.min(MAX_TOOLBAR_WIDTH, nextWidth));
      setWidth(nextWidth);
    },
    [collapse, setWidth],
  );

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(resizeRef.current.pointerId);
    } catch {}
    resizeRef.current = null;
  }, []);

  // =============================================================================
  // COLLAPSED TAB  (click or drag to expand)
  // =============================================================================

  const onTabPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      dragRef.current = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startRight: rightOffset,
        startTop: top,
        pointerId: e.pointerId,
      };
    },
    [rightOffset, top],
  );

  // Re-use the same move handler as header drag
  const onTabPointerMove = onHeaderPointerMove;
  const onTabPointerUp = onHeaderPointerUp;

  // =============================================================================
  // Event isolation  (prevent canvas drawing when interacting with toolbar)
  // =============================================================================

  const stopEvent = useCallback(
    (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
      e.stopPropagation();
    },
    [],
  );

  // =============================================================================
  // RENDER
  // =============================================================================

  const isDragging = dragRef.current !== null;
  const isResizing = resizeRef.current !== null;
  const effectiveWidth = expanded ? width : COLLAPSED_TAB_SIZE;

  return (
    <div
      ref={shellRef}
      className={`canvas-toolbar-shell${expanded ? ' is-expanded' : ' is-collapsed'}`}
      style={{
        position: 'absolute',
        top: expanded ? top : '50%',
        right: expanded ? rightOffset : -2, // when collapsed, the tab peeks from the right edge
        transform: expanded ? undefined : 'translateY(-50%)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
        width: effectiveWidth,
        minWidth: COLLAPSED_TAB_SIZE,
        height: expanded ? undefined : '160px',
        transition: isDragging || isResizing ? 'none' : 'width 160ms ease, right 160ms ease',
      }}
      onPointerDown={expanded ? stopEvent : undefined}
      onPointerMove={expanded ? stopEvent : undefined}
      onPointerUp={expanded ? stopEvent : undefined}
      onWheel={stopEvent}
    >
      {/* ================================================================== */}
      {/* EXPANDED VIEW                                                     */}
      {/* ================================================================== */}
      {expanded && (
        <>
          {/* --- Resize handle (left edge) --- */}
          <div
            role="separator"
            className={`toolbar-resize-handle${isResizing ? ' is-resizing' : ''}`}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              ...resizeHandleBase,
              background: isResizing ? 'rgba(100,150,255,0.7)' : 'transparent',
              zIndex: 2,
            }}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            onMouseEnter={(e) => {
              if (!isResizing) (e.currentTarget as HTMLElement).style.background = 'rgba(100,150,255,0.35)';
            }}
            onMouseLeave={(e) => {
              if (!isResizing) (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          />

          {/* --- Drag handle (header strip) --- */}
          <div
            style={{
              cursor: 'grab',
              userSelect: 'none',
              padding: '5px 10px 0 14px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              position: 'sticky',
              top: 0,
              zIndex: 3,
              borderRadius: '10px 10px 0 0',
              background: isDragging
                ? 'rgba(100,130,200,0.15)'
                : 'transparent',
              transition: 'background 0.15s',
            }}
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={onHeaderPointerUp}
            onPointerCancel={onHeaderPointerUp}
            onMouseEnter={(e) => {
              if (!isDragging)
                (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)';
            }}
            onMouseLeave={(e) => {
              if (!isDragging)
                (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            {/* Grip dots */}
            <svg width="12" height="10" viewBox="0 0 12 10" style={{ opacity: 0.35, flexShrink: 0 }}>
              <circle cx="3" cy="2" r="1.3" fill="currentColor" />
              <circle cx="9" cy="2" r="1.3" fill="currentColor" />
              <circle cx="3" cy="5" r="1.3" fill="currentColor" />
              <circle cx="9" cy="5" r="1.3" fill="currentColor" />
              <circle cx="3" cy="8" r="1.3" fill="currentColor" />
              <circle cx="9" cy="8" r="1.3" fill="currentColor" />
            </svg>

            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                pointerEvents: 'none',
              }}
            >
              笔刷工具
            </span>

            {/* Drag hint */}
            <span
              style={{
                fontSize: '10px',
                color: 'var(--text-muted)',
                pointerEvents: 'none',
              }}
            >
              ⠿
            </span>
          </div>

          {/* --- Panel content --- */}
          <div style={panelBase}>
            {children}
          </div>
        </>
      )}

      {/* ================================================================== */}
      {/* COLLAPSED TAB                                                     */}
      {/* ================================================================== */}
      {!expanded && (
        <div
          style={{
            ...collapsedTabBase,
            height: '160px',
          }}
          onPointerDown={onTabPointerDown}
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerUp}
          onPointerCancel={onTabPointerUp}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.width = '10px';
            (e.currentTarget as HTMLElement).style.background = 'rgba(100,150,255,0.65)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.width = `${COLLAPSED_TAB_SIZE}px`;
            (e.currentTarget as HTMLElement).style.background = 'rgba(100,120,180,0.35)';
          }}
          title="拖拽或点击展开工具栏 (N)"
        />
      )}
    </div>
  );
};

export default ToolbarShell;
