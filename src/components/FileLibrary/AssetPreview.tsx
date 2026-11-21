import { useEffect, useState } from 'react';
import { rebindAsset, resolveAsset, useAssetLibrary } from './assetLibrary';
import { fileName } from './fileTypes';
import { inspectPdf, type OpenedPdf } from './inspectPdf';
import { FileDialog, PageNavigation, PreviewPage } from './FileDialogs';

export default function AssetPreview({ onOpen }: { onOpen: (path: string) => void }) {
  const id = useAssetLibrary(state => state.previewId);
  const path = useAssetLibrary(state => id ? resolveAsset(state, id)?.path : undefined);
  const [opened, setOpened] = useState<OpenedPdf>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (!id || !path) return;
    let closed = false;
    let pdf: OpenedPdf | undefined;
    const abort = new AbortController();
    setPage(1);
    setOpened(undefined);
    setError('');
    setOffline(false);
    void (async () => {
      const result = await window.electronAPI?.prepareLibraryDocument?.([path]);
      if (closed) return;
      if (!result) throw new Error('请在桌面应用中打开。');
      if (!result.ok) {
        setOffline(!!result.offline);
        if (result.offline) {
          const asset = resolveAsset(useAssetLibrary.getState(), id);
          if (asset) useAssetLibrary.getState().setAvailable(asset.id, path, false);
        }
        throw new Error(result.error);
      }
      pdf = await inspectPdf(result.file.data, abort.signal);
      if (closed) pdf.dispose(); else setOpened(pdf);
    })().catch(err => { if (!closed) setError(String(err.message ?? err)); });
    return () => { closed = true; abort.abort(); pdf?.dispose(); };
  }, [id, path]);

  if (!id || !path) return null;
  const close = () => useAssetLibrary.setState({ previewId: null });
  return <FileDialog title={fileName(path)} onClose={close}>
    {error ? <p role="alert" className="file-library-error">{error}</p> : opened
      ? <PreviewPage doc={opened.doc} page={page} maxWidth={Math.min(900, window.innerWidth - 60)} />
      : <p role="status">正在打开文件…</p>}
    {opened && <PageNavigation page={page} count={opened.doc.numPages} onPage={setPage} />}
    <div className="file-dialog-actions">
      {offline && <button className="glass-btn" onClick={() => rebindAsset(id)}>重新绑定</button>}
      {opened && <button className="btn-accent" onClick={() => { close(); onOpen(path); }}>打开到文件</button>}
    </div>
  </FileDialog>;
}
