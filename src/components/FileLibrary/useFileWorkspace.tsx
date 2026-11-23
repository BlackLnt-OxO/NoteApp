import { useEffect, useRef, useState } from 'react';
import { usePdfLibrary, type PdfLibraryItem } from '../PdfAnnotation/PdfLibrary';
import { usePdfStore } from '../PdfAnnotation/PdfStore';
import { pickPdfFile } from '../PdfAnnotation/PdfPicker';
import { annotatedPages, commitAnnotationBinding, createBinding, loadAnnotationFile, matchPages, saveAnnotationFile, type AnnotationFile } from './annotationFiles';
import { fileName, isImageFile, localPathKey, type PreparedFile } from './fileTypes';
import { awaitPdfOperation, fingerprintPages, inspectPdf, PDF_PAGE_READY, type OpenedPdf } from './inspectPdf';
import { isInkPointerActive } from '../inkInputActivity';
import { FileDialog, ImageSequenceDialog } from './FileDialogs';
import FileMigrationDialog, { type MigrationReview } from './FileMigrationDialog';

interface Sequence { paths: string[]; finish: (paths: string[]) => void }

function pathsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((path, index) => localPathKey(path) === localPathKey(right[index]));
}

async function pickBrowserPdf(): Promise<PreparedFile | null> {
  const picked = await pickPdfFile();
  if (!picked) return null;
  const hash = await crypto.subtle.digest('SHA-256', picked.buffer);
  const digest = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  return { paths: [picked.path], kind: 'pdf', name: picked.name, sizeBytes: picked.buffer.byteLength, digest, data: picked.buffer };
}

async function flushCurrentPdf() {
  window.dispatchEvent(new Event('ink:flush-gesture'));
  while (usePdfStore.getState().dirty) {
    if (!(await usePdfStore.getState().saveAnnotations()).ok) throw new Error('当前文件的批注保存失败。');
  }
  const state = usePdfStore.getState();
  if (state.currentItemId) {
    usePdfLibrary.getState().updateItemResume(state.currentItemId, {
      lastPage: state.currentPage, camera: state.camera, showDotGrid: state.showDotGrid,
      sidebarOpen: state.sidebarOpen, anchorPages: state.anchorPages,
    });
  }
}

