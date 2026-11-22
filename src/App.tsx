import React, { useEffect, useState, useCallback, useLayoutEffect, useRef } from 'react';
import { useNoteStore } from './store';
import Sidebar from './components/Sidebar';
import NoteGrid from './components/NoteGrid';
import AssetSidebar from './components/FileLibrary/AssetSidebar';
import AssetPreview from './components/FileLibrary/AssetPreview';
import { FileDialog } from './components/FileLibrary/FileDialogs';
import { useAssetLibrary } from './components/FileLibrary/assetLibrary';
import CreateNoteDialog from './components/CreateNoteDialog';
import SettingsDialog from './components/SettingsDialog';
import ConfirmHost from './components/ConfirmDialog';
import DataDirectoryPrompt from './components/DataDirectoryPrompt';
import ScreenshotTool from './components/ScreenshotTool';
import DiagnosticPanel from './components/DiagnosticPanel';
import CanvasView from './components/InfiniteInkCanvas/CanvasView';
import { canvasRepository } from './components/InfiniteInkCanvas/CanvasRepository';
import { useCanvasLibrary } from './components/InfiniteInkCanvas/useCanvasLibrary';
import { useCanvasStore } from './components/InfiniteInkCanvas/useCanvasStore';
import PdfView from './components/PdfAnnotation/PdfView';
import { usePdfStore } from './components/PdfAnnotation/PdfStore';
import { themeCanvasColors, isDefaultBrushColor } from './themeColors';
import { fs, fsn } from './utils';
import { backgroundShade, cardFrostRadius } from './workspaceBackground';
import { setGlassBlur } from './components/liquidGlassSurface';

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
  const { settings, loadData, saveData, setNoteFloating, viewMode, setViewMode, sidebarCollapsed, setSidebarCollapsed, toggleSidebar, setUiScale } = useNoteStore();
  // Subscribe via selector so the title-bar zoom readout re-renders on change.
  const uiScale = useNoteStore((s) => s.uiScale);
  const canvasOpen = useCanvasLibrary(s => s.canvases.some(canvas => canvas.id === s.currentCanvasId));
  const fileOpen = usePdfStore(s => !!s.fileName);
  const shade = backgroundShade(settings.backgroundOpacity);
  const frostRadius = cardFrostRadius(settings.cardFrost);
  const showBackground = viewMode === 'notes' || (viewMode === 'inkcanvas' ? !canvasOpen : !fileOpen);
  const previousView = useRef(viewMode);
  const switchingView = previousView.current !== viewMode;
  const gfs = settings.fontSize;
  const titleBarH = gfs >= 18 ? fsn(38, gfs) : 38;
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [assetError, setAssetError] = useState('');

  useLayoutEffect(() => { previousView.current = viewMode; }, [viewMode]);
  useLayoutEffect(() => { setGlassBlur(frostRadius); }, [frostRadius]);

  useEffect(() => {
    const assets = useAssetLibrary.getState();
    assets.load();
    const refresh = () => { void assets.refresh().catch(() => {}); };
    const showError = (event: Event) => setAssetError(String((event as CustomEvent).detail));
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('noteapp:asset-error', showError);
    const interval = window.setInterval(() => { if (document.hasFocus()) refresh(); }, 3000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('noteapp:asset-error', showError);
      window.clearInterval(interval);
    };
  }, []);

  const openAssetDocument = async (path: string) => {
    try {
      window.dispatchEvent(new Event('ink:flush-gesture'));
      while (viewMode === 'inkcanvas' && useCanvasStore.getState().currentCanvasId && useCanvasStore.getState().loaded) {
        if (!await useCanvasStore.getState().saveCanvasData()) throw new Error('画布保存失败。');
        if (useCanvasStore.getState().saveStatus === 'saved') break;
      }
      useAssetLibrary.setState({ requestedPath: path });
      setViewMode('pdf');
    } catch (error) { setAssetError(error instanceof Error ? error.message : String(error)); }
  };
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [dataDirState, setDataDirState] = useState<'checking' | 'ready' | 'prompt'>('checking');
  const [storageBarrier, setStorageBarrier] = useState(false);
  useEffect(() => {
    if (!storageBarrier) return;
    const blockKeys = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    document.addEventListener('keydown', blockKeys, true);
    return () => document.removeEventListener('keydown', blockKeys, true);
  }, [storageBarrier]);
  const [isMaximized, setIsMaximized] = useState(false);
  const [fontToast, setFontToast] = useState({ show: false, size: 14, fading: false });
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
      });
    });
    // Keep default-brush ink contrast-correct when the theme flips (user-picked
    // colors are left alone).
    const colors = themeCanvasColors(settings.theme);
    const cs = useCanvasStore.getState();
    if (isDefaultBrushColor(cs.brushSettings.color)) {
      cs.setBrushSettings({ color: colors.defaultBrush });
    }
    // PDF annotations use a FIXED default color (PDF_ANNOTATION_BLUE) that does
    // NOT follow the app theme — intentionally no PDF branch here.
  }, [settings.theme, settings.fontFamily, settings.fontSize]);

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
    const prev = useNoteStore.getState().uiScale;
    const n = Math.min(1.6, Math.max(0.7, Math.round((prev + delta) * 10) / 10));
    localStorage.setItem('sticky-notes-ui-zoom', String(n));
    setUiScale(n);
    // Toast: show immediately, fade out after a beat (mirrors fontToast).
    setUiZoomToast({ show: true, value: n, fading: false });
    clearTimeout((window as any).__uiZoomTimer);
    (window as any).__uiZoomTimer = setTimeout(() => {
      setUiZoomToast((prev) => ({ ...prev, fading: true }));
      setTimeout(() => setUiZoomToast((p) => ({ show: false, value: p.value, fading: false })), 600);
    }, 1500);
  }, [setUiScale]);

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
      // Ctrl + +/- (with or without Shift) → UI zoom. preventDefault also stops
      // Chromium's own page-zoom from firing, which would otherwise scale the page
      // without the app knowing and desync the readout (the "stuck at 150%" bug).
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomStep(0.1);
      }
      if (e.ctrlKey && (e.key === '-' || e.key === '_')) {
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

  useEffect(() => window.electronAPI?.onStorageFlush?.(async id => {
    setStorageBarrier(true);
    try {
      window.dispatchEvent(new Event('ink:flush-gesture'));
      window.dispatchEvent(new Event('ink:suspend-background'));
      await useNoteStore.getState().saveData();
      useCanvasLibrary.getState().saveState();
      while (useCanvasStore.getState().currentCanvasId && useCanvasStore.getState().loaded) {
        if (!await useCanvasStore.getState().saveCanvasData()) throw new Error(useCanvasStore.getState().saveError ?? '保存失败');
        if (useCanvasStore.getState().saveStatus === 'saved') break;
      }
      do {
        const pdf = await usePdfStore.getState().saveAnnotations();
        if (!pdf.ok) throw new Error('PDF 标注保存失败');
      } while (usePdfStore.getState().dirty);
      await canvasRepository.close();
      window.electronAPI?.storageFlushed(id);
    } catch (error) {
      setStorageBarrier(false); window.dispatchEvent(new Event('ink:resume-background'));
      window.electronAPI?.storageFlushed(id, error instanceof Error ? error.message : String(error));
    }
  }), []);

  useEffect(() => window.electronAPI?.onStorageResume?.(() => {
    setStorageBarrier(false); window.dispatchEvent(new Event('ink:resume-background'));
  }), []);

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
      '--workspace-surface-opacity': Math.min(1, shade * 1.2),
      '--card-frost-filter': frostRadius ? `blur(${frostRadius}px)` : 'none',
      // Viewport zoom: compensate the layout size by 1/uiScale so that after
      // transform: scale the content exactly fills the fixed window.
      width: `${100 / uiScale}vw`,
      height: `${100 / uiScale}vh`,
      transform: `scale(${uiScale})`,
      transformOrigin: 'top left',
      display: 'flex', flexDirection: 'column',
      position: 'relative',
      backgroundColor: 'var(--page-bg)',
      borderRadius: '12px', overflow: 'hidden',
    } as React.CSSProperties}>
      {storageBarrier && <div role="status" style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.3)' }}>正在保存…</div>}

      {/* Background image via <img>, NOT CSS url(data:) — Chromium drops very large
          base64 data URLs in CSS, which is why the background never painted even
          though the renderer held the data. <img> renders any size reliably. */}
      {settings.backgroundImage && showBackground && (
        <img
          src={settings.backgroundImage}
          alt=""
          data-workspace-background
          style={{
            position: 'absolute', inset: 0, zIndex: 0,
            width: '100%', height: '100%',
            objectFit: 'cover', objectPosition: 'center',
            background: 'var(--page-bg)', pointerEvents: 'none',
          }}
        />
      )}
      {/* Dimming overlay on top of the image, driven by background opacity. */}
      {settings.backgroundImage && showBackground && (
        <div data-workspace-background-shade style={{
          position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
          background: `rgba(var(--app-overlay), ${shade})`,
        }} />
      )}

      <div className="title-bar glass" style={{
        position: 'relative', zIndex: 2,
        borderRadius: '12px 12px 0 0', borderBottom: '1px solid var(--glass-border)',
        height: titleBarH, minHeight: titleBarH,
      }}>
        <div className="title-bar-left">
          <span style={{ fontSize: fs(13, gfs), fontWeight: 500, color: 'var(--text-secondary)', letterSpacing: '0.3px' }}>
            Sticky Notes
          </span>
        </div>
        <div className="title-bar-right">
          <span
            data-tooltip="界面缩放：Ctrl+Shift 加/减 (60%–150%)"
            style={{ fontSize: fs(11, gfs), color: 'var(--text-muted)', marginRight: fs(8, gfs), userSelect: 'none', minWidth: fsn(38, gfs), textAlign: 'right' }}
          >
            {Math.round((uiScale - 0.1) * 100)}%
          </span>
          <button className="title-btn" onClick={handleMinimize} aria-label="最小化" style={{ fontSize: fs(13, gfs), width: fsn(32, gfs), height: fsn(28, gfs) }}>_</button>
          <button className="title-btn" onClick={handleMaximize} aria-label={isMaximized ? '还原' : '最大化'} style={{ fontSize: fs(13, gfs), width: fsn(32, gfs), height: fsn(28, gfs) }}>
            {isMaximized ? '[]' : 'o'}
          </button>
          <button className="title-btn close" onClick={handleClose} aria-label="关闭" style={{ fontSize: fs(13, gfs), width: fsn(32, gfs), height: fsn(28, gfs) }}>x</button>
        </div>
      </div>

      <div data-ink-workspace style={{ position: 'relative', zIndex: 2, flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Manual toggles reflow the grid. A workspace switch measures its new width immediately. */}
        <div style={{
          width: sidebarCollapsed ? 0 : 220,
          overflow: 'hidden', flexShrink: 0,
          display: 'flex',
          transition: switchingView ? 'none' : 'width var(--transition-slow)',
          borderRight: sidebarCollapsed ? 'none' : '1px solid var(--glass-border)',
        }}>
          {viewMode === 'notes'
            ? <Sidebar onCreateNote={() => setShowCreateDialog(true)} />
            : <AssetSidebar />}
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
              {([{ id: 'notes' as const, label: '便笺' }, { id: 'inkcanvas' as const, label: '画布' }, { id: 'pdf' as const, label: '文件' }]).map((m) => (
                <button key={m.id} onClick={() => { setViewMode(m.id); if (m.id !== viewMode) setSidebarCollapsed(false); }}
                  className={viewMode === m.id ? 'hover-ring-dark' : 'hover-ring-light'}
                  style={{ padding: '4px 10px', borderRadius: '6px', background: viewMode === m.id ? 'var(--accent)' : 'var(--glass-bg-light)',
                    border: viewMode === m.id ? 'none' : '1px solid var(--glass-border)', color: viewMode === m.id ? '#fff' : 'var(--text-secondary)',
                    cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {/* Home grids animate their cards after the backdrop filters are ready. */}
          <div key={viewMode} className={showBackground ? undefined : 'animate-fade-in'} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {viewMode === 'inkcanvas' ? (
              <CanvasView />
            ) : viewMode === 'pdf' ? (
              <PdfView />
            ) : (
              <NoteGrid />
            )}
          </div>

          {/* Canvas keeps the screenshot controls beside the workspace.
              Notes shows them here when its sidebar is collapsed. */}
          <div style={{
            position: 'absolute', bottom: '16px', left: '16px', zIndex: 120,
            display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center',
          }}>
            {(viewMode === 'inkcanvas' || (sidebarCollapsed && viewMode === 'notes')) && (<>
              <button onClick={() => window.electronAPI?.startScreenshot()} aria-label="截图" className="hover-ring-light" style={shotBtnStyle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
              <button onClick={() => window.electronAPI?.startLongScreenshot()} aria-label="长截图" className="hover-ring-light" style={shotBtnStyle}>
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
              aria-label={sidebarCollapsed ? '展开边栏' : '收起边栏'}
              className="workspace-corner-button sidebar-toggle">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: sidebarCollapsed ? 'scaleX(-1)' : 'none', transition: 'transform 0.2s' }}>
                <rect x="3" y="3" width="18" height="18" rx="3" opacity="0.5" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          </div>

          {/* Global settings entry — bottom-right on all three views. */}
          <button onClick={() => setShowSettings(true)} aria-label="设置" className="workspace-corner-button settings-toggle">
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
        }}>{Math.round((uiZoomToast.value - 0.1) * 100)}%</div>
      )}
      {showCreateDialog && <CreateNoteDialog onClose={() => setShowCreateDialog(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <AssetPreview onOpen={path => void openAssetDocument(path)} />
      {assetError && <FileDialog title="资料操作失败" onClose={() => setAssetError('')}>
        <p role="alert" className="file-library-error">{assetError}</p>
      </FileDialog>}
      <DiagnosticPanel visible={showDiagnostic} onClose={() => setShowDiagnostic(false)} />
      <ConfirmHost />
    </div>
  );
};

export default App;
