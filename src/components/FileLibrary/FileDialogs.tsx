import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PdfJsDocument } from '../PdfAnnotation/PdfLoader';
import type { PdfItem } from '../PdfAnnotation/PdfTypes';
import { drawAnnotatedStroke } from '../PdfAnnotation/PdfBrushRenderers';
import { resolveAsset, useAssetLibrary } from './assetLibrary';
import { useAssetImage } from './AssetObject';
import { fileName } from './fileTypes';
import { HomeButtonResponse } from '../buttonPointerResponse';
import SettingsBackdrop from '../SettingsBackdrop';
import { ActionIcon } from '../IconAction';
import { useNoteStore } from '../../store';
import { backgroundShade } from '../../workspaceBackground';
import { awaitPdfOperation } from './inspectPdf';
import './fileLibrary.css';

export function FileDialog({ title, onClose, children, closeLabel = '关闭', saving = false }: {
  title: string; onClose: () => void; children: ReactNode; closeLabel?: string; saving?: boolean;
}) {
  const pointerScope = useContext(HomeButtonResponse);
  const wallpaper = useNoteStore(state => state.settings.backgroundImage);
  const opacity = useNoteStore(state => state.settings.backgroundOpacity);
  const closeRef = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, [title]);
  return createPortal(<div className="file-dialog-backdrop" data-file-dialog data-pointer-scope={pointerScope || undefined}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); if (!saving) onClose(); }
      if (event.key === 'Tab') {
        const focusable = section.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)');
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
    <section ref={section} role="dialog" aria-modal="true" aria-label={title} className="file-dialog frosted-dialog-shell"
      style={{ '--workspace-current-shade': backgroundShade(opacity) } as React.CSSProperties}>
      <SettingsBackdrop wallpaper={wallpaper} />
      <div className="file-dialog-scroll">
      <header className="file-dialog-header"><strong>{title}</strong>
        {closeLabel === '关闭'
          ? <button ref={closeRef} type="button" className="icon-action" aria-label={closeLabel} data-tooltip={closeLabel}
            disabled={saving} onClick={onClose}><ActionIcon /></button>
          : <button ref={closeRef} className="glass-btn" disabled={saving} onClick={onClose}>{closeLabel}</button>}
      </header>
      {children}
      </div>
    </section>
  </div>, document.body);
}

const NO_ITEMS: PdfItem[] = [];

function PreviewAsset({ object, style }: { object: Extract<PdfItem, { type: 'asset' }>; style: React.CSSProperties }) {
  const asset = useAssetLibrary(state => resolveAsset(state, object.assetId));
  const image = useAssetImage(object.assetId, true);
  return image ? <img className="file-preview-object" alt={asset ? fileName(asset.path) : ''} src={image} style={{ ...style, objectFit: 'fill' }} />
    : <div className="file-preview-object" style={{ ...style, background: 'var(--chrome-bg)', border: '1px solid currentColor' }}>
      {fileName(object.sourcePath ?? asset?.path ?? '') || '文件离线'}
    </div>;
}

