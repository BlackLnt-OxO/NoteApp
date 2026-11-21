/**
 * PdfLibrary — persisted library of imported PDFs (home screen).
 *
 * Items store the ABSOLUTE import-time path. Opening an item re-reads the file
 * via IPC; if the file moved and the path is dead, the UI offers a re-select
 * dialog (which updates the stored path).
 *
 * Persistence: localStorage (small metadata — pages/categories only; the PDF
 * bytes and page images are never persisted, they re-read from disk).
 */

import { create } from 'zustand';
import type { FileBinding } from '../FileLibrary/annotationFiles';
import type { FileKind } from '../FileLibrary/fileTypes';

export interface PdfCategory {
  id: string;
  name: string;
  createdAt: number;
}

export interface PdfLibraryItem {
  id: string;
  name: string;
  path: string;
  paths?: string[];
  kind?: FileKind;
  categoryId: string | null;
  pageCount: number;
  sizeBytes: number;
  lastOpened: number;
  addedAt: number;
  // Resume state (restored when reopened from the library)
  lastPage?: number;
  camera?: { x: number; y: number; zoom: number };
  showDotGrid?: boolean;
  sidebarOpen?: boolean;
  /** Anchored ("marked") page numbers the user added; restored on reopen. */
  anchorPages?: number[];
}

const STORAGE_KEY = 'stickynotes-pdf-library';

export interface PdfLibraryStore {
  items: PdfLibraryItem[];
  categories: PdfCategory[];
  loaded: boolean;

  addItem: (data: { name: string; path: string; categoryId: string | null; pageCount: number; sizeBytes: number }) => string;
  removeItem: (id: string) => void;
  setItemCategory: (id: string, categoryId: string | null) => void;
  updateItemPath: (id: string, path: string) => void;
  touchLastOpened: (id: string) => void;
  publishFile: (id: string, binding: FileBinding, pageCount: number, categoryId?: string | null, replaced?: boolean) => void;
  /** Drag-to-reorder: swap two items in the list. */
  reorderItems: (fromIndex: number, toIndex: number) => void;

  addCategory: (name: string) => string;
  renameCategory: (id: string, name: string) => void;
  deleteCategory: (id: string) => void;
  /** Persist resume state (last page / camera / toggles / anchors) onto an item. */
  updateItemResume: (id: string, resume: { lastPage: number; camera: { x: number; y: number; zoom: number }; showDotGrid: boolean; sidebarOpen: boolean; anchorPages?: number[] }) => void;

  saveState: () => void;
  loadState: () => void;
  reset: () => void;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export const usePdfLibrary = create<PdfLibraryStore>((set, get) => ({
  items: [],
  categories: [],
  loaded: false,

  addItem: (data) => {
    const { items } = get();
    // Reuse an existing entry for the same path (re-import → refresh it).
    const existing = items.find((i) => i.path === data.path);
    if (existing) {
      set((s) => ({
        items: s.items.map((i) =>
          i.id === existing.id
            ? { ...i, name: data.name, pageCount: data.pageCount, sizeBytes: data.sizeBytes, lastOpened: Date.now() }
            : i,
        ),
      }));
      return existing.id;
    }
    const id = makeId('pdf');
    set((s) => ({
      items: [
        { id, addedAt: Date.now(), lastOpened: Date.now(), ...data },
        ...s.items,
      ],
    }));
    return id;
  },

  removeItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),

  setItemCategory: (id, categoryId) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, categoryId } : i)) })),

  updateItemPath: (id, path) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, path } : i)) })),

  touchLastOpened: (id) =>
    set((s) => ({
      // Update the timestamp only — never reorder (the home screen keeps the
      // user's drag-to-reorder sequence).
      items: s.items.map((i) => (i.id === id ? { ...i, lastOpened: Date.now() } : i)),
    })),

  publishFile: (id, binding, pageCount, categoryId = null, replaced = false) => {
    const { items, categories } = get();
    const existing = items.find(item => item.id === id);
    const next: PdfLibraryItem = {
      ...(existing ?? { id, categoryId, addedAt: Date.now() }),
      name: binding.name, path: binding.paths[0], paths: binding.paths,
      kind: binding.kind, pageCount, sizeBytes: binding.sizeBytes, lastOpened: Date.now(),
      ...(replaced ? { camera: undefined, anchorPages: [], lastPage: 1 } : {}),
    };
    const ordered = existing ? items.map(item => item.id === id ? next : item) : [next, ...items];
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: ordered, categories })); }
    catch (error) { if (!existing) throw error; }
    set({ items: ordered, loaded: true });
  },

  reorderItems: (fromIndex, toIndex) =>
    set((s) => {
      const items = [...s.items];
      [items[fromIndex], items[toIndex]] = [items[toIndex], items[fromIndex]];
      return { items };
    }),

  addCategory: (name) => {
    const id = makeId('cat');
    set((s) => ({ categories: [...s.categories, { id, name, createdAt: Date.now() }] }));
    return id;
  },

  renameCategory: (id, name) =>
    set((s) => ({ categories: s.categories.map((c) => (c.id === id ? { ...c, name } : c)) })),

  deleteCategory: (id) =>
    set((s) => ({
      categories: s.categories.filter((c) => c.id !== id),
      items: s.items.map((i) => (i.categoryId === id ? { ...i, categoryId: null } : i)),
    })),

  updateItemResume: (id, resume) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, ...resume } : i)),
    })),

  saveState: () => {
    try {
      const { items, categories } = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, categories }));
    } catch { /* quota / private mode */ }
  },

  loadState: () => {
    if (get().loaded) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        set({
          items: Array.isArray(data.items) ? data.items : [],
          categories: Array.isArray(data.categories) ? data.categories : [],
          loaded: true,
        });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  reset: () => set({ items: [], categories: [], loaded: false }),
}));

// ---- Auto-save (debounced) ---------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
usePdfLibrary.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (usePdfLibrary.getState().loaded) usePdfLibrary.getState().saveState();
  }, 500);
});
