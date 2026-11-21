import { useEffect, useRef, useState } from 'react';
import { usePdfLibrary, type PdfLibraryItem } from '../PdfAnnotation/PdfLibrary';
import { usePdfStore } from '../PdfAnnotation/PdfStore';
import { pickPdfFile } from '../PdfAnnotation/PdfPicker';
import { annotatedPages, commitAnnotationBinding, createBinding, loadAnnotationFile, matchPages, saveAnnotationFile, type AnnotationFile } from './annotationFiles';
import { fileName, isImageFile, localPathKey, type PreparedFile } from './fileTypes';
import { fingerprintPages, inspectPdf, type OpenedPdf } from './inspectPdf';
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
  const [error, setError] = useState('');
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [review, setReview] = useState<MigrationReview | null>(null);
  const [offline, setOffline] = useState<PdfLibraryItem | null>(null);
  const task = useRef<AbortController>();
  const sequenceRef = useRef<Sequence>();
  const reviewRef = useRef<OpenedPdf>();

  useEffect(() => () => {
    task.current?.abort();
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
      setBusy('');
    }
  };

  const reviewFile = async (
    paths: string[], signal: AbortSignal, item?: PdfLibraryItem,
    options: { force?: boolean; relink?: boolean; pending?: boolean; category?: string | null; picked?: PreparedFile } = {},
  ) => {
    const current = usePdfStore.getState();
    const previous = item ? (item.id === current.currentItemId
      ? { items: current.items, unplaced: current.unplacedPages, binding: current.binding }
      : await loadAnnotationFile(item.id)) : { items: {} };
    const originalPaths = previous.binding?.paths ?? item?.paths ?? (item ? [item.path] : []);
    const selectedPaths = paths.length ? paths : originalPaths;
    signal.throwIfAborted();
    let file = options.picked;
    if (!file) {
      const result = await window.electronAPI?.prepareLibraryDocument?.(selectedPaths);
      signal.throwIfAborted();
      if (!result) { if (item) { setOffline(item); return; } throw new Error('请在桌面应用中导入文件。'); }
      if (!result.ok) {
        if (result.offline && item && !paths.length) { setOffline(item); return; }
        throw new Error(result.error);
      }
      file = result.file;
    }
    const opened = await inspectPdf(file.data, signal);
    let owned = true;
    try {
      const previousPrints = previous.binding?.fingerprints;
      const sameSource = previous.binding?.digest === file.digest;
      setBusy('正在识别页面…');
      const prints = sameSource && file.kind === 'pdf' && previousPrints?.version === 1 && previousPrints.pages.length === opened.doc.numPages
        ? previousPrints : await fingerprintPages(opened.doc, () => signal.throwIfAborted());
      signal.throwIfAborted();
      const changed = !!previous.binding && (!sameSource || !previousPrints || previousPrints.version !== prints.version
        || previousPrints.pages.length !== prints.pages.length || previousPrints.pages.some((key, index) => key !== prints.pages[index]));
      if (item?.id === current.currentItemId && !changed && !options.force && !options.relink && !options.pending) return;
      const binding = createBinding(file, prints);
      const id = item?.id ?? 'file_' + crypto.randomUUID();
      const publish = async (notes: AnnotationFile, replaced: boolean) => {
        await flushCurrentPdf();
        await commitAnnotationBinding(async () => {
          const next = { ...notes, binding };
          // The sidecar is the source of truth for both the binding and its ink.
          await saveAnnotationFile(id, next);
          usePdfLibrary.getState().publishFile(id, binding, opened.doc.numPages, options.category, replaced);
          usePdfStore.getState().openPreparedPdf(opened, binding.name, {
            ...(replaced ? { showDotGrid: item?.showDotGrid } : item),
            itemId: id,
          }, next);
        });
      };
      const migrate = item && (changed || options.force || options.pending || (options.relink && !previous.binding));
      if (!migrate) {
        await publish(previous, false);
        owned = false;
        return;
      }
      const rows = annotatedPages(previous);
      const match = matchPages(previousPrints, prints);
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
    task.current?.abort();
    setBusy('正在取消…');
  };

  return {
    pickAndOpen, open, openPath, replace, pairPending,
    busy: !!busy,
    overlays: <>
      {sequence && <ImageSequenceDialog initial={sequence.paths} onFinish={sequence.finish} />}
      {busy && !sequence && <FileDialog title={busy} onClose={abortTask}><p role="status">{busy}</p></FileDialog>}
      {review && <FileMigrationDialog review={review} close={closeReview} />}
      {offline && <FileDialog title="文件离线" onClose={() => setOffline(null)}>
        <p>{offline.name}</p>
        <div className="file-dialog-actions"><button className="btn-accent" onClick={() => void replace(offline, true)}>重新绑定</button></div>
      </FileDialog>}
      {error && <FileDialog title="文件操作失败" onClose={() => setError('')}><p role="alert" className="file-library-error">{error}</p></FileDialog>}
    </>,
  };
}
