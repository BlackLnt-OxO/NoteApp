import { create } from 'zustand';
import { Note, Tag, AppSettings, MindMapState, ViewMode, DEFAULT_TAGS, DEFAULT_SETTINGS, DEFAULT_COLORS } from '../types';

interface NoteStore {
  // Load state
  loaded: boolean;

  // Notes
  notes: Note[];
  selectedNoteId: string | null;
  activeTag: string;

  // Tags
  tags: Tag[];

  // Settings
  settings: AppSettings;

  // View
  viewMode: ViewMode;
  /** Whether the left sidebar is collapsed. */
  sidebarCollapsed: boolean;
  /** Viewport-style UI zoom (0.7–1.6). Lifted to a global store so the canvas
   *  and cursor ring can correct their coordinates against it (fixes "click
   *  selects/inserts/erases at the wrong spot when zoom isn't 100%"). */
  uiScale: number;

  // Mind map (global)
  mindMap: MindMapState;


  // Actions - Notes
  addNote: (note: Partial<Note>) => Note;
  updateNote: (id: string, data: Partial<Note>) => void;
  deleteNote: (id: string) => void;
  moveNote: (id: string, gridX: number, gridY: number) => void;
  moveNoteOnMap: (id: string, mapX: number, mapY: number) => void;
  setNoteFloating: (id: string, isFloating: boolean, floatWindowId?: string) => void;
  reorderNotes: (fromIndex: number, toIndex: number) => void;

  // Actions - Selection
  selectNote: (id: string | null) => void;
  setActiveTag: (tagId: string) => void;

  // Actions - Tags
  addTag: (tag: Tag) => void;
  updateTag: (id: string, data: Partial<Tag>) => void;
  deleteTag: (id: string) => void;

  // Actions - Settings
  updateSettings: (data: Partial<AppSettings>) => void;

  // Actions - View
  setViewMode: (mode: ViewMode) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setUiScale: (s: number) => void;

  // Actions - Mind Map
  updateMindMap: (data: Partial<MindMapState>) => void;

  // Persistence
  saveData: () => Promise<void>;
  loadData: () => Promise<void>;
}

