import React, { useEffect, useState, useCallback } from 'react';
import { useNoteStore } from './store';
import Sidebar from './components/Sidebar';
import NoteGrid from './components/NoteGrid';
import CreateNoteDialog from './components/CreateNoteDialog';
import SettingsDialog from './components/SettingsDialog';
import ConfirmHost from './components/ConfirmDialog';
import DataDirectoryPrompt from './components/DataDirectoryPrompt';
import ScreenshotTool from './components/ScreenshotTool';
import DiagnosticPanel from './components/DiagnosticPanel';
import CanvasView from './components/InfiniteInkCanvas/CanvasView';
import { useCanvasStore } from './components/InfiniteInkCanvas/useCanvasStore';
import PdfView from './components/PdfAnnotation/PdfView';
import { usePdfStore } from './components/PdfAnnotation/PdfStore';
import { themeCanvasColors, isDefaultBrushColor } from './themeColors';
import { fs, fsn } from './utils';

// Round glass affordance shared by the collapsed-state screenshot buttons
// (bottom-left cluster) — same look as the settings / fullscreen circles.
const shotBtnStyle: React.CSSProperties = {
  width: '36px', height: '36px', borderRadius: '50%',
  background: 'var(--glass-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
  border: '1px solid var(--glass-border)',
  color: 'var(--text-secondary)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: 'var(--glass-shadow)',
};

