/**
 * PdfTextObject — a committed text card on the PDF page, rendered as a light
 * DOM card (mirrors InfiniteInkCanvas/TextObject): drag-to-move, corner (width)
 * resize, delete × on hover, context menu (编辑 / 删除), and a plain CLICK reopens
 * the editor. Empty cards render a placeholder so a placed box never vanishes.
 *
 * The card is light with fixed PDF_ANNOTATION_BLUE text (node colors) — a PDF
 * page is always light, so it stays readable in any app theme.
 *
 * `interactive` (select tool) toggles pointer-events so pen/eraser pass through.
 * While dragging/resizing the card moves via LOCAL state only (no store writes
 * per pointermove); x/y/width/height commit once on pointer-up.
 */
import React, { useRef, useState, useCallback } from 'react';
import type { PdfTextObject, PdfCamera } from './PdfTypes';
import { worldToScreen } from '../InkCore/inkGeometry';
import { usePdfStore } from './PdfStore';
import { useNoteStore } from '../../store';
import { PDF_ANNOTATION_BLUE } from '../../themeColors';

interface Props {
  node: PdfTextObject;
  page: number;
  camera: PdfCamera;
  interactive: boolean;
}

const PdfTextObject: React.FC<Props> = ({ node, page, camera, interactive }) => {
  const uiScale = useNoteStore((s) => s.uiScale);
  const updateTextNode = usePdfStore((s) => s.updateTextNode);
  const deleteTextNode = usePdfStore((s) => s.deleteTextNode);
  const setEditingTextId = usePdfStore((s) => s.setEditingTextId);
  const pushHistory = usePdfStore((s) => s.pushHistory);
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragD, setDragD] = useState<{ x: number; y: number } | null>(null);
  const [rzW, setRzW] = useState<number | null>(null); // live world delta while resizing
  const boxRef = useRef<HTMLDivElement>(null);

  const hasContent = !!node.content && !!node.content.trim();

  // worldToScreen is VISUAL px; App is CSS-scaled by uiScale → layout px = /uiScale.
  const screen = worldToScreen(node.x, node.y, camera);
  const left = (screen.x + (dragD ? dragD.x : 0)) / uiScale;
  const top = (screen.y + (dragD ? dragD.y : 0)) / uiScale;
  const widthWorld = node.width + (rzW ?? 0);
  const screenW = Math.max(60, widthWorld * camera.zoom) / uiScale;
  const screenH = Math.max(28, node.height * camera.zoom) / uiScale;
  const fontSize = Math.max(10, node.fontSize * camera.zoom) / uiScale;

  const openEdit = useCallback(() => {
    // Remember the tool in use so closing the editor returns to it (re-opening an
    // existing card must NOT yank the user into the pen tool).
    const curTool = usePdfStore.getState().activeTool;
    const ae = document.activeElement;
    if (ae && ae instanceof HTMLTextAreaElement) ae.blur();
    usePdfStore.getState().setTextCommitReturnTool(curTool);
    setMenu(null);
    setDragD(null);
    setRzW(null);
    setEditingTextId(node.id);
  }, [node.id, setEditingTextId]);

  // ---- drag to move -----------------------------------------------------------
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    pushHistory(page);
    setHover(true);
  }, [interactive, node.x, node.y, page, pushHistory]);

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
    const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
    setDragD(null);
    if (moved < 5) {
      openEdit();
      return;
    }
    updateTextNode(page, node.id, {
      x: d.ox + (e.clientX - d.sx) / camera.zoom,
      y: d.oy + (e.clientY - d.sy) / camera.zoom,
    });
  }, [node.id, page, camera.zoom, updateTextNode, openEdit]);

  // ---- width resize (height follows content) -----------------------------------
  const rzRef = useRef<{ sx: number; ow: number } | null>(null);
  const onRzDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rzRef.current = { sx: e.clientX, ow: node.width };
    pushHistory(page);
  }, [interactive, node.width, page, pushHistory]);

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
    updateTextNode(page, node.id, {
      width: w,
      // offsetHeight is layout px → visual px = ×uiScale → world = ÷zoom.
      height: Math.max(20, (el ? el.offsetHeight * uiScale : node.height * camera.zoom) / camera.zoom),
    });
    setRzW(null);
  }, [node.id, page, camera.zoom, uiScale, node.height, updateTextNode]);

  const onContext = useCallback((e: React.MouseEvent) => {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
    setHover(true);
  }, [interactive]);

  const deleteMe = useCallback(() => {
    setMenu(null);
    deleteTextNode(page, node.id);
  }, [node.id, page, deleteTextNode]);

  const cardBorder = hover
    ? `1px solid ${PDF_ANNOTATION_BLUE}`
    : hasContent ? '1px solid rgba(37,99,235,0.4)' : '1px dashed rgba(37,99,235,0.5)';

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
            background: node.backgroundColor,
            border: cardBorder,
            color: node.color,
            fontSize,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
            minWidth: 0,
          }}
        >
          {hasContent ? node.content : <span style={{ opacity: 0.5 }}>输入文本…</span>}
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
                background: `linear-gradient(135deg, transparent 50%, ${PDF_ANNOTATION_BLUE} 50%)`,
              }}
            />
          </>
        )}
      </div>

      {menu && interactive && (
        <div
          style={{
            position: 'fixed', left: menu.x / uiScale, top: menu.y / uiScale, zIndex: 10002,
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

export default PdfTextObject;
