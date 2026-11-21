import { create } from 'zustand';
import { canvasRepository } from './CanvasRepository';
import { isInkInputBusy } from '../inkInputActivity';
import { reportInkFrame } from '../InkFrameStats';
import { loadQuickSizes, saveQuickSizes } from '../inkToolPrefs';
import { replaceStrokePoints } from '../InkShapeGeometry';
import { moveSelectedItem } from '../InkSelection';
import type {
  Camera,
  BrushSettings,
  Stroke,
  StrokePoint,
  TextNodeData,
  ImageObject,
  CanvasObject,
  ToolType,
  SelectionMode,
  InsertMode,
  BrushType,
} from './types';
import {
  DEFAULT_CAMERA,
  DEFAULT_BRUSH,
  TEXT_DEFAULTS,
  MAX_HISTORY,
} from './constants';

// ---- Store interface ---------------------------------------------------------

export interface CanvasStore {
  // State
  objects: CanvasObject[];
  camera: Camera;
  activeTool: ToolType;
  /** Sub-type of the pen tool (marker / fountain / pencil / laser). */
  brush: BrushType;
  brushSettings: BrushSettings;
  showDotGrid: boolean;
  editingTextId: string | null;
  /** Tool to restore when the open text editor commits / cancels (null = keep).
   *  Set to 'pen' when placing a NEW text node (insert), or to the active tool
   *  when re-opening an existing card so the user isn't yanked out of it. */
  textCommitReturnTool: ToolType | null;
  selectedIds: string[];
  selectionMode: SelectionMode;
  eraserMode: 'free' | 'stroke';
  insertMode: InsertMode;
  history: CanvasObject[][];
  redoStack: CanvasObject[][];
  loaded: boolean;
  /** Canvas whose data is loaded into this store (null = home screen). */
  currentCanvasId: string | null;
  /** Bumped only by structural ops → canvas rebuilds its ink tiles from source. */
  renderEpoch: number;
  /** One-shot: a screenshot is waiting to be dropped at the viewport center. */
  pendingImageInsert: { dataUrl: string; width: number; height: number } | null;

  // Actions
  addStroke: (stroke: Stroke) => void;
  replaceStroke: (stroke: Stroke, recordHistory?: boolean) => void;
  updateStrokePoints: (id: string, points: StrokePoint[]) => void;
  addTextNode: (x: number, y: number) => string;
  updateTextNode: (id: string, data: Partial<TextNodeData>) => void;
  deleteTextNode: (id: string) => void;
  moveTextNode: (id: string, x: number, y: number) => void;
  /** Queue a screenshot (compressed) to insert at the viewport center. */
  queueImageInsert: (dataUrl: string, width: number, height: number) => void;
  /** Add a baked image object at the given world position (w/h = world units).
   *  `recordHistory=false` batches the insert into one surrounding history push
   *  (used by multi-image import so a single import = a single undo). */
  addImageObject: (data: { dataUrl: string; x: number; y: number; width: number; height: number }, recordHistory?: boolean) => void;
  addAssetObject: (data: import('../FileLibrary/fileTypes').AssetPlacement) => void;
  resizeAssetObject: (id: string, width: number, height: number) => void;
  updateImageObject: (id: string, patch: Partial<Pick<ImageObject, 'x' | 'y' | 'width' | 'height'>>) => void;
  setCamera: (partial: Partial<Camera>) => void;
  setActiveTool: (tool: ToolType) => void;
  setBrush: (brush: BrushType) => void;
  setBrushSettings: (partial: Partial<BrushSettings>) => void;
  setShowDotGrid: (show: boolean) => void;
  setEditingTextId: (id: string | null) => void;
  setTextCommitReturnTool: (t: ToolType | null) => void;
  setSelectedIds: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  setSelectionMode: (mode: SelectionMode) => void;
  clearSelection: () => void;
  setEraserMode: (mode: 'free' | 'stroke') => void;
  setInsertMode: (mode: InsertMode) => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  clearCanvas: () => void;
  deleteObject: (id: string) => void;
  deleteObjects: (ids: string[]) => void;
  /** Whole-stroke eraser: snapshot history ONCE per wipe gesture (undo restores
   *  every stroke removed by one drag in a single step). */
  beginEraseGesture: () => void;
  /** Remove whole ink strokes WITHOUT recording history and WITHOUT bumping
   *  renderEpoch — during a drag wipe the canvas clears just the erased strokes'
   *  pixels out of its ink tiles locally (no page-wide rebuild per stroke). The
   *  full rebuild happens once when the gesture is undone. */
  eraseStrokesLive: (ids: string[]) => void;
  /** Batch-replace stroke points (drag-move drop). NOT structural: the canvas
   *  already erased the moved strokes out of its tiles at drag start and stamps
   *  only those strokes back here — a page-wide rebuild would make dropping a
   *  selection on a dense canvas take seconds. */
  commitStrokesPoints: (entries: { id: string; points: StrokePoint[] }[]) => void;
  commitSelectionMove: (ids: string[], dx: number, dy: number) => void;
  saveStatus: 'saved' | 'pending' | 'saving' | 'error';
  saveError: string | null;
  storageWarning: string | null;
  saveCanvasData: () => Promise<boolean>;
  loadCanvasData: (canvasId?: string) => Promise<void>;
  /** Persist the current canvas, then swap in the target canvas's data. */
  switchCanvas: (canvasId: string) => Promise<void>;
}

