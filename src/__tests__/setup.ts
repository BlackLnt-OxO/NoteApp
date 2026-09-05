import '@testing-library/jest-dom';
import { vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock window.electronAPI — all methods return sensible defaults so any
// component or store code that touches electronAPI won't throw in tests.
// Individual tests can override specific methods via vi.mocked().
// ---------------------------------------------------------------------------

const electronAPIMock = {
  // Window controls
  minimize: vi.fn().mockResolvedValue(undefined),
  maximize: vi.fn().mockResolvedValue(true),
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),

  // Floating notes
  createFloatingNote: vi.fn().mockResolvedValue('float-mock-1'),
  closeFloatingNote: vi.fn().mockResolvedValue(true),
  updateFloatingNote: vi.fn().mockResolvedValue(true),
  closeAllFloating: vi.fn().mockResolvedValue(true),
  updateAllFloatingFontSize: vi.fn().mockResolvedValue(true),
  loadFloatState: vi.fn().mockResolvedValue(null),
  saveFloatState: vi.fn().mockResolvedValue(true),
  updateFloatContent: vi.fn().mockResolvedValue(true),
  setFloatIgnoreMouse: vi.fn().mockResolvedValue(true),

  // Floating event listeners (no-ops for test registration)
  onFloatContentUpdated: vi.fn(),
  onFloatingClosed: vi.fn(),
  onAllFloatingClosed: vi.fn(),

  // Screenshot
  getCursorScreenPoint: vi.fn().mockResolvedValue({ x: 100, y: 100 }),
  startScreenshot: vi.fn().mockResolvedValue(true),
  startEyedropper: vi.fn().mockResolvedValue('#ff0000'),
  startLongScreenshot: vi.fn().mockResolvedValue(true),
  cancelScreenshot: vi.fn().mockResolvedValue(true),
  showToast: vi.fn().mockResolvedValue(true),
  onScreenshotCompleted: vi.fn(),

  // File / image pickers
  pickImage: vi.fn().mockResolvedValue({
    dataUrl: 'data:image/png;base64,fake',
    filePath: '/fake/path.png',
  }),
  pickBackground: vi.fn().mockResolvedValue({
    dataUrl: 'data:image/png;base64,fakebg',
    filePath: '/fake/bg.png',
  }),
  saveImage: vi.fn().mockResolvedValue('/fake/saved.png'),
  saveImageAs: vi.fn().mockResolvedValue({ ok: true, filePath: '/fake/saved-as.png' }),
  getPath: vi.fn().mockResolvedValue('/fake/userdata'),
  getDefaultBackground: vi.fn().mockResolvedValue(null),

  // Persistence
  saveStore: vi.fn().mockResolvedValue(true),
  loadStore: vi.fn().mockResolvedValue(null),
  loadStoreSync: vi.fn().mockReturnValue(null),
};

Object.defineProperty(window, 'electronAPI', {
  value: electronAPIMock,
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Mock localStorage (Zustand store fallback when electronAPI is absent)
// ---------------------------------------------------------------------------

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Mock ResizeObserver (used by NoteGrid)
// ---------------------------------------------------------------------------

window.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ---------------------------------------------------------------------------
// Mock document.createRange and window.getSelection
// (used by NoteCard contentEditable undo logic)
// ---------------------------------------------------------------------------

document.createRange = () =>
  ({
    setStart: vi.fn(),
    setEnd: vi.fn(),
    selectNodeContents: vi.fn(),
    collapse: vi.fn(),
    cloneContents: vi.fn(() => document.createDocumentFragment()),
    cloneRange: vi.fn(() => document.createRange()),
    extractContents: vi.fn(() => document.createDocumentFragment()),
    deleteContents: vi.fn(),
    insertNode: vi.fn(),
    setStartAfter: vi.fn(),
    setEndAfter: vi.fn(),
    setStartBefore: vi.fn(),
    setEndBefore: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, right: 0, bottom: 0, left: 0,
      toJSON: () => {},
    })),
    getClientRects: vi.fn(() => [] as unknown as DOMRectList),
    startContainer: null,
    startOffset: 0,
    endContainer: null,
    endOffset: 0,
    collapsed: true,
    commonAncestorContainer: null,
    compareBoundaryPoints: vi.fn(() => 0),
    detach: vi.fn(),
    toString: vi.fn(() => ''),
  } as any);

window.getSelection = () =>
  ({
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    isCollapsed: true,
    rangeCount: 0,
    type: 'None',
    addRange: vi.fn(),
    collapse: vi.fn(),
    collapseToEnd: vi.fn(),
    collapseToStart: vi.fn(),
    containsNode: vi.fn(() => false),
    deleteFromDocument: vi.fn(),
    extend: vi.fn(),
    getRangeAt: vi.fn(() => document.createRange()),
    removeAllRanges: vi.fn(),
    removeRange: vi.fn(),
    selectAllChildren: vi.fn(),
    setBaseAndExtent: vi.fn(),
    setPosition: vi.fn(),
    toString: vi.fn(() => ''),
    anchorNode_X: null, // non-standard but sometimes accessed
  } as any);

// ---------------------------------------------------------------------------
// Mock URL.createObjectURL / revokeObjectURL
// (used by image drag-drop in CreateNoteDialog / NoteCard)
// ---------------------------------------------------------------------------

URL.createObjectURL = vi.fn(() => 'blob:mock-url');
URL.revokeObjectURL = vi.fn();

// ---------------------------------------------------------------------------
// Mock matchMedia (used by theme / dark-mode detection)
// ---------------------------------------------------------------------------

window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Clean up mocks between tests (so call counts and mock implementations
// don't leak across test cases)
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
  // Also reset localStorage
  window.localStorage.clear();
});
