/**
 * PdfView — PDF annotation view (single-page book mode).
 *
 * Home routing:
 *   - no PDF open + empty library  → ImportScreen (first-time)
 *   - no PDF open + library items  → LibraryHome (recent PDFs, categories)
 *   - PDF open                     → NavBar + canvas + dockable toolbar
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { usePdfStore, MAX_ANCHOR_PAGES } from './PdfStore';
import { usePdfLibrary } from './PdfLibrary';
import { usePdfToolbarStore } from '../InfiniteInkCanvas/useToolbarStore';
import { askConfirm } from '../ConfirmDialog';
import PdfCanvas from './PdfCanvas';
import PdfToolbar from './PdfToolbar';
import PdfSidebar from './PdfSidebar';
import ToolbarShell from '../InfiniteInkCanvas/ToolbarShell';
import LibraryHome from './LibraryHome';
import { pickPdfFile } from './PdfPicker';

// ---- Shared import (native dialog → load → record in library) ----------------

async function importPdf(categoryId: string | null): Promise<void> {
  const picked = await pickPdfFile();
  if (!picked) return;
  await usePdfStore.getState().loadPdfFromBuffer(picked.buffer, picked.name);
  const numPages = usePdfStore.getState().numPages;
  const id = usePdfLibrary.getState().addItem({
    name: picked.name,
    path: picked.path,
    categoryId,
    pageCount: numPages,
    sizeBytes: picked.buffer.byteLength,
  });
  // Link the open doc to its library item so resume state persists.
  usePdfStore.setState({ currentItemId: id });
}

// ---- Import screen (first-time) -----------------------------------------------

const ImportScreen: React.FC = () => {
  const loading = usePdfStore((s) => s.loading);
  const error = usePdfStore((s) => s.error);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16, background: 'var(--page-bg)', color: 'var(--text-secondary)',
    }}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" x2="16" y1="13" y2="13" /><line x1="8" x2="16" y1="17" y2="17" /><line x1="8" x2="12" y1="9" y2="9" />
      </svg>
      <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
        导入 PDF 进行批注
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', lineHeight: '1.7' }}>
        单页书本式浏览 · 每页独立笔迹 · 支持大型文档<br />导入后出现在左侧 PDF 库中
      </div>
      {loading ? (
        <div style={{ marginTop: 8, padding: '10px 22px', fontSize: '13px', color: 'var(--text-secondary)' }}>
          正在加载 PDF…
        </div>
      ) : (
        <button
          onClick={() => importPdf(null)}
          style={{
            marginTop: 8, padding: '10px 22px',
            background: 'var(--accent)', border: 'none', borderRadius: '8px',
            color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            transition: 'all var(--transition)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
        >
          选择 PDF 文件
        </button>
      )}
      {error && (
        <div style={{
          marginTop: 12, maxWidth: 480, padding: '10px 14px',
          fontSize: '11px', lineHeight: '1.6',
          color: '#ff8a8a', background: 'rgba(231,76,60,0.12)',
          border: '1px solid rgba(231,76,60,0.3)', borderRadius: '8px',
          fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          PDF 加载失败：{error}
        </div>
      )}
    </div>
  );
};

// ---- Anchor badge (one per anchored page) -------------------------------------

const AnchorBadge: React.FC<{
  page: number;
  current: boolean;
  onJump: () => void;
  onRemove: () => void;
}> = ({ page, current, onJump, onRemove }) => {
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
        color: 'var(--accent)', fontSize: '12px', fontWeight: 600,
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
          fontSize: '10px', cursor: 'pointer', lineHeight: 1,
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
  onClose: () => void;
  savedFlash: boolean;
  dirty: boolean;
}> = ({ onSave, onClose, savedFlash, dirty }) => {
  const fileName = usePdfStore((s) => s.fileName);
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
    fontSize: '12px', border: '1px solid var(--glass-border)',
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
      <button onClick={prevPage} disabled={currentPage <= 1} style={{ ...btnStyle, opacity: currentPage <= 1 ? 0.35 : 1 }}>
        ‹ 上一页
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: '12px' }}>
        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
          onBlur={commitPage}
          onKeyDown={(e) => { if (e.key === 'Enter') commitPage(); }}
          style={{
            width: 48, padding: '4px 6px', textAlign: 'center', fontFamily: 'inherit', fontSize: '12px',
            background: 'var(--glass-bg-light)', color: 'var(--text-primary)',
            border: '1px solid var(--glass-border)', borderRadius: '6px', outline: 'none',
          }}
        />
        <span>/ {numPages}</span>
      </div>
      <button onClick={nextPage} disabled={currentPage >= numPages} style={{ ...btnStyle, opacity: currentPage >= numPages ? 0.35 : 1 }}>
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
              fontFamily: 'inherit', fontSize: '16px', fontWeight: 600,
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
        marginLeft: 'auto', fontSize: '12px', color: 'var(--text-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px',
      }}>
        {fileName}
      </span>

      <button onClick={() => importPdf(null)} style={btnStyle} title="导入其它 PDF">
        导入
      </button>
      <button onClick={onSave} style={btnStyle} title="保存批注 (Ctrl+S)">
        保存
      </button>
      {savedFlash && (
        <span style={{ fontSize: '11px', color: '#51cf66', fontWeight: 600 }}>已保存</span>
      )}
      <button onClick={onClose} style={{ ...btnStyle, color: dirty ? 'var(--danger, #e74c3c)' : 'var(--text-secondary)' }} title="返回 PDF 库">
        关闭
      </button>
    </div>
  );
};

// ---- Main view ----------------------------------------------------------------

const PdfView: React.FC = () => {
  const fileName = usePdfStore((s) => s.fileName);
  const libraryItems = usePdfLibrary((s) => s.items);
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
    const st = usePdfStore.getState();
    // Flush resume state synchronously before closing.
    if (st.currentItemId) {
      usePdfLibrary.getState().updateItemResume(st.currentItemId, {
        lastPage: st.currentPage,
        camera: st.camera,
        showDotGrid: st.showDotGrid,
        sidebarOpen: st.sidebarOpen,
      });
    }
    if (st.dirty) {
      askConfirm({
        title: '关闭 PDF',
        message: '有未保存的批注，确定关闭？',
        confirmLabel: '关闭',
        danger: false,
        onConfirm: () => usePdfStore.getState().closePdf(),
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

  useEffect(() => {
    if (!currentItemId || !fileName) return;
    const t = setTimeout(() => {
      usePdfLibrary.getState().updateItemResume(currentItemId, {
        lastPage: currentPage,
        camera,
        showDotGrid,
        sidebarOpen,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [currentItemId, fileName, currentPage, camera, showDotGrid, sidebarOpen]);

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
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
      {!fileName ? (
        libraryItems.length === 0 ? <ImportScreen /> : <LibraryHome />
      ) : (
        <>
          <NavBar onSave={doSave} onClose={doClose} savedFlash={savedFlash} dirty={dirty} />
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
  );
};

export default PdfView;
