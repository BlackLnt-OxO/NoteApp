/**
 * PdfSidebar — dockable page-thumbnail rail on the left.
 *
 * Performance model (800-page PDFs):
 *   - Virtualized: only the pages intersecting the scroll viewport (plus a
 *     small overscan) are mounted, so the DOM stays ~constant regardless of
 *     page count.
 *   - Lazy thumbnails: a page's thumbnail is rendered by pdf.js only when it
 *     enters view; an LRU cache (bounded) evicts the least-recently-used ones.
 *   - Wheel only scrolls the rail — the current page changes exclusively via
 *     clicking a thumbnail (or the page input / anchor button).
 *
 * Toggle visibility via the chevron button; the store owns `sidebarOpen`.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useNoteStore } from "../../store";
import { fs } from "../../utils";
import { usePdfStore } from './PdfStore';
import { renderThumbnail } from './PdfLoader';

const THUMB_W = 120;
const THUMB_GAP = 12;
const OVERSCAN = 800; // px above/below the viewport to render thumbnails
const LRU_MAX = 60;   // max cached thumbnail canvases

// ---- LRU cache (module-level, survives re-render) -----------------------------

const thumbCache = new Map<number, string>();

function cacheGet(page: number): string | undefined {
  const c = thumbCache.get(page);
  if (c) {
    // refresh recency
    thumbCache.delete(page);
    thumbCache.set(page, c);
  }
  return c;
}

function cacheSet(page: number, dataUrl: string): void {
  thumbCache.set(page, dataUrl);
  while (thumbCache.size > LRU_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
}

// ---- Single thumbnail ---------------------------------------------------------

const Thumb: React.FC<{ page: number; height: number; current: boolean; onSelect: (p: number) => void }> = React.memo(
  ({ page, height, current, onSelect }) => {
    const gfs = useNoteStore((s) => s.settings.fontSize);
    const [src, setSrc] = useState<string | null>(() => cacheGet(page) ?? null);
    const [err, setErr] = useState(false);
    const doc = usePdfStore((s) => s.pdfDoc);

    useEffect(() => {
      const cached = cacheGet(page);
      if (cached) { setSrc(cached); return; }
      if (!doc) return;
      let cancelled = false;
      renderThumbnail(doc, page, THUMB_W)
        .then((canvas) => {
          if (cancelled) return;
          const dataUrl = canvas.toDataURL('image/png');
          cacheSet(page, dataUrl);
          setSrc(dataUrl);
        })
        .catch(() => { if (!cancelled) setErr(true); });
      return () => { cancelled = true; };
    }, [doc, page]);

    return (
      <button
        onClick={() => onSelect(page)}
        style={{
          width: THUMB_W, height, flexShrink: 0, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0, border: current ? '2px solid var(--accent)' : '1px solid var(--glass-border)',
          borderRadius: '6px', background: '#fff', cursor: 'pointer', overflow: 'hidden',
          boxShadow: current ? '0 0 0 2px rgba(107,92,231,0.4)' : 'none',
        }}
      >
        {src ? (
          <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} draggable={false} />
        ) : (
          <span style={{ fontSize: fs(11, gfs), color: '#999' }}>{err ? '—' : `${page}`}</span>
        )}
        <span style={{
          position: 'absolute', bottom: 2, right: 4, fontSize: fs(10, gfs), fontWeight: 700,
          color: '#fff', background: 'rgba(0,0,0,0.55)', borderRadius: '4px', padding: '0 4px',
        }}>
          {page}
        </span>
      </button>
    );
  },
);

// ---- Sidebar ------------------------------------------------------------------

const PdfSidebar: React.FC = () => {
  const gfs = useNoteStore((s) => s.settings.fontSize);
  const pdfDoc = usePdfStore((s) => s.pdfDoc);
  const numPages = usePdfStore((s) => s.numPages);
  const currentPage = usePdfStore((s) => s.currentPage);
  const setCurrentPage = usePdfStore((s) => s.setCurrentPage);
  const sidebarOpen = usePdfStore((s) => s.sidebarOpen);
  const toggleSidebar = usePdfStore((s) => s.toggleSidebar);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Thumbnail aspect ratio is unknown until the first render; assume A4-ish
  // (1.414) so layout is stable. We use the first page's size if available.
  const firstSize = usePdfStore((s) => s.pageSizes[1]);
  const ratio = firstSize ? firstSize.height / firstSize.width : Math.SQRT2;
  const thumbH = Math.round(THUMB_W * ratio);

  // Total content height = N * (thumbH + gap)
  const itemH = thumbH + THUMB_GAP;
  const totalH = numPages * itemH;

  // Compute the visible page range
  const firstIndex = Math.max(0, Math.floor((scrollTop - OVERSCAN) / itemH));
  const lastIndex = Math.min(numPages - 1, Math.ceil((scrollTop + viewportH + OVERSCAN) / itemH));

  const pages: number[] = [];
  for (let i = firstIndex; i <= lastIndex; i++) pages.push(i + 1);

  // Wheel scroll only scrolls the rail — page changes come exclusively from
  // clicking a thumbnail (or the page input / anchor button). Persist the scroll
  // position so it survives collapse/expand (and reopening).
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    usePdfStore.getState().setRailScrollTop(e.currentTarget.scrollTop);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewportH(el.clientHeight);
  }, [sidebarOpen]);

  // Scroll the rail to the anchor page when the "back to current page" button
  // fires (one-shot store signal). Pure scroll — it never changes the page.
  const sidebarScrollTarget = usePdfStore((s) => s.sidebarScrollTarget);
  useEffect(() => {
    if (sidebarScrollTarget == null) return;
    const el = scrollRef.current;
    if (el) {
      const idx = Math.max(0, Math.min(numPages - 1, sidebarScrollTarget - 1));
      el.scrollTop = Math.max(0, idx * itemH - 10);
    }
    usePdfStore.getState().setSidebarScrollTarget(null);
  }, [sidebarScrollTarget, numPages, itemH]);

  // On document open (incl. resume), position the rail at the current page
  // instead of starting from page 1. One-shot per open — later page changes are
  // driven by clicks / the anchor button, not by this effect.
  useEffect(() => {
    if (!pdfDoc) return;
    const el = scrollRef.current;
    if (!el) return;
    const idx = Math.max(0, Math.min(numPages - 1, usePdfStore.getState().currentPage - 1));
    const target = Math.max(0, idx * itemH - 10);
    el.scrollTop = target;
    // Sync the rail's remembered scroll too, so the "reopen restores scroll"
    // effect below doesn't overwrite this with a stale value from a prior doc.
    usePdfStore.getState().setRailScrollTop(target);
  }, [pdfDoc, itemH, numPages]);

  // When the rail is re-opened (collapse → expand), restore the previous scroll
  // position instead of jumping to page 1 / showing a blank rail.
  useEffect(() => {
    if (!sidebarOpen) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, usePdfStore.getState().railScrollTop);
  }, [sidebarOpen, itemH]);

  if (!pdfDoc) return null;

  const RAIL_W = THUMB_W + 28;
  const railBtn: React.CSSProperties = {
    position: 'absolute', top: 12, left: 6, zIndex: 94,
    width: 32, height: 32, borderRadius: '50%',
    border: '1px solid var(--glass-border)', cursor: 'pointer',
    background: 'var(--chrome-bg)', color: 'var(--text-secondary)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: fs(12, gfs), fontWeight: 700,
    boxShadow: 'var(--glass-shadow)',
  };

  return (
    <>
      {!sidebarOpen && (
        <button onClick={toggleSidebar} title="展开页面预览"
          className="hover-ring-light" style={railBtn}>
          ▷
        </button>
      )}

      {/* Rail stays mounted (so scroll position survives) with a width transition,
          mirroring the left sidebar's collapse animation. */}
      <div style={{
        position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 93,
        width: sidebarOpen ? RAIL_W : 0,
        overflow: 'hidden',
        transition: 'width var(--transition-slow)',
        display: 'flex', flexDirection: 'column',
        background: 'var(--chrome-bg)', borderRight: sidebarOpen ? '1px solid var(--glass-border)' : 'none',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 6px 8px 10px', fontSize: fs(11, gfs), color: 'var(--text-secondary)',
          borderBottom: '1px solid var(--glass-border)', flexShrink: 0,
          opacity: sidebarOpen ? 1 : 0, pointerEvents: sidebarOpen ? 'auto' : 'none',
          transition: 'opacity var(--transition-slow)',
        }}>
          <span>页面</span>
          <button onClick={toggleSidebar} title="收起" className="hover-ring-light"
            style={{ width: 26, height: 26, borderRadius: '50%', border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: fs(12, gfs), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            ◁
          </button>
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            flex: 1, overflowY: 'auto', overflowX: 'hidden',
            padding: '10px 10px', display: 'flex', flexDirection: 'column', gap: THUMB_GAP,
            opacity: sidebarOpen ? 1 : 0, pointerEvents: sidebarOpen ? 'auto' : 'none',
            transition: 'opacity var(--transition-slow)',
          }}
        >
          {/* Spacer above the virtualized range */}
          <div style={{ height: firstIndex * itemH, flexShrink: 0 }} />
          {pages.map((p) => (
            <Thumb key={p} page={p} height={thumbH} current={p === currentPage} onSelect={setCurrentPage} />
          ))}
          {/* Spacer below */}
          <div style={{ height: Math.max(0, (numPages - 1 - lastIndex) * itemH), flexShrink: 0 }} />
        </div>
      </div>
    </>
  );
};

export default PdfSidebar;
