import { describe, expect, it, vi } from 'vitest';
import { collectMigration, commitAnnotationBinding, matchPages, saveAnnotationFile, type UnplacedPage } from '../annotationFiles';
import type { LinkedAssetObject } from '../fileTypes';
import { resolveAsset, useAssetLibrary } from '../assetLibrary';

function page(oldPage: number): UnplacedPage {
  return { oldPage, items: [{ id: 'mark-' + oldPage, type: 'asset', assetId: 'source',
    x: 28, y: 76, width: 155, height: 50, createdAt: 0 } satisfies LinkedAssetObject] };
}
function fingerprints(...pages: string[]) { return { version: 1, pages }; }

describe('whole page migration', () => {
  it('matches unchanged pages after adding, deleting and reordering pages', () => {
    const result = matchPages(fingerprints('red', 'green', 'blue'), fingerprints('yellow', 'blue', 'red'));
    expect([...result]).toEqual([[1, 3], [3, 2]]);
    const rows = [page(1), page(2), page(3)];
    const migration = collectMigration(rows, { 0: 3, 2: 2 });
    expect(migration.items[3]).toBe(rows[0].items);
    expect(migration.items[2][0]).toMatchObject({ assetId: 'source', x: 28, y: 76 });
    expect(migration.unplaced).toEqual([rows[1]]);
  });

  it('requires manual placement when either version repeats a page or the old fingerprint is missing', () => {
    expect([...matchPages(fingerprints('a', 'a', 'b', 'c'), fingerprints('a', 'b', 'b', 'c'))]).toEqual([[4, 4]]);
    expect([...matchPages(undefined, fingerprints('a'))]).toEqual([]);
    expect([...matchPages({ version: 0, pages: ['a'] }, fingerprints('a'))]).toEqual([]);
    const rows = [page(2), page(3)];
    expect(collectMigration(rows, { 0: 1, 1: 1 })).toEqual({ items: { 1: rows[0].items }, unplaced: [rows[1]] });
  });

  it('treats an IPC write rejection as a failed save', async () => {
    vi.stubGlobal('electronAPI', { savePdfAnnotation: vi.fn().mockResolvedValue({ ok: false, error: '写入失败' }) });
    try { await expect(saveAnnotationFile('file', { items: {} })).rejects.toThrow('写入失败'); }
    finally { vi.unstubAllGlobals(); }
  });

  it('serializes binding and ink writes and continues after a failed write', async () => {
    let rejectFirst!: (error: Error) => void;
    const second = vi.fn().mockResolvedValue(undefined);
    const first = commitAnnotationBinding(() => new Promise((_, reject) => { rejectFirst = reject; }));
    const checked = expect(first).rejects.toThrow('write failed');
    const save = commitAnnotationBinding(second);
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
    rejectFirst(new Error('write failed'));
    await checked;
    await save;
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('shared asset paths', () => {
  it('merges a relink to an existing path while both saved IDs still resolve', async () => {
    vi.stubGlobal('electronAPI', {
      pickLibraryFiles: vi.fn().mockResolvedValue(['C:/moved/lecture.pdf']),
      checkLibraryFiles: vi.fn().mockResolvedValue([true]),
    });
    const state = useAssetLibrary.getState();
    try {
      useAssetLibrary.setState({ assets: [
        { id: 'old', path: 'C:/old/lecture.pdf' }, { id: 'current', path: 'C:/moved/lecture.pdf' },
      ], aliases: {}, available: { old: false } });
      await state.relink('old');
      expect(useAssetLibrary.getState().assets).toHaveLength(1);
      expect(resolveAsset(useAssetLibrary.getState(), 'old')?.path).toBe('C:/moved/lecture.pdf');
      expect(useAssetLibrary.getState().available.current).toBe(true);
    } finally {
      useAssetLibrary.setState({ assets: [], aliases: {}, available: {} });
      vi.unstubAllGlobals();
    }
  });
});
