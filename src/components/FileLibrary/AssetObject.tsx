import { useEffect, useRef, useState } from 'react';
import { useNoteStore } from '../../store';
import { rebindAsset, resolveAsset, showAssetPreview, showLocalAssetPreview, useAssetLibrary } from './assetLibrary';
import { fileKind, fileName, fileTypeLabel, isImageFile, type LinkedAssetObject } from './fileTypes';
import { boxResizePreview, usePreviewGesture } from '../usePreviewGesture';
import InkImageControls from '../InkImageControls';
import { pickReplacementDocument, reportFileError, useLocalFileOffline } from './externalFiles';
import './fileLibrary.css';

interface Props {
  object: LinkedAssetObject;
  camera: { x: number; y: number; zoom: number };
  interactive: boolean;
  selected: boolean;
  onDelete: () => void;
  startResize: () => void;
  resize: (width: number, height: number) => void;
  onRelink: (previous: string, path: string) => boolean;
}

export function useAssetImage(assetId: string | undefined, enabled: boolean) {
  const asset = useAssetLibrary(state => resolveAsset(state, assetId));
  const canonicalId = asset?.id;
  const path = asset?.path;
  const online = useAssetLibrary(state => asset ? state.available[asset.id] : false);
  const [image, setImage] = useState<{ path: string; url: string }>();
  const imagePath = enabled && online !== false && path && isImageFile(path) ? path : undefined;
  useEffect(() => {
    setImage(undefined);
    if (!imagePath || !canonicalId || !window.electronAPI?.readLibraryImage || !URL.createObjectURL) return;
    let cancelled = false;
    let url: string | undefined;
    void window.electronAPI.readLibraryImage(imagePath).then(({ data, mime }) => {
      if (cancelled) return;
      url = URL.createObjectURL(new Blob([data], { type: mime }));
      setImage({ path: imagePath, url });
    }).catch(() => useAssetLibrary.getState().setAvailable(canonicalId, imagePath, false));
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [imagePath, canonicalId]);
  return imagePath && image && image.path === imagePath ? image.url : undefined;
}

export default function AssetObject({ object, camera, interactive, selected, onDelete, startResize, resize, onRelink }: Props) {
  const uiScale = useNoteStore(state => state.uiScale);
  const asset = useAssetLibrary(state => resolveAsset(state, object.assetId));
  const online = useAssetLibrary(state => asset ? state.available[asset.id] : false);
  const image = useAssetImage(object.assetId, true);
  const [menu, setMenu] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const previewResize = usePreviewGesture(interactive && selected);
  const path = object.sourcePath ?? asset?.path ?? '';
  const localOffline = useLocalFileOffline(object.sourcePath);
  const isImage = isImageFile(path);
  const offline = object.sourcePath ? localOffline : online === false;
  const showImage = isImage && !offline;
  const relink = () => {
    if (object.assetId) return rebindAsset(object.assetId);
    void pickReplacementDocument().then(replacement => { if (replacement) onRelink(path, replacement); }).catch(reportFileError);
  };

  return <div ref={boxRef} className={showImage ? 'linked-asset-object ink-image-frame' : 'linked-asset-object'} data-ink-object-id={object.id}
    data-ink-selected={selected || undefined} data-offline={offline} data-image={showImage} data-interactive={interactive}
    data-tooltip={offline ? '文件离线' : fileName(path)}
    onDoubleClick={event => {
      if (showImage) return;
      event.stopPropagation();
      if (object.sourcePath) showLocalAssetPreview(path, onRelink);
      else if (object.assetId) {
        if (offline) relink();
        else showAssetPreview(object.assetId);
      }
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
      <button className="glass-btn" onClick={() => { setMenu(false); relink(); }}>重新绑定</button>
      <button className="glass-btn" onClick={onDelete}>删除对象</button>
      <button className="glass-btn" onClick={() => setMenu(false)}>关闭</button>
    </div>}
    {interactive && showImage && <InkImageControls box={boxRef} width={object.width} height={object.height}
      zoom={camera.zoom} uiScale={uiScale} onRemove={onDelete} onResize={(width, height) => { startResize(); resize(width, height); }} />}
    {interactive && selected && !showImage && <button className="linked-asset-resize" data-tooltip="调整大小" aria-label="调整大小"
      onPointerDown={event => {
        if (!boxRef.current) return;
        const { width, height } = object;
        const dimensions = (dx: number, dy: number) => ({
          width: Math.max(54, width + dx / camera.zoom), height: Math.max(28, height + dy / camera.zoom),
        });
        previewResize(event, boxResizePreview(boxRef.current, dimensions, camera.zoom / uiScale, (w, h) => {
          if (w === width && h === height) return;
          startResize();
          resize(w, h);
        }));
      }} />}
  </div>;
}
