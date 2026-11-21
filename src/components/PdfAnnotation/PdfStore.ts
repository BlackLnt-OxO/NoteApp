/**
 * PdfStore — Zustand store for the PDF annotation view.
 *
 * - Page content is stored per page (`items[pageNumber]`) and can be either ink
 *   strokes (PdfStroke, rasterized into tiles) or insert objects (text cards /
 *   images, rendered as DOM overlays). Only the active page is ever touched.
 * - History uses REFERENCE sharing (never `structuredClone`): items are
 *   immutable, so an undo snapshot is just the previous array reference — the
 *   memory cost is effectively zero no matter how many pages / items exist.
 * - `renderEpoch` is bumped ONLY by structural ops (undo / redo / delete /
 *   clear / moveStrokes) so the canvas knows when to rebuild its inkLayer from
 *   the vector source of truth. Additive stroke commits, drag-move point
 *   commits and text/image object edits do NOT bump it — the canvas already
 *   rasterized those strokes itself (and re-stamps just the moved ones), and
 *   objects are DOM-only.
 * - PDF default color is FIXED (PDF_ANNOTATION_BLUE) and never theme-flipped;
 *   only the canvas default brush follows the theme.
 */

import { create } from 'zustand';
import { loadQuickSizes, saveQuickSizes } from '../inkToolPrefs';
import { replaceStrokePoints } from '../InkShapeGeometry';
import { moveSelectedItem } from '../InkSelection';
import type {
  PdfBrush,
  PdfCamera,
  PdfEraserMode,
  PdfImageObject,
  PdfInsertMode,
  PdfItem,
  PdfPageSize,
  PdfPoint,
  PdfSelectionMode,
  PdfStroke,
  PdfTextObject,
  PdfTool,
  PdfBrushType,
} from './PdfTypes';
import { loadPdfDocument, type PdfJsDocument, abortActivePdfLoad, resetPdfWorker } from './PdfLoader';
import { PDF_ANNOTATION_BLUE } from '../../themeColors';
import { loadAnnotationFile, pendingAnnotationBinding, saveAnnotationFile, type AnnotationFile } from '../FileLibrary/annotationFiles';
import type { OpenedPdf } from '../FileLibrary/inspectPdf';

interface PdfResume {
  itemId?: string;
  lastPage?: number;
  camera?: PdfCamera;
  showDotGrid?: boolean;
  sidebarOpen?: boolean;
  anchorPages?: number[];
}

let disposeCurrentPdf: (() => void) | undefined;
function releaseDocument() {
  disposeCurrentPdf?.();
  disposeCurrentPdf = undefined;
}

/**
 * Monotonic load-generation counter. Every loadPdfFromBuffer captures the value
 * at its start; abortPdfLoad bumps it so a load that resolves AFTER the user hit
 * "中断" is discarded instead of hijacking the UI. Restarting the app resets the
 * rare pdf.js hang the user described — this gives an in-app escape hatch.
 */
let pdfLoadEpoch = 0;

const MAX_HISTORY = 50;
/** Hard cap on how many pages can be anchored at once. */
export const MAX_ANCHOR_PAGES = 7;

/** Clamp restored anchor pages to the real page range (a file may have been
 *  replaced by a shorter one since the user last marked pages). */
export function clampAnchorPages(pages: number[] | undefined, numPages: number): number[] {
  if (!pages) return [];
  return pages.filter((p) => Number.isInteger(p) && p >= 1 && p <= numPages);
}

export const DEFAULT_PDF_BRUSH: PdfBrush = {
  size: 8,
  opacity: 1,
  /** Fixed PDF default ink — does NOT follow the app theme. */
  color: PDF_ANNOTATION_BLUE,
  smoothing: 0.05,
  inkSpeed: 0.5,
  pressureOpacity: false,
  edgeFeather: true,
  featherSize: 0.4,
  quickSizes: [8, 20, 40],
  eraserSize: 20,
  eraserQuickSizes: [12, 20, 60],
};

