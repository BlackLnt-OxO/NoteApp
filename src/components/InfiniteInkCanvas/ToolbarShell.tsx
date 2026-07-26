/**
 * ToolbarShell — Blender N-panel style collapsible, resizable toolbar frame.
 *
 * Features:
 * - N key to toggle expand / collapse
 * - Collapse button (chevron) always visible
 * - Resize handle with pointer capture
 * - Auto-collapses when width < threshold
 * - Saves state to localStorage
 * - Event isolation from underlying canvas
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { useToolbarStore } from './useToolbarStore';
import {
  MIN_TOOLBAR_WIDTH,
  MAX_TOOLBAR_WIDTH,
  COLLAPSED_TOOLBAR_WIDTH,
  AUTO_COLLAPSE_THRESHOLD,
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

// ---- Component ----------------------------------------------------------------

const ToolbarShell: React.FC<Props> = ({ children }) => {
  const {
    expanded,
    width,
    lastExpandedWidth,
    top,
    left,
    side,
    autoCollapseThreshold,
    toggle,
    collapse,
    setWidth,
    clampPosition,
    loadState,
  } = useToolbarStore();

  const shellRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);

  // ---- Load persisted state on mount ------------------------------------------

  useEffect(() => {
    loadState();
  }, [loadState]);

  // ---- Clamp position on window resize ----------------------------------------

  useEffect(() => {
    const onResize = () => {
      clampPosition(window.innerWidth, window.innerHeight);
    };
    onResize(); // clamp on mount
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPosition]);

  // ---- N-key toggle -----------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // don't steal Ctrl+N etc.
      if (shouldIgnoreShortcut(e.target)) return;

      e.preventDefault();
      toggle();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  // ---- Resize handle pointer events -------------------------------------------

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);

      resizeRef.current = {
        startX: e.clientX,
        startWidth: width,
        pointerId: e.pointerId,
      };
    },
    [width],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rs = resizeRef.current;
      if (!rs || rs.pointerId !== e.pointerId) return;

      e.preventDefault();
      e.stopPropagation();

      const delta = e.clientX - rs.startX;
      const nextWidth = side === 'left'
        ? rs.startWidth + delta
        : rs.startWidth - delta;

      if (nextWidth < autoCollapseThreshold) {
        // Auto-collapse
        collapse();
        resizeRef.current = null;
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        } catch {}
        return;
      }

      const clamped = Math.max(
        MIN_TOOLBAR_WIDTH,
        Math.min(MAX_TOOLBAR_WIDTH, nextWidth),
      );
      setWidth(clamped);
    },
    [side, autoCollapseThreshold, collapse, setWidth],
  );

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return;
      e.preventDefault();
      e.stopPropagation();

      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(
          resizeRef.current.pointerId,
        );
      } catch {}

      resizeRef.current = null;
    },
    [],
  );

  // ---- Prevent canvas events from leaking through toolbar ---------------------

  const stopCanvasEvent = useCallback(
    (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
      e.stopPropagation();
    },
    [],
  );

  // ---- Layout ----------------------------------------------------------------

  const effectiveWidth = expanded ? width : COLLAPSED_TOOLBAR_WIDTH;
  const isResizing = resizeRef.current !== null;

  return (
    <div
      ref={shellRef}
      className={`canvas-toolbar-shell${expanded ? ' is-expanded' : ' is-collapsed'}`}
      style={{
        position: 'absolute',
        top,
        left,
        zIndex: 100,
        display: 'flex',
        alignItems: 'stretch',
        pointerEvents: 'auto',
        width: effectiveWidth,
        minWidth: expanded ? MIN_TOOLBAR_WIDTH : COLLAPSED_TOOLBAR_WIDTH,
        transition: isResizing ? 'none' : 'width 160ms ease',
      }}
      onPointerDown={stopCanvasEvent}
      onPointerMove={stopCanvasEvent}
      onPointerUp={stopCanvasEvent}
      onWheel={stopCanvasEvent}
    >
      {/* ---- Resize handle (left side when docked on right) ---- */}
      {side === 'right' && (
        <div
          role="separator"
          className={`toolbar-resize-handle${isResizing ? ' is-resizing' : ''}`}
          style={{
            flex: `0 0 ${RESIZE_HANDLE_WIDTH}px`,
            width: RESIZE_HANDLE_WIDTH,
            cursor: 'col-resize',
            touchAction: 'none',
            background: isResizing
              ? 'rgba(100,150,255,0.7)'
              : 'transparent',
            transition: 'background 0.15s',
          }}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          onMouseEnter={(e) => {
            if (!isResizing) {
              (e.currentTarget as HTMLElement).style.background =
                'rgba(100,150,255,0.35)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isResizing) {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }
          }}
        />
      )}

      {/* ---- Panel content ---- */}
      {expanded && (
        <div
          className="canvas-toolbar-panel"
          style={{
            width: '100%',
            minWidth: 0,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '10px',
            background: 'rgba(30,30,48,0.96)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.28)',
            maxHeight: 'calc(100vh - 32px)',
            overflowY: 'auto',
          }}
        >
          {children}
        </div>
      )}

      {/* ---- Toggle button (chevron) ---- */}
      <button
        className="canvas-toolbar-toggle"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={expanded ? '收起工具栏 (N)' : '展开工具栏 (N)'}
        title={expanded ? '收起工具栏 (N)' : '展开工具栏 (N)'}
        style={{
          flex: '0 0 28px',
          width: 28,
          minWidth: 28,
          border: 0,
          color: 'rgba(255,255,255,0.8)',
          background: 'rgba(40,40,60,0.95)',
          backdropFilter: 'blur(8px)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '13px',
          fontWeight: 700,
          borderRadius: expanded
            ? side === 'left'
              ? '0 6px 6px 0'
              : '6px 0 0 6px'
            : '6px',
          transition: 'background 0.15s, color 0.15s',
          outline: 'none',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = '#fff';
          e.currentTarget.style.background = 'rgba(70,70,100,0.98)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'rgba(255,255,255,0.8)';
          e.currentTarget.style.background = 'rgba(40,40,60,0.95)';
        }}
      >
        {/* Chevron pointing toward canvas */}
        {side === 'left' ? (expanded ? '◀' : '▶') : expanded ? '▶' : '◀'}
      </button>

      {/* ---- Resize handle (right side when docked on left) ---- */}
      {side === 'left' && (
        <div
          role="separator"
          className={`toolbar-resize-handle${isResizing ? ' is-resizing' : ''}`}
          style={{
            flex: `0 0 ${RESIZE_HANDLE_WIDTH}px`,
            width: RESIZE_HANDLE_WIDTH,
            cursor: 'col-resize',
            touchAction: 'none',
            background: isResizing
              ? 'rgba(100,150,255,0.7)'
              : 'transparent',
            transition: 'background 0.15s',
          }}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          onMouseEnter={(e) => {
            if (!isResizing) {
              (e.currentTarget as HTMLElement).style.background =
                'rgba(100,150,255,0.35)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isResizing) {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }
          }}
        />
      )}
    </div>
  );
};

export default ToolbarShell;
