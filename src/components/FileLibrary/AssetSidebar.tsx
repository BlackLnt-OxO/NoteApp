import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ViewMode } from '../../types';
import { rebindAsset, useAssetLibrary } from './assetLibrary';
import { dispatchAssetDrop } from './assetDrop';
import { fileKind, fileName, fileTypeLabel } from './fileTypes';
import './fileLibrary.css';

interface Drag { id: string; path: string; pointer: number; x: number; y: number }

export default function AssetSidebar({ view, onView }: { view: ViewMode; onView: (view: ViewMode) => void }) {
  const assets = useAssetLibrary(state => state.assets);
  const available = useAssetLibrary(state => state.available);
  const pending = useRef<Drag | null>(null);
  const active = useRef(false);
  const [ghost, setGhost] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);

  const add = async () => {
    setError('');
    setPicking(true);
    try {
      const paths = await window.electronAPI?.pickLibraryFiles?.();
      if (paths?.length) useAssetLibrary.getState().add(paths);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPicking(false); }
  };

  useEffect(() => {
    const stopDrag = () => { pending.current = null; active.current = false; setGhost(null); };
    const move = (event: PointerEvent) => {
      const start = pending.current;
      if (!start || start.pointer !== event.pointerId) return;
      if (!active.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
      active.current = true;
      setGhost({ ...start, x: event.clientX, y: event.clientY });
    };
    const drop = (event: PointerEvent) => {
      const start = pending.current;
      if (!start || start.pointer !== event.pointerId) return;
      if (active.current) dispatchAssetDrop(start.id, event.clientX, event.clientY);
      stopDrag();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', drop, true);
    window.addEventListener('pointercancel', stopDrag);
    window.addEventListener('blur', stopDrag);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', drop, true);
      window.removeEventListener('pointercancel', stopDrag);
      window.removeEventListener('blur', stopDrag);
    };
  }, []);

  return <aside className="asset-sidebar">
    <nav aria-label="工作区" className="asset-view-switch">
      {([['notes', '便笺'], ['inkcanvas', '画布'], ['pdf', '文件']] as const).map(([key, label]) =>
        <button key={key} className="glass-btn" aria-current={view === key ? 'page' : undefined} onClick={() => onView(key)}>{label}</button>)}
    </nav>
    <div className="asset-sidebar-heading">
      <strong>资料库</strong>
      <button className="glass-btn" disabled={picking || !window.electronAPI?.pickLibraryFiles} onClick={() => void add()}>添加资料</button>
    </div>
    {error && <div role="alert" className="file-library-error">{error}</div>}
    <div className="asset-sidebar-list">
      {assets.length === 0 && <p>添加本地文件，然后拖到画布或批注页。</p>}
      {assets.map(asset => {
        const offline = available[asset.id] === false;
        return <div key={asset.id}>
          <button className="asset-row" data-offline={offline} data-tooltip={asset.path}
            onContextMenu={event => { event.preventDefault(); setMenu(asset.id); }}
            onPointerDown={event => {
              if (event.button !== 0 || offline) return;
              setMenu(null);
              pending.current = { id: asset.id, path: asset.path, pointer: event.pointerId, x: event.clientX, y: event.clientY };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}>
            <span>{fileName(asset.path)}</span><small>{offline ? '文件离线' : fileTypeLabel(fileKind(asset.path))}</small>
          </button>
          {menu === asset.id && <div className="asset-row-actions">
            <button className="glass-btn" onClick={() => { setMenu(null); rebindAsset(asset.id); }}>重新绑定</button>
            <button className="glass-btn" onClick={() => setMenu(null)}>关闭</button>
          </div>}
        </div>;
      })}
    </div>
    {ghost && createPortal(<div className="asset-drag-ghost" style={{ left: ghost.x + 12, top: ghost.y + 10 }}>
      {fileName(ghost.path)}
    </div>, document.body)}
  </aside>;
}
