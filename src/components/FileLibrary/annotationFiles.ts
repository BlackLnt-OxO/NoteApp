import type { PdfItem } from '../PdfAnnotation/PdfTypes';
import type { FileKind, PreparedFile } from './fileTypes';

export interface FileBinding {
  paths: string[];
  kind: FileKind;
  name: string;
  sizeBytes: number;
  digest: string;
  fingerprints?: PageFingerprints;
}

export interface PageFingerprints {
  version: number;
  pages: string[];
}

export interface UnplacedPage {
  oldPage: number;
  items: PdfItem[];
}

export interface AnnotationFile {
  items: Record<number, PdfItem[]>;
  savedAt?: number;
  binding?: FileBinding;
  unplaced?: UnplacedPage[];
}

let bindingWrite: Promise<void> | undefined;
export async function commitAnnotationBinding(commit: () => Promise<void>) {
  const operation = bindingWrite ? bindingWrite.catch(() => {}).then(commit) : commit();
  bindingWrite = operation;
  try { await operation; }
  finally { if (bindingWrite === operation) bindingWrite = undefined; }
}

export async function loadAnnotationFile(id: string): Promise<AnnotationFile> {
  const raw = window.electronAPI?.loadPdfAnnotation ? await window.electronAPI.loadPdfAnnotation(id)
    : JSON.parse(localStorage.getItem('pdf-annotation-' + id) ?? 'null');
  return { ...raw, items: raw?.items ?? raw?.strokes ?? {} };
}

export async function saveAnnotationFile(id: string, file: AnnotationFile) {
  const data = { ...file, savedAt: Date.now() };
  if (window.electronAPI?.savePdfAnnotation) {
    const result = await window.electronAPI.savePdfAnnotation(id, data);
    if (!result?.ok) throw new Error(result?.error ?? '保存批注失败。');
  } else {
    localStorage.setItem('pdf-annotation-' + id, JSON.stringify(data));
  }
}

export function createBinding(file: PreparedFile, fingerprints?: PageFingerprints): FileBinding {
  const { paths, kind, name, sizeBytes, digest } = file;
  return { paths, kind, name, sizeBytes, digest, fingerprints };
}

export function annotatedPages(file: AnnotationFile): UnplacedPage[] {
  return [
    ...Object.entries(file.items).filter(([, items]) => items.length).map(([page, items]) => ({ oldPage: Number(page), items })),
    ...(file.unplaced ?? []),
  ];
}

export function matchPages(from: PageFingerprints | undefined, to: PageFingerprints): Map<number, number> {
  const result = new Map<number, number>();
  if (!from || from.version !== to.version) return result;
  const unique = (pages: string[]) => {
    const map = new Map<string, number>();
    pages.forEach((key, index) => {
      if (key) map.set(key, map.has(key) ? 0 : index + 1);
    });
    return map;
  };
  const previous = unique(from.pages);
  const next = unique(to.pages);
  for (const [key, oldPage] of previous) {
    const newPage = next.get(key);
    if (oldPage && newPage) result.set(oldPage, newPage);
  }
  return result;
}

// Indices refer to the migration rows, not the old page numbers. Detached rows
// may come from an earlier replacement and share a page number with live ink.
export function collectMigration(rows: UnplacedPage[], assignments: Record<number, number>): AnnotationFile {
  const items: Record<number, PdfItem[]> = {};
  const unplaced: UnplacedPage[] = [];
  rows.forEach((row, index) => {
    const page = assignments[index];
    if (page && !items[page]) items[page] = row.items;
    else unplaced.push(row);
  });
  return { items, unplaced };
}
