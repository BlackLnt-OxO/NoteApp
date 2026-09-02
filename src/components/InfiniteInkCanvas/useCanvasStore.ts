import { create } from 'zustand';
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
  brushSettings: BrushSettings;
  showDotGrid: boolean;
  editingTextId: string | null;
  selectedIds: string[];
  selectionMode: SelectionMode;
  eraserMode: 'free' | 'stroke';
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
  /** Add a baked image object at the given world position (w/h = world units). */
  addImageObject: (data: { dataUrl: string; x: number; y: number; width: number; height: number }) => void;
  updateImageObject: (id: string, patch: Partial<Pick<ImageObject, 'x' | 'y' | 'width' | 'height'>>) => void;
  setCamera: (partial: Partial<Camera>) => void;
  setActiveTool: (tool: ToolType) => void;
  setBrushSettings: (partial: Partial<BrushSettings>) => void;
  setShowDotGrid: (show: boolean) => void;
  setEditingTextId: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  toggleSelected: (id: string) => void;
  setSelectionMode: (mode: SelectionMode) => void;
  clearSelection: () => void;
  setEraserMode: (mode: 'free' | 'stroke') => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  clearCanvas: () => void;
  deleteObject: (id: string) => void;
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
  brushSettings: { ...DEFAULT_BRUSH },
  showDotGrid: true,
  editingTextId: null,
  selectedIds: [],
  selectionMode: 'box',
  eraserMode: 'free',
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
    set((s) => ({ objects: [...s.objects, node], editingTextId: id }));
    return id;
  },

  queueImageInsert: (dataUrl, width, height) =>
    set({ pendingImageInsert: { dataUrl, width, height } }),

  addImageObject: (data) => {
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
    get().pushHistory();
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

  setBrushSettings: (partial) =>
    set((s) => ({ brushSettings: { ...s.brushSettings, ...partial } })),

  setShowDotGrid: (show) => set({ showDotGrid: show }),

  setEditingTextId: (id) => set({ editingTextId: id }),

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
useCanvasStore.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const state = useCanvasStore.getState();
    if (state.loaded && state.currentCanvasId) {
      state.saveCanvasData();
    }
  }, 1000);
});
