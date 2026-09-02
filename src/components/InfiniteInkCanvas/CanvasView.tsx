/**
 * CanvasView — routes between the multi-canvas home screen and the ink editor.
 *
 * - No canvas open (currentCanvasId null) → <CanvasHome />.
 * - Canvas open → a nav bar (back / rename) + <InfiniteInkCanvas />, plus a
 *   fullscreen button sitting above the app settings gear at bottom-right.
 *
 * Opening a canvas calls switchCanvas() which flushes the previous canvas and
 * loads the target one; going home saves the current canvas first.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useCanvasLibrary } from './useCanvasLibrary';
import { useCanvasStore } from './useCanvasStore';
import InfiniteInkCanvas from './InfiniteInkCanvas';
import CanvasHome from './CanvasHome';

const btnStyle: React.CSSProperties = {
  padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '12px', border: '1px solid var(--glass-border)',
  background: 'var(--glass-bg-light)', color: 'var(--text-secondary)',
  transition: 'all var(--transition)',
};

// ---- Nav bar (editor top bar) ------------------------------------------------

const NavBar: React.FC<{
  name: string;
  onHome: () => void;
  onRename: (name: string) => void;
}> = ({ name, onHome, onRename }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 44, zIndex: 95,
      display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px',
      background: 'var(--chrome-bg)', borderBottom: '1px solid var(--glass-border)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    }}>
      <button onClick={onHome} style={btnStyle} title="返回画布列表">‹ 返回列表</button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { const v = draft.trim(); if (v) onRename(v); setEditing(false); }
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          style={{
            width: 200, padding: '4px 8px', fontFamily: 'inherit', fontSize: '13px',
            background: 'var(--glass-bg-light)', color: 'var(--text-primary)',
            border: '1px solid var(--accent)', borderRadius: '6px', outline: 'none',
          }}
        />
      ) : (
        <button onClick={() => setEditing(true)} title="点击重命名" style={{ ...btnStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
          {name}
        </button>
      )}
    </div>
  );
};

// ---- Fullscreen button ---------------------------------------------------------

const FullscreenButton: React.FC = () => {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.isFullScreen().then(setFullscreen);
    return window.electronAPI.onFullScreenChanged(setFullscreen);
  }, []);

  const toggle = useCallback(() => {
    if (window.electronAPI) window.electronAPI.toggleFullScreen().then(setFullscreen);
  }, []);

  return (
    <button
      onClick={toggle}
      title={fullscreen ? '退出全屏 (Esc)' : '全屏'}
      style={{
        position: 'absolute', bottom: '60px', right: '16px',
        width: '36px', height: '36px', borderRadius: '50%',
        background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--glass-border)',
        color: 'var(--text-secondary)', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 120, transition: 'all var(--transition)',
        boxShadow: 'var(--glass-shadow)',
      }}
    >
      {fullscreen ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      )}
    </button>
  );
};

// ---- CanvasView ----------------------------------------------------------------

const CanvasView: React.FC = () => {
  const currentCanvasId = useCanvasLibrary((s) => s.currentCanvasId);
  const canvases = useCanvasLibrary((s) => s.canvases);
  const loadLibrary = useCanvasLibrary((s) => s.loadLibrary);
  const setCurrentCanvasId = useCanvasLibrary((s) => s.setCurrentCanvasId);
  const renameCanvas = useCanvasLibrary((s) => s.renameCanvas);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  const openCanvas = useCallback((id: string) => {
    setCurrentCanvasId(id);
    useCanvasStore.getState().switchCanvas(id);
  }, [setCurrentCanvasId]);

  const newCanvas = useCallback(() => {
    const id = useCanvasLibrary.getState().addCanvas();
    useCanvasStore.getState().switchCanvas(id);
  }, []);

  const goHome = useCallback(() => {
    const st = useCanvasStore.getState();
    if (st.loaded && st.currentCanvasId) st.saveCanvasData();
    setCurrentCanvasId(null);
    useCanvasStore.setState({ currentCanvasId: null });
  }, [setCurrentCanvasId]);

  const current = canvases.find((c) => c.id === currentCanvasId);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)' }}>
      <div key={currentCanvasId || 'home'} className="animate-fade-in" style={{ position: 'absolute', inset: 0 }}>
        {!currentCanvasId || !current ? (
          <CanvasHome onOpen={openCanvas} onNew={newCanvas} />
        ) : (
          <>
            <NavBar name={current.name} onHome={goHome} onRename={(name) => renameCanvas(current.id, name)} />
            <div style={{ position: 'absolute', top: 44, left: 0, right: 0, bottom: 0 }}>
              <InfiniteInkCanvas />
            </div>
            <FullscreenButton />
          </>
        )}
      </div>
    </div>
  );
};

export default CanvasView;
