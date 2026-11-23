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
import { askConfirm } from '../ConfirmDialog';
import PdfCanvas from './PdfCanvas';
import { INK_EDITOR_NAV_HEIGHT } from '../InkViewport';
import PdfToolbar from './PdfToolbar';
import PdfSidebar from './PdfSidebar';
import LibraryHome from './LibraryHome';
import { useFileWorkspace } from '../FileLibrary/useFileWorkspace';
import { FileDialog } from '../FileLibrary/FileDialogs';
import { useAssetLibrary } from '../FileLibrary/assetLibrary';
import IconAction from '../IconAction';
import './pdfNav.css';

// ---- Anchor badge (one per anchored page) -------------------------------------

const AnchorBadge: React.FC<{
  page: number;
  current: boolean;
  onJump: () => void;
  onRemove: () => void;
}> = ({ page, current, onJump, onRemove }) => {
  return <div className="pdf-nav-marker">
    <button type="button" className="pdf-nav-button pdf-nav-mark" aria-current={current ? 'page' : undefined}
      onClick={onJump} data-tooltip={`回到标记的第 ${page} 页`}>{page}</button>
    <IconAction className="pdf-nav-marker-remove" label={`删除第 ${page} 页标记`} danger onClick={onRemove} />
  </div>;
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

  return (
    <div className="pdf-nav-bar" style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: INK_EDITOR_NAV_HEIGHT, zIndex: 95,
      display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px', fontSize: fs(12, gfs),
    }}>
      <button className="pdf-nav-button" onClick={prevPage} disabled={currentPage <= 1}>
        ‹ 上一页
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: fs(12, gfs) }}>
        <input aria-label="页码" className="pdf-nav-input"
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
          onBlur={commitPage}
          onKeyDown={(e) => { if (e.key === 'Enter') commitPage(); }}
        />
        <span>/ {numPages}</span>
      </div>
      <button className="pdf-nav-button" onClick={nextPage} disabled={currentPage >= numPages}>
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
            className="pdf-nav-button pdf-nav-add" aria-label="添加当前页标记" onClick={() => addAnchorPage(currentPage)}
            disabled={already || atCap}
            data-tooltip={already ? '当前页已在标记中' : atCap ? `已达标记上限（${MAX_ANCHOR_PAGES} 个）` : '把当前页添加为标记（回跳目标，保留渲染缓存）'}
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

      {unplacedCount > 0 && <button className="pdf-nav-button" onClick={onPairPending}>待配对 {unplacedCount} 页</button>}
      <button className="pdf-nav-button" onClick={onImport} data-tooltip="导入其它文件">
        导入
      </button>
      <button className="pdf-nav-button" onClick={onSave} data-tooltip="保存批注 (Ctrl+S)">
        保存
      </button>
      {savedFlash && (
        <span style={{ fontSize: fs(11, gfs), color: '#51cf66', fontWeight: 600 }}>已保存</span>
      )}
      <button className="pdf-nav-button" onClick={onClose} data-dirty={dirty || undefined} data-tooltip="返回文件库">
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
  const pageError = usePdfStore(state => state.error);
  const pageLoading = usePdfStore(state => state.loading ? state.loadingPhase : null);
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
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: fileName ? 'var(--page-bg)' : undefined }}>
      <div key={documentKey.current.key} className={fileName ? 'animate-fade-in' : undefined} style={{ position: 'absolute', inset: 0 }}>
      {!fileName ? (
        <LibraryHome onImport={workspace.pickAndOpen} onOpen={workspace.open} onReplace={workspace.replace} importing={workspace.busy} />
      ) : (
        <>
          <NavBar onSave={doSave} onClose={doClose} onImport={() => void workspace.pickAndOpen(null)}
            onPairPending={workspace.pairPending} savedFlash={savedFlash} dirty={dirty} />
          <div style={{ position: 'absolute', top: INK_EDITOR_NAV_HEIGHT, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
            <PdfCanvas />
            <PdfSidebar />
            <PdfToolbar />
          </div>
        </>
      )}
      </div>
      {workspace.overlays}
      {fileName && (pageLoading || workspace.indexProgress)
        && <span role="status" className="pdf-index-progress">{pageLoading || workspace.indexProgress}</span>}
      {fileName && pageError && <FileDialog title="PDF 页面显示失败" onClose={() => usePdfStore.setState({ error: null })}>
        <p role="alert" className="file-library-error">{pageError}</p>
      </FileDialog>}
    </div>
  );
};

export default PdfView;
