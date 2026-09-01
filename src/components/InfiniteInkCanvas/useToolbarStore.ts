/**
 * useToolbarStore — factory for collapsible, draggable, resizable toolbar
 * stores. The PDF and infinite-canvas toolbars each get their OWN instance so
 * position/expansion memory is per-interface (never per document / file).
 */

import { create } from 'zustand';
import { DEFAULT_TOOLBAR_STATE, TOOLBAR_STORAGE_KEY } from './constants';

// ---- Types ---------------------------------------------------------------

export interface ToolbarStoreState {
  expanded: boolean;
  width: number;
  lastExpandedWidth: number;
  top: number;
  /** Distance from the docked edge (left or right) in px. */
  offset: number;
  /** Which edge the toolbar is docked to. */
  side: 'left' | 'right';
  /** Whether the user is currently dragging the toolbar (for canvas overlay). */
  isDragging: boolean;
  /** Current cursor X during drag (for real-time overlay zone highlight). */
  dragCursorX: number;
}

export interface ToolbarStoreActions {
  toggle: () => void;
  expand: () => void;
  collapse: () => void;
  setWidth: (w: number) => void;
  setPosition: (top: number, offset: number) => void;
  setSide: (side: 'left' | 'right') => void;
  setIsDragging: (v: boolean) => void;
  setDragCursorX: (x: number) => void;
  clampPosition: (viewportW: number, viewportH: number) => void;
  saveState: () => void;
  loadState: () => void;
  reset: () => void;
}

export type ToolbarStore = ToolbarStoreState & ToolbarStoreActions;

const COLLAPSE_THRESHOLD = 60;

export function createToolbarStore(storageKey: string) {
  const useStore = create<ToolbarStore>((set, get) => ({
    expanded: DEFAULT_TOOLBAR_STATE.expanded,
    width: DEFAULT_TOOLBAR_STATE.width,
    lastExpandedWidth: DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
    top: DEFAULT_TOOLBAR_STATE.top,
    offset: DEFAULT_TOOLBAR_STATE.offset,
    side: DEFAULT_TOOLBAR_STATE.side,
    isDragging: false,
    dragCursorX: 0,

    // --- expand / collapse ---

    toggle: () => {
      const { expanded, width, lastExpandedWidth } = get();
      if (expanded) {
        const saved = width > COLLAPSE_THRESHOLD ? width : lastExpandedWidth;
        set({ expanded: false, lastExpandedWidth: saved });
      } else {
        set({ expanded: true, width: lastExpandedWidth });
      }
    },

    expand: () => set({ expanded: true, width: get().lastExpandedWidth }),

    collapse: () => {
      const { width, lastExpandedWidth } = get();
      const saved = width > COLLAPSE_THRESHOLD ? width : lastExpandedWidth;
      set({ expanded: false, lastExpandedWidth: saved });
    },

    // --- size & position ---

    setWidth: (w) => set({ width: w }),

    setPosition: (top, offset) => set({ top, offset }),

    setSide: (side) => set({ side }),

    setIsDragging: (v) => set({ isDragging: v }),
    setDragCursorX: (x) => set({ dragCursorX: x }),

    clampPosition: (viewportW, viewportH) => {
      const { top, offset } = get();
      const estH = 600;
      const margin = 12;
      set({
        top: Math.max(margin, Math.min(top, Math.max(margin, viewportH - estH))),
        offset: Math.max(-12, Math.min(offset, viewportW - 60)),
      });
    },

    // --- persistence ---

    saveState: () => {
      try {
        const { expanded, width, lastExpandedWidth, top, offset, side } = get();
        localStorage.setItem(
          storageKey,
          JSON.stringify({ expanded, width, lastExpandedWidth, top, offset, side }),
        );
      } catch { /* noop */ }
    },

    loadState: () => {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const data = JSON.parse(raw);
          set({
            expanded: data.expanded ?? DEFAULT_TOOLBAR_STATE.expanded,
            width: data.width ?? DEFAULT_TOOLBAR_STATE.width,
            lastExpandedWidth: data.lastExpandedWidth ?? DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
            top: data.top ?? DEFAULT_TOOLBAR_STATE.top,
            offset: data.offset ?? data.rightOffset ?? DEFAULT_TOOLBAR_STATE.offset,
            side: data.side ?? DEFAULT_TOOLBAR_STATE.side,
          });
        }
      } catch { /* corrupt */ }
    },

    reset: () => set({ ...DEFAULT_TOOLBAR_STATE, isDragging: false, dragCursorX: 0 }),
  }));

  // Auto-save (debounced), scoped to this instance's key.
  let saveTimeout: ReturnType<typeof setTimeout>;
  useStore.subscribe(() => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      useStore.getState().saveState();
    }, 500);
  });

  return useStore;
}

/** Infinite-canvas toolbar memory (kept at its legacy key). */
export const useCanvasToolbarStore = createToolbarStore(TOOLBAR_STORAGE_KEY);
/** PDF toolbar memory (separate key — independent position/expansion). */
export const usePdfToolbarStore = createToolbarStore('stickynotes-pdf-toolbar');