export function useFileWorkspace() {
  const [busy, setBusy] = useState('');
  const [matching, setMatching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [indexProgress, setIndexProgress] = useState('');
  const [error, setError] = useState('');
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [review, setReview] = useState<MigrationReview | null>(null);
  const [offline, setOffline] = useState<PdfLibraryItem | null>(null);
  const task = useRef<AbortController>();
  const sequenceRef = useRef<Sequence>();
  const reviewRef = useRef<OpenedPdf>();
  const manualMatch = useRef<AbortController>();
  const writing = useRef(false);
  const pdfDoc = usePdfStore(state => state.pdfDoc);
  const binding = usePdfStore(state => state.binding);
  const itemId = usePdfStore(state => state.currentItemId);

  useEffect(() => {
    setIndexProgress('');
    if (!pdfDoc || !binding || !itemId || hasCompleteIndex(binding.fingerprints, pdfDoc.numPages)) return;
    const abort = new AbortController();
    const { signal } = abort;
    let started = false;
    const ready = (event: Event) => {
      if (started || (event as CustomEvent).detail !== pdfDoc) return;
      started = true;
      void (async () => {
        try {
          const fingerprints = await fingerprintPages(pdfDoc, {
            signal,
            progress: (page, count) => setIndexProgress(`后台生成页指纹 ${page}/${count}`),
            beforePage: async () => {
              do {
                await new Promise(resolve => setTimeout(resolve, 65));
                signal.throwIfAborted();
              } while (task.current || usePdfStore.getState().loading || isInkPointerActive());
            },
            retainPage: page => usePdfStore.getState().currentPage === page,
          });
          signal.throwIfAborted();
          await commitAnnotationBinding(async () => {
            if (signal.aborted) return;
            const saved = await loadAnnotationFile(itemId);
            if (signal.aborted || saved.binding?.digest !== binding.digest) return;
            await saveAnnotationFile(itemId, { ...saved, binding: { ...saved.binding, fingerprints } });
            const current = usePdfStore.getState();
            if (!signal.aborted && current.pdfDoc === pdfDoc && current.currentItemId === itemId
              && current.binding?.digest === binding.digest) {
              usePdfStore.setState({ binding: { ...current.binding, fingerprints } });
            }
          });
          if (!signal.aborted) setIndexProgress('');
        } catch {
          if (!signal.aborted) setIndexProgress('页指纹未完成，可在替换时手动配对');
        }
      })();
    };
    window.addEventListener(PDF_PAGE_READY, ready);
    return () => { abort.abort(); window.removeEventListener(PDF_PAGE_READY, ready); };
  }, [pdfDoc, binding, itemId]);

  useEffect(() => () => {
    if (!writing.current) task.current?.abort();
    sequenceRef.current?.finish([]);
    reviewRef.current?.dispose();
  }, []);

  const selectFiles = async (): Promise<string[]> => {
    const paths = await window.electronAPI!.pickLibraryFiles();
    if (paths.length < 2) return paths;
    if (!paths.every(isImageFile)) throw new Error('请选择一份文档，或多选图片组成图片序列。');
    const sorted = [...paths].sort((a, b) => fileName(a).localeCompare(fileName(b), 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return new Promise(resolve => {
      const finish = (paths: string[]) => { sequenceRef.current = undefined; setSequence(null); resolve(paths); };
      sequenceRef.current = { paths: sorted, finish };
      setSequence(sequenceRef.current);
    });
  };

  const run = async (job: (signal: AbortSignal) => Promise<void>) => {
    if (task.current || reviewRef.current) return;
    const abort = new AbortController();
    task.current = abort;
    setError('');
    setBusy('正在打开文件…');
    try { await job(abort.signal); }
    catch (err) {
      if (!abort.signal.aborted) setError((err instanceof Error ? err.message : String(err)) || '无法打开文件。');
    } finally {
      task.current = undefined;
      manualMatch.current = undefined;
      setMatching(false);
      setBusy('');
    }
  };

  const reviewFile = async (
    paths: string[], signal: AbortSignal, item?: PdfLibraryItem,
    options: { force?: boolean; relink?: boolean; pending?: boolean; category?: string | null; picked?: PreparedFile } = {},
  ) => {
    if (item?.id && item.id === usePdfStore.getState().currentItemId) await flushCurrentPdf();
    const current = usePdfStore.getState();
    const previous = item ? (item.id === current.currentItemId
      ? { items: current.items, unplaced: current.unplacedPages, binding: current.binding }
      : await loadAnnotationFile(item.id)) : { items: {} };
    const originalPaths = previous.binding?.paths ?? item?.paths ?? (item ? [item.path] : []);
    const selectedPaths = paths.length ? paths : originalPaths;
    signal.throwIfAborted();
    let file = options.picked;
    if (!file) {
      const preparing = window.electronAPI?.prepareLibraryDocument?.(selectedPaths);
      const result = preparing ? await awaitPdfOperation(preparing, signal, '读取文件超时，请重试。') : undefined;
      signal.throwIfAborted();
      if (!result) { if (item) { setOffline(item); return; } throw new Error('请在桌面应用中导入文件。'); }
      if (!result.ok) {
        if (result.offline && item && !paths.length) { setOffline(item); return; }
        throw new Error(result.error);
      }
      file = result.file;
    }
    const previousPrints = previous.binding?.fingerprints;
    const sameSource = previous.binding?.digest === file.digest;
    const changed = !!previous.binding && !sameSource;
    const migrate = item && (changed || options.force || options.pending || (options.relink && !previous.binding));
    const rows = migrate ? annotatedPages(previous) : [];
    const autoMatch = changed && rows.length > 0 && hasCompleteIndex(previousPrints);
    // The worker takes ownership of its buffer. Keep a copy only while an automatic
    // replacement scan might need to restart with a clean worker for manual review.
    let opened = await inspectPdf(autoMatch ? file.data.slice(0) : file.data, signal);
    let owned = true;
    try {
      let prints = sameSource && hasCompleteIndex(previousPrints, opened.doc.numPages) ? previousPrints : undefined;
      if (item?.id === current.currentItemId && !changed && !options.force && !options.relink && !options.pending) return;
      if (autoMatch) {
        const manual = new AbortController();
        manualMatch.current = manual;
        setMatching(true);
        try {
          prints = await fingerprintPages(opened.doc, {
            signal: AbortSignal.any([signal, manual.signal]),
            progress: (page, count) => setBusy(`正在匹配批注，第 ${page}/${count} 页`),
          });
        } catch {
          signal.throwIfAborted();
          // A stalled operator stream can remain cached on the page proxy.
          opened.dispose();
          setMatching(false);
          setBusy('正在准备手动配对…');
          opened = await inspectPdf(file.data, signal);
        } finally {
          manualMatch.current = undefined;
          setMatching(false);
        }
      }
      signal.throwIfAborted();
      const binding = createBinding(file, prints);
      const id = item?.id ?? 'file_' + crypto.randomUUID();
      const publish = async (notes: AnnotationFile, replaced: boolean, openSignal?: AbortSignal) => {
        await flushCurrentPdf();
        await commitAnnotationBinding(async () => {
          openSignal?.throwIfAborted();
          writing.current = true;
          setSaving(true);
          try {
            const next = { ...notes, binding };
            // The sidecar is the source of truth for both the binding and its ink.
            await saveAnnotationFile(id, next);
            usePdfLibrary.getState().publishFile(id, binding, opened.doc.numPages, options.category, replaced);
            usePdfStore.getState().openPreparedPdf(opened, binding.name, {
              ...(replaced ? { showDotGrid: item?.showDotGrid } : item),
              itemId: id,
            }, next);
          } finally {
            writing.current = false;
            setSaving(false);
          }
        });
      };
      if (!migrate) {
        await publish(previous, false, signal);
        owned = false;
        return;
      }
      const match = prints ? matchPages(previousPrints, prints) : new Map<number, number>();
      const liveCount = rows.length - (previous.unplaced?.length ?? 0);
      const initial: Record<number, number> = {};
      rows.slice(0, liveCount).forEach((row, index) => {
        const target = !changed && previous.binding ? row.oldPage : match.get(row.oldPage);
        if (target && target <= opened.doc.numPages) initial[index] = target;
      });
      reviewRef.current = opened;
      setReview({
        doc: opened, name: binding.name, rows, initial,
        commit: async notes => {
          await publish(notes, !options.pending || changed);
          reviewRef.current = undefined;
          setReview(null);
        },
      });
      owned = false;
    } finally { if (owned) opened.dispose(); }
  };

  const pickAndOpen = (category: string | null) => run(async signal => {
    if (!window.electronAPI?.pickLibraryFiles) {
      const picked = await pickBrowserPdf();
      if (!picked) return;
      const item = usePdfLibrary.getState().items.find(item => pathsEqual(item.paths ?? [item.path], picked.paths));
      await reviewFile(picked.paths, signal, item, { category, picked });
      return;
    }
    const paths = await selectFiles();
    if (!paths.length) return;
    const item = usePdfLibrary.getState().items.find(item => pathsEqual(item.paths ?? [item.path], paths));
    await reviewFile(paths, signal, item, { category });
  });

  const replace = (item: PdfLibraryItem, relink = false) => run(async signal => {
    setOffline(null);
    if (!window.electronAPI?.pickLibraryFiles) {
      const picked = await pickBrowserPdf();
      if (picked) await reviewFile(picked.paths, signal, item, { force: !relink, relink, picked });
      return;
    }
    const paths = await selectFiles();
    if (paths.length) await reviewFile(paths, signal, item, { force: !relink, relink });
  });

  const open = (item: PdfLibraryItem) => run(signal => reviewFile([], signal, item));
  const openPath = (path: string) => run(async signal => {
    usePdfLibrary.getState().loadState();
    const item = usePdfLibrary.getState().items.find(item => pathsEqual(item.paths ?? [item.path], [path]));
    await reviewFile([path], signal, item);
  });
  const pairPending = () => {
    const item = usePdfLibrary.getState().items.find(item => item.id === usePdfStore.getState().currentItemId);
    if (item) void run(signal => reviewFile([], signal, item, { pending: true }));
  };
  const closeReview = () => { reviewRef.current?.dispose(); reviewRef.current = undefined; setReview(null); };
  const abortTask = () => {
    if (writing.current) return;
    task.current?.abort();
    setBusy('正在取消…');
  };

  return {
    pickAndOpen, open, openPath, replace, pairPending,
    busy: !!busy, indexProgress,
    overlays: <>
      {sequence && <ImageSequenceDialog initial={sequence.paths} onFinish={sequence.finish} />}
      {busy && !sequence && <FileDialog title="打开文档" closeLabel="取消" saving={saving} onClose={abortTask}>
        <p role="status">{saving ? '正在保存文件绑定…' : busy}</p>
        {matching && <div className="file-dialog-actions"><button className="glass-btn"
          onClick={() => manualMatch.current?.abort()}>手动配对</button></div>}
      </FileDialog>}
      {review && <FileMigrationDialog review={review} close={closeReview} />}
      {offline && <FileDialog title="文件离线" onClose={() => setOffline(null)}>
        <p>{offline.name}</p>
        <div className="file-dialog-actions"><button className="btn-accent" onClick={() => void replace(offline, true)}>重新绑定</button></div>
      </FileDialog>}
      {error && <FileDialog title="文件操作失败" onClose={() => setError('')}><p role="alert" className="file-library-error">{error}</p></FileDialog>}
    </>,
  };
}

function hasCompleteIndex(index?: import('./annotationFiles').PageFingerprints, count?: number) {
  return index?.version === 1 && index.pages.length > 0
    && (count === undefined || index.pages.length === count) && index.pages.every(Boolean);
}
