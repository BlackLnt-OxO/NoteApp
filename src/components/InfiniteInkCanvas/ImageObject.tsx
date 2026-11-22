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
import { useNoteStore } from '../../store';
import { setPointerHold } from '../inkInputActivity';
import { boxResizePreview, usePreviewGesture } from '../usePreviewGesture';

interface Props {
  obj: ImageObj;
  camera: Camera;
}

const ImageObject: React.FC<Props> = ({ obj, camera }) => {
  // Per-field selectors (matching the PDF overlay): a whole-store subscription
  // re-rendered every image on every camera nudge and every committed stroke.
  const updateImageObject = useCanvasStore((s) => s.updateImageObject);
  const deleteObject = useCanvasStore((s) => s.deleteObject);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const selected = useCanvasStore((s) => s.selectedIds.includes(obj.id));
  const uiScale = useNoteStore((s) => s.uiScale);
  const [hover, setHover] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const imageRef = useRef<HTMLDivElement>(null);
  const startPreview = usePreviewGesture();

  // worldToScreen is VISUAL px; App is CSS-scaled by uiScale → layout px = /uiScale.
  const screen = worldToScreen(obj.x, obj.y, camera);
  const screenX = screen.x / uiScale;
  const screenY = screen.y / uiScale;
  const screenW = (obj.width * camera.zoom) / uiScale;
  const screenH = (obj.height * camera.zoom) / uiScale;

  const onDragDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const before = element.style.translate;
    const active = startPreview(e, {
      paint: (x, y) => { element.style.translate = `${x / uiScale}px ${y / uiScale}px`; },
      finish: (x, y) => useCanvasStore.getState().commitSelectionMove([obj.id], x / camera.zoom, y / camera.zoom),
      reset: () => { element.style.translate = before; setPointerHold(false); },
    });
    if (active) setPointerHold(true);
  }, [startPreview, uiScale, camera.zoom, obj.id]);

  const onResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const element = imageRef.current;
    if (!element) return;
    const dimensions = (dx: number, dy: number) => ({
      width: Math.max(40, obj.width + dx / camera.zoom),
      height: Math.max(30, obj.height + dy / camera.zoom),
    });
    startPreview(e, boxResizePreview(element, dimensions, camera.zoom / uiScale, (width, height) => {
      if (width === obj.width && height === obj.height) return;
      pushHistory();
      updateImageObject(obj.id, { width, height });
    }));
  }, [startPreview, uiScale, camera.zoom, obj.id, obj.width, obj.height, pushHistory, updateImageObject]);

  return (
    <>
      <div ref={imageRef} data-ink-object-id={obj.id}
        data-ink-selected={selected || undefined}
        onPointerDown={onDragDown}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'absolute',
          left: screenX,
          top: screenY,
          width: screenW,
          height: screenH,
          cursor: 'grabbing',
          zIndex: 1, // below the canvas (ink draws on top)
          userSelect: 'none',
          touchAction: 'none',
          outline: selected ? '1.5px dashed #6b5ce7' : undefined,
          outlineOffset: 3,
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
              aria-label="删除"
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
              data-tooltip="缩放"
              data-ink-object-control=""
              onPointerDown={onResizeDown}
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
          data-lightbox=""
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
