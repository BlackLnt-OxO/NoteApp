import { useState } from 'react';
import { collectMigration, type AnnotationFile, type UnplacedPage } from './annotationFiles';
import { FileDialog, PageNavigation, PreviewPage } from './FileDialogs';
import type { OpenedPdf } from './inspectPdf';

export interface MigrationReview {
  doc: OpenedPdf;
  name: string;
  rows: UnplacedPage[];
  initial: Record<number, number>;
  commit: (notes: AnnotationFile) => Promise<void>;
}

export default function FileMigrationDialog({ review, close }: { review: MigrationReview; close: () => void }) {
  const [assignments, setAssignments] = useState(review.initial);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [page, setPage] = useState(() => Object.values(review.initial).find(Boolean) ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<number | null>(null);
  const notes = collectMigration(review.rows, assignments);
  const count = review.doc.doc.numPages;
  const assign = (index: number, value: string) => {
    setDrafts(current => ({ ...current, [index]: value }));
    const next = value.trim() ? Number(value) : 0;
    if (!Number.isInteger(next) || next < 0 || next > count
      || (next && Object.entries(assignments).some(([key, target]) => Number(key) !== index && target === next))) {
      setInvalid(index);
      return;
    }
    setInvalid(null);
    setError('');
    setAssignments(current => ({ ...current, [index]: next }));
    if (next) setPage(next);
  };
  const commit = async () => {
    setSaving(true);
    setError('');
    try { await review.commit(notes); }
    catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };
  return <FileDialog title={'批注迁移预览 · ' + review.name} onClose={() => { if (!saving) close(); }}>
    <div className="file-preview-body">
      <PreviewPage doc={review.doc.doc} page={page} items={notes.items[page]} maxWidth={Math.min(820, window.innerWidth - 320)} />
      <div className="file-preview-assignments">
        <strong>{review.rows.length - notes.unplaced!.length} 页已配对 · {notes.unplaced!.length} 页待配对</strong>
        {review.rows.map((row, index) => {
          const target = assignments[index];
          return <label key={index}>
            <button className="glass-btn" type="button" disabled={!target} onClick={() => setPage(target)}>
              旧第 {row.oldPage} 页
            </button>
            <span>→</span>
            <input type="number" min={1} max={count} aria-label={'旧第 ' + row.oldPage + ' 页的目标页码'}
              placeholder="待配对" value={drafts[index] ?? (target || '')} disabled={saving}
              onChange={event => assign(index, event.target.value)}
              onBlur={() => {
                if (invalid === index) setInvalid(null);
                setDrafts(current => { const next = { ...current }; delete next[index]; return next; });
              }} />
          </label>;
        })}
      </div>
    </div>
    <PageNavigation page={page} count={count} onPage={setPage} />
    {error && <p className="file-library-error" role="alert">{error}</p>}
    {invalid !== null && <p className="file-library-error" role="alert">请选择有效且尚未配对的新版页码。</p>}
    <div className="file-dialog-actions">
      <button className="glass-btn" disabled={saving} onClick={close}>取消</button>
      <button className="btn-accent" disabled={saving || invalid !== null} onClick={() => void commit()}>{saving ? '正在保存…' : '确认替换'}</button>
    </div>
  </FileDialog>;
}
