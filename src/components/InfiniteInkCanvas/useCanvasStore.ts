import { create } from 'zustand';
import { isInkInputBusy } from '../inkInputActivity';
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
  canvasDataKey,
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
  /** Whole-stroke eraser: snapshot history ONCE per wipe gesture (undo restores
   *  every stroke removed by one drag in a single step). */
  beginEraseGesture: () => void;
  /** Remove whole ink strokes WITHOUT recording history and WITHOUT bumping
   *  renderEpoch — during a drag wipe the canvas clears just the erased strokes'
   *  pixels out of its ink tiles locally (no page-wide rebuild per stroke). The
   *  full rebuild happens once when the gesture is undone. */
  eraseStrokesLive: (ids: string[]) => void;
  /** Batch-replace stroke points (drag-move drop). Structural → rebuilds tiles. */
  commitStrokesPoints: (entries: { id: string; points: StrokePoint[] }[]) => void;
  saveCanvasData: () => Promise<void>;
  loadCanvasData: (canvasId?: string) => Promise<void>;
  /** Persist the current canvas, then swap in the target canvas's data. */
  switchCanvas: (canvasId: string) => Promise<void>;
}

// ---- Helpers -----------------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// ---- Store -------------------------------------------------------------------

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  // --- Initial state ---
  objects: [],
  camera: { ...DEFAULT_CAMERA },
  activeTool: 'pen',
  brush: 'marker',
  brushSettings: { ...DEFAULT_BRUSH },
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

  updateStrokePoints: (id, points) => {
    set((s) => ({
      objects: s.objects.map((o) =>
        o.type === 'stroke' && o.id === id ? { ...o, points } : o,
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

  deleteObject: (id) => {
    get().pushHistory();
    set((s) => ({
      objects: s.objects.filter((o) => o.id !== id),
      editingTextId: s.editingTextId === id ? null : s.editingTextId,
      renderEpoch: get().renderEpoch + 1,
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
      o.type === 'stroke' && map.has(o.id) ? { ...o, points: map.get(o.id)! } : o,
    );
    set((s) => ({
      objects: next,
      redoStack: [],
      renderEpoch: get().renderEpoch + 1,
    }));
  },

  // --- Simple setters ---

  setCamera: (partial) =>
    set((s) => ({ camera: { ...s.camera, ...partial } })),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setBrush: (brush) => set({ brush }),

  setBrushSettings: (partial) =>
    set((s) => ({ brushSettings: { ...s.brushSettings, ...partial } })),

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
    try {
      const { objects, camera, showDotGrid, currentCanvasId } = get();
      if (!currentCanvasId) return;
      localStorage.setItem(canvasDataKey(currentCanvasId), JSON.stringify({ objects, camera, showDotGrid }));
    } catch (e) {
      console.error('Failed to save canvas data:', e);
    }
  },

  loadCanvasData: async (canvasId?: string) => {
    try {
      const id = canvasId ?? get().currentCanvasId;
      if (!id) { set({ loaded: true }); return; }
      let data = null;
      const raw = localStorage.getItem(canvasDataKey(id));
      if (raw) data = JSON.parse(raw);
      set({
        loaded: true,
        currentCanvasId: id,
        objects: data?.objects || [],
        camera: { ...DEFAULT_CAMERA, ...data?.camera },
        showDotGrid: data?.showDotGrid ?? true,
        history: [],
        redoStack: [],
        selectedIds: [],
        editingTextId: null,
        textCommitReturnTool: null,
        renderEpoch: get().renderEpoch + 1,
      });
    } catch (e) {
      console.error('Failed to load canvas data:', e);
      set({ loaded: true });
    }
  },

  switchCanvas: async (canvasId: string) => {
    // Flush the current canvas immediately (don't wait for the 1s debounce).
    await get().saveCanvasData();
    await get().loadCanvasData(canvasId);
  },
}));

// ---- Auto-save ---------------------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
function autoSaveCanvas(): void {
  if (isInkInputBusy()) {
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
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(autoSaveCanvas, 1000);
});
