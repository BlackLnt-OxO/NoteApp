import { create } from 'zustand';
import type {
  Camera,
  BrushSettings,
  Stroke,
  TextNodeData,
  CanvasObject,
  ToolType,
} from './types';
import {
  DEFAULT_CAMERA,
  DEFAULT_BRUSH,
  DEFAULT_DOT_DENSITY,
  STORAGE_KEY,
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
  dotDensity: number;
  editingTextId: string | null;
  history: CanvasObject[][];
  redoStack: CanvasObject[][];
  loaded: boolean;

  // Actions
  addStroke: (stroke: Stroke) => void;
  addTextNode: (x: number, y: number) => string;
  updateTextNode: (id: string, data: Partial<TextNodeData>) => void;
  deleteTextNode: (id: string) => void;
  moveTextNode: (id: string, x: number, y: number) => void;
  setCamera: (partial: Partial<Camera>) => void;
  setActiveTool: (tool: ToolType) => void;
  setBrushSettings: (partial: Partial<BrushSettings>) => void;
  setDotDensity: (density: number) => void;
  setEditingTextId: (id: string | null) => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  clearCanvas: () => void;
  deleteObject: (id: string) => void;
  saveCanvasData: () => Promise<void>;
  loadCanvasData: () => Promise<void>;
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
  dotDensity: DEFAULT_DOT_DENSITY,
  editingTextId: null,
  history: [],
  redoStack: [],
  loaded: false,

  // --- History ---

  pushHistory: () => {
    const { objects, history } = get();
    const snapshot = structuredClone(objects);
    history.push(snapshot);
    if (history.length > MAX_HISTORY) history.shift();
    set({ history, redoStack: [] });
  },

  undo: () => {
    const { history, objects, redoStack } = get();
    if (history.length === 0) return;
    redoStack.push(objects);
    const previous = history.pop()!;
    set({ objects: previous, history, redoStack });
  },

  redo: () => {
    const { redoStack, objects, history } = get();
    if (redoStack.length === 0) return;
    history.push(objects);
    const next = redoStack.pop()!;
    set({ objects: next, history, redoStack });
  },

  // --- Objects ---

  addStroke: (stroke) => {
    get().pushHistory();
    set((s) => ({ objects: [...s.objects, stroke] }));
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
    }));
  },

  clearCanvas: () => {
    get().pushHistory();
    set({ objects: [] });
  },

  // --- Simple setters ---

  setCamera: (partial) =>
    set((s) => ({ camera: { ...s.camera, ...partial } })),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setBrushSettings: (partial) =>
    set((s) => ({ brushSettings: { ...s.brushSettings, ...partial } })),

  setDotDensity: (density) => set({ dotDensity: density }),

  setEditingTextId: (id) => set({ editingTextId: id }),

  // --- Persistence ---

  saveCanvasData: async () => {
    try {
      const { objects, camera, dotDensity } = get();
      const data = { objects, camera, dotDensity };
      if (window.electronAPI?.saveCanvasData) {
        await window.electronAPI.saveCanvasData(data);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      }
    } catch (e) {
      console.error('Failed to save canvas data:', e);
    }
  },

  loadCanvasData: async () => {
    try {
      let data = null;
      if (window.electronAPI?.loadCanvasData) {
        data = await window.electronAPI.loadCanvasData();
      } else {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) data = JSON.parse(raw);
      }
      if (data) {
        set({
          loaded: true,
          objects: data.objects || [],
          camera: { ...DEFAULT_CAMERA, ...data.camera },
          dotDensity: data.dotDensity ?? DEFAULT_DOT_DENSITY,
        });
      } else {
        set({ loaded: true });
      }
    } catch (e) {
      console.error('Failed to load canvas data:', e);
      set({ loaded: true });
    }
  },
}));

// ---- Auto-save ---------------------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
useCanvasStore.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const state = useCanvasStore.getState();
    if (state.loaded) {
      state.saveCanvasData();
    }
  }, 1000);
});
