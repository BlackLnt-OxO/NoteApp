/**
 * useCanvasLibrary — persisted library of ink canvases (home screen).
 *
 * Mirrors PdfLibrary: a small metadata list in localStorage (id/name/timestamps)
 * while each canvas's {objects, camera, showDotGrid} lives under its own
 * `stickynotes-inkcanvas-<id>` key.
 *
 * Migration: the pre-multi-canvas build stored a single document at the legacy
 * `stickynotes-inkcanvas` key. On first load, if that key exists and the list is
 * empty, it becomes "未命名1" and the legacy key is removed.
 */

import { create } from 'zustand';
import type { CanvasCategory, CanvasMeta } from './types';
import { CANVAS_LIST_KEY, canvasDataKey, STORAGE_KEY } from './constants';

export interface CanvasLibraryStore {
  canvases: CanvasMeta[];
  categories: CanvasCategory[];
  /** Canvas currently open in the view (null → show the home screen). */
  currentCanvasId: string | null;
  loaded: boolean;

  loadLibrary: () => void;
  saveState: () => void;
  /** Create a new untitled canvas, seed empty data, and open it. */
  addCanvas: () => string;
  renameCanvas: (id: string, name: string) => void;
  deleteCanvas: (id: string) => void;
  setCanvasCategory: (id: string, categoryId: string | null) => void;
  addCategory: (name: string) => string;
  renameCategory: (id: string, name: string) => void;
  deleteCategory: (id: string) => void;
  /** Drag-to-reorder: swap two canvases in the list. */
  reorderCanvases: (fromIndex: number, toIndex: number) => void;
  setCurrentCanvasId: (id: string | null) => void;
}

function makeId(): string {
  return `canvas_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Next "未命名N" name (N = highest existing suffix + 1). */
function nextUntitledName(canvases: CanvasMeta[]): string {
  let max = 0;
  for (const c of canvases) {
    const m = c.name.match(/^未命名(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `未命名${max + 1}`;
}

export const useCanvasLibrary = create<CanvasLibraryStore>((set, get) => ({
  canvases: [],
  categories: [],
  currentCanvasId: null,
  loaded: false,

  loadLibrary: () => {
    try {
      const legacy = localStorage.getItem(STORAGE_KEY);
      const raw = localStorage.getItem(CANVAS_LIST_KEY);
      let list: CanvasMeta[] = [];
      let categories: CanvasCategory[] = [];
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.canvases)) {
          list = parsed.canvases;
          categories = Array.isArray(parsed.categories) ? parsed.categories : [];
        } else if (Array.isArray(parsed)) {
          list = parsed; // legacy list-only shape
        }
      }
      if (legacy && list.length === 0) {
        const id = makeId();
        localStorage.setItem(canvasDataKey(id), legacy);
        localStorage.removeItem(STORAGE_KEY);
        list = [{ id, name: '未命名1', categoryId: null, createdAt: Date.now(), updatedAt: Date.now() }];
        localStorage.setItem(CANVAS_LIST_KEY, JSON.stringify({ canvases: list, categories }));
      }
      set({ canvases: list, categories, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  saveState: () => {
    try {
      localStorage.setItem(CANVAS_LIST_KEY, JSON.stringify({ canvases: get().canvases, categories: get().categories }));
    } catch { /* quota / private mode */ }
  },

  addCanvas: () => {
    const id = makeId();
    const meta: CanvasMeta = { id, name: nextUntitledName(get().canvases), categoryId: null, createdAt: Date.now(), updatedAt: Date.now() };
    try {
      localStorage.setItem(
        canvasDataKey(id),
        JSON.stringify({ objects: [], camera: { x: 0, y: 0, zoom: 1 }, showDotGrid: true }),
      );
    } catch { /* ignore */ }
    set((s) => ({ canvases: [meta, ...s.canvases], currentCanvasId: id }));
    get().saveState();
    return id;
  },

  renameCanvas: (id, name) =>
    set((s) => ({
      canvases: s.canvases.map((c) => (c.id === id ? { ...c, name, updatedAt: Date.now() } : c)),
    })),

  deleteCanvas: (id) => {
    try { localStorage.removeItem(canvasDataKey(id)); } catch { /* ignore */ }
    set((s) => ({
      canvases: s.canvases.filter((c) => c.id !== id),
      currentCanvasId: s.currentCanvasId === id ? null : s.currentCanvasId,
    }));
  },

  setCanvasCategory: (id, categoryId) =>
    set((s) => ({
      canvases: s.canvases.map((c) => (c.id === id ? { ...c, categoryId, updatedAt: Date.now() } : c)),
    })),

  addCategory: (name) => {
    const id = makeId();
    set((s) => ({ categories: [...s.categories, { id, name, createdAt: Date.now() }] }));
    return id;
  },

  renameCategory: (id, name) =>
    set((s) => ({ categories: s.categories.map((c) => (c.id === id ? { ...c, name } : c)) })),

  deleteCategory: (id) =>
    set((s) => ({
      categories: s.categories.filter((c) => c.id !== id),
      canvases: s.canvases.map((c) => (c.categoryId === id ? { ...c, categoryId: null } : c)),
    })),

  reorderCanvases: (fromIndex, toIndex) =>
    set((s) => {
      const canvases = [...s.canvases];
      [canvases[fromIndex], canvases[toIndex]] = [canvases[toIndex], canvases[fromIndex]];
      return { canvases };
    }),

  setCurrentCanvasId: (id) => set({ currentCanvasId: id }),
}));

// ---- Auto-save metadata (debounced) -------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
useCanvasLibrary.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (useCanvasLibrary.getState().loaded) useCanvasLibrary.getState().saveState();
  }, 500);
});
