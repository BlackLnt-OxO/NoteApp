/**
 * PdfImageObject — a raster image dropped onto the PDF page, rendered as an
 * absolutely-positioned <img> ABOVE the canvas. Supports drag-to-move (page
 * world coords), corner resize, and a delete ×. Mirrors InfiniteInkCanvas's
 * ImageObject, but bound to the per-page PdfStore and gated by `interactive`
 * (select tool) so pen/eraser pass through.
 */
import React, { useRef, useState, useCallback } from 'react';
import type { PdfImageObject as PdfImgObj, PdfCamera } from './PdfTypes';
import { worldToScreen } from './PdfEngine';
import { usePdfStore } from './PdfStore';
import { useNoteStore } from '../../store';
import { boxResizePreview, usePreviewGesture } from '../usePreviewGesture';

interface Props {
  obj: PdfImgObj;
  page: number;
  camera: PdfCamera;
  interactive: boolean;
}

const PdfImageObject: React.FC<Props> = ({ obj, page, camera, interactive }) => {
  const uiScale = useNoteStore((s) => s.uiScale);
  const selected = usePdfStore((s) => s.selectedIds.includes(obj.id));
  const updateImageObject = usePdfStore((s) => s.updateImageObject);
  const deleteObject = usePdfStore((s) => s.deleteObject);
  const pushHistory = usePdfStore((s) => s.pushHistory);
  const [hover, setHover] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const imageRef = useRef<HTMLDivElement>(null);
  const startPreview = usePreviewGesture(interactive ? page : false);

  // worldToScreen is VISUAL px; App is CSS-scaled by uiScale → layout px = /uiScale.
  const screen = worldToScreen(obj.x, obj.y, camera);
  const screenX = screen.x / uiScale;
  const screenY = screen.y / uiScale;
  const screenW = (obj.width * camera.zoom) / uiScale;
  const screenH = (obj.height * camera.zoom) / uiScale;

  const onDragDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const element = e.currentTarget;
    const before = element.style.translate;
    startPreview(e, {
      paint: (x, y) => { element.style.translate = `${x / uiScale}px ${y / uiScale}px`; },
      finish: (x, y) => usePdfStore.getState().commitSelectionMove(page, [obj.id], x / camera.zoom, y / camera.zoom),
      reset: () => { element.style.translate = before; },
    });
  }, [interactive, startPreview, uiScale, camera.zoom, page, obj.id]);

  const onResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const element = imageRef.current;
    if (!interactive || !element) return;
    const dimensions = (dx: number, dy: number) => ({
      width: Math.max(40, obj.width + dx / camera.zoom),
      height: Math.max(30, obj.height + dy / camera.zoom),
    });
    startPreview(e, boxResizePreview(element, dimensions, camera.zoom / uiScale, (width, height) => {
      if (width === obj.width && height === obj.height) return;
      pushHistory(page);
      updateImageObject(page, obj.id, { width, height });
    }));
  }, [interactive, startPreview, uiScale, camera.zoom, page, obj.id, obj.width, obj.height, pushHistory, updateImageObject]);

  const boxShadow = '0 4px 14px rgba(0,0,0,0.3)';

  return (
    <>
      <div ref={imageRef} data-ink-object-id={obj.id}
        data-ink-selected={selected || undefined}
        onPointerDown={interactive ? onDragDown : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'absolute',
          outline: selected ? '1.5px dashed #6b5ce7' : undefined,
          outlineOffset: 3,
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
              aria-label="删除"
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
              data-tooltip="缩放"
              data-ink-object-control=""
              onPointerDown={onResizeDown}
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
