import { useEffect, useRef, useState } from 'react';
import { useNoteStore } from '../../store';
import { rebindAsset, resolveAsset, showAssetPreview, useAssetLibrary } from './assetLibrary';
import { fileKind, fileName, fileTypeLabel, isImageFile, type LinkedAssetObject } from './fileTypes';
import './fileLibrary.css';

interface Props {
  object: LinkedAssetObject;
  camera: { x: number; y: number; zoom: number };
  interactive: boolean;
  selected: boolean;
  onDelete: () => void;
  startResize: () => void;
  resize: (width: number, height: number) => void;
}

export function useAssetImage(assetId: string, enabled: boolean) {
  const asset = useAssetLibrary(state => resolveAsset(state, assetId));
  const path = asset?.path;
  const online = useAssetLibrary(state => asset ? state.available[asset.id] : false);
  const [image, setImage] = useState<{ path: string; url: string }>();
  const imagePath = enabled && online !== false && path && isImageFile(path) ? path : undefined;
  useEffect(() => {
    setImage(undefined);
    if (!imagePath || !asset || !window.electronAPI?.readLibraryImage || !URL.createObjectURL) return;
    let cancelled = false;
    let url: string | undefined;
    void window.electronAPI.readLibraryImage(imagePath).then(({ data, mime }) => {
      if (cancelled) return;
      url = URL.createObjectURL(new Blob([data], { type: mime }));
      setImage({ path: imagePath, url });
    }).catch(() => useAssetLibrary.getState().setAvailable(asset.id, imagePath, false));
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [imagePath, asset]);
  return imagePath && image && image.path === imagePath ? image.url : undefined;
}

export default function AssetObject({ object, camera, interactive, selected, onDelete, startResize, resize }: Props) {
  const uiScale = useNoteStore(state => state.uiScale);
  const asset = useAssetLibrary(state => resolveAsset(state, object.assetId));
  const online = useAssetLibrary(state => asset ? state.available[asset.id] : false);
  const image = useAssetImage(object.assetId, true);
  const [menu, setMenu] = useState(false);
  const sizing = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const path = asset?.path ?? '';
  const isImage = isImageFile(path);
  const offline = online === false;

  return <div className="linked-asset-object" data-ink-object-id={object.id}
    data-ink-selected={selected || undefined} data-offline={offline} data-image={isImage && !offline}
    data-tooltip={offline ? '文件离线' : fileName(path)}
    onDoubleClick={event => {
      if (isImage && !offline) return;
      event.stopPropagation();
      if (offline) rebindAsset(object.assetId);
      else showAssetPreview(object.assetId);
    }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu(value => !value); }}
    style={{
      left: (camera.x + object.x * camera.zoom) / uiScale, top: (camera.y + object.y * camera.zoom) / uiScale,
      width: object.width * camera.zoom / uiScale, height: object.height * camera.zoom / uiScale,
      pointerEvents: interactive || offline || !isImage ? 'auto' : 'none',
    }}>
    {image && !offline ? <img src={image} alt={fileName(path)} draggable={false} /> : <div className="linked-asset-label">
      <strong>{fileName(path) || '找不到资料'}</strong>
      <small>{offline ? '文件离线' : fileTypeLabel(fileKind(path))}</small>
    </div>}
    {menu && <div className="linked-asset-menu">
      <button className="glass-btn" onClick={() => { setMenu(false); rebindAsset(object.assetId); }}>重新绑定</button>
      <button className="glass-btn" onClick={onDelete}>删除对象</button>
      <button className="glass-btn" onClick={() => setMenu(false)}>关闭</button>
    </div>}
    {interactive && selected && <button className="linked-asset-resize" data-tooltip="调整大小" aria-label="调整大小"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        sizing.current = { x: event.clientX, y: event.clientY, width: object.width, height: object.height };
        startResize();
      }}
      onPointerMove={event => {
        const start = sizing.current;
        if (!start) return;
        if (isImage) {
          const ratio = Math.max(1 / start.width, 1 / start.height, 1 + (event.clientX - start.x) / camera.zoom / start.width);
          resize(start.width * ratio, start.height * ratio);
        } else {
          resize(Math.max(54, start.width + (event.clientX - start.x) / camera.zoom),
            Math.max(28, start.height + (event.clientY - start.y) / camera.zoom));
        }
      }}
      onLostPointerCapture={() => { sizing.current = null; }}
      onPointerUp={() => { sizing.current = null; }}
      onPointerCancel={() => { sizing.current = null; }} />}
  </div>;
}