/** The quick-size swatches are a tool preference, remembered across launches
 *  and across documents (per surface — the PDF toolbar keeps its own, separate
 *  from the infinite canvas). */
const QUICK_SIZES_KEY = 'stickynotes-pdf-quick-sizes';

/** The brush a document starts with: the fixed PDF defaults, plus the user's
 *  remembered quick sizes. Also used when a document closes — a tool
 *  preference must not be reset by closing a file. */
function defaultPdfBrush(): PdfBrush {
  return { ...DEFAULT_PDF_BRUSH, ...loadQuickSizes(QUICK_SIZES_KEY, DEFAULT_PDF_BRUSH) };
}

/** Defaults for a newly inserted PDF text card. bg is fixed light (a PDF page is
 *  always light) so blue text stays readable even in a dark app theme. */
export const PDF_TEXT_DEFAULTS = {
  fontSize: 16,
  minWidth: 100,
  minHeight: 40,
  color: PDF_ANNOTATION_BLUE,
  backgroundColor: 'rgba(255,255,255,0.9)',
};

function makePdfId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

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
  /** Coarse phase label for the open/loading overlay ("解析" | "渲染页面 N"). */
  loadingPhase: string | null;
  /** Human-readable import error, shown on the import screen. */
  error: string | null;

  // Vector source of truth, per page: strokes + inserted objects
  items: Record<number, PdfItem[]>;

  /** True when there are unsaved annotation changes (since last save/load). */
  dirty: boolean;

  // Reference-sharing undo stacks, per page
  history: Record<number, PdfItem[][]>;
  redoStack: Record<number, PdfItem[][]>;

  // Bumped on structural changes → canvas rebuilds inkLayer
  renderEpoch: number;

  // Tool / brush
  activeTool: PdfTool;
  /** Sub-type of the pen tool (marker / fountain / pencil / laser). */
  brushType: PdfBrushType;
  brush: PdfBrush;
  eraserMode: PdfEraserMode;
  selectionMode: PdfSelectionMode;
  selectedIds: string[];
  /** Dot-grid overlay behind the annotations (independent of the canvas, default off). */
  showDotGrid: boolean;

  // Insert tool
  insertMode: PdfInsertMode;
  /** Id of the text card currently open in its editor (null = none). */
  editingTextId: string | null;
  /** Tool to restore when the open text editor commits / cancels (null = keep).
   *  'pen' when placing a NEW node via insert; the active tool when re-opening an
   *  existing card. Returned brush subtype is preserved (fountain stays fountain). */
  textCommitReturnTool: PdfTool | null;
  /** One-shot raster dropped from an external screenshot, centered on viewport. */
  pendingImageInsert: { dataUrl: string; width: number; height: number } | null;

  // Camera (per current page)
  camera: PdfCamera;

  // Thumbnail sidebar
  sidebarOpen: boolean;
  /** Rail scroll position, preserved across collapse/expand (and saved). */
  railScrollTop: number;
  /** Anchored pages for the back-jump buttons; their bg renders stay cached. */
  anchorPages: number[];
  /** One-shot: scroll the thumbnail rail to this page (set by the anchor buttons). */
  sidebarScrollTarget: number | null;

  // Actions
  /** Load a PDF from raw bytes (from the library / file picker). */
  loadPdfFromBuffer: (buffer: ArrayBuffer, name: string, resume?: PdfResume) => Promise<void>;
  openPreparedPdf: (file: OpenedPdf, name: string, resume?: PdfResume, annotations?: AnnotationFile) => void;
  binding?: AnnotationFile['binding'];
  unplacedPages?: AnnotationFile['unplaced'];
  /** Abort a stuck import / resume: destroys the pdf.js load, resets to home. */
  abortPdfLoad: () => void;
  closePdf: () => void;
  setPageSize: (page: number, size: PdfPageSize) => void;
  setCurrentPage: (page: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  setCamera: (partial: Partial<PdfCamera>) => void;
  resetCamera: (cam: PdfCamera) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setRailScrollTop: (top: number) => void;
  /** Add the current page to the anchors (no-op if already present or at cap). */
  addAnchorPage: (page: number) => void;
  removeAnchorPage: (page: number) => void;
  setSidebarScrollTarget: (page: number | null) => void;

  setActiveTool: (t: PdfTool) => void;
  setBrushType: (t: PdfBrushType) => void;
  setBrush: (partial: Partial<PdfBrush>) => void;
  setEraserMode: (m: PdfEraserMode) => void;
  setSelectionMode: (m: PdfSelectionMode) => void;
  setSelectedIds: (ids: string[]) => void;
  clearSelection: () => void;
  toggleSelected: (id: string) => void;
  setShowDotGrid: (show: boolean) => void;

  // Insert-object actions (page-scoped; text/image are DOM-only, no epoch bump)
  setInsertMode: (m: PdfInsertMode) => void;
  setEditingTextId: (id: string | null) => void;
  setTextCommitReturnTool: (t: PdfTool | null) => void;
  /** Place an empty text card at (x,y); opens it in its editor immediately. */
  addTextNode: (page: number, x: number, y: number) => string;
  addAssetObject: (page: number, data: import('../FileLibrary/fileTypes').AssetPlacement) => void;
  resizeAssetObject: (page: number, id: string, width: number, height: number) => void;
  /** Merge content/geometry into a text card. Caller pushes history first. */
  updateTextNode: (page: number, id: string, data: Partial<PdfTextObject>) => void;
  moveTextNode: (page: number, id: string, x: number, y: number) => void;
  deleteTextNode: (page: number, id: string) => void;
  /** Stage a raster (external screenshot) to be dropped at the viewport center. */
  queueImageInsert: (dataUrl: string, width: number, height: number) => void;
  /** Append an image object. `recordHistory` false when batching after one push. */
  addImageObject: (
    page: number,
    data: { dataUrl: string; x: number; y: number; width: number; height: number },
    recordHistory?: boolean,
  ) => void;
  updateImageObject: (
    page: number,
    id: string,
    patch: Partial<Pick<PdfImageObject, 'x' | 'y' | 'width' | 'height'>>,
  ) => void;
  /** Remove any item (stroke or object) by id. Bumps epoch (may be a stroke). */
  deleteObject: (page: number, id: string) => void;
  /** Live group-drag of text/image objects (no history, no epoch). */
  moveObjectsLive: (page: number, ids: string[], dx: number, dy: number) => void;

  /** Batch-replace stroke points (drag-move drop). Structural → rebuilds inkLayer. */
  commitStrokesPoints: (page: number, entries: { id: string; points: PdfPoint[] }[]) => void;
  commitSelectionMove: (page: number, ids: string[], dx: number, dy: number) => void;

  /** Additive: appends a stroke + records history. Canvas already rasterized it. */
  commitStroke: (page: number, stroke: PdfStroke) => void;
  replaceStroke: (page: number, stroke: PdfStroke, recordHistory?: boolean) => void;
  removeStroke: (page: number, id: string) => void;
  /** Whole-stroke eraser: one history snapshot per wipe gesture (page-scoped). */
  beginStrokeErase: (page: number) => void;
  /** Remove whole ink strokes WITHOUT a history entry and WITHOUT bumping
   *  renderEpoch — during a drag wipe PdfCanvas clears just the erased strokes'
   *  pixels out of its ink tiles locally, so no page-wide rebuild happens per
   *  stroke. The full rebuild runs once when the gesture is undone. */
  eraseStrokesLive: (page: number, ids: string[]) => void;
  /** Records a history entry without changing anything (used at drag start). */
  pushHistory: (page: number) => void;
  /** Moves strokes WITHOUT recording history (used during a live drag). */
  moveStrokesLive: (page: number, ids: string[], dx: number, dy: number) => void;
  undo: () => void;
  redo: () => void;
  deleteSelected: () => void;
  moveStrokes: (page: number, ids: string[], dx: number, dy: number) => void;
  clearPage: () => void;

  /** Save all annotations to disk (manual, Ctrl+S). */
  saveAnnotations: () => Promise<{ ok: boolean }>;
  /** Load saved annotations for an item. */
  loadAnnotations: (itemId: string) => Promise<void>;

  reset: () => void;
}

