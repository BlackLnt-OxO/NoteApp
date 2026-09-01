import React, { useEffect, useState, useCallback } from 'react';
import { useNoteStore } from './store';
import Sidebar from './components/Sidebar';
import NoteGrid from './components/NoteGrid';
import CreateNoteDialog from './components/CreateNoteDialog';
import SettingsDialog from './components/SettingsDialog';
import ScreenshotTool from './components/ScreenshotTool';
import DiagnosticPanel from './components/DiagnosticPanel';
import CanvasView from './components/InfiniteInkCanvas/CanvasView';
import { useCanvasStore } from './components/InfiniteInkCanvas/useCanvasStore';
import PdfView from './components/PdfAnnotation/PdfView';
import { usePdfStore } from './components/PdfAnnotation/PdfStore';
import { themeCanvasColors, isDefaultBrushColor } from './themeColors';
import { fs, fsn } from './utils';

const App: React.FC = () => {
  const { settings, loadData, saveData, setNoteFloating, viewMode } = useNoteStore();
  const gfs = settings.fontSize;
  const titleBarH = gfs >= 18 ? fsn(38, gfs) : 38;
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [fontToast, setFontToast] = useState({ show: false, size: 14, fading: false });

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.body.style.fontFamily = settings.fontFamily;
    document.body.style.fontSize = settings.fontSize + 'px';
    // Update all floating notes with new font size
    const floatingNotes = useNoteStore.getState().notes.filter(n => n.isFloating);
    floatingNotes.forEach(n => {
      window.electronAPI?.updateFloatingNote(n.id, {
        ...n,
        content: n.content,
        fontSize: settings.fontSize,
        settingsBgOpacity: settings.backgroundOpacity,
      });
    });
    // Keep default-brush ink contrast-correct when the theme flips (user-picked
    // colors are left alone).
    const colors = themeCanvasColors(settings.theme);
    const cs = useCanvasStore.getState();
    if (isDefaultBrushColor(cs.brushSettings.color)) {
      cs.setBrushSettings({ color: colors.defaultBrush });
    }
    const ps = usePdfStore.getState();
    if (isDefaultBrushColor(ps.brush.color)) {
      ps.setBrush({ color: colors.defaultBrush });
    }
  }, [settings.theme, settings.fontFamily, settings.fontSize, settings.backgroundOpacity]);

  // Ctrl+Scroll font zoom (throttled)
  useEffect(() => {
    let lastTime = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const now = Date.now();
        if (now - lastTime < 60) return;
        lastTime = now;
        const store = useNoteStore.getState();
        const delta = e.deltaY > 0 ? -1 : 1;
        const newSize = Math.max(11, Math.min(28, store.settings.fontSize + delta));
        store.updateSettings({ fontSize: newSize });
        setFontToast({ show: true, size: newSize, fading: false });
        clearTimeout((window as any).__fontToastTimer);
        (window as any).__fontToastTimer = setTimeout(() => {
          setFontToast(prev => ({ ...prev, fading: true }));
          setTimeout(() => setFontToast(prev2 => prev2.fading ? { show: false, size: prev2.size, fading: false } : prev2), 600);
        }, 2500);
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // Ctrl+Shift+X screenshot shortcut (renderer fallback)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        window.electronAPI?.startScreenshot();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setShowDiagnostic(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);


  useEffect(() => {
    const handleBeforeUnload = () => saveData();
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [saveData]);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onFloatingClosed((noteId: string) => {
        setNoteFloating(noteId, false, undefined);
      });
      window.electronAPI.onAllFloatingClosed(() => {
        useNoteStore.getState().notes.forEach((n) => {
          if (n.isFloating) setNoteFloating(n.id, false, undefined);
        });
      });
      // Sync float window text edits back to main note
      window.electronAPI.onFloatContentUpdated(({ noteId, content }: any) => {
        const st = useNoteStore.getState();
        const note = st.notes.find((n: any) => n.id === noteId);
        if (note) st.updateNote(noteId, { content });
      });
    }
  }, [setNoteFloating]);

  const handleMinimize = useCallback(() => window.electronAPI?.minimize(), []);
  const handleMaximize = useCallback(async () => {
    if (window.electronAPI) {
      const m = await window.electronAPI.maximize();
      setIsMaximized(m);
    }
  }, []);
  const handleClose = useCallback(() => window.electronAPI?.close(), []);

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      backgroundImage: settings.backgroundImage
        ? `linear-gradient(rgba(26,26,46,${(1 - settings.backgroundOpacity).toFixed(2)}), rgba(26,26,46,${(1 - settings.backgroundOpacity).toFixed(2)})), url(${settings.backgroundImage})`
        : 'none',
      backgroundSize: 'cover', backgroundPosition: 'center',
      backgroundColor: '#1a1a2e',
      borderRadius: '12px', overflow: 'hidden',
    }}>

      <div className="title-bar glass" style={{
        borderRadius: '12px 12px 0 0', borderBottom: '1px solid var(--glass-border)',
        height: titleBarH, minHeight: titleBarH,
      }}>
        <div className="title-bar-left">
          <span style={{ fontSize: fs(13, gfs), fontWeight: 500, color: 'var(--text-secondary)', letterSpacing: '0.3px' }}>
            Sticky Notes
          </span>
        </div>
        <div className="title-bar-right">
          <button className="title-btn" onClick={handleMinimize} title="最小化" style={{ fontSize: fs(13, gfs), width: fsn(32, gfs), height: fsn(28, gfs) }}>_</button>
          <button className="title-btn" onClick={handleMaximize} title={isMaximized ? '还原' : '最大化'} style={{ fontSize: fs(13, gfs), width: fsn(32, gfs), height: fsn(28, gfs) }}>
            {isMaximized ? '[]' : 'o'}
          </button>
          <button className="title-btn close" onClick={handleClose} title="关闭" style={{ fontSize: fs(13, gfs), width: fsn(32, gfs), height: fsn(28, gfs) }}>x</button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar onCreateNote={() => setShowCreateDialog(true)} />
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRadius: '0 0 12px 0' }}>
          {viewMode === 'inkcanvas' ? (
            <CanvasView />
          ) : viewMode === 'pdf' ? (
            <PdfView />
          ) : (
            <>
              <div style={{
                position: 'absolute', inset: 0,
                background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                borderLeft: '1px solid var(--glass-border)',
              }} />
              <NoteGrid />
            </>
          )}

          {/* Global settings entry — bottom-right on all three views. */}
          <button onClick={() => setShowSettings(true)} title="设置" style={{
            position: 'absolute', bottom: '16px', right: '16px',
            width: '36px', height: '36px', borderRadius: '50%',
            background: 'var(--glass-bg)', backdropFilter: 'blur(20px)',
            border: '1px solid var(--glass-border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 120, transition: 'all var(--transition)',
            boxShadow: 'var(--glass-shadow)',
          }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'rotate(30deg)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'rotate(0deg)'; }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>

      <ScreenshotTool />
      {fontToast.show && (
        <div
          onMouseEnter={() => {
            clearTimeout((window as any).__fontToastTimer);
            setFontToast(prev => ({ ...prev, fading: false }));
          }}
          onMouseLeave={() => {
            setFontToast(prev => ({ ...prev, fading: true }));
            setTimeout(() => setFontToast(prev2 => prev2.fading ? { show: false, size: prev2.size, fading: false } : prev2), 600);
          }}
          style={{
          position: 'fixed', bottom: '60px', right: '20px', zIndex: 10001,
          background: 'var(--glass-bg)', backdropFilter: 'blur(12px)',
          border: '1px solid var(--glass-border)', borderRadius: '12px',
          padding: '6px 16px', color: 'var(--text-primary)',
          fontSize: '18px', fontWeight: 600, fontFamily: 'inherit',
          boxShadow: 'var(--glass-shadow)',
          opacity: fontToast.fading ? 0 : 1,
          transition: 'opacity 0.5s ease',
          pointerEvents: 'auto',
        }}>{fontToast.size}px</div>
      )}
      {showCreateDialog && <CreateNoteDialog onClose={() => setShowCreateDialog(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <DiagnosticPanel visible={showDiagnostic} onClose={() => setShowDiagnostic(false)} />
    </div>
  );
};

export default App;
