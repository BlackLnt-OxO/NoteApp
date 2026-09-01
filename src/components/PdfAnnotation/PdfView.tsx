/**
 * PdfView — PDF annotation view (single-page book mode).
 *
 * - Import screen when no PDF is open.
 * - Top navigation bar: previous / page input / next / filename / import other.
 * - Canvas fills the rest, with the shared dockable ToolbarShell + PdfToolbar.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { usePdfStore } from './PdfStore';
import { useToolbarStore } from '../InfiniteInkCanvas/useToolbarStore';
import PdfCanvas from './PdfCanvas';
import PdfToolbar from './PdfToolbar';
import ToolbarShell from '../InfiniteInkCanvas/ToolbarShell';

// ---- Import screen ------------------------------------------------------------

const ImportScreen: React.FC<{ onPick: (file: File) => void }> = ({ onPick }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16, background: '#1a1a2e', color: 'var(--text-secondary)',
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
        单页书本式浏览 · 每页独立笔迹<br />支持大型文档（按页惰性加载，不预渲染）
      </div>
      <button
        onClick={() => inputRef.current?.click()}
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
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
    </div>
  );
};

// ---- Navigation bar -----------------------------------------------------------

const NavBar: React.FC = () => {
  const fileName = usePdfStore((s) => s.fileName);
  const currentPage = usePdfStore((s) => s.currentPage);
  const numPages = usePdfStore((s) => s.numPages);
  const nextPage = usePdfStore((s) => s.nextPage);
  const prevPage = usePdfStore((s) => s.prevPage);
  const setCurrentPage = usePdfStore((s) => s.setCurrentPage);
  const loadPdf = usePdfStore((s) => s.loadPdf);
  const closePdf = usePdfStore((s) => s.closePdf);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
      background: 'rgba(30,30,48,0.92)', borderBottom: '1px solid var(--glass-border)',
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

      <span style={{
        marginLeft: 'auto', fontSize: '12px', color: 'var(--text-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px',
      }}>
        {fileName}
      </span>

      <button onClick={() => fileInputRef.current?.click()} style={btnStyle} title="导入其它 PDF">
        导入
      </button>
      <button onClick={() => { if (confirm('关闭当前 PDF？本页批注尚未持久化，关闭后丢失。')) closePdf(); }} style={{ ...btnStyle, color: 'var(--danger, #e74c3c)' }} title="关闭当前 PDF">
        关闭
      </button>
      <input
        ref={fileInputRef} type="file" accept="application/pdf" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) loadPdf(f); e.target.value = ''; }}
      />
    </div>
  );
};

// ---- Main view ----------------------------------------------------------------

const PdfView: React.FC = () => {
  const fileName = usePdfStore((s) => s.fileName);
  const loadPdf = usePdfStore((s) => s.loadPdf);

  // Toolbar drag overlay (same behavior as the infinite canvas)
  const isDraggingToolbar = useToolbarStore((s) => s.isDragging);
  const tOffset = useToolbarStore((s) => s.offset);
  const tWidth = useToolbarStore((s) => s.width);
  const tSide = useToolbarStore((s) => s.side);
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
      else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedIds.length > 0) { e.preventDefault(); st.deleteSelected(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); st.nextPage(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); st.prevPage(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#1a1a2e' }}>
      {!fileName ? (
        <ImportScreen onPick={loadPdf} />
      ) : (
        <>
          <NavBar />
          <div ref={areaRef} style={{ position: 'absolute', top: 44, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
            <PdfCanvas />

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

            <ToolbarShell><PdfToolbar /></ToolbarShell>
          </div>
        </>
      )}
    </div>
  );
};

export default PdfView;
