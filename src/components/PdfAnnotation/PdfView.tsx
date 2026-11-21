/**
 * PdfView — PDF annotation view (single-page book mode).
 *
 * Home routing:
 *   - library home → import, open, and replace source files
 *   - open file    → page editor and its dockable toolbar
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useNoteStore } from '../../store';
import { usePdfStore, MAX_ANCHOR_PAGES } from './PdfStore';
import { usePdfLibrary } from './PdfLibrary';
import { fs } from '../../utils';
import { usePdfToolbarStore } from '../InfiniteInkCanvas/useToolbarStore';
import { askConfirm } from '../ConfirmDialog';
import PdfCanvas from './PdfCanvas';
import PdfToolbar from './PdfToolbar';
import PdfSidebar from './PdfSidebar';
import ToolbarShell from '../InfiniteInkCanvas/ToolbarShell';
import LibraryHome from './LibraryHome';
import { useFileWorkspace } from '../FileLibrary/useFileWorkspace';
import { useAssetLibrary } from '../FileLibrary/assetLibrary';

// ---- Anchor badge (one per anchored page) -------------------------------------

const AnchorBadge: React.FC<{
  page: number;
  current: boolean;
  onJump: () => void;
  onRemove: () => void;
}> = ({ page, current, onJump, onRemove }) => {
  const gfs = useNoteStore((s) => s.settings.fontSize);
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onJump}
      title={current ? `当前就在标记的第 ${page} 页` : `回到标记的第 ${page} 页（渲染已缓存，秒回）`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 26, padding: '5px 8px', borderRadius: '6px',
        cursor: current ? 'default' : 'pointer',
        border: '1px solid var(--accent)',
        background: hover ? 'rgba(107,92,231,0.22)' : 'rgba(107,92,231,0.12)',
        color: 'var(--accent)', fontSize: fs(12, gfs), fontWeight: 600,
        userSelect: 'none', transition: 'background 0.12s',
      }}
    >
      <span>{page}</span>
      <span
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="删除标记"
        style={{
          position: 'absolute', top: -6, right: -6,
          width: 15, height: 15, borderRadius: '50%',
          background: '#444', color: '#eee',
          border: '1px solid var(--glass-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: fs(10, gfs), cursor: 'pointer', lineHeight: 1,
          opacity: hover ? 1 : 0, pointerEvents: hover ? 'auto' : 'none',
          transition: 'opacity 0.12s',
        }}
      >
        ×
      </span>
    </div>
  );
};

// ---- Navigation bar -----------------------------------------------------------

const NavBar: React.FC<{
  onSave: () => void;
  onImport: () => void;
  onPairPending: () => void;
  onClose: () => void;
  savedFlash: boolean;
  dirty: boolean;
}> = ({ onSave, onImport, onPairPending, onClose, savedFlash, dirty }) => {
  const gfs = useNoteStore((s) => s.settings.fontSize);
  const fileName = usePdfStore((s) => s.fileName);
  const unplacedCount = usePdfStore(s => s.unplacedPages?.length ?? 0);
  const currentPage = usePdfStore((s) => s.currentPage);
  const numPages = usePdfStore((s) => s.numPages);
  const nextPage = usePdfStore((s) => s.nextPage);
  const prevPage = usePdfStore((s) => s.prevPage);
  const setCurrentPage = usePdfStore((s) => s.setCurrentPage);
  const anchorPages = usePdfStore((s) => s.anchorPages);
  const addAnchorPage = usePdfStore((s) => s.addAnchorPage);
  const removeAnchorPage = usePdfStore((s) => s.removeAnchorPage);
  const setSidebarScrollTarget = usePdfStore((s) => s.setSidebarScrollTarget);
  const [pageInput, setPageInput] = useState(String(currentPage));

  useEffect(() => { setPageInput(String(currentPage)); }, [currentPage]);

  const commitPage = () => {
    const n = parseInt(pageInput, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= numPages) setCurrentPage(n);
    else setPageInput(String(currentPage));
  };

  const btnStyle: React.CSSProperties = {
    padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
    fontSize: fs(12, gfs), border: '1px solid var(--glass-border)',
    background: 'var(--glass-bg-light)', color: 'var(--text-secondary)',
    transition: 'all var(--transition)',
  };

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 44, zIndex: 95,
      display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px',
      background: 'var(--chrome-bg)', borderBottom: '1px solid var(--glass-border)',
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    }}>
      <button className="glass-btn" onClick={prevPage} disabled={currentPage <= 1} style={{ ...btnStyle, opacity: currentPage <= 1 ? 0.35 : 1 }}>
        ‹ 上一页
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: fs(12, gfs) }}>
        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
          onBlur={commitPage}
          onKeyDown={(e) => { if (e.key === 'Enter') commitPage(); }}
          style={{
            width: 48, padding: '4px 6px', textAlign: 'center', fontFamily: 'inherit', fontSize: fs(12, gfs),
            background: 'var(--glass-bg-light)', color: 'var(--text-primary)',
            border: '1px solid var(--glass-border)', borderRadius: '6px', outline: 'none',
          }}
        />
        <span>/ {numPages}</span>
      </div>
      <button className="glass-btn" onClick={nextPage} disabled={currentPage >= numPages} style={{ ...btnStyle, opacity: currentPage >= numPages ? 0.35 : 1 }}>
        下一页 ›
      </button>

      {anchorPages.map((p) => (
        <AnchorBadge
          key={p}
          page={p}
          current={p === currentPage}
          onJump={() => { if (p !== currentPage) { setCurrentPage(p); setSidebarScrollTarget(p); } }}
          onRemove={() => removeAnchorPage(p)}
        />
      ))}

      {(() => {
        const atCap = anchorPages.length >= MAX_ANCHOR_PAGES;
        const already = anchorPages.includes(currentPage);
        return (
          <button
            onClick={() => addAnchorPage(currentPage)}
            disabled={already || atCap}
            title={already ? '当前页已在标记中' : atCap ? `已达标记上限（${MAX_ANCHOR_PAGES} 个）` : '把当前页添加为标记（回跳目标，保留渲染缓存）'}
            style={{
              width: 28, padding: 0, lineHeight: '24px', textAlign: 'center',
              borderRadius: '6px', cursor: (already || atCap) ? 'default' : 'pointer',
              fontFamily: 'inherit', fontSize: fs(16, gfs), fontWeight: 600,
              border: '1px solid var(--glass-border)',
              background: 'var(--glass-bg-light)', color: 'var(--text-secondary)',
              opacity: (already || atCap) ? 0.35 : 1,
            }}
          >
            +
          </button>
        );
      })()}

      <span style={{
        marginLeft: 'auto', fontSize: fs(12, gfs), color: 'var(--text-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px',
      }}>
        {fileName}
      </span>

      {unplacedCount > 0 && <button className="glass-btn" style={btnStyle} onClick={onPairPending}>待配对 {unplacedCount} 页</button>}
      <button className="glass-btn" onClick={onImport} style={btnStyle} title="导入其它文件">
        导入
      </button>
      <button className="glass-btn" onClick={onSave} style={btnStyle} title="保存批注 (Ctrl+S)">
        保存
      </button>
      {savedFlash && (
        <span style={{ fontSize: fs(11, gfs), color: '#51cf66', fontWeight: 600 }}>已保存</span>
      )}
      <button className="glass-btn" onClick={onClose} style={{ ...btnStyle, color: dirty ? 'var(--danger, #e74c3c)' : 'var(--text-secondary)' }} title="返回文件库">
        关闭
      </button>
    </div>
  );
};

// ---- Main view ----------------------------------------------------------------

const PdfView: React.FC = () => {
  const fileName = usePdfStore((s) => s.fileName);
  const pdfDoc = usePdfStore(s => s.pdfDoc);
  const documentKey = useRef<{ doc: typeof pdfDoc; key: number }>({ doc: null, key: 0 });
  if (documentKey.current.doc !== pdfDoc) documentKey.current = { doc: pdfDoc, key: documentKey.current.key + 1 };
  const workspace = useFileWorkspace();
  const requestedPath = useAssetLibrary(s => s.requestedPath);
  useEffect(() => {
    if (!requestedPath || workspace.busy) return;
    const timer = window.setTimeout(() => {
      if (useAssetLibrary.getState().requestedPath !== requestedPath) return;
      useAssetLibrary.setState({ requestedPath: null });
      void workspace.openPath(requestedPath);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [requestedPath, workspace]);
  const dirty = usePdfStore((s) => s.dirty);

  // Ensure the library is loaded so resume/annotation state can persist.
  useEffect(() => { usePdfLibrary.getState().loadState(); }, []);

  // ---- Save / close handlers --------------------------------------------------
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const doSave = useCallback(async () => {
    const st = usePdfStore.getState();
    if (!st.currentItemId) return;
    const r = await st.saveAnnotations();
    if (r.ok) {
      setSavedFlash(true);
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1500);
    }
  }, []);

  const doClose = useCallback(() => {
    window.dispatchEvent(new Event('ink:flush-gesture'));
    const st = usePdfStore.getState();
    // Flush resume state synchronously before closing.
    if (st.currentItemId) {
      usePdfLibrary.getState().updateItemResume(st.currentItemId, {
        lastPage: st.currentPage,
        camera: st.camera,
        showDotGrid: st.showDotGrid,
        sidebarOpen: st.sidebarOpen,
        anchorPages: st.anchorPages,
      });
    }
    if (st.dirty) {
      askConfirm({
        title: '关闭文件',
        message: '有未保存的批注。',
        confirmLabel: '保存并关闭',
        secondaryLabel: '不保存关闭',
        danger: false,
        onSecondary: () => usePdfStore.getState().closePdf(),
        onConfirm: async () => {
          do {
            if (!(await usePdfStore.getState().saveAnnotations()).ok) return;
          } while (usePdfStore.getState().dirty);
          usePdfStore.getState().closePdf();
        },
      });
      return;
    }
    st.closePdf();
  }, []);

  // ---- Persist resume state to the open library item (debounced) --------------
  const currentItemId = usePdfStore((s) => s.currentItemId);
  const currentPage = usePdfStore((s) => s.currentPage);
  const camera = usePdfStore((s) => s.camera);
  const showDotGrid = usePdfStore((s) => s.showDotGrid);
  const sidebarOpen = usePdfStore((s) => s.sidebarOpen);
  const anchorPages = usePdfStore((s) => s.anchorPages);

  useEffect(() => {
    if (!currentItemId || !fileName) return;
    const t = setTimeout(() => {
      usePdfLibrary.getState().updateItemResume(currentItemId, {
        lastPage: currentPage,
        camera,
        showDotGrid,
        sidebarOpen,
        anchorPages,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [currentItemId, fileName, currentPage, camera, showDotGrid, sidebarOpen, anchorPages]);

  // Toolbar drag overlay (same behavior as the infinite canvas)
  const isDraggingToolbar = usePdfToolbarStore((s) => s.isDragging);
  const tOffset = usePdfToolbarStore((s) => s.offset);
  const tWidth = usePdfToolbarStore((s) => s.width);
  const tSide = usePdfToolbarStore((s) => s.side);
  const areaRef = useRef<HTMLDivElement>(null);

  // Keyboard: undo/redo/delete/page-flip
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('[data-file-dialog]')) return;
      const st = usePdfStore.getState();
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); st.undo(); }
      else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); st.redo(); }
      else if (e.ctrlKey && e.key === 'Z') { e.preventDefault(); st.redo(); }
      else if (e.ctrlKey && e.key === 's') { e.preventDefault(); doSave(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedIds.length > 0) { e.preventDefault(); st.deleteSelected(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); st.nextPage(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); st.prevPage(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [doSave]);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--page-bg)' }}>
      <div key={documentKey.current.key} className="animate-fade-in" style={{ position: 'absolute', inset: 0 }}>
      {!fileName ? (
        <LibraryHome onImport={workspace.pickAndOpen} onOpen={workspace.open} onReplace={workspace.replace} importing={workspace.busy} />
      ) : (
        <>
          <NavBar onSave={doSave} onClose={doClose} onImport={() => void workspace.pickAndOpen(null)}
            onPairPending={workspace.pairPending} savedFlash={savedFlash} dirty={dirty} />
          <div ref={areaRef} style={{ position: 'absolute', top: 44, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
            <PdfCanvas />
            <PdfSidebar />

            {isDraggingToolbar && (() => {
              const cw = areaRef.current?.clientWidth ?? window.innerWidth;
              const mid = cw * 0.5;
              const tl = tSide === 'left' ? tOffset : cw - tOffset - tWidth;
              const tr = tSide === 'left' ? tOffset + tWidth : cw - tOffset;
              const snapLeft = (tl + tr) / 2 < mid;
              return (
                <div style={{ position: 'absolute', inset: 0, zIndex: 99, pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '50%',
                    background: snapLeft ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.15)', transition: 'background 0.10s' }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: '50%',
                    background: !snapLeft ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.15)', transition: 'background 0.10s' }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1,
                    background: 'rgba(255,255,255,0.12)' }} />
                </div>
              );
            })()}

            <ToolbarShell useStore={usePdfToolbarStore}><PdfToolbar /></ToolbarShell>
          </div>
        </>
      )}
      </div>
      {workspace.overlays}
    </div>
  );
};

export default PdfView;
