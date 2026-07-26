/**
 * useToolbarStore — Independent Zustand store for the Blender N-panel style
 * collapsible, draggable, resizable toolbar.
 *
 * Managed: expand/collapse, width, drag position, dock side, localStorage.
 * Does NOT touch canvas or brush state.
 */

import { create } from 'zustand';
import { DEFAULT_TOOLBAR_STATE, TOOLBAR_STORAGE_KEY } from './constants';

// ---- Types --------------------------------------------------------------------

export interface ToolbarStoreState {
  expanded: boolean;
  width: number;
  lastExpandedWidth: number;
  top: number;
  rightOffset: number;
  side: 'left' | 'right';
}

export interface ToolbarStoreActions {
  toggle: () => void;
  expand: () => void;
  collapse: () => void;
  setWidth: (w: number) => void;
  setPosition: (top: number, rightOffset: number) => void;
  clampPosition: (viewportW: number, viewportH: number) => void;
  saveState: () => void;
  loadState: () => void;
  reset: () => void;
}

type ToolbarStore = ToolbarStoreState & ToolbarStoreActions;

// ---- Helpers ------------------------------------------------------------------

const MIN_WIDTH = 200;
const COLLAPSE_THRESHOLD = 60; // width below which we auto-collapse

// ---- Store --------------------------------------------------------------------

export const useToolbarStore = create<ToolbarStore>((set, get) => ({
  expanded: DEFAULT_TOOLBAR_STATE.expanded,
  width: DEFAULT_TOOLBAR_STATE.width,
  lastExpandedWidth: DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
  top: DEFAULT_TOOLBAR_STATE.top,
  rightOffset: DEFAULT_TOOLBAR_STATE.rightOffset,
  side: DEFAULT_TOOLBAR_STATE.side,

  // ------------------------------------------------------------------
  // expand / collapse
  // ------------------------------------------------------------------

  toggle: () => {
    const { expanded, width, lastExpandedWidth } = get();
    if (expanded) {
      const saved = width > COLLAPSE_THRESHOLD ? width : lastExpandedWidth;
      set({ expanded: false, lastExpandedWidth: saved });
    } else {
      set({ expanded: true, width: lastExpandedWidth });
    }
  },

  expand: () => {
    set({ expanded: true, width: get().lastExpandedWidth });
  },

  collapse: () => {
    const { width, lastExpandedWidth } = get();
    const saved = width > COLLAPSE_THRESHOLD ? width : lastExpandedWidth;
    set({ expanded: false, lastExpandedWidth: saved });
  },

  // ------------------------------------------------------------------
  // size & position
  // ------------------------------------------------------------------

  setWidth: (w) => set({ width: w }),

  setPosition: (top, rightOffset) => set({ top, rightOffset }),

  clampPosition: (viewportW, viewportH) => {
    const { top, rightOffset, expanded } = get();
    const estH = 600; // rough toolbar panel height
    const margin = 12;
    set({
      top: Math.max(margin, Math.min(top, Math.max(margin, viewportH - estH))),
      rightOffset: Math.max(-12, Math.min(rightOffset, viewportW - 60)),
    });
  },

  // ------------------------------------------------------------------
  // persistence
  // ------------------------------------------------------------------

  saveState: () => {
    try {
      const { expanded, width, lastExpandedWidth, top, rightOffset, side } = get();
      localStorage.setItem(
        TOOLBAR_STORAGE_KEY,
        JSON.stringify({ expanded, width, lastExpandedWidth, top, rightOffset, side }),
      );
    } catch {
      /* localStorage may be unavailable */
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
          lastExpandedWidth: data.lastExpandedWidth ?? DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
          top: data.top ?? DEFAULT_TOOLBAR_STATE.top,
          rightOffset: data.rightOffset ?? DEFAULT_TOOLBAR_STATE.rightOffset,
          side: data.side ?? DEFAULT_TOOLBAR_STATE.side,
        });
      }
    } catch {
      /* corrupt data — keep defaults */
    }
  },

  reset: () => set({ ...DEFAULT_TOOLBAR_STATE }),
}));

// ---- Auto-save ----------------------------------------------------------------

let saveTimeout: ReturnType<typeof setTimeout>;
useToolbarStore.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    useToolbarStore.getState().saveState();
  }, 500);
});
