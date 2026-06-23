export interface NoteImage {
  id: string;
  dataUrl: string;
  fileName?: string;
  width?: number;
  height?: number;
  _previewH?: number;
  _imgX?: number;
  _imgY?: number;
}

export interface Note {
  id: string;
  content: string;
  color: string;
  tag: string;
  images: NoteImage[];
  createdAt: number;
  updatedAt: number;
  // Grid position (for main view)
  gridX: number;
  gridY: number;
  // Mind map position (free position)
  mapX: number;
  mapY: number;
  // Size
  width: number;
  height: number;
  customSize?: boolean;
  // Floating window state
  isFloating: boolean;
  floatWindowId?: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  icon?: string;
}

export interface AppSettings {
  theme: 'light' | 'dark';
  fontSize: number;
  fontFamily: string;
  backgroundImage: string | null;
  backgroundOpacity: number;
  gridSize: number;
  defaultNoteColor: string;
  customNoteColors: string[];
  shortcutScreenshot: string;
  shortcutLongScreenshot: string;
  shortcutPenetrate: string;
  shortcutCloseAll: string;
  shortcutTransparent: string;
}

export interface MindMapState {
  offsetX: number;
  offsetY: number;
  scale: number;
  backgroundImage: string | null;
  showDots: boolean;
}

export type ViewMode = 'notes' | 'mindmap';

export const DEFAULT_COLORS = [
  '#6b5ce7', // Purple
  '#e74c3c', // Red
  '#e67e22', // Orange
  '#2ecc71', // Green
  '#3498db', // Blue
  '#1abc9c', // Teal
  '#f39c12', // Yellow
  '#e91e63', // Pink
  '#9b59b6', // Violet
  '#34495e', // Dark Gray
  '#16a085', // Dark Teal
  '#2d2d44', // Deep Purple-Gray
];

export const DEFAULT_TAGS: Tag[] = [
  { id: 'all', name: '全部', color: '#6b5ce7' },
  { id: 'general', name: '通用', color: '#3498db' },
  { id: 'work', name: '工作', color: '#e74c3c' },
  { id: 'personal', name: '个人', color: '#2ecc71' },
  { id: 'important', name: '重要', color: '#e67e22' },
  { id: 'screenshot', name: '截图', color: '#1abc9c' },
  { id: 'idea', name: '想法', color: '#9b59b6' },
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  backgroundImage: null,
  backgroundOpacity: 0.3,
  gridSize: 20,
  defaultNoteColor: '#2d2d44',
  customNoteColors: [],
  shortcutScreenshot: 'Ctrl+Shift+X',
  shortcutLongScreenshot: 'Ctrl+Shift+Alt+X',
  shortcutPenetrate: 'Ctrl+P',
  shortcutCloseAll: 'Ctrl+Shift+W',
  shortcutTransparent: 'Ctrl+Shift+T',
};

