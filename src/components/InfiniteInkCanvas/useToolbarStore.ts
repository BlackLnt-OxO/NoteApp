/**
 * useToolbarStore — Zustand store for the collapsible, draggable, resizable
 * toolbar.  Supports left / right edge docking with snap-on-release.
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
}

export interface ToolbarStoreActions {
  toggle: () => void;
  expand: () => void;
  collapse: () => void;
  setWidth: (w: number) => void;
  setPosition: (top: number, offset: number) => void;
  setSide: (side: 'left' | 'right') => void;
  setIsDragging: (v: boolean) => void;
  clampPosition: (viewportW: number, viewportH: number) => void;
  saveState: () => void;
  loadState: () => void;
  reset: () => void;
}

type ToolbarStore = ToolbarStoreState & ToolbarStoreActions;

const COLLAPSE_THRESHOLD = 60;

// ---- Store ---------------------------------------------------------------

export const useToolbarStore = create<ToolbarStore>((set, get) => ({
  expanded: DEFAULT_TOOLBAR_STATE.expanded,
  width: DEFAULT_TOOLBAR_STATE.width,
  lastExpandedWidth: DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
  top: DEFAULT_TOOLBAR_STATE.top,
  offset: DEFAULT_TOOLBAR_STATE.offset,
  side: DEFAULT_TOOLBAR_STATE.side,
  isDragging: false,

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

  clampPosition: (viewportW, viewportH) => {
    const { top, offset, expanded } = get();
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
        TOOLBAR_STORAGE_KEY,
        JSON.stringify({ expanded, width, lastExpandedWidth, top, offset, side }),
      );
    } catch { /* noop */ }
  },

  loadState: () => {
    try {
      const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
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

  reset: () => set({ ...DEFAULT_TOOLBAR_STATE, isDragging: false }),
}));

// ---- Auto-save -----------------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
useToolbarStore.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    useToolbarStore.getState().saveState();
  }, 500);
});
