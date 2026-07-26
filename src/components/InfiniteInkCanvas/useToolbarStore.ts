/**
 * useToolbarStore — Independent Zustand store for Blender N-panel toolbar UI state.
 *
 * Manages: expand/collapse, width, resize history, position, dock side, and
 * localStorage persistence.  Does NOT touch canvas or brush state.
 */

import { create } from 'zustand';
import { DEFAULT_TOOLBAR_STATE, TOOLBAR_STORAGE_KEY } from './constants';

// ---- Types --------------------------------------------------------------------

export interface ToolbarStoreState {
  expanded: boolean;
  width: number;
  lastExpandedWidth: number;
  top: number;
  left: number;
  side: 'left' | 'right';
  autoCollapseThreshold: number;
}

export interface ToolbarStoreActions {
  toggle: () => void;
  expand: () => void;
  collapse: () => void;
  setWidth: (w: number) => void;
  setPosition: (top: number, left: number) => void;
  clampPosition: (viewportW: number, viewportH: number) => void;
  saveState: () => void;
  loadState: () => void;
  reset: () => void;
}

type ToolbarStore = ToolbarStoreState & ToolbarStoreActions;

// ---- Store --------------------------------------------------------------------

export const useToolbarStore = create<ToolbarStore>((set, get) => ({
  // --- initial state ---
  expanded: DEFAULT_TOOLBAR_STATE.expanded,
  width: DEFAULT_TOOLBAR_STATE.width,
  lastExpandedWidth: DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
  top: DEFAULT_TOOLBAR_STATE.top,
  left: DEFAULT_TOOLBAR_STATE.left,
  side: DEFAULT_TOOLBAR_STATE.side,
  autoCollapseThreshold: 100,

  // --- actions ---

  toggle: () => {
    const { expanded, width, lastExpandedWidth, autoCollapseThreshold } = get();
    if (expanded) {
      // collapsing — save current width as lastExpandedWidth (unless it's already tiny)
      const savedWidth = width > autoCollapseThreshold ? width : lastExpandedWidth;
      set({ expanded: false, lastExpandedWidth: savedWidth });
    } else {
      // expanding — restore saved width
      set({ expanded: true, width: lastExpandedWidth });
    }
  },

  expand: () => {
    const { lastExpandedWidth } = get();
    set({ expanded: true, width: lastExpandedWidth });
  },

  collapse: () => {
    const { width, lastExpandedWidth, autoCollapseThreshold } = get();
    const savedWidth = width > autoCollapseThreshold ? width : lastExpandedWidth;
    set({ expanded: false, lastExpandedWidth: savedWidth });
  },

  setWidth: (w) => set({ width: w }),

  setPosition: (top, left) => set({ top, left }),

  clampPosition: (viewportW, viewportH) => {
    const { top, left, width, expanded } = get();
    const effectiveW = expanded ? width : 28;
    // Estimate toolbar height for clamping (rough)
    const estH = 600;
    const margin = 12;
    set({
      left: Math.max(margin, Math.min(left, viewportW - effectiveW - margin)),
      top: Math.max(margin, Math.min(top, viewportH - estH - margin)),
    });
  },

  // --- persistence ---

  saveState: () => {
    try {
      const { expanded, width, lastExpandedWidth, top, left, side } = get();
      const data = { expanded, width, lastExpandedWidth, top, left, side };
      localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('Failed to save toolbar state:', e);
    }
  },

  loadState: () => {
    try {
      const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        set({
          expanded: data.expanded ?? DEFAULT_TOOLBAR_STATE.expanded,
          width: data.width ?? DEFAULT_TOOLBAR_STATE.width,
          lastExpandedWidth:
            data.lastExpandedWidth ?? DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
          top: data.top ?? DEFAULT_TOOLBAR_STATE.top,
          left: data.left ?? DEFAULT_TOOLBAR_STATE.left,
          side: data.side ?? DEFAULT_TOOLBAR_STATE.side,
        });
      }
    } catch (e) {
      console.error('Failed to load toolbar state:', e);
    }
  },

  reset: () => {
    set({ ...DEFAULT_TOOLBAR_STATE });
  },
}));

// ---- Auto-save ----------------------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
useToolbarStore.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    useToolbarStore.getState().saveState();
  }, 500);
});
