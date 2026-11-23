import type { RefObject } from 'react';
import IconAction from './IconAction';
import { boxResizePreview, usePreviewGesture } from './usePreviewGesture';

export function resizeInkImage(width: number, height: number, dx: number, dy: number, locked: boolean) {
  const minWidth = Math.min(width, 40);
  const minHeight = Math.min(height, 30);
  if (!locked) return { width: Math.max(minWidth, width + dx), height: Math.max(minHeight, height + dy) };
  const scale = Math.max(minWidth / width, minHeight / height, 1 + (dx * width + dy * height) / (width ** 2 + height ** 2));
  return { width: width * scale, height: height * scale };
}

export default function InkImageControls({ box, width, height, zoom, uiScale, onRemove, onResize }: {
  box: RefObject<HTMLDivElement>; width: number; height: number; zoom: number; uiScale: number;
  onRemove: () => void; onResize: (width: number, height: number) => void;
}) {
  const preview = usePreviewGesture();
  return <>
    <IconAction className="ink-image-remove" label="移除图片" danger
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onRemove(); }} />
    <button type="button" className="ink-image-resize" aria-label="调整图片大小" data-tooltip="调整大小 · Shift 保持比例"
      onPointerDown={event => {
        if (!box.current) return;
        preview(event, boxResizePreview(box.current, (dx, dy, shift) => resizeInkImage(width, height, dx / zoom, dy / zoom, shift),
          zoom / uiScale, (w, h) => { if (w !== width || h !== height) onResize(w, h); }, true));
      }} />
  </>;
}
