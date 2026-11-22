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

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNoteStore } from "../../store";
import { fs } from "../../utils";
import { useCanvasLibrary } from './useCanvasLibrary';
import { useCanvasStore } from './useCanvasStore';
import InfiniteInkCanvas from './InfiniteInkCanvas';
import { INK_EDITOR_NAV_HEIGHT } from '../InkViewport';
import CanvasHome from './CanvasHome';

const btnStyle = (gfs: number): React.CSSProperties => ({
  padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: fs(12, gfs), border: '1px solid var(--glass-border)',
  background: 'var(--glass-bg-light)', color: 'var(--text-secondary)',
  transition: 'all var(--transition)',
});

// ---- Nav bar (editor top bar) ------------------------------------------------

const NavBar: React.FC<{
  name: string;
  onHome: () => void;
  onRename: (name: string) => void;
}> = ({ name, onHome, onRename }) => {
  const gfs = useNoteStore((s) => s.settings.fontSize);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: INK_EDITOR_NAV_HEIGHT, zIndex: 95,
      display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px',
      background: 'var(--chrome-bg)', borderBottom: '1px solid var(--glass-border)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    }}>
      <button className="glass-btn" onClick={onHome} style={btnStyle(gfs)} data-tooltip="返回画布列表">‹ 返回列表</button>
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
            width: 200, padding: '4px 8px', fontFamily: 'inherit', fontSize: fs(13, gfs),
            background: 'var(--glass-bg-light)', color: 'var(--text-primary)',
            border: '1px solid var(--accent)', borderRadius: '6px', outline: 'none',
          }}
        />
      ) : (
        <button className="glass-btn" onClick={() => setEditing(true)} data-tooltip="点击重命名" style={{ ...btnStyle(gfs), fontWeight: 600, color: 'var(--text-primary)' }}>
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
      data-tooltip={fullscreen ? '退出全屏 (Esc)' : '全屏'}
      className="hover-ring-light"
      style={{
        position: 'absolute', bottom: '60px', right: '16px',
        width: '36px', height: '36px', borderRadius: '50%',
        background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--glass-border)',
        color: 'var(--text-secondary)', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 120,
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
  const navigation = useRef(0);
  const navigationBusy = useRef(false);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const saveStatus = useCanvasStore(s => s.saveStatus);
  const saveError = useCanvasStore(s => s.saveError);
  const storageWarning = useCanvasStore(s => s.storageWarning);
  const currentCanvasId = useCanvasLibrary((s) => s.currentCanvasId);
  const canvases = useCanvasLibrary((s) => s.canvases);
  const loadLibrary = useCanvasLibrary((s) => s.loadLibrary);
  const setCurrentCanvasId = useCanvasLibrary((s) => s.setCurrentCanvasId);
  const renameCanvas = useCanvasLibrary((s) => s.renameCanvas);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);
  useEffect(() => {
    const blockKeys = (event: KeyboardEvent) => {
      if (!navigationBusy.current) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', blockKeys, true);
    return () => document.removeEventListener('keydown', blockKeys, true);
  }, []);

  const openCanvas = useCallback(async (id: string) => {
    if (navigationBusy.current) return;
    navigationBusy.current = true; setNavigationLoading(true);
    const ticket = ++navigation.current;
    setNavigationError(null);
    try {
      await useCanvasStore.getState().switchCanvas(id);
      if (ticket === navigation.current) setCurrentCanvasId(id);
    } catch (error) { setNavigationError(error instanceof Error ? error.message : String(error)); }
    finally { navigationBusy.current = false; setNavigationLoading(false); }
  }, [setCurrentCanvasId]);
  const newCanvas = useCallback(() => { void openCanvas(useCanvasLibrary.getState().addCanvas()); }, [openCanvas]);
  const goHome = useCallback(async () => {
    if (navigationBusy.current) return;
    navigationBusy.current = true; setNavigationLoading(true);
    window.dispatchEvent(new Event('ink:flush-gesture'));
    ++navigation.current;
    const st = useCanvasStore.getState();
    try {
      while (st.loaded && st.currentCanvasId) {
        if (!await useCanvasStore.getState().saveCanvasData()) return;
        if (useCanvasStore.getState().saveStatus === 'saved') break;
      }
      setCurrentCanvasId(null);
      useCanvasStore.setState({ currentCanvasId: null });
    } finally {
      navigationBusy.current = false; setNavigationLoading(false);
    }
  }, [setCurrentCanvasId]);

  const current = canvases.find((c) => c.id === currentCanvasId);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: current ? 'var(--page-bg)' : undefined }}>
      {navigationLoading && <div role="status" aria-live="polite" style={{ position: 'absolute', inset: 0, zIndex: 150,
        display: 'grid', placeItems: 'center', background: 'var(--glass-bg)', cursor: 'wait' }}>正在保存并打开画布…</div>}
      {(navigationError || saveStatus === 'error' || storageWarning) && <div role="alert" style={{ position: 'absolute', top: 48, right: 12, zIndex: 130, background: 'var(--chrome-bg)', padding: 12 }}>
        {navigationError || saveError || storageWarning || '画布保存失败'}
        {saveStatus === 'error' && <button onClick={() => { setNavigationError(null); void useCanvasStore.getState().saveCanvasData(); }}>重试保存</button>}
      </div>}
      <div key={currentCanvasId || 'home'} className={current ? 'animate-fade-in' : undefined} style={{ position: 'absolute', inset: 0 }}>
        {!currentCanvasId || !current ? (
          <CanvasHome onOpen={openCanvas} onNew={newCanvas} />
        ) : (
          <>
            <NavBar name={current.name} onHome={goHome} onRename={(name) => renameCanvas(current.id, name)} />
            <div style={{ position: 'absolute', top: INK_EDITOR_NAV_HEIGHT, left: 0, right: 0, bottom: 0 }}>
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
