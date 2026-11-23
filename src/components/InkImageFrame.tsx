import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNoteStore } from '../store';
import InkImageControls from './InkImageControls';
import { usePreviewGesture } from './usePreviewGesture';
import { setPointerHold } from './inkInputActivity';

export default function InkImageFrame({ object, camera, selected, interactive, onRemove, onResize, onMove, layer }: {
  object: { id: string; x: number; y: number; width: number; height: number; dataUrl: string };
  camera: { x: number; y: number; zoom: number }; selected: boolean; interactive: boolean;
  onRemove: () => void; onResize: (width: number, height: number) => void; layer: number;
  onMove?: (dx: number, dy: number) => void;
}) {
  const uiScale = useNoteStore(state => state.uiScale);
  const box = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState(false);
  const movePreview = usePreviewGesture(object.id);
  return <>
    <div ref={box} className="ink-image-frame" data-ink-object-id={object.id}
      data-ink-selected={selected || undefined} data-interactive={interactive || Boolean(onMove)}
      style={{ left: (camera.x + object.x * camera.zoom) / uiScale, top: (camera.y + object.y * camera.zoom) / uiScale,
        width: object.width * camera.zoom / uiScale, height: object.height * camera.zoom / uiScale, zIndex: layer }}
      onPointerDown={onMove && !interactive ? event => {
        const element = event.currentTarget;
        const before = element.style.translate;
        const active = movePreview(event, {
          paint: (x, y) => { element.style.translate = `${x / uiScale}px ${y / uiScale}px`; },
          finish: (x, y) => onMove(x / camera.zoom, y / camera.zoom),
          reset: () => { element.style.translate = before; setPointerHold(false); },
        });
        if (active) setPointerHold(true);
      } : undefined}
      onDoubleClick={() => { if (interactive) setPreview(true); }}>
      <img src={object.dataUrl} alt="" draggable={false} />
      {interactive && <InkImageControls box={box} width={object.width} height={object.height} zoom={camera.zoom}
        uiScale={uiScale} onRemove={onRemove} onResize={onResize} />}
    </div>
    {preview && createPortal(<div className="img-lightbox-overlay" data-lightbox onClick={() => setPreview(false)}>
      <img src={object.dataUrl} alt="" />
    </div>, document.body)}
  </>;
}
