/**
 * PdfStore — Zustand store for the PDF annotation view.
 *
 * - Strokes are stored per page (`strokes[pageNumber]`), only the active page
 *   is ever touched by the canvas.
 * - History uses REFERENCE sharing (never `structuredClone`): strokes are
 *   immutable, so an undo snapshot is just the previous array reference — the
 *   memory cost is effectively zero no matter how many pages / strokes exist.
 * - `renderEpoch` is bumped ONLY by structural ops (undo / redo / delete /
 *   move / clear) so the canvas knows when to rebuild its inkLayer from the
 *   vector source of truth. `commitStroke` is additive — the canvas already
 *   rasterized the stroke incrementally, so it must NOT trigger a rebuild.
 */

import { create } from 'zustand';
import type {
  PdfBrush,
  PdfCamera,
  PdfEraserMode,
  PdfPageSize,
  PdfPoint,
  PdfSelectionMode,
  PdfStroke,
  PdfTool,
} from './PdfTypes';
import { loadPdfDocument, type PdfJsDocument } from './PdfLoader';

const MAX_HISTORY = 50;

export const DEFAULT_PDF_BRUSH: PdfBrush = {
  size: 8,
  opacity: 1,
  color: 'rgba(255,255,255,0.95)',
  smoothing: 0.35,
};

export interface PdfStore {
  // PDF document
  fileName: string | null;
  pdfDoc: PdfJsDocument | null;
  numPages: number;
  currentPage: number;
  pageSizes: Record<number, PdfPageSize>;
  /** Library item currently open (for writing resume state back). */
  currentItemId: string | null;
  /** Non-null when resuming: the canvas uses this camera instead of fit-to-page. */
  pendingResumeCamera: PdfCamera | null;
  /** Set while a PDF is being parsed / rendered. */
  loading: boolean;
  /** Human-readable import error, shown on the import screen. */
  error: string | null;

  // Vector source of truth, per page
  strokes: Record<number, PdfStroke[]>;

  // Reference-sharing undo stacks, per page
  history: Record<number, PdfStroke[][]>;
  redoStack: Record<number, PdfStroke[][]>;

  // Bumped on structural changes → canvas rebuilds inkLayer
  renderEpoch: number;

  // Tool / brush
  activeTool: PdfTool;
  brush: PdfBrush;
  eraserMode: PdfEraserMode;
  selectionMode: PdfSelectionMode;
  selectedIds: string[];
  /** Dot-grid overlay behind the annotations (independent of the canvas, default off). */
  showDotGrid: boolean;

  // Camera (per current page)
  camera: PdfCamera;

  // Thumbnail sidebar
  sidebarOpen: boolean;

