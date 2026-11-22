import { create } from 'zustand';

export type AlternatePen = 'fountain' | 'pencil';

interface ToolbarPreferences {
  alternatePen: AlternatePen;
  setAlternatePen: (pen: AlternatePen) => void;
}

export function createToolbarStore(storageKey: string) {
  let alternatePen: AlternatePen = 'fountain';
  try {
    if (localStorage.getItem(storageKey) === 'pencil') alternatePen = 'pencil';
  } catch { /* Preferences are still available for this session. */ }
  return create<ToolbarPreferences>((set, get) => ({
    alternatePen,
    setAlternatePen: pen => {
      if (pen === get().alternatePen) return;
      try { localStorage.setItem(storageKey, pen); } catch { /* Keep the in-memory preference. */ }
      set({ alternatePen: pen });
    },
  }));
}

export const useCanvasToolbarStore = createToolbarStore('stickynotes-inkcanvas-alternate-pen');
export const usePdfToolbarStore = createToolbarStore('stickynotes-pdf-alternate-pen');