const App: React.FC = () => {
  const { settings, loadData, saveData, setNoteFloating, viewMode, setViewMode, sidebarCollapsed, setSidebarCollapsed, toggleSidebar } = useNoteStore();
  const gfs = settings.fontSize;
  const titleBarH = gfs >= 18 ? fsn(38, gfs) : 38;
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [dataDirState, setDataDirState] = useState<'checking' | 'ready' | 'prompt'>('checking');
  const [isMaximized, setIsMaximized] = useState(false);
  const [fontToast, setFontToast] = useState({ show: false, size: 14, fading: false });
  // Viewport-style UI zoom: the window stays fixed and the scaled content always
  // fills it (no black bars, nothing clipped). Default = current viewport (1.0).
  const [uiScale, setUiScale] = useState(() => {
    const v = parseFloat(localStorage.getItem('sticky-notes-ui-zoom') || '');
    return Number.isFinite(v) && v >= 0.7 && v <= 1.6 ? v : 1;
  });
  const [uiZoomToast, setUiZoomToast] = useState({ show: false, value: 0, fading: false });

  useEffect(() => { loadData(); }, []);

  // First-run check: until a data directory is configured, show the setup prompt.
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getDataDirectory().then((info) => {
        setDataDirState(info.isConfigured ? 'ready' : 'prompt');
      });
    } else {
      setDataDirState('ready'); // browser dev — no data-dir flow
    }
  }, []);

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

  const zoomStep = useCallback((delta: number) => {
    setUiScale((prev) => {
      const n = Math.min(1.6, Math.max(0.7, Math.round((prev + delta) * 10) / 10));
      localStorage.setItem('sticky-notes-ui-zoom', String(n));
      // Toast: show immediately, fade out after a beat (mirrors fontToast).
      setUiZoomToast({ show: true, value: n, fading: false });
      clearTimeout((window as any).__uiZoomTimer);
      (window as any).__uiZoomTimer = setTimeout(() => {
        setUiZoomToast((prev) => ({ ...prev, fading: true }));
        setTimeout(() => setUiZoomToast((p) => ({ show: false, value: p.value, fading: false })), 600);
      }, 1500);
      return n;
    });
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
      // Ctrl+Shift+= / Ctrl+Shift+- → viewport UI zoom (fills the fixed window).
      if (e.ctrlKey && e.shiftKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomStep(0.1);
      }
      if (e.ctrlKey && e.shiftKey && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        zoomStep(-0.1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomStep]);


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

  // Before the data directory is chosen, show the first-run prompt instead of
  // the main UI (all hooks above already ran, so this early return is safe).
  if (dataDirState !== 'ready') {
    return dataDirState === 'prompt'
      ? <DataDirectoryPrompt onDone={() => setDataDirState('ready')} />
      : null;
  }

  return (
    <div style={{
      // Viewport zoom: compensate the layout size by 1/uiScale so that after
      // transform: scale the content exactly fills the fixed window.
      width: `${100 / uiScale}vw`,
      height: `${100 / uiScale}vh`,
      transform: `scale(${uiScale})`,
      transformOrigin: 'top left',
      display: 'flex', flexDirection: 'column',
      backgroundImage: settings.backgroundImage
        ? `linear-gradient(rgba(var(--app-overlay),${(1 - settings.backgroundOpacity).toFixed(2)}), rgba(var(--app-overlay),${(1 - settings.backgroundOpacity).toFixed(2)})), url(${settings.backgroundImage})`
        : 'none',
      backgroundSize: 'cover', backgroundPosition: 'center',
      backgroundColor: 'var(--page-bg)',
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
        {/* Sidebar lives in a width-clamping container so collapse/expand gets a
            smooth height-free width transition (the content area re-flows each
            frame, and NoteGrid/FlowGrid's left/top transitions animate the cards). */}
        <div style={{
          width: sidebarCollapsed ? 0 : 220,
          overflow: 'hidden', flexShrink: 0,
          display: 'flex',
          transition: 'width var(--transition-slow)',
          borderRight: sidebarCollapsed ? 'none' : '1px solid var(--glass-border)',
        }}>
          <Sidebar onCreateNote={() => setShowCreateDialog(true)} />
        </div>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRadius: '0 0 12px 0', display: 'flex', flexDirection: 'column' }}>
          {/* When the left sidebar is collapsed, a slim top bar keeps the view
              switcher reachable (screenshots live in the bottom-left cluster). */}
          {sidebarCollapsed && (
            <div style={{
              flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 10px', background: 'var(--chrome-bg)',
              borderBottom: '1px solid var(--glass-border)', zIndex: 98,
            }}>
              {([{ id: 'notes' as const, label: '便笺' }, { id: 'inkcanvas' as const, label: '画布' }, { id: 'pdf' as const, label: 'PDF' }]).map((m) => (
                <button key={m.id} onClick={() => { setViewMode(m.id); if (m.id === 'notes') setSidebarCollapsed(false); }}
                  className={viewMode === m.id ? 'hover-ring-dark' : 'hover-ring-light'}
                  style={{ padding: '4px 10px', borderRadius: '6px', background: viewMode === m.id ? 'var(--accent)' : 'var(--glass-bg-light)',
                    border: viewMode === m.id ? 'none' : '1px solid var(--glass-border)', color: viewMode === m.id ? '#fff' : 'var(--text-secondary)',
                    cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {/* key=viewMode remounts on switch → the fade-in plays each time. */}
          <div key={viewMode} className="animate-fade-in" style={{ flex: 1, position: 'relative', minHeight: 0 }}>
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
          </div>

          {/* Bottom-left cluster: while the sidebar is collapsed it stacks the
              two round screenshot buttons above the sidebar toggle; as soon as
              the sidebar opens those disappear (the sidebar's own bottom buttons
              take over), so there is never a duplicate entry. */}
          <div style={{
            position: 'absolute', bottom: '16px', left: '16px', zIndex: 120,
            display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center',
          }}>
            {sidebarCollapsed && (<>
              <button onClick={() => window.electronAPI?.startScreenshot()} title="截图" className="hover-ring-light" style={shotBtnStyle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
              <button onClick={() => window.electronAPI?.startLongScreenshot()} title="长截图" className="hover-ring-light" style={shotBtnStyle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="3" width="16" height="10" rx="2" />
                  <path d="M12 15v4" />
                  <path d="m9 19 3 3 3-3" />
                </svg>
              </button>
            </>)}
            {/* Sidebar toggle — stays bottom-most and open-state aware (panel icon
                points left → collapse, right → expand). */}
            <button
              onClick={toggleSidebar}
              title={sidebarCollapsed ? '展开边栏' : '收起边栏'}
              className="hover-ring-light"
              style={{
                width: '36px', height: '36px', borderRadius: '12px',
                background: 'var(--glass-bg)', backdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                color: 'var(--text-secondary)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: 'var(--glass-shadow)',
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: sidebarCollapsed ? 'scaleX(-1)' : 'none', transition: 'transform 0.2s' }}>
                <rect x="3" y="3" width="18" height="18" rx="3" opacity="0.5" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          </div>

          {/* Global settings entry — bottom-right on all three views. */}
          <button onClick={() => setShowSettings(true)} title="设置" className="hover-ring-light" style={{
            position: 'absolute', bottom: '16px', right: '16px',
            width: '36px', height: '36px', borderRadius: '50%',
            background: 'var(--glass-bg)', backdropFilter: 'blur(20px)',
            border: '1px solid var(--glass-border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 120,
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
      {uiZoomToast.show && (
        <div style={{
          position: 'fixed', bottom: '60px', right: '20px', zIndex: 10001,
          background: 'var(--glass-bg)', backdropFilter: 'blur(12px)',
          border: '1px solid var(--glass-border)', borderRadius: '12px',
          padding: '6px 16px', color: 'var(--text-primary)',
          fontSize: '16px', fontWeight: 600, fontFamily: 'inherit',
          boxShadow: 'var(--glass-shadow)',
          opacity: uiZoomToast.fading ? 0 : 1,
          transition: 'opacity 0.5s ease',
        }}>{Math.round(uiZoomToast.value * 100)}%</div>
      )}
      {showCreateDialog && <CreateNoteDialog onClose={() => setShowCreateDialog(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <DiagnosticPanel visible={showDiagnostic} onClose={() => setShowDiagnostic(false)} />
      <ConfirmHost />
    </div>
  );
};

export default App;
