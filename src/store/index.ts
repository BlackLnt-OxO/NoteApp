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

  // Actions - Mind Map
  updateMindMap: (data: Partial<MindMapState>) => void;

  // Persistence
  saveData: () => Promise<void>;
  loadData: () => Promise<void>;
}

function generateId(): string {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

export const useNoteStore = create<NoteStore>((set, get) => ({
  loaded: false,
  notes: [],
  selectedNoteId: null,
  activeTag: 'all',
  tags: DEFAULT_TAGS,
  settings: DEFAULT_SETTINGS,
  viewMode: 'notes',
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
      width: partial.width || 65,
      height: partial.height || 50,
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

      if (data) {
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
        });
      } else {
        // First run - add welcome notes
        const welcomeNotes = [
          {
            id: 'welcome_1',
            content: '欢迎使用便笺笔记！\n\n✨ 双击编辑内容\n🎨 右键更换颜色\n📌 固定便笺到屏幕\n🖼️ 拖拽或点击插入图片',
            color: '#6b5ce7',
            tag: 'general',
            images: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            gridX: 0,
            gridY: 0,
            mapX: -100,
            mapY: -80,
            width: 65,
            height: 55,
            isFloating: false,
          },
          {
            id: 'welcome_2',
            content: '📷 截图功能\n\n点击左侧截图按钮或按 Ctrl+Shift+X 启动截图工具。\n\n支持长截图：框选区域后点击"长截图"，然后滚动页面自动拼接。',
            color: '#3498db',
            tag: 'general',
            images: [],
            createdAt: Date.now() + 1,
            updatedAt: Date.now() + 1,
            gridX: 290,
            gridY: 0,
            mapX: 200,
            mapY: -80,
            width: 65,
            height: 55,
            isFloating: false,
          },
          {
            id: 'welcome_3',
            content: '🧠 思维导图模式\n\n点击顶部「思维导图」切换到无限画布模式。\n右键拖动背景，左键拖动便笺，滚轮缩放。\n右下角可更换背景图片。',
            color: '#2ecc71',
            tag: 'general',
            images: [],
            createdAt: Date.now() + 2,
            updatedAt: Date.now() + 2,
            gridX: 580,
            gridY: 0,
            mapX: 500,
            mapY: -80,
            width: 65,
            height: 55,
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
