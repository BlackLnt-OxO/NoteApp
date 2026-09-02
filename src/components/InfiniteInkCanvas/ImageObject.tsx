/**
 * ImageObject — a screenshot/photo dropped onto the infinite canvas, rendered as
 * an absolutely-positioned <img> that sits BELOW the canvas (so ink draws over
 * it). Supports drag-to-move (world coords), corner resize, and a delete ×.
 * Interactivity mirrors NoteCard's note-image handling but in world space.
 */

import React, { useRef, useState, useCallback } from 'react';
import type { ImageObject as ImageObj, Camera } from './types';
import { worldToScreen } from './constants';
import { useCanvasStore } from './useCanvasStore';

interface Props {
  obj: ImageObj;
  camera: Camera;
}

const ImageObject: React.FC<Props> = ({ obj, camera }) => {
  const { updateImageObject, deleteObject, pushHistory } = useCanvasStore();
  const [hover, setHover] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  const screen = worldToScreen(obj.x, obj.y, camera);
  const screenW = obj.width * camera.zoom;
  const screenH = obj.height * camera.zoom;

  // ---- drag to move (world delta = screen delta / zoom) ----------------------
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const onDragDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: obj.x, oy: obj.y };
    pushHistory();
  }, [obj.x, obj.y, pushHistory]);

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / camera.zoom;
    const dy = (e.clientY - d.startY) / camera.zoom;
    updateImageObject(obj.id, { x: d.ox + dx, y: d.oy + dy });
  }, [camera.zoom, obj.id, updateImageObject]);

  const onDragUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) { dragRef.current = null; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {} }
  }, []);

  // ---- corner resize (bottom-right) ------------------------------------------
  const resizeRef = useRef<{ startX: number; startY: number; ow: number; oh: number } | null>(null);
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, ow: obj.width, oh: obj.height };
    pushHistory();
  }, [obj.width, obj.height, pushHistory]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dw = (e.clientX - r.startX) / camera.zoom;
    const dh = (e.clientY - r.startY) / camera.zoom;
    updateImageObject(obj.id, { width: Math.max(40, r.ow + dw), height: Math.max(30, r.oh + dh) });
  }, [camera.zoom, obj.id, updateImageObject]);

  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (resizeRef.current) { resizeRef.current = null; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {} }
  }, []);

  return (
    <>
      <div
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'absolute',
          left: screen.x,
          top: screen.y,
          width: screenW,
          height: screenH,
          cursor: 'grabbing',
          zIndex: 1, // below the canvas (ink draws on top)
          userSelect: 'none',
        }}
      >
        <img
          src={obj.dataUrl}
          alt=""
          draggable={false}
          onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block', borderRadius: 6, pointerEvents: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.3)' }}
        />
        {hover && (
          <>
            <button
              title="删除"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); deleteObject(obj.id); }}
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
              style={{
                position: 'absolute', bottom: 2, right: 2, width: 14, height: 14, cursor: 'nwse-resize',
                background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.6) 50%)',
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

export default ImageObject;
