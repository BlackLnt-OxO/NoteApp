/**
 * TextObject — a committed text node rendered as an ALWAYS-visible DOM "card"
 * above the canvas (so it reads as a sticky-note text box and can be interacted
 * with). Supports: drag-to-move, corner (width) resize, delete × on hover,
 * double-click / context-menu to re-open editing, and a right-click menu whose
 * "删除" row uses a checkbox-style control.
 *
 * When not `interactive` (pen/eraser/laser tools) the card is pointer-events:none
 * so drawing passes straight through it — the box just stays visible above ink.
 *
 * While dragging/resizing the card moves via LOCAL state only (no store writes),
 * so it does not force a full canvas re-render every pointermove; the new
 * x/y/width/height are committed to the store once on pointer-up.
 */
import React, { useRef, useState, useCallback } from 'react';
import type { TextNodeData, Camera } from './types';
import { worldToScreen } from './constants';
import { useCanvasStore } from './useCanvasStore';

interface Props {
  node: TextNodeData;
  camera: Camera;
  interactive: boolean;
}

const TextObject: React.FC<Props> = ({ node, camera, interactive }) => {
  const { updateTextNode, deleteTextNode, setEditingTextId, pushHistory } = useCanvasStore();
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragD, setDragD] = useState<{ x: number; y: number } | null>(null);
  const [rzW, setRzW] = useState<number | null>(null); // live world delta while resizing
  const boxRef = useRef<HTMLDivElement>(null);

  if (!node.content || !node.content.trim()) return null;

  const screen = worldToScreen(node.x, node.y, camera);
  const left = screen.x + (dragD ? dragD.x : 0);
  const top = screen.y + (dragD ? dragD.y : 0);
  const widthWorld = node.width + (rzW ?? 0);
  const screenW = Math.max(60, widthWorld * camera.zoom);
  const screenH = Math.max(28, node.height * camera.zoom);
  const fontSize = Math.max(10, node.fontSize * camera.zoom);

  // ---- drag to move (world delta = screen delta / zoom) ------------------------
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    pushHistory();
    setHover(true);
  }, [interactive, node.x, node.y, pushHistory]);

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setDragD({ x: e.clientX - d.sx, y: e.clientY - d.sy });
  }, []);

  const onUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    updateTextNode(node.id, {
      x: d.ox + (e.clientX - d.sx) / camera.zoom,
      y: d.oy + (e.clientY - d.sy) / camera.zoom,
    });
    setDragD(null);
  }, [node.id, camera.zoom, updateTextNode]);

  // ---- width resize (height follows content) ------------------------------------
  const rzRef = useRef<{ sx: number; ow: number } | null>(null);
  const onRzDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rzRef.current = { sx: e.clientX, ow: node.width };
    pushHistory();
  }, [interactive, node.width, pushHistory]);

  const onRzMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = rzRef.current;
    if (!r) return;
    setRzW(Math.max(60, r.ow + (e.clientX - r.sx) / camera.zoom) - r.ow);
  }, [camera.zoom]);

  const onRzUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = rzRef.current;
    if (!r) return;
    rzRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    const w = Math.max(60, r.ow + (e.clientX - r.sx) / camera.zoom);
    const el = boxRef.current;
    updateTextNode(node.id, {
      width: w,
      height: Math.max(20, (el ? el.offsetHeight / camera.zoom : node.height)),
    });
    setRzW(null);
  }, [node.id, camera.zoom, node.height, updateTextNode]);

  const openEdit = useCallback(() => {
    setMenu(null);
    setDragD(null);
    setRzW(null);
    setEditingTextId(node.id);
  }, [node.id, setEditingTextId]);

  const onContext = useCallback((e: React.MouseEvent) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
    setHover(true);
  }, [interactive]);

  const deleteMe = useCallback(() => {
    setMenu(null);
    deleteTextNode(node.id);
  }, [node.id, deleteTextNode]);

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width: screenW,
          minHeight: screenH,
          zIndex: 6,
          cursor: interactive ? (dragD || rzW !== null ? 'grabbing' : 'default') : 'default',
          pointerEvents: interactive ? 'auto' : 'none',
          userSelect: 'none',
          touchAction: 'none',
        }}
        onPointerDown={interactive ? onDown : undefined}
        onPointerMove={interactive ? onMove : undefined}
        onPointerUp={interactive ? onUp : undefined}
        onPointerCancel={interactive ? onUp : undefined}
        onDoubleClick={interactive ? openEdit : undefined}
        onContextMenu={onContext}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <div
          ref={boxRef}
          style={{
            boxSizing: 'border-box',
            width: '100%',
            minHeight: screenH,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--glass-bg, rgba(30,30,50,0.72))',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            border: `1px solid ${hover ? 'var(--accent, rgba(255,255,255,0.6))' : 'rgba(128,128,150,0.35)'}`,
            color: node.color || 'var(--text-primary, #e0e0e0)',
            fontSize,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
          }}
        >
          {node.content}
        </div>

        {interactive && hover && (
          <>
            <button
              title="删除文本框"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); deleteMe(); }}
              style={{
                position: 'absolute', top: -8, right: -8, width: 20, height: 20,
                borderRadius: '50%', border: 'none', cursor: 'pointer',
                background: 'rgba(231,76,60,0.9)', color: '#fff', fontSize: 12,
                lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ×
            </button>
            <div
              title="拖拽调整宽度"
              onPointerDown={onRzDown}
              onPointerMove={onRzMove}
              onPointerUp={onRzUp}
              onPointerCancel={onRzUp}
              style={{
                position: 'absolute', bottom: -2, right: -2, width: 14, height: 14,
                cursor: 'nwse-resize', touchAction: 'none',
                background: 'linear-gradient(135deg, transparent 50%, var(--accent, rgba(255,255,255,0.7)) 50%)',
              }}
            />
          </>
        )}
      </div>

      {menu && interactive && (
        <div
          style={{
            position: 'fixed', left: menu.x, top: menu.y, zIndex: 10002,
            background: 'var(--dropdown-bg, #1f2230)', border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 8, padding: 4, minWidth: 120, color: 'var(--text-primary, #e0e0e0)',
            fontSize: 13, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); openEdit(); }}
            style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            编辑
          </div>
          <div
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); deleteMe(); }}
            style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(231,76,60,0.15)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12, height: 12, borderRadius: 3, border: '1.5px solid currentColor',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}
            />
            删除
          </div>
        </div>
      )}
    </>
  );
};

export default TextObject;