// ---- Helpers -----------------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/** The quick-size swatches are a tool preference, remembered across launches
 *  (per surface — the canvas keeps its own, independent of the PDF toolbar). */
const QUICK_SIZES_KEY = 'stickynotes-inkcanvas-quick-sizes';

let loadTicket = 0;

// ---- Store -------------------------------------------------------------------

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  // --- Initial state ---
  objects: [],
  camera: { ...DEFAULT_CAMERA },
  activeTool: 'pen',
  brush: 'marker',
  brushSettings: { ...DEFAULT_BRUSH, ...loadQuickSizes(QUICK_SIZES_KEY, DEFAULT_BRUSH) },
  showDotGrid: true,
  editingTextId: null,
  textCommitReturnTool: null,
  selectedIds: [],
  selectionMode: 'box',
  eraserMode: 'free',
  insertMode: 'text',
  history: [],
  redoStack: [],
  loaded: false,
  saveStatus: 'saved',
  saveError: null,
  storageWarning: null,
  currentCanvasId: null,
  renderEpoch: 0,
  pendingImageInsert: null,

  // --- History ---

  pushHistory: () => {
    const { objects, history } = get();
    // Reference sharing (PDF model): objects are treated as immutable, so an
    // undo snapshot is just the previous array reference — zero memory cost.
    history.push(objects);
    if (history.length > MAX_HISTORY) history.shift();
    set({ history, redoStack: [] });
  },

  undo: () => {
    const { history, objects, redoStack } = get();
    if (history.length === 0) return;
    redoStack.push(objects);
    const previous = history.pop()!;
    set({ objects: previous, history, redoStack, renderEpoch: get().renderEpoch + 1 });
  },

  redo: () => {
    const { redoStack, objects, history } = get();
    if (redoStack.length === 0) return;
    history.push(objects);
    const next = redoStack.pop()!;
    set({ objects: next, history, redoStack, renderEpoch: get().renderEpoch + 1 });
  },

  // --- Objects ---

  // Additive (PDF model): the canvas already rasterized the stroke into tiles,
  // so this must NOT bump renderEpoch.
  addStroke: (stroke) => {
    get().pushHistory();
    set((s) => ({ objects: [...s.objects, stroke], redoStack: [] }));
  },

  replaceStroke: (stroke, recordHistory = true) => {
    if (!get().objects.some(o => o.type === 'stroke' && o.id === stroke.id)) return;
    if (recordHistory) get().pushHistory();
    set(s => ({ objects: s.objects.map(o => o.type === 'stroke' && o.id === stroke.id ? { ...stroke } : o),
      renderEpoch: s.renderEpoch + 1, redoStack: recordHistory ? [] : s.redoStack }));
  },

  updateStrokePoints: (id, points) => {
    set((s) => ({
      objects: s.objects.map((o) =>
        o.type === 'stroke' && o.id === id ? replaceStrokePoints(o, points) : o,
      ),
    }));
  },

  addTextNode: (x, y) => {
    const id = makeId('text');
    const node: TextNodeData = {
      id,
      type: 'text',
      x,
      y,
      width: TEXT_DEFAULTS.minWidth,
      height: TEXT_DEFAULTS.minHeight,
      content: '',
      fontSize: TEXT_DEFAULTS.fontSize,
      color: TEXT_DEFAULTS.color,
      backgroundColor: TEXT_DEFAULTS.backgroundColor,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    get().pushHistory();
    set((s) => ({ objects: [...s.objects, node], editingTextId: id, textCommitReturnTool: 'pen' }));
    return id;
  },

  queueImageInsert: (dataUrl, width, height) =>
    set({ pendingImageInsert: { dataUrl, width, height } }),

  addImageObject: (data, recordHistory = true) => {
    const id = makeId('img');
    const obj: ImageObject = {
      id,
      type: 'image',
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height,
      dataUrl: data.dataUrl,
      createdAt: Date.now(),
    };
    if (recordHistory) get().pushHistory();
    set((s) => ({ objects: [...s.objects, obj], pendingImageInsert: null }));
  },

  addAssetObject: data => {
    const id = makeId('asset');
    get().pushHistory();
    set(state => ({
      objects: [...state.objects, { ...data, id, type: 'asset', createdAt: Date.now() }],
      activeTool: 'select', selectedIds: [id], redoStack: [],
    }));
  },

  resizeAssetObject: (id, width, height) => set(state => ({
    objects: state.objects.map(object => object.type === 'asset' && object.id === id ? { ...object, width, height } : object),
  })),

  updateImageObject: (id, patch) =>
    set((s) => ({
      objects: s.objects.map((o) =>
        o.type === 'image' && o.id === id ? { ...o, ...patch } : o,
      ),
    })),

  updateTextNode: (id, data) => {
    set((s) => ({
      objects: s.objects.map((o) =>
        o.type === 'text' && o.id === id
          ? ({ ...o, ...data, updatedAt: Date.now() } as TextNodeData)
          : o,
      ),
    }));
  },

  deleteTextNode: (id) => {
    get().pushHistory();
    set((s) => ({
      objects: s.objects.filter((o) => !(o.type === 'text' && o.id === id)),
      editingTextId: s.editingTextId === id ? null : s.editingTextId,
    }));
  },

  moveTextNode: (id, x, y) => {
    set((s) => ({
      objects: s.objects.map((o) =>
        o.type === 'text' && o.id === id
          ? ({ ...o, x, y } as TextNodeData)
          : o,
      ),
    }));
  },

  deleteObject: id => get().deleteObjects([id]),

  deleteObjects: ids => {
    const removed = new Set(ids);
    if (!get().objects.some(object => removed.has(object.id))) return;
    get().pushHistory();
    set(state => ({
      objects: state.objects.filter(object => !removed.has(object.id)),
      selectedIds: state.selectedIds.filter(id => !removed.has(id)),
      editingTextId: state.editingTextId && removed.has(state.editingTextId) ? null : state.editingTextId,
      renderEpoch: state.renderEpoch + 1,
    }));
  },

  clearCanvas: () => {
    get().pushHistory();
    set({ objects: [], renderEpoch: get().renderEpoch + 1 });
  },

  beginEraseGesture: () => {
    // Reference-sharing snapshot; also clears the redo stack (like any edit).
    get().pushHistory();
  },

  eraseStrokesLive: (ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const cur = get().objects;
    const next = cur.filter((o) => !(o.type === 'stroke' && idSet.has(o.id)));
    if (next.length === cur.length) return;
    // No renderEpoch bump: the canvas clears the erased strokes from its ink
    // tiles locally so a wipe never triggers a page-wide rebuild per stroke.
    set((s) => ({
      objects: next,
      redoStack: [],
      selectedIds: s.selectedIds.filter((id) => !idSet.has(id)),
    }));
  },

  commitStrokesPoints: (entries) => {
    if (entries.length === 0) return;
    const map = new Map(entries.map((e) => [e.id, e.points]));
    const next = get().objects.map((o) =>
      o.type === 'stroke' && map.has(o.id) ? replaceStrokePoints(o, map.get(o.id)!) : o,
    );
    // No renderEpoch bump — see the interface comment.
    set(() => ({ objects: next, redoStack: [] }));
  },

  commitSelectionMove: (ids, dx, dy) => {
    if ((!dx && !dy) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const selected = new Set(ids);
    if (!get().objects.some(o => selected.has(o.id))) return;
    get().pushHistory();
    set(s => ({ objects: s.objects.map(o => selected.has(o.id) ? moveSelectedItem(o, dx, dy) : o), redoStack: [] }));
  },

  // --- Simple setters ---

  setCamera: (partial) =>
    set((s) => ({ camera: { ...s.camera, ...partial } })),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setBrush: (brush) => set({ brush }),

  setBrushSettings: (partial) => {
    set((s) => ({ brushSettings: { ...s.brushSettings, ...partial } }));
    // Only the quick-size swatches are a cross-session preference; the rest of
    // the brush is per-session (and the colour follows the theme by default).
    if (partial.quickSizes || partial.eraserQuickSizes) {
      const { quickSizes, eraserQuickSizes } = get().brushSettings;
      saveQuickSizes(QUICK_SIZES_KEY, { quickSizes, eraserQuickSizes });
    }
  },

  setShowDotGrid: (show) => set({ showDotGrid: show }),

  setEditingTextId: (id) => set({ editingTextId: id }),

  setTextCommitReturnTool: (t) => set({ textCommitReturnTool: t }),

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  toggleSelected: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),

  setSelectionMode: (mode) => set({ selectionMode: mode }),

  clearSelection: () => set({ selectedIds: [] }),

  setEraserMode: (mode) => set({ eraserMode: mode }),

  setInsertMode: (mode) => set({ insertMode: mode }),

  // --- Persistence ---

  saveCanvasData: async () => {
    const snapshot = get(), id = snapshot.currentCanvasId;
    if (!id || !snapshot.loaded) return true;
    set({ saveStatus: 'saving', saveError: null });
    const t0 = performance.now();
    try {
      await canvasRepository.save(id, snapshot.objects, snapshot.camera, snapshot.showDotGrid);
      const latest = get();
      if (latest.currentCanvasId === id) set({ saveStatus: latest.objects === snapshot.objects
        && latest.camera === snapshot.camera && latest.showDotGrid === snapshot.showDotGrid ? 'saved' : 'pending' });
      reportInkFrame({ saveBodyMs: performance.now() - t0 });
      return true;
    } catch (error) {
      if (get().currentCanvasId === id) set({ saveStatus: 'error', saveError: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
  loadCanvasData: async (canvasId?: string) => {
    const id = canvasId ?? get().currentCanvasId, ticket = ++loadTicket;
    if (!id) { set({ loaded: true }); return; }
    const data = await canvasRepository.load(id);
    if (ticket !== loadTicket) return;
    set({ loaded: true, currentCanvasId: id, objects: data.objects, camera: data.camera,
      showDotGrid: data.showDotGrid, history: [], redoStack: [], selectedIds: [], editingTextId: null,
      textCommitReturnTool: null, saveStatus: 'saved', saveError: null,
      storageWarning: canvasRepository.migrationErrors.get(id) ?? null, renderEpoch: get().renderEpoch + 1 });
  },
  switchCanvas: async (canvasId: string) => {
    window.dispatchEvent(new Event('ink:flush-gesture'));
    // Edits arriving while a transaction is in flight also cross the save barrier.
    while (get().loaded && get().currentCanvasId) {
      if (!await get().saveCanvasData()) throw new Error(get().saveError ?? '画布保存失败');
      if (get().saveStatus === 'saved') break;
    }
    await get().loadCanvasData(canvasId);
  },
}));

// ---- Auto-save ---------------------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
function autoSaveCanvas(): void {
  if (!canvasRepository.background && isInkInputBusy()) {
    saveTimeout = setTimeout(autoSaveCanvas, 250);
    return;
  }
  const state = useCanvasStore.getState();
  if (state.loaded && state.currentCanvasId) state.saveCanvasData();
}
useCanvasStore.subscribe((state, previous) => {
  // Tool, cursor, selection, and history-only changes do not change saved data.
  if (state.objects === previous.objects && state.camera === previous.camera
      && state.showDotGrid === previous.showDotGrid
      && state.currentCanvasId === previous.currentCanvasId && state.loaded === previous.loaded) return;
  if (state.loaded && state.currentCanvasId && state.saveStatus === 'saved') useCanvasStore.setState({ saveStatus: 'pending' });
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(autoSaveCanvas, 1000);
});
