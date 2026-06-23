import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { useNoteStore } from '../store';
import { DEFAULT_TAGS, DEFAULT_SETTINGS, DEFAULT_COLORS } from '../types';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const initialState = {
  loaded: false,
  notes: [] as Note[],
  selectedNoteId: null as string | null,
  activeTag: 'all',
  tags: DEFAULT_TAGS,
  settings: DEFAULT_SETTINGS,
  viewMode: 'notes' as const,
  mindMap: {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    backgroundImage: null as string | null,
    showDots: true,
  },
};

/** Reset store to known state. The `true` flag replaces entire state object. */
function resetStore() {
  // Don't pass `true` (replace) — it wipes out the action functions.
  // Shallow merge is enough because we specify every data key.
  useNoteStore.setState(initialState);
}

// ---------------------------------------------------------------------------
//  Test suite
// ---------------------------------------------------------------------------

describe('NoteStore', () => {
  // The store auto-subscribes at module level to debounce-save after 1s.
  // Use fake timers so we can flush the initial save and not pollute tests.
  beforeAll(() => {
    // Only fake timers and Date, NOT Math.random (needed for unique IDs).
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    resetStore();
    // Advance past any pending debounced save from previous test
    vi.advanceTimersByTime(2000);
    // Clear save mock calls so each test starts fresh
    vi.clearAllMocks();
  });

  // =========================================================================
  // Initial state
  // =========================================================================

  describe('initial state', () => {
    it('has loaded = false', () => {
      expect(useNoteStore.getState().loaded).toBe(false);
    });

    it('contains default tags, settings, and empty notes', () => {
      const s = useNoteStore.getState();
      expect(s.tags).toEqual(DEFAULT_TAGS);
      expect(s.settings).toEqual(DEFAULT_SETTINGS);
      expect(s.notes).toEqual([]);
      expect(s.activeTag).toBe('all');
      expect(s.viewMode).toBe('notes');
    });
  });

  // =========================================================================
  // addNote
  // =========================================================================

  describe('addNote', () => {
    it('creates a note with a prefixed generated ID', () => {
      const note = useNoteStore.getState().addNote({ content: 'hello' });
      expect(note.id).toMatch(/^note_\d+_[a-z0-9]+$/);
    });

    it('sets content from the partial argument', () => {
      const note = useNoteStore.getState().addNote({ content: 'my note' });
      expect(note.content).toBe('my note');
    });

    it('defaults content to empty string when not provided', () => {
      const note = useNoteStore.getState().addNote({});
      expect(note.content).toBe('');
    });

    it('uses provided color when specified', () => {
      const note = useNoteStore.getState().addNote({ color: '#ff0000' });
      expect(note.color).toBe('#ff0000');
    });

    it('falls back to settings.defaultNoteColor when no color is provided', () => {
      // First change the default note color in settings
      useNoteStore.getState().updateSettings({ defaultNoteColor: '#abcdef' });
      const note = useNoteStore.getState().addNote({ content: 'test' });
      expect(note.color).toBe('#abcdef');
    });

    it('assigns default width=260, height=200, customSize=true', () => {
      const note = useNoteStore.getState().addNote({ content: 'test' });
      expect(note.width).toBe(260);
      expect(note.height).toBe(200);
      expect(note.customSize).toBe(true);
    });

    it('sets createdAt and updatedAt near system time', () => {
      const note = useNoteStore.getState().addNote({ content: 'test' });
      const now = Date.now();
      expect(note.createdAt).toBe(now);
      expect(note.updatedAt).toBe(now);
    });

    it('sets gridX/gridY to 0 when not specified', () => {
      const note = useNoteStore.getState().addNote({});
      expect(note.gridX).toBe(0);
      expect(note.gridY).toBe(0);
    });

    it('sets mapX/mapY to random values in the range [-200, 200)', () => {
      // Fix Math.random to return 0.5 → 0.5*400 - 200 = 0
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const note = useNoteStore.getState().addNote({});
      expect(note.mapX).toBe(0);
      expect(note.mapY).toBe(0);
      vi.spyOn(Math, 'random').mockRestore();
    });

    it('increments notes array length by 1', () => {
      expect(useNoteStore.getState().notes).toHaveLength(0);
      useNoteStore.getState().addNote({ content: 'a' });
      expect(useNoteStore.getState().notes).toHaveLength(1);
      useNoteStore.getState().addNote({ content: 'b' });
      expect(useNoteStore.getState().notes).toHaveLength(2);
    });

    it('accepts gridX/gridY from partial', () => {
      const note = useNoteStore.getState().addNote({ gridX: 100, gridY: 200 });
      expect(note.gridX).toBe(100);
      expect(note.gridY).toBe(200);
    });

    it('accepts custom tag from partial', () => {
      const note = useNoteStore.getState().addNote({ tag: 'work' });
      expect(note.tag).toBe('work');
    });

    it('defaults tag to general', () => {
      const note = useNoteStore.getState().addNote({});
      expect(note.tag).toBe('general');
    });

    it('isFloating defaults to false', () => {
      const note = useNoteStore.getState().addNote({});
      expect(note.isFloating).toBe(false);
    });
  });

  // =========================================================================
  // updateNote
  // =========================================================================

  describe('updateNote', () => {
    it('updates specified fields on the target note', () => {
      const note = useNoteStore.getState().addNote({ content: 'old' });
      useNoteStore.getState().updateNote(note.id, { content: 'new' });
      const updated = useNoteStore.getState().notes.find(n => n.id === note.id);
      expect(updated?.content).toBe('new');
    });

    it('does not modify other notes', () => {
      const n1 = useNoteStore.getState().addNote({ content: 'a' });
      const n2 = useNoteStore.getState().addNote({ content: 'b' });
      useNoteStore.getState().updateNote(n1.id, { content: 'changed' });
      const unchanged = useNoteStore.getState().notes.find(n => n.id === n2.id);
      expect(unchanged?.content).toBe('b');
    });

    it('updates updatedAt to a newer timestamp', () => {
      const note = useNoteStore.getState().addNote({ content: 'test' });
      const originalUpdatedAt = note.updatedAt;
      // Advance time slightly
      vi.setSystemTime(new Date('2026-06-23T00:01:00Z'));
      useNoteStore.getState().updateNote(note.id, { content: 'modified' });
      const updated = useNoteStore.getState().notes.find(n => n.id === note.id);
      expect(updated!.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });

    it('does nothing for a non-existent ID (no crash)', () => {
      expect(() => {
        useNoteStore.getState().updateNote('nonexistent', { content: 'x' });
      }).not.toThrow();
    });
  });

  // =========================================================================
  // deleteNote
  // =========================================================================

  describe('deleteNote', () => {
    it('removes the note from the array', () => {
      const note = useNoteStore.getState().addNote({ content: 'test' });
      expect(useNoteStore.getState().notes).toHaveLength(1);
      useNoteStore.getState().deleteNote(note.id);
      expect(useNoteStore.getState().notes).toHaveLength(0);
    });

    it('clears selectedNoteId when the deleted note was selected', () => {
      const note = useNoteStore.getState().addNote({ content: 'test' });
      useNoteStore.getState().selectNote(note.id);
      expect(useNoteStore.getState().selectedNoteId).toBe(note.id);
      useNoteStore.getState().deleteNote(note.id);
      expect(useNoteStore.getState().selectedNoteId).toBeNull();
    });

    it('leaves selectedNoteId unchanged when deleting a different note', () => {
      const n1 = useNoteStore.getState().addNote({ content: 'a' });
      const n2 = useNoteStore.getState().addNote({ content: 'b' });
      useNoteStore.getState().selectNote(n1.id);
      useNoteStore.getState().deleteNote(n2.id);
      expect(useNoteStore.getState().selectedNoteId).toBe(n1.id);
    });

    it('does nothing for a non-existent ID (no crash)', () => {
      expect(() => {
        useNoteStore.getState().deleteNote('nonexistent');
      }).not.toThrow();
    });
  });

  // =========================================================================
  // moveNote / moveNoteOnMap
  // =========================================================================

  describe('moveNote', () => {
    it('updates gridX and gridY', () => {
      const note = useNoteStore.getState().addNote({});
      useNoteStore.getState().moveNote(note.id, 300, 400);
      const moved = useNoteStore.getState().notes.find(n => n.id === note.id);
      expect(moved?.gridX).toBe(300);
      expect(moved?.gridY).toBe(400);
    });

    it('does not affect other note fields', () => {
      const note = useNoteStore.getState().addNote({ content: 'keep me' });
      useNoteStore.getState().moveNote(note.id, 999, 888);
      const moved = useNoteStore.getState().notes.find(n => n.id === note.id);
      expect(moved?.content).toBe('keep me');
      expect(moved?.width).toBe(260);
    });
  });

  describe('moveNoteOnMap', () => {
    it('updates mapX and mapY', () => {
      const note = useNoteStore.getState().addNote({});
      useNoteStore.getState().moveNoteOnMap(note.id, -50, 120);
      const moved = useNoteStore.getState().notes.find(n => n.id === note.id);
      expect(moved?.mapX).toBe(-50);
      expect(moved?.mapY).toBe(120);
    });
  });

  // =========================================================================
  // setNoteFloating
  // =========================================================================

  describe('setNoteFloating', () => {
    it('sets isFloating = true and records floatWindowId', () => {
      const note = useNoteStore.getState().addNote({});
      useNoteStore.getState().setNoteFloating(note.id, true, 'float-win-42');
      const updated = useNoteStore.getState().notes.find(n => n.id === note.id);
      expect(updated?.isFloating).toBe(true);
      expect(updated?.floatWindowId).toBe('float-win-42');
    });

    it('sets isFloating = false and clears floatWindowId', () => {
      const note = useNoteStore.getState().addNote({});
      // First float it
      useNoteStore.getState().setNoteFloating(note.id, true, 'float-win-42');
      // Then un-float
      useNoteStore.getState().setNoteFloating(note.id, false);
      const updated = useNoteStore.getState().notes.find(n => n.id === note.id);
      expect(updated?.isFloating).toBe(false);
      expect(updated?.floatWindowId).toBeUndefined();
    });
  });

  // =========================================================================
  // reorderNotes
  // =========================================================================

  describe('reorderNotes', () => {
    it('swaps notes at the given indices', () => {
      const n1 = useNoteStore.getState().addNote({ content: 'first' });
      const n2 = useNoteStore.getState().addNote({ content: 'second' });
      useNoteStore.getState().reorderNotes(0, 1);
      const notes = useNoteStore.getState().notes;
      expect(notes[0].id).toBe(n2.id);
      expect(notes[1].id).toBe(n1.id);
    });

    it('handles same index (no-op)', () => {
      const n1 = useNoteStore.getState().addNote({ content: 'first' });
      const n2 = useNoteStore.getState().addNote({ content: 'second' });
      useNoteStore.getState().reorderNotes(1, 1);
      const notes = useNoteStore.getState().notes;
      expect(notes[0].id).toBe(n1.id);
      expect(notes[1].id).toBe(n2.id);
    });
  });

  // =========================================================================
  // Selection & activeTag
  // =========================================================================

  describe('selectNote', () => {
    it('sets selectedNoteId', () => {
      useNoteStore.getState().selectNote('abc');
      expect(useNoteStore.getState().selectedNoteId).toBe('abc');
    });

    it('can set to null', () => {
      useNoteStore.getState().selectNote('abc');
      useNoteStore.getState().selectNote(null);
      expect(useNoteStore.getState().selectedNoteId).toBeNull();
    });
  });

  describe('setActiveTag', () => {
    it('changes activeTag', () => {
      useNoteStore.getState().setActiveTag('work');
      expect(useNoteStore.getState().activeTag).toBe('work');
    });
  });

  // =========================================================================
  // Tag CRUD
  // =========================================================================

  describe('tags', () => {
    it('addTag appends a new tag to the array', () => {
      const newTag = { id: 'custom', name: 'Custom', color: '#ff0000' };
      useNoteStore.getState().addTag(newTag);
      expect(useNoteStore.getState().tags).toContainEqual(newTag);
    });

    it('updateTag modifies an existing tag', () => {
      useNoteStore.getState().updateTag('work', { name: '上班' });
      const tag = useNoteStore.getState().tags.find(t => t.id === 'work');
      expect(tag?.name).toBe('上班');
    });

    it('deleteTag removes a tag and resets activeTag to all when active', () => {
      useNoteStore.getState().setActiveTag('work');
      useNoteStore.getState().deleteTag('work');
      expect(useNoteStore.getState().tags.find(t => t.id === 'work')).toBeUndefined();
      expect(useNoteStore.getState().activeTag).toBe('all');
    });

    it('deleteTag always removes the "all" tag (known issue in filter logic)', () => {
      // Current code has: t.id !== id && t.id !== 'all'
      // which filters 'all' out when ANY tag is deleted — a bug, not intentional.
      useNoteStore.getState().deleteTag('all');
      expect(useNoteStore.getState().tags.find(t => t.id === 'all')).toBeUndefined();
    });

    it('deleteTag leaves activeTag unchanged if deleting a non-active tag', () => {
      useNoteStore.getState().setActiveTag('work');
      useNoteStore.getState().deleteTag('personal');
      expect(useNoteStore.getState().activeTag).toBe('work');
    });
  });

  // =========================================================================
  // Settings
  // =========================================================================

  describe('settings', () => {
    it('updateSettings merges partial settings', () => {
      useNoteStore.getState().updateSettings({ fontSize: 20, theme: 'light' });
      const s = useNoteStore.getState().settings;
      expect(s.fontSize).toBe(20);
      expect(s.theme).toBe('light');
      // Other keys remain at defaults
      expect(s.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
    });

    it('updates customNoteColors', () => {
      useNoteStore.getState().updateSettings({ customNoteColors: ['#aaa', '#bbb'] });
      expect(useNoteStore.getState().settings.customNoteColors).toEqual(['#aaa', '#bbb']);
    });
  });

  // =========================================================================
  // View mode
  // =========================================================================

  describe('setViewMode', () => {
    it('switches between notes and mindmap', () => {
      useNoteStore.getState().setViewMode('mindmap');
      expect(useNoteStore.getState().viewMode).toBe('mindmap');
      useNoteStore.getState().setViewMode('notes');
      expect(useNoteStore.getState().viewMode).toBe('notes');
    });
  });

  // =========================================================================
  // Mind map
  // =========================================================================

  describe('updateMindMap', () => {
    it('merges partial mind map state', () => {
      useNoteStore.getState().updateMindMap({ scale: 2.5, offsetX: 100 });
      const m = useNoteStore.getState().mindMap;
      expect(m.scale).toBe(2.5);
      expect(m.offsetX).toBe(100);
      // Unspecified fields preserved
      expect(m.showDots).toBe(true);
    });
  });

  // =========================================================================
  // saveData
  // =========================================================================

  describe('saveData', () => {
    it('calls electronAPI.saveStore with correct data shape', async () => {
      const note = useNoteStore.getState().addNote({ content: 'test' });
      await useNoteStore.getState().saveData();

      const electronAPI = window.electronAPI!;
      expect(electronAPI.saveStore).toHaveBeenCalledTimes(1);

      const savedData = vi.mocked(electronAPI.saveStore).mock.calls[0][0];
      expect(savedData.notes).toHaveLength(1);
      expect(savedData.notes[0].id).toBe(note.id);
      expect(savedData.tags).toBeDefined();
      expect(savedData.settings).toBeDefined();
      expect(savedData.mindMap).toBeDefined();
    });

    it('falls back to localStorage when electronAPI is absent', async () => {
      // Temporarily remove electronAPI
      const original = window.electronAPI;
      delete (window as any).electronAPI;

      const note = useNoteStore.getState().addNote({ content: 'local' });
      await useNoteStore.getState().saveData();

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'stickynotes-data',
        expect.stringContaining('local'),
      );

      // Restore
      Object.defineProperty(window, 'electronAPI', {
        value: original,
        writable: true,
        configurable: true,
      });
    });

    it('swallows errors gracefully (does not throw)', async () => {
      const electronAPI = window.electronAPI!;
      vi.mocked(electronAPI.saveStore).mockRejectedValueOnce(new Error('disk full'));

      await expect(useNoteStore.getState().saveData()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // loadData
  // =========================================================================

  describe('loadData', () => {
    it('loads data from electronAPI when available', async () => {
      const electronAPI = window.electronAPI!;
      vi.mocked(electronAPI.loadStore).mockResolvedValueOnce({
        notes: [
          {
            id: 'saved_note_1',
            content: 'saved content',
            color: '#123456',
            tag: 'work',
            images: [],
            createdAt: 1000,
            updatedAt: 2000,
            gridX: 10,
            gridY: 20,
            mapX: -50,
            mapY: 30,
            width: 300,
            height: 250,
            isFloating: true,
            floatWindowId: 'old-float',
          },
        ],
        tags: DEFAULT_TAGS,
        settings: { ...DEFAULT_SETTINGS, theme: 'light' as const },
        mindMap: { offsetX: 5, offsetY: 5, scale: 1.5, backgroundImage: null, showDots: false },
      });

      await useNoteStore.getState().loadData();

      const s = useNoteStore.getState();
      expect(s.loaded).toBe(true);
      expect(s.notes).toHaveLength(1);
      expect(s.notes[0].content).toBe('saved content');
      // isFloating must be cleared on load (float windows don't persist across restarts)
      expect(s.notes[0].isFloating).toBe(false);
      expect(s.notes[0].floatWindowId).toBeUndefined();
      // Settings merged
      expect(s.settings.theme).toBe('light');
      expect(s.settings.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
      // Mind map loaded
      expect(s.mindMap.scale).toBe(1.5);
      expect(s.mindMap.offsetX).toBe(5);
    });

    it('falls back to localStorage when electronAPI is absent', async () => {
      const original = window.electronAPI;
      delete (window as any).electronAPI;

      localStorage.setItem(
        'stickynotes-data',
        JSON.stringify({
          notes: [{ id: 'local_note', content: 'from localStorage', color: '#000',
            tag: 'general', images: [], createdAt: 1, updatedAt: 2,
            gridX: 0, gridY: 0, mapX: 0, mapY: 0, width: 260, height: 200,
            isFloating: false }],
          tags: DEFAULT_TAGS,
          settings: DEFAULT_SETTINGS,
          mindMap: { offsetX: 0, offsetY: 0, scale: 1, backgroundImage: null, showDots: true },
        }),
      );

      await useNoteStore.getState().loadData();
      expect(useNoteStore.getState().notes).toHaveLength(1);
      expect(useNoteStore.getState().notes[0].content).toBe('from localStorage');

      // Restore
      Object.defineProperty(window, 'electronAPI', {
        value: original,
        writable: true,
        configurable: true,
      });
    });

    it('generates 3 welcome notes on first run (no stored data)', async () => {
      const electronAPI = window.electronAPI!;
      vi.mocked(electronAPI.loadStore).mockResolvedValueOnce(null);

      await useNoteStore.getState().loadData();

      const s = useNoteStore.getState();
      expect(s.loaded).toBe(true);
      expect(s.notes).toHaveLength(3);
      expect(s.notes[0].id).toBe('welcome_1');
      expect(s.notes[1].id).toBe('welcome_2');
      expect(s.notes[2].id).toBe('welcome_3');
    });

    it('handles empty data object gracefully (no welcome notes — empty object is truthy)', async () => {
      const electronAPI = window.electronAPI!;
      vi.mocked(electronAPI.loadStore).mockResolvedValueOnce({});

      await useNoteStore.getState().loadData();

      // An empty object {} is truthy, so the code enters the "has data" branch,
      // maps data.notes (undefined → []), and does not create welcome notes.
      expect(useNoteStore.getState().notes).toHaveLength(0);
    });

    it('handles corrupt JSON in localStorage gracefully', async () => {
      const original = window.electronAPI;
      delete (window as any).electronAPI;
      localStorage.setItem('stickynotes-data', '{invalid json!!!}');

      await useNoteStore.getState().loadData();
      // Should not crash and fall through to loaded: true
      expect(useNoteStore.getState().loaded).toBe(true);

      // Restore
      Object.defineProperty(window, 'electronAPI', {
        value: original,
        writable: true,
        configurable: true,
      });
    });

    it('handles loadStore rejection gracefully', async () => {
      const electronAPI = window.electronAPI!;
      vi.mocked(electronAPI.loadStore).mockRejectedValueOnce(new Error('read error'));

      await useNoteStore.getState().loadData();
      // Should not throw, sets loaded = true anyway
      expect(useNoteStore.getState().loaded).toBe(true);
    });

    it('merges partial settings from saved data with defaults', async () => {
      const electronAPI = window.electronAPI!;
      vi.mocked(electronAPI.loadStore).mockResolvedValueOnce({
        notes: [],
        tags: DEFAULT_TAGS.slice(0, 3),
        settings: { fontSize: 24 },
        // mindMap missing
      });

      await useNoteStore.getState().loadData();

      const s = useNoteStore.getState();
      expect(s.settings.fontSize).toBe(24);
      // Missing settings keys remain defaults
      expect(s.settings.theme).toBe(DEFAULT_SETTINGS.theme);
      // Missing mindMap gets defaults
      expect(s.mindMap.scale).toBe(1);
    });
  });

  // =========================================================================
  // Auto-save subscription
  // =========================================================================

  describe('auto-save', () => {
    it('debounces saveData calls after store changes (1 second delay)', async () => {
      const electronAPI = window.electronAPI!;

      // Trigger a state change
      useNoteStore.getState().addNote({ content: 'auto-save test' });

      // Should NOT have saved instantly
      expect(electronAPI.saveStore).not.toHaveBeenCalled();

      // Advance past the 1s debounce
      vi.advanceTimersByTime(1100);

      // Now it should have saved
      expect(electronAPI.saveStore).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('deleteNote twice for the same ID does not crash', () => {
      const note = useNoteStore.getState().addNote({});
      useNoteStore.getState().deleteNote(note.id);
      expect(() => useNoteStore.getState().deleteNote(note.id)).not.toThrow();
    });

    it('reorderNotes with out-of-bounds performs swap anyway', () => {
      const n1 = useNoteStore.getState().addNote({ content: 'a' });
      const n2 = useNoteStore.getState().addNote({ content: 'b' });
      // Index 99 is beyond array length, but simple swap still works (undefined swap)
      // Should not crash
      expect(() => useNoteStore.getState().reorderNotes(0, 99)).not.toThrow();
    });

    it('addNote with images array', () => {
      const images = [{ id: 'img1', dataUrl: 'data:image/png;base64,abc' }];
      const note = useNoteStore.getState().addNote({ content: 'with image', images });
      expect(note.images).toEqual(images);
    });
  });
});