// ---- Helpers -----------------------------------------------------------------

function pushHistoryEntry(
  history: Record<number, PdfItem[][]>,
  page: number,
  cur: PdfItem[],
): Record<number, PdfItem[][]> {
  const pageHist = history[page] ?? [];
  pageHist.push(cur);
  if (pageHist.length > MAX_HISTORY) pageHist.shift();
  return { ...history, [page]: pageHist };
}

function emptyHistoryRecord(): Record<number, PdfItem[][]> {
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
  loadingPhase: null,
  error: null,

  items: {},
  dirty: false,
  history: {},
  redoStack: {},

  renderEpoch: 0,

  activeTool: 'pen',
  brushType: 'marker',
  brush: defaultPdfBrush(),
  eraserMode: 'free',
  selectionMode: 'box',
  selectedIds: [],
  showDotGrid: false,

  insertMode: 'text',
  editingTextId: null,
  textCommitReturnTool: null,
  pendingImageInsert: null,

  camera: { x: 0, y: 0, zoom: 1 },

  sidebarOpen: true,
  railScrollTop: 0,
  anchorPages: [],
  sidebarScrollTarget: null,

  // --- document ------------------------------------------------------------

  loadPdfFromBuffer: async (buffer: ArrayBuffer, name: string, resume) => {
    window.dispatchEvent(new Event('ink:flush-gesture'));
    const startEpoch = ++pdfLoadEpoch;
    try {
      set({ loading: true, loadingPhase: '解析', error: null });
      const { doc, firstPage } = await loadPdfDocument(buffer);
      // User hit "中断" while pdf.js was still parsing → discard this result.
      if (pdfLoadEpoch !== startEpoch) {
        try { (doc as any)?.destroy?.(); } catch { /* ignore */ }
        return;
      }
      get().openPreparedPdf({ doc, firstPage, dispose: () => {
        void Promise.resolve(doc.destroy?.()).catch(() => {});
      } }, name, resume);
    } catch (e) {
      if (pdfLoadEpoch !== startEpoch) {
        // Aborted — unwind quietly, do NOT surface a scary "failed" banner.
        set({ loading: false, loadingPhase: null });
        return;
      }
      console.error('PDF import failed:', e);
      // A load that died mid-parse can wedge the pdf.js worker/port. Drop it so
      // the NEXT open starts from a fresh worker — but never while another
      // document is still open and rendering on that same worker.
      if (!get().pdfDoc) resetPdfWorker();
      set({ loading: false, loadingPhase: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  openPreparedPdf: (file, name, resume, annotations) => {
    releaseDocument();
    disposeCurrentPdf = file.dispose;
    const numPages = file.doc.numPages;
    set({
      fileName: name, pdfDoc: file.doc, numPages,
      currentPage: Math.min(numPages, Math.max(1, resume?.lastPage ?? 1)),
      pageSizes: { 1: file.firstPage },
      currentItemId: resume?.itemId ?? null,
      pendingResumeCamera: resume?.camera ?? null,
      items: annotations?.items ?? {},
      binding: annotations?.binding,
      unplacedPages: annotations?.unplaced,
      dirty: false, history: emptyHistoryRecord(), redoStack: emptyHistoryRecord(),
      renderEpoch: 0, selectedIds: [], editingTextId: null, textCommitReturnTool: null,
      showDotGrid: resume?.showDotGrid ?? false,
      sidebarOpen: true, railScrollTop: 0,
      camera: resume?.camera ?? { x: 0, y: 0, zoom: 1 },
      anchorPages: clampAnchorPages(resume?.anchorPages, numPages),
      sidebarScrollTarget: null, loading: false, loadingPhase: null, error: null,
    });
  },

  abortPdfLoad: () => {
    // Invalidate any in-flight load AND destroy the live pdf.js task so a stuck
    // parse/render stops burning CPU.
    pdfLoadEpoch++;
    abortActivePdfLoad();
    get().reset();
  },

  closePdf: () => {
    releaseDocument();
    set({
      fileName: null,
      pdfDoc: null,
      numPages: 0,
      currentPage: 1,
      pageSizes: {},
      currentItemId: null,
      pendingResumeCamera: null,
      items: {},
      binding: undefined,
      unplacedPages: undefined,
      dirty: false,
      history: emptyHistoryRecord(),
      redoStack: emptyHistoryRecord(),
      renderEpoch: 0,
      selectedIds: [],
      editingTextId: null,
      camera: { x: 0, y: 0, zoom: 1 },
      anchorPages: [],
      sidebarScrollTarget: null,
      loading: false,
      loadingPhase: null,
      railScrollTop: 0,
      error: null,
    });
  },

  setPageSize: (page, size) =>
    set((s) => ({ pageSizes: { ...s.pageSizes, [page]: size } })),

  setCurrentPage: (page) => {
    const clamped = Math.max(1, Math.min(get().numPages, page));
    if (clamped !== get().currentPage) window.dispatchEvent(new Event('ink:flush-gesture'));
    // NOTE: the camera is intentionally left untouched here — PdfCanvas resets
    // it (fit/resume) once the new page's background is ready. Zeroing it now
    // would let a mid-render frame paint old bg + a default camera → visible flash.
    set((s) => ({ currentPage: clamped, selectedIds: [], editingTextId: null }));
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

  setRailScrollTop: (top) => set({ railScrollTop: top }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  addAnchorPage: (page) => {
    const cur = get().anchorPages;
    if (cur.includes(page) || cur.length >= MAX_ANCHOR_PAGES) return;
    set({ anchorPages: [...cur, page] });
  },

  removeAnchorPage: (page) =>
    set((s) => ({ anchorPages: s.anchorPages.filter((p) => p !== page) })),

  setSidebarScrollTarget: (page) => set({ sidebarScrollTarget: page }),

  // --- tool / brush --------------------------------------------------------

  setActiveTool: (t) => set({ activeTool: t }),

  setBrushType: (t) => set({ brushType: t }),

  setBrush: (partial) => {
    set((s) => ({ brush: { ...s.brush, ...partial } }));
    // Only the quick-size swatches are a cross-session preference (see
    // inkToolPrefs) — the rest of the brush is per-session, and the PDF ink
    // colour is deliberately fixed.
    if (partial.quickSizes || partial.eraserQuickSizes) {
      const { quickSizes, eraserQuickSizes } = get().brush;
      saveQuickSizes(QUICK_SIZES_KEY, { quickSizes, eraserQuickSizes });
    }
  },

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

  // --- insert objects ------------------------------------------------------

  setInsertMode: (m) => set({ insertMode: m }),

  setEditingTextId: (id) => set({ editingTextId: id }),

  setTextCommitReturnTool: (t) => set({ textCommitReturnTool: t }),

  addTextNode: (page, x, y) => {
    const id = makePdfId('text');
    const node: PdfTextObject = {
      id,
      type: 'text',
      x,
      y,
      width: PDF_TEXT_DEFAULTS.minWidth,
      height: PDF_TEXT_DEFAULTS.minHeight,
      content: '',
      fontSize: PDF_TEXT_DEFAULTS.fontSize,
      color: PDF_TEXT_DEFAULTS.color,
      backgroundColor: PDF_TEXT_DEFAULTS.backgroundColor,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const cur = get().items[page] ?? [];
    set((s) => ({
      items: { ...s.items, [page]: [...cur, node] },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      editingTextId: id,
      textCommitReturnTool: 'pen',
      dirty: true,
    }));
    return id;
  },

  updateTextNode: (page, id, data) => {
    set((s) => ({
      items: {
        ...s.items,
        [page]: (s.items[page] ?? []).map((o) =>
          o.type === 'text' && o.id === id
            ? { ...o, ...data, updatedAt: Date.now() } as PdfTextObject
            : o,
        ),
      },
      dirty: true,
    }));
  },

  moveTextNode: (page, id, x, y) => get().updateTextNode(page, id, { x, y }),

  deleteTextNode: (page, id) => {
    const cur = get().items[page] ?? [];
    set((s) => ({
      items: { ...s.items, [page]: cur.filter((o) => !(o.type === 'text' && o.id === id)) },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      editingTextId: s.editingTextId === id ? null : s.editingTextId,
      dirty: true,
    }));
  },

  queueImageInsert: (dataUrl, width, height) =>
    set({ pendingImageInsert: { dataUrl, width, height } }),

  addImageObject: (page, data, recordHistory = true) => {
    const obj: PdfImageObject = {
      id: makePdfId('img'),
      type: 'image',
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
      dataUrl: data.dataUrl,
      createdAt: Date.now(),
    };
    if (recordHistory) get().pushHistory(page);
    set((s) => ({
      items: { ...s.items, [page]: [...(s.items[page] ?? []), obj] },
      pendingImageInsert: null,
      dirty: true,
    }));
  },

  addAssetObject: (page, data) => {
    const id = makePdfId('asset');
    get().pushHistory(page);
    set(state => ({
      items: { ...state.items, [page]: [...(state.items[page] ?? []), { ...data, id, type: 'asset', createdAt: Date.now() }] },
      dirty: true,
      ...(page === state.currentPage ? { activeTool: 'select', selectedIds: [id] } : {}),
    }));
  },

  resizeAssetObject: (page, id, width, height) => set(state => ({
    items: { ...state.items, [page]: (state.items[page] ?? []).map(object =>
      object.type === 'asset' && object.id === id ? { ...object, width, height } : object) },
    dirty: true,
  })),

  updateImageObject: (page, id, patch) => {
    set((s) => ({
      items: {
        ...s.items,
        [page]: (s.items[page] ?? []).map((o) =>
          o.type === 'image' && o.id === id ? { ...o, ...patch } as PdfImageObject : o,
        ),
      },
      dirty: true,
    }));
  },

  deleteObject: (page, id) => {
    const cur = get().items[page] ?? [];
    const next = cur.filter((o) => o.id !== id);
    if (next.length === cur.length) return;
    set((s) => ({
      items: { ...s.items, [page]: next },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: s.selectedIds.filter((x) => x !== id),
      editingTextId: s.editingTextId === id ? null : s.editingTextId,
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  moveObjectsLive: (page, ids, dx, dy) => {
    if (dx === 0 && dy === 0) return;
    const setIds = new Set(ids);
    if (setIds.size === 0) return;
    set((s) => ({
      items: {
        ...s.items,
        [page]: (s.items[page] ?? []).map((o) => {
          if (!setIds.has(o.id)) return o;
          if (o.type === 'text') return { ...o, x: o.x + dx, y: o.y + dy, updatedAt: Date.now() } as PdfTextObject;
          if (o.type === 'image' || o.type === 'asset') return { ...o, x: o.x + dx, y: o.y + dy };
          return o;
        }),
      },
      dirty: true,
    }));
  },

  commitStrokesPoints: (page, entries) => {
    if (entries.length === 0) return;
    const map = new Map(entries.map((e) => [e.id, e.points]));
    const cur = get().items[page] ?? [];
    const next = cur.map((o) => (o.type === 'stroke' && map.has(o.id) ? replaceStrokePoints(o, map.get(o.id)!) : o));
    // No renderEpoch bump: PdfCanvas already cleared the moved strokes' pixels at
    // drag start and stamps only those strokes back — a page-wide rebuild here
    // would make dropping a selection on a dense page take seconds.
    set((s) => ({
      items: { ...s.items, [page]: next },
      redoStack: { ...s.redoStack, [page]: [] },
      dirty: true,
    }));
  },

  commitSelectionMove: (page, ids, dx, dy) => {
    if ((!dx && !dy) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const selected = new Set(ids), cur = get().items[page] ?? [];
    if (!cur.some(o => selected.has(o.id))) return;
    set(s => ({ items: { ...s.items, [page]: cur.map(o => selected.has(o.id) ? moveSelectedItem(o, dx, dy) : o) },
      history: pushHistoryEntry(s.history, page, cur), redoStack: { ...s.redoStack, [page]: [] }, dirty: true }));
  },

  // --- editing -------------------------------------------------------------

  replaceStroke: (page, stroke, recordHistory = true) => {
    const cur = get().items[page] ?? [];
    if (!cur.some(o => o.type === 'stroke' && o.id === stroke.id)) return;
    set(s => ({ items: { ...s.items, [page]: cur.map(o => o.type === 'stroke' && o.id === stroke.id ? { ...stroke } : o) },
      history: recordHistory ? pushHistoryEntry(s.history, page, cur) : s.history,
      redoStack: recordHistory ? { ...s.redoStack, [page]: [] } : s.redoStack,
      renderEpoch: s.renderEpoch + 1, dirty: true }));
  },

  commitStroke: (page, stroke) => {
    const cur = get().items[page] ?? [];
    set((s) => ({
      items: { ...s.items, [page]: [...cur, stroke] },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      dirty: true,
    }));
  },

  removeStroke: (page, id) => {
    const cur = get().items[page] ?? [];
    const next = cur.filter((o) => !(o.type === 'stroke' && o.id === id));
    if (next.length === cur.length) return;
    set((s) => ({
      items: { ...s.items, [page]: next },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: s.selectedIds.filter((x) => x !== id),
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  beginStrokeErase: (page) => get().pushHistory(page),

  eraseStrokesLive: (page, ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const cur = get().items[page] ?? [];
    const next = cur.filter((o) => !(o.type === 'stroke' && idSet.has(o.id)));
    if (next.length === cur.length) return;
    // No renderEpoch bump: PdfCanvas clears the erased strokes from its ink
    // tiles locally so a wipe never triggers a page-wide rebuild per stroke.
    set((s) => ({
      items: { ...s.items, [page]: next },
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: s.selectedIds.filter((x) => !idSet.has(x)),
      dirty: true,
    }));
  },

  pushHistory: (page) =>
    set((s) => ({
      history: pushHistoryEntry(s.history, page, s.items[page] ?? []),
      redoStack: { ...s.redoStack, [page]: [] },
    })),

  moveStrokesLive: (page, ids, dx, dy) => {
    if (dx === 0 && dy === 0) return;
    const setIds = new Set(ids);
    if (setIds.size === 0) return;
    const cur = get().items[page] ?? [];
    const next = cur.map((o) =>
      o.type === 'stroke' && setIds.has(o.id)
        ? replaceStrokePoints(o, o.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })))
        : o,
    );
    set((s) => ({
      items: { ...s.items, [page]: next },
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  undo: () => {
    const page = get().currentPage;
    const hist = get().history[page] ?? [];
    if (hist.length === 0) return;
    const cur = get().items[page] ?? [];
    const prev = hist[hist.length - 1];
    set((s) => ({
      history: { ...s.history, [page]: hist.slice(0, -1) },
      redoStack: { ...s.redoStack, [page]: [...(s.redoStack[page] ?? []), cur] },
      items: { ...s.items, [page]: prev },
      selectedIds: [],
      editingTextId: null,
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  redo: () => {
    const page = get().currentPage;
    const rs = get().redoStack[page] ?? [];
    if (rs.length === 0) return;
    const cur = get().items[page] ?? [];
    const next = rs[rs.length - 1];
    set((s) => ({
      redoStack: { ...s.redoStack, [page]: rs.slice(0, -1) },
      history: pushHistoryEntry(s.history, page, cur),
      items: { ...s.items, [page]: next },
      selectedIds: [],
      editingTextId: null,
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  deleteSelected: () => {
    const page = get().currentPage;
    const ids = new Set(get().selectedIds);
    if (ids.size === 0) return;
    const cur = get().items[page] ?? [];
    const next = cur.filter((o) => !ids.has(o.id));
    if (next.length === cur.length) return;
    set((s) => ({
      items: { ...s.items, [page]: next },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: [],
      editingTextId: null,
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  moveStrokes: (page, ids, dx, dy) => {
    if (dx === 0 && dy === 0) return;
    const setIds = new Set(ids);
    if (setIds.size === 0) return;
    const cur = get().items[page] ?? [];
    const next = cur.map((o) =>
      o.type === 'stroke' && setIds.has(o.id)
        ? replaceStrokePoints(o, o.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })))
        : o,
    );
    set((s) => ({
      items: { ...s.items, [page]: next },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  clearPage: () => {
    const page = get().currentPage;
    const cur = get().items[page] ?? [];
    if (cur.length === 0) return;
    set((s) => ({
      items: { ...s.items, [page]: [] },
      history: pushHistoryEntry(s.history, page, cur),
      redoStack: { ...s.redoStack, [page]: [] },
      selectedIds: [],
      editingTextId: null,
      renderEpoch: get().renderEpoch + 1,
      dirty: true,
    }));
  },

  saveAnnotations: async () => {
    window.dispatchEvent(new Event('ink:flush-gesture'));
    const pending = pendingAnnotationBinding();
    if (pending) await pending.catch(() => {});
    const { currentItemId, items, binding, unplacedPages } = get();
    if (!currentItemId) return { ok: !get().dirty };
    try {
      await saveAnnotationFile(currentItemId, { items, binding, unplaced: unplacedPages });
      if (get().currentItemId === currentItemId && get().items === items) set({ dirty: false });
      return { ok: true };
    } catch (e) {
      console.error('Save annotations failed:', e);
      return { ok: false };
    }
  },

  loadAnnotations: async (itemId) => {
    try {
      const data = await loadAnnotationFile(itemId);
      set({ items: data.items, binding: data.binding, unplacedPages: data.unplaced, dirty: false, renderEpoch: get().renderEpoch + 1 });
    } catch (e) {
      console.error('Load annotations failed:', e);
    }
  },

  reset: () => {
    releaseDocument();
    set({
      fileName: null,
      pdfDoc: null,
      numPages: 0,
      currentPage: 1,
      pageSizes: {},
      currentItemId: null,
      pendingResumeCamera: null,
      items: {},
      binding: undefined,
      unplacedPages: undefined,
      dirty: false,
      history: {},
      redoStack: {},
      renderEpoch: 0,
      activeTool: 'pen',
      brushType: 'marker',
      brush: defaultPdfBrush(),
      eraserMode: 'free',
      selectionMode: 'box',
      selectedIds: [],
      showDotGrid: false,
      insertMode: 'text',
      editingTextId: null,
      textCommitReturnTool: null,
      pendingImageInsert: null,
      camera: { x: 0, y: 0, zoom: 1 },
      sidebarOpen: true,
      railScrollTop: 0,
      anchorPages: [],
      sidebarScrollTarget: null,
      loading: false,
      loadingPhase: null,
      error: null,
    });
  },
}));