  // Actions
  /** Load a PDF from raw bytes (from the library / file picker). */
  loadPdfFromBuffer: (buffer: ArrayBuffer, name: string, resume?: {
    itemId?: string;
    lastPage?: number;
    camera?: PdfCamera;
    showDotGrid?: boolean;
    sidebarOpen?: boolean;
  }) => Promise<void>;
  closePdf: () => void;
  setPageSize: (page: number, size: PdfPageSize) => void;
  setCurrentPage: (page: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  setCamera: (partial: Partial<PdfCamera>) => void;
  resetCamera: (cam: PdfCamera) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;

  setActiveTool: (t: PdfTool) => void;
  setBrush: (partial: Partial<PdfBrush>) => void;
  setEraserMode: (m: PdfEraserMode) => void;
  setSelectionMode: (m: PdfSelectionMode) => void;
  setSelectedIds: (ids: string[]) => void;
  clearSelection: () => void;
  toggleSelected: (id: string) => void;
  setShowDotGrid: (show: boolean) => void;
  /** Batch-replace stroke points (drag-move drop). Structural → rebuilds inkLayer. */
  commitStrokesPoints: (page: number, entries: { id: string; points: PdfPoint[] }[]) => void;

  /** Additive: appends a stroke + records history. Canvas already rasterized it. */
  commitStroke: (page: number, stroke: PdfStroke) => void;
  removeStroke: (page: number, id: string) => void;
  /** Records a history entry without changing anything (used at drag start). */
  pushHistory: (page: number) => void;
  /** Moves strokes WITHOUT recording history (used during a live drag). */
  moveStrokesLive: (page: number, ids: string[], dx: number, dy: number) => void;
  undo: () => void;
  redo: () => void;
  deleteSelected: () => void;
  moveStrokes: (page: number, ids: string[], dx: number, dy: number) => void;
  clearPage: () => void;

  reset: () => void;
}

// ---- Helpers -----------------------------------------------------------------

function pushHistoryEntry(
  history: Record<number, PdfStroke[][]>,
  page: number,
  cur: PdfStroke[],
): Record<number, PdfStroke[][]> {
  const pageHist = history[page] ?? [];
  pageHist.push(cur);
  if (pageHist.length > MAX_HISTORY) pageHist.shift();
  return { ...history, [page]: pageHist };
}

function emptyHistoryRecord(): Record<number, PdfStroke[][]> {
  return {};
}

// ---- Store -------------------------------------------------------------------

export const usePdfStore = create<PdfStore>((set, get) => ({
  fileName: null,
  pdfDoc: null,
  numPages: 0,
  currentPage: 1,
  pageSizes: {},
  currentItemId: null,
  pendingResumeCamera: null,
  loading: false,
  error: null,

  strokes: {},
  history: {},
  redoStack: {},

  renderEpoch: 0,

  activeTool: 'pen',
  brush: { ...DEFAULT_PDF_BRUSH },
  eraserMode: 'free',
  selectionMode: 'box',
  selectedIds: [],
  showDotGrid: false,

  camera: { x: 0, y: 0, zoom: 1 },

  sidebarOpen: true,

  // --- document ------------------------------------------------------------

  loadPdfFromBuffer: async (buffer: ArrayBuffer, name: string, resume) => {
    try {
      set({ loading: true, error: null });
      const { doc, numPages, firstPage } = await loadPdfDocument(buffer);
      const lastPage = Math.min(numPages, Math.max(1, resume?.lastPage ?? 1));
      set({
        fileName: name,
        pdfDoc: doc,
        numPages,
        currentPage: lastPage,
        pageSizes: { 1: firstPage },
        currentItemId: resume?.itemId ?? null,
        pendingResumeCamera: resume?.camera ?? null,
        strokes: {},
        history: emptyHistoryRecord(),
        redoStack: emptyHistoryRecord(),
        renderEpoch: 0,
        selectedIds: [],
        showDotGrid: resume?.showDotGrid ?? false,
        sidebarOpen: resume?.sidebarOpen ?? true,
        camera: resume?.camera ?? { x: 0, y: 0, zoom: 1 },
        loading: false,
      });
    } catch (e) {
      console.error('PDF import failed:', e);
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  closePdf: () => {
    set({
      fileName: null,
      pdfDoc: null,
      numPages: 0,
      currentPage: 1,
      pageSizes: {},
      currentItemId: null,
      pendingResumeCamera: null,
      strokes: {},
      history: emptyHistoryRecord(),
      redoStack: emptyHistoryRecord(),
      renderEpoch: 0,
      selectedIds: [],
      camera: { x: 0, y: 0, zoom: 1 },
      loading: false,
      error: null,
    });
  },

  setPageSize: (page, size) =>
    set((s) => ({ pageSizes: { ...s.pageSizes, [page]: size } })),

  setCurrentPage: (page) => {
    const clamped = Math.max(1, Math.min(get().numPages, page));
    set((s) => ({ currentPage: clamped, selectedIds: [], camera: { x: 0, y: 0, zoom: 1 } }));
  },

  nextPage: () => {
    const { currentPage, numPages } = get();
    if (currentPage < numPages) get().setCurrentPage(currentPage + 1);
  },

  prevPage: () => {
    const { currentPage } = get();
    if (currentPage > 1) get().setCurrentPage(currentPage - 1);
  },

  setCamera: (partial) => set((s) => ({ camera: { ...s.camera, ...partial } })),

  resetCamera: (cam) => set({ camera: cam }),

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  // --- tool / brush --------------------------------------------------------

  setActiveTool: (t) => set({ activeTool: t }),

  setBrush: (partial) => set((s) => ({ brush: { ...s.brush, ...partial } })),

  setEraserMode: (m) => set({ eraserMode: m }),

  setSelectionMode: (m) => set({ selectionMode: m }),

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  clearSelection: () => set({ selectedIds: [] }),

  toggleSelected: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),

  setShowDotGrid: (show) => set({ showDotGrid: show }),

  commitStrokesPoints: (page, entries) => {
    if (entries.length === 0) return;
    const map = new Map(entries.map((e) => [e.id, e.points]));
    const cur = get().strokes[page] ?? [];
    const next = cur.map((o) => (map.has(o.id) ? { ...o, points: map.get(o.id)! } : o));
    set((s) => ({
      strokes: { ...s.strokes, [page]: next },
      redoStack: { ...s.redoStack, [page]: [] },
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  // --- editing -------------------------------------------------------------

  commitStroke: (page, stroke) => {
    const cur = get().strokes[page] ?? [];
    set((s) => ({
      strokes: { ...s.strokes, [page]: [...cur, stroke] },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
    }));
  },

  removeStroke: (page, id) => {
    const cur = get().strokes[page] ?? [];
    const next = cur.filter((s) => s.id !== id);
    if (next.length === cur.length) return;
    set((s) => ({
      strokes: { ...s.strokes, [page]: next },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: s.selectedIds.filter((x) => x !== id),
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  pushHistory: (page) =>
    set((s) => ({
      history: pushHistoryEntry(s.history, page, s.strokes[page] ?? []),
      redoStack: { ...s.redoStack, [page]: [] },
    })),

  moveStrokesLive: (page, ids, dx, dy) => {
    if (dx === 0 && dy === 0) return;
    const setIds = new Set(ids);
    if (setIds.size === 0) return;
    const cur = get().strokes[page] ?? [];
    const next = cur.map((s) =>
      setIds.has(s.id)
        ? { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }
        : s,
    );
    set((s) => ({
      strokes: { ...s.strokes, [page]: next },
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  undo: () => {
    const page = get().currentPage;
    const hist = get().history[page] ?? [];
    if (hist.length === 0) return;
    const cur = get().strokes[page] ?? [];
    const prev = hist[hist.length - 1];
    set((s) => ({
      history: { ...s.history, [page]: hist.slice(0, -1) },
      redoStack: { ...s.redoStack, [page]: [...(s.redoStack[page] ?? []), cur] },
      strokes: { ...s.strokes, [page]: prev },
      selectedIds: [],
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  redo: () => {
    const page = get().currentPage;
    const rs = get().redoStack[page] ?? [];
    if (rs.length === 0) return;
    const cur = get().strokes[page] ?? [];
    const next = rs[rs.length - 1];
    set((s) => ({
      redoStack: { ...s.redoStack, [page]: rs.slice(0, -1) },
      history: pushHistoryEntry(s.history, page, cur),
      strokes: { ...s.strokes, [page]: next },
      selectedIds: [],
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  deleteSelected: () => {
    const page = get().currentPage;
    const ids = new Set(get().selectedIds);
    if (ids.size === 0) return;
    const cur = get().strokes[page] ?? [];
    const next = cur.filter((s) => !ids.has(s.id));
    if (next.length === cur.length) return;
    set((s) => ({
      strokes: { ...s.strokes, [page]: next },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: [],
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  moveStrokes: (page, ids, dx, dy) => {
    if (dx === 0 && dy === 0) return;
    const setIds = new Set(ids);
    if (setIds.size === 0) return;
    const cur = get().strokes[page] ?? [];
    const next = cur.map((s) =>
      setIds.has(s.id)
        ? { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }
        : s,
    );
    set((s) => ({
      strokes: { ...s.strokes, [page]: next },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  clearPage: () => {
    const page = get().currentPage;
    const cur = get().strokes[page] ?? [];
    if (cur.length === 0) return;
    set((s) => ({
      strokes: { ...s.strokes, [page]: [] },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: [],
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  reset: () =>
    set({
      fileName: null,
      pdfDoc: null,
      numPages: 0,
      currentPage: 1,
      pageSizes: {},
      currentItemId: null,
      pendingResumeCamera: null,
      strokes: {},
      history: {},
      redoStack: {},
      renderEpoch: 0,
      activeTool: 'pen',
      brush: { ...DEFAULT_PDF_BRUSH },
      eraserMode: 'free',
      selectionMode: 'box',
      selectedIds: [],
      showDotGrid: false,
      camera: { x: 0, y: 0, zoom: 1 },
      sidebarOpen: true,
      loading: false,
      error: null,
    }),
}));
