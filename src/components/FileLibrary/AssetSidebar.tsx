import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import WorkspaceModeSwitch from '../WorkspaceModeSwitch';
import { rebindAsset, useAssetLibrary } from './assetLibrary';
import { dispatchAssetDrop } from './assetDrop';
import { fileKind, fileName, fileTypeLabel } from './fileTypes';
import { usePreviewGesture } from '../usePreviewGesture';
import { askConfirm } from '../ConfirmDialog';
import { droppedPaths, hasExternalFiles, validateDroppedPaths } from './externalFiles';
import './fileLibrary.css';

export default function AssetSidebar() {
  const assets = useAssetLibrary(state => state.assets).filter(asset => !asset.hidden);
  const available = useAssetLibrary(state => state.available);
  const ghost = useRef<HTMLDivElement>(null);
  const startPreview = usePreviewGesture();
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const [slot, setSlot] = useState<string | null>(null);
  const insertionSlot = (list: HTMLElement, y: number) =>
    Array.from(list.querySelectorAll<HTMLElement>('[data-library-row]')).find(row => {
      const bounds = row.getBoundingClientRect();
      return y < (bounds.top + bounds.bottom) / 2;
    })?.dataset.libraryRow ?? '';

  const add = async () => {
    setError('');
    setPicking(true);
    try {
      const paths = await window.electronAPI?.pickLibraryFiles?.();
      if (paths?.length) useAssetLibrary.getState().add(paths);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPicking(false); }
  };

  return <aside className="asset-sidebar">
    <WorkspaceModeSwitch />
    <div className="asset-sidebar-heading">
      <strong>资料库</strong>
      <button className="glass-btn" disabled={picking || !window.electronAPI?.pickLibraryFiles} onClick={() => void add()}>添加资料</button>
    </div>
    {error && <div role="alert" className="file-library-error">{error}</div>}
    <div className="asset-sidebar-list" data-file-drop={slot !== null || undefined}
      onDragOver={event => {
        if (!hasExternalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setSlot(insertionSlot(event.currentTarget, event.clientY));
      }}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setSlot(null);
      }}
      onDrop={event => {
        if (!hasExternalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const before = insertionSlot(event.currentTarget, event.clientY);
        setSlot(null);
        setError('');
        void validateDroppedPaths(droppedPaths(event.dataTransfer)).then(({ accepted, skipped }) => {
          useAssetLibrary.getState().add(accepted, before);
          if (skipped) setError(`已跳过 ${skipped} 个不支持或无法读取的文件。`);
        }).catch(err => setError(String(err.message ?? err)));
      }}>
      {assets.length === 0 && <p>添加本地文件，然后拖到画布或批注页。</p>}
      {assets.map(asset => {
        const offline = available[asset.id] === false;
        return <div key={asset.id} className="asset-row-wrap" data-insertion-target={slot === asset.id || undefined}>
          <button className="asset-row" data-library-row={asset.id} data-offline={offline} data-tooltip={asset.path}
            onContextMenu={event => { event.preventDefault(); setMenu(asset.id); }}
            onPointerDown={event => {
              const preview = ghost.current;
              if (event.button !== 0 || offline || !preview) return;
              setMenu(null);
              const x = event.clientX + 12;
              const y = event.clientY + 10;
              let moved = false;
              startPreview(event, {
                paint(dx, dy) {
                  if (!moved && Math.hypot(dx, dy) < 5) return;
                  if (!moved) {
                    preview.textContent = fileName(asset.path);
                    preview.hidden = false;
                    moved = true;
                  }
                  preview.style.transform = `translate3d(${x + dx}px, ${y + dy}px, 0)`;
                },
                finish(dx, dy, pointer) {
                  if (moved || Math.hypot(dx, dy) >= 5) dispatchAssetDrop(asset.id, pointer.clientX, pointer.clientY);
                },
                reset() { preview.hidden = true; },
              });
            }}>
            <span>{fileName(asset.path)}</span><small>{offline ? '文件离线' : fileTypeLabel(fileKind(asset.path))}</small>
          </button>
          {menu === asset.id && <div className="asset-row-actions">
            <button className="glass-btn" onClick={() => { setMenu(null); rebindAsset(asset.id); }}>重新绑定</button>
            <button className="glass-btn" onClick={() => {
              setMenu(null);
              void window.electronAPI?.revealLibraryFile(asset.path).catch(err => setError(String(err.message ?? err)));
            }}>打开所在文件夹</button>
            <button className="glass-btn" onClick={() => {
              setMenu(null);
              askConfirm({ title: '从资料库移除', message: `移除「${fileName(asset.path)}」？已经放进文档的对象仍可使用。`,
                confirmLabel: '移除', onConfirm: () => useAssetLibrary.getState().remove(asset.id) });
            }}>从资料库移除</button>
            <button className="glass-btn" onClick={() => setMenu(null)}>关闭</button>
          </div>}
        </div>;
      })}
      {slot === '' && <div className="asset-drop-end" aria-hidden="true">松手后添加文件</div>}
    </div>
    {createPortal(<div ref={ghost} className="asset-drag-ghost" hidden aria-hidden="true" style={{ left: 0, top: 0 }} />, document.body)}
  </aside>;
}
