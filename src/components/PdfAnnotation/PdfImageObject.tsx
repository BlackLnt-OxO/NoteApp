/**
 * PdfImageObject — a raster image dropped onto the PDF page, rendered as an
 * absolutely-positioned <img> ABOVE the canvas. Supports drag-to-move (page
 * world coords), corner resize, and a delete ×. Mirrors InfiniteInkCanvas's
 * ImageObject, but bound to the per-page PdfStore and gated by `interactive`
 * (select tool) so pen/eraser pass through.
 */
import React, { useRef, useState, useCallback } from 'react';
import type { PdfImageObject as PdfImgObj, PdfCamera } from './PdfTypes';
import { worldToScreen } from '../InkCore/inkGeometry';
import { usePdfStore } from './PdfStore';
import { useNoteStore } from '../../store';

interface Props {
  obj: PdfImgObj;
  page: number;
  camera: PdfCamera;
  interactive: boolean;
}

const PdfImageObject: React.FC<Props> = ({ obj, page, camera, interactive }) => {
  const uiScale = useNoteStore((s) => s.uiScale);
  const updateImageObject = usePdfStore((s) => s.updateImageObject);
  const deleteObject = usePdfStore((s) => s.deleteObject);
  const pushHistory = usePdfStore((s) => s.pushHistory);
  const [hover, setHover] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  // worldToScreen is VISUAL px; App is CSS-scaled by uiScale → layout px = /uiScale.
  const screen = worldToScreen(obj.x, obj.y, camera);
  const screenX = screen.x / uiScale;
  const screenY = screen.y / uiScale;
  const screenW = (obj.width * camera.zoom) / uiScale;
  const screenH = (obj.height * camera.zoom) / uiScale;

  // ---- drag to move (world delta = screen delta / zoom) ----------------------
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const onDragDown = useCallback((e: React.PointerEvent) => {
    if (!interactive) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: obj.x, oy: obj.y };
    pushHistory(page);
  }, [interactive, obj.x, obj.y, page, pushHistory]);

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / camera.zoom;
    const dy = (e.clientY - d.startY) / camera.zoom;
    updateImageObject(page, obj.id, { x: d.ox + dx, y: d.oy + dy });
  }, [camera.zoom, page, obj.id, updateImageObject]);

  const onDragUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null;
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }, []);

  // ---- corner resize (bottom-right) ------------------------------------------
  const resizeRef = useRef<{ startX: number; startY: number; ow: number; oh: number } | null>(null);
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    if (!interactive) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, ow: obj.width, oh: obj.height };
    pushHistory(page);
  }, [interactive, obj.width, obj.height, page, pushHistory]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dw = (e.clientX - r.startX) / camera.zoom;
    const dh = (e.clientY - r.startY) / camera.zoom;
    updateImageObject(page, obj.id, { width: Math.max(40, r.ow + dw), height: Math.max(30, r.oh + dh) });
  }, [camera.zoom, page, obj.id, updateImageObject]);

  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (resizeRef.current) {
      resizeRef.current = null;
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }, []);

  const boxShadow = '0 4px 14px rgba(0,0,0,0.3)';

  return (
    <>
      <div
        onPointerDown={interactive ? onDragDown : undefined}
        onPointerMove={interactive ? onDragMove : undefined}
        onPointerUp={interactive ? onDragUp : undefined}
        onPointerCancel={interactive ? onDragUp : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'absolute',
          left: screenX,
          top: screenY,
          width: screenW,
          height: screenH,
          cursor: interactive ? (hover ? 'move' : 'move') : 'default',
          pointerEvents: interactive ? 'auto' : 'none',
          zIndex: 5,
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <img
          src={obj.dataUrl}
          alt=""
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            if (interactive) setLightbox(true);
          }}
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block', borderRadius: 6, pointerEvents: 'none', boxShadow }}
        />
        {interactive && hover && (
          <>
            <button
              title="删除"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); deleteObject(page, obj.id); }}
              style={{
                position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: '50%',
                border: 'none', cursor: 'pointer', background: 'rgba(231,76,60,0.85)', color: '#fff',
                fontSize: 12, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 3,
              }}
            >
              ×
            </button>
            <div
              title="缩放"
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              onPointerCancel={onResizeUp}
              style={{
                position: 'absolute', bottom: 2, right: 2, width: 14, height: 14, cursor: 'nwse-resize',
                background: 'linear-gradient(135deg, transparent 50%, rgba(37,99,235,0.85) 50%)',
                zIndex: 3, touchAction: 'none',
              }}
            />
          </>
        )}
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <img src={obj.dataUrl} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, boxShadow: '0 16px 64px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </>
  );
};

export default PdfImageObject;