function generateId(): string {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/** Read the persisted UI zoom (defaults to 1 if invalid/missing). */
function readUiScale(): number {
  // Default UI zoom is 110%. This hits the title-bar readout as "100%" (the
  // readout subtracts a 0.1 offset), so 110% is treated as the standard 100%.
  // Clear any stale persisted zoom so a leftover percentage can't stick.
  localStorage.removeItem('sticky-notes-ui-zoom');
  return 1.1;
}

export const useNoteStore = create<NoteStore>((set, get) => ({
  loaded: false,
  notes: [],
  selectedNoteId: null,
  activeTag: 'all',
  tags: DEFAULT_TAGS,
  settings: DEFAULT_SETTINGS,
  viewMode: 'notes',
  sidebarCollapsed: false,
  uiScale: readUiScale(),
  mindMap: {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    backgroundImage: null,
    showDots: true,
  },

  addNote: (partial) => {
    const note: Note = {
      id: generateId(),
      content: partial.content || '',
      color: partial.color || get().settings.defaultNoteColor || DEFAULT_COLORS[0],
      tag: partial.tag || 'general',
      images: partial.images || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      gridX: partial.gridX ?? 0,
      gridY: partial.gridY ?? 0,
      mapX: partial.mapX ?? Math.random() * 400 - 200,
      mapY: partial.mapY ?? Math.random() * 400 - 200,
      width: partial.width || 260,
      height: partial.height || 200,
      customSize: partial.customSize ?? true,
      isFloating: false,
    };
    set((state) => ({ notes: [...state.notes, note] }));
    return note;
  },

  updateNote: (id, data) => {
    set((state) => ({
      notes: state.notes.map((n) =>
        n.id === id ? { ...n, ...data, updatedAt: Date.now() } : n
      ),
    }));
  },

  deleteNote: (id) => {
    set((state) => ({
      notes: state.notes.filter((n) => n.id !== id),
      selectedNoteId: state.selectedNoteId === id ? null : state.selectedNoteId,
    }));
  },

  moveNote: (id, gridX, gridY) => {
    set((state) => ({
      notes: state.notes.map((n) =>
        n.id === id ? { ...n, gridX, gridY } : n
      ),
    }));
  },

  moveNoteOnMap: (id, mapX, mapY) => {
    set((state) => ({
      notes: state.notes.map((n) =>
        n.id === id ? { ...n, mapX, mapY } : n
      ),
    }));
  },

  setNoteFloating: (id, isFloating, floatWindowId) => {
    set((state) => ({
      notes: state.notes.map((n) =>
        n.id === id ? { ...n, isFloating, floatWindowId } : n
      ),
    }));
  },

  reorderNotes: (fromIndex, toIndex) => {
    set((state) => {
      const notes = [...state.notes];
      // Simple swap
      [notes[fromIndex], notes[toIndex]] = [notes[toIndex], notes[fromIndex]];
      return { notes };
    });
  },

  selectNote: (id) => set({ selectedNoteId: id }),
  setActiveTag: (tagId) => set({ activeTag: tagId }),

  addTag: (tag) => {
    set((state) => ({ tags: [...state.tags, tag] }));
  },

  updateTag: (id, data) => {
    set((state) => ({
      tags: state.tags.map((t) => (t.id === id ? { ...t, ...data } : t)),
    }));
  },

  deleteTag: (id) => {
    set((state) => ({
      tags: state.tags.filter((t) => t.id !== id && t.id !== 'all'),
      activeTag: state.activeTag === id ? 'all' : state.activeTag,
    }));
  },

  updateSettings: (data) => {
    set((state) => ({ settings: { ...state.settings, ...data } }));
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setUiScale: (s) => set({ uiScale: s }),

  updateMindMap: (data) => {
    set((state) => ({ mindMap: { ...state.mindMap, ...data } }));
  },

  saveData: async () => {
    try {
      const state = get();
      const data = {
        notes: state.notes,
        tags: state.tags,
        settings: state.settings,
        mindMap: state.mindMap,
        viewMode: state.viewMode,
        sidebarCollapsed: state.sidebarCollapsed,
      };
      if (window.electronAPI) {
        await window.electronAPI.saveStore(data);
      } else {
        localStorage.setItem('stickynotes-data', JSON.stringify(data));
      }
    } catch (e) {
      console.error('Failed to save data:', e);
    }
  },

  loadData: async () => {
    try {
      let data = null;
      if (window.electronAPI) {
        data = await window.electronAPI.loadStore();
      } else {
        const raw = localStorage.getItem('stickynotes-data');
        if (raw) data = JSON.parse(raw);
      }

      if (data && Array.isArray(data.notes) && data.notes.length) {
        // Clear isFloating on all notes (float windows don't persist across restarts)
        const notes = (data.notes || []).map((n: Note) => ({ ...n, isFloating: false, floatWindowId: undefined }));
        set({
          loaded: true,
          notes,
          tags: data.tags || DEFAULT_TAGS,
          settings: {
            ...DEFAULT_SETTINGS,
            ...data.settings,
            backgroundImage: data.settings?.backgroundImage || null,
          },
          mindMap: data.mindMap || {
            offsetX: 0, offsetY: 0, scale: 1,
            backgroundImage: null, showDots: true,
          },
          // Restore the last-used view. Notes keeps the sidebar open; canvas/PDF
          // start collapsed (their default), so the user lands where they left off.
          viewMode: (['notes', 'inkcanvas', 'pdf'] as const).includes(data.viewMode) ? data.viewMode : 'notes',
          sidebarCollapsed: data.viewMode === 'notes' ? false : true,
        });
      } else {
        // First run - add welcome notes introducing the three sections.
        const welcomeNotes = [
          {
            id: 'welcome_1',
            content: '便笺 — 日常记录\n\n双击编辑内容，右键更换颜色，\n可插入图片，拖拽排序。\n\n快捷键\nCtrl+Shift+X 截图 · Ctrl+P 磁贴穿透\nCtrl+Shift+W 关闭全部磁贴',
            color: DEFAULT_SETTINGS.defaultNoteColor,
            tag: 'general',
            images: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            gridX: 0,
            gridY: 0,
            mapX: -100,
            mapY: -80,
            width: 260,
            height: 200,
            isFloating: false,
          },
          {
            id: 'welcome_2',
            content: '无限画布 — 自由书写\n\n左侧切到「画布」可新建多个画布，\n支持钢笔、橡皮、文本工具，滚轮缩放平移。',
            color: DEFAULT_SETTINGS.defaultNoteColor,
            tag: 'general',
            images: [],
            createdAt: Date.now() + 1,
            updatedAt: Date.now() + 1,
            gridX: 290,
            gridY: 0,
            mapX: 200,
            mapY: -80,
            width: 260,
            height: 200,
            isFloating: false,
          },
          {
            id: 'welcome_3',
            content: 'PDF 批注 — 文档上书写\n\n左侧切到「PDF」导入文档，\n逐页批注与擦除，Ctrl+S 保存批注。',
            color: DEFAULT_SETTINGS.defaultNoteColor,
            tag: 'general',
            images: [],
            createdAt: Date.now() + 2,
            updatedAt: Date.now() + 2,
            gridX: 580,
            gridY: 0,
            mapX: 500,
            mapY: -80,
            width: 260,
            height: 200,
            isFloating: false,
          },
        ];

        set({
          loaded: true,
          notes: welcomeNotes,
          settings: {
            ...DEFAULT_SETTINGS,
            backgroundImage: null,
          },
        });
      }
    } catch (e) {
      console.error('Failed to load data:', e);
      set({ loaded: true });
    }

    // Load default background asynchronously (slow, don't block UI)
    if (window.electronAPI) {
      const s = get();
      if (!s.settings.backgroundImage) {
        window.electronAPI.getDefaultBackground().then(bg => {
          if (bg) set((st) => ({ settings: { ...st.settings, backgroundImage: bg } }));
        }).catch(() => {});
      }
    }
  },
}));

// Auto-save on changes
let saveTimeout: ReturnType<typeof setTimeout>;
useNoteStore.subscribe(() => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    useNoteStore.getState().saveData();
  }, 1000);
});