export function PreviewPage({ doc, page, items = NO_ITEMS, maxWidth }: {
  doc: PdfJsDocument; page: number; items?: PdfItem[]; maxWidth: number;
}) {
  const paper = useRef<HTMLCanvasElement>(null);
  const ink = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState({ width: 1, height: 1, scale: 1, page: 0 });
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    const abort = new AbortController();
    let render: import('pdfjs-dist').RenderTask | undefined;
    const work = document.createElement('canvas');
    setError('');
    const preview = (async () => {
      const pdfPage = await doc.getPage(page);
      if (stopped) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(Math.max(120, maxWidth) / base.width, 0.64 * window.innerHeight / base.height, 1.7);
      const viewport = pdfPage.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const renderViewport = pdfPage.getViewport({ scale: scale * dpr });
      work.width = Math.max(1, Math.ceil(renderViewport.width));
      work.height = Math.max(1, Math.ceil(renderViewport.height));
      const context = work.getContext('2d');
      if (!context) throw new Error('无法显示页面。');
      render = pdfPage.render({ canvasContext: context, viewport: renderViewport, background: '#fff' });
      await render.promise;
      if (stopped || !paper.current) return;
      paper.current.width = work.width;
      paper.current.height = work.height;
      paper.current.getContext('2d')?.drawImage(work, 0, 0);
      setLayout({ width: viewport.width, height: viewport.height, scale, page });
    })();
    void awaitPdfOperation(preview, abort.signal, `预览第 ${page} 页超时。可切换页面或手动填写页码。`)
      .catch(error => {
        if (stopped) return;
        stopped = true;
        render?.cancel();
        setError(String(error?.message ?? error));
      }).finally(() => { work.width = work.height = 1; });
    return () => { stopped = true; abort.abort(); render?.cancel(); };
  }, [doc, page, maxWidth]);

  useEffect(() => {
    if (!ink.current || layout.page !== page) return;
    const dpr = window.devicePixelRatio || 1;
    ink.current.width = Math.max(1, Math.ceil(layout.width * dpr));
    ink.current.height = Math.max(1, Math.ceil(layout.height * dpr));
    const ctx = ink.current.getContext('2d');
    if (!ctx) return;
    ctx.scale(layout.scale * dpr, layout.scale * dpr);
    for (const item of items) if (item.type === 'stroke') drawAnnotatedStroke(ctx, item);
  }, [items, layout, page]);

  const ready = layout.page === page && !error;
  return <div>
    {!ready && <div role={error ? 'alert' : 'status'}>{error || '正在显示页面…'}</div>}
    <div className="file-preview-paper" style={{ width: layout.width, height: layout.height, visibility: ready ? 'visible' : 'hidden' }}>
      <canvas ref={paper} className="file-preview-page" style={{ width: layout.width, height: layout.height }} />
      <canvas ref={ink} style={{ width: layout.width, height: layout.height }} />
      {ready && items.map(item => {
        if (item.type === 'stroke') return null;
        const style = { left: item.x * layout.scale, top: item.y * layout.scale, width: item.width * layout.scale, height: item.height * layout.scale };
        if (item.type === 'asset') return <PreviewAsset key={item.id} object={item} style={style} />;
        if (item.type === 'image') return <img key={item.id} alt="" src={item.dataUrl} className="file-preview-object" style={style} />;
        if (item.type === 'comment') return <div key={item.id} className="file-preview-object" style={{
          ...style, pointerEvents: 'none', border: '1px solid var(--accent)', borderRadius: 3,
          color: 'var(--text-primary)', fontSize: 14 * layout.scale,
        }}><div style={{ background: 'color-mix(in srgb, var(--page-bg) 70%, var(--accent))', paddingInline: '.55em',
          lineHeight: 2, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.title}</div></div>;
        return <div key={item.id} className="file-preview-object" style={{ ...style, whiteSpace: 'pre-wrap',
          color: item.color, background: item.backgroundColor, fontSize: item.fontSize * layout.scale }}>{item.content}</div>;
      })}
    </div>
  </div>;
}

export function PageNavigation({ page, count, onPage }: { page: number; count: number; onPage: (page: number) => void }) {
  return <div className="file-preview-nav">
    <button className="glass-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
    <label>第 <input aria-label="预览页码" type="number" min={1} max={count} value={page}
      style={{ width: 55 }} onChange={event => {
        const value = event.target.valueAsNumber;
        if (Number.isInteger(value) && value >= 1 && value <= count) onPage(value);
      }} /> / {count} 页</label>
    <button className="glass-btn" disabled={page >= count} onClick={() => onPage(page + 1)}>下一页</button>
  </div>;
}

function SequenceThumbnail({ path }: { path: string }) {
  const thumb = useRef<HTMLImageElement>(null);
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let source: string | undefined;
    const load = () => {
      void window.electronAPI?.readLibraryImage?.(path).then(result => {
        if (!active) return;
        source = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
        setUrl(source);
      }).catch(() => {});
    };
    const observer = typeof IntersectionObserver !== 'undefined' && thumb.current
      ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); } })
      : null;
    if (observer && thumb.current) observer.observe(thumb.current); else load();
    return () => { active = false; observer?.disconnect(); if (source) URL.revokeObjectURL(source); };
  }, [path]);
  return <img ref={thumb} src={url || undefined} alt="" />;
}

export function ImageSequenceDialog({ initial, onFinish }: { initial: string[]; onFinish: (paths: string[]) => void }) {
  const [paths, setPaths] = useState(initial);
  const dragging = useRef<number | null>(null);
  const move = (from: number, to: number) => setPaths(current => {
    const next = [...current];
    const [path] = next.splice(from, 1);
    next.splice(to, 0, path);
    return next;
  });
  return <FileDialog title="图片序列" onClose={() => onFinish([])}>
    <ol className="file-sequence-list">{paths.map((path, index) =>
      <li key={path} draggable onDragStart={event => {
        dragging.current = index;
        event.dataTransfer.setData('text/plain', fileName(path));
        event.dataTransfer.effectAllowed = 'move';
      }} onDragEnd={() => { dragging.current = null; }} onDragOver={event => event.preventDefault()} onDrop={event => {
        event.preventDefault();
        if (dragging.current !== null) move(dragging.current, index);
        dragging.current = null;
      }}>
        {index + 1}. <SequenceThumbnail path={path} /><span data-tooltip={path}>{fileName(path)}</span>
        <button className="glass-btn" aria-label="上移" disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button>
        <button className="glass-btn" aria-label="下移" disabled={index === paths.length - 1} onClick={() => move(index, index + 1)}>↓</button>
      </li>)}</ol>
    <div className="file-dialog-actions"><button className="btn-accent" onClick={() => onFinish(paths)}>确认页序</button></div>
  </FileDialog>;
}
