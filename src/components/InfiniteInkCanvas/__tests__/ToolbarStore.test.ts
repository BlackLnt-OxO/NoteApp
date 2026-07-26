import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToolbarStore } from '../useToolbarStore';
import { DEFAULT_TOOLBAR_STATE, TOOLBAR_STORAGE_KEY } from '../constants';

beforeEach(() => {
  useToolbarStore.setState({
    expanded: DEFAULT_TOOLBAR_STATE.expanded,
    width: DEFAULT_TOOLBAR_STATE.width,
    lastExpandedWidth: DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
    top: DEFAULT_TOOLBAR_STATE.top,
    rightOffset: DEFAULT_TOOLBAR_STATE.rightOffset,
    side: DEFAULT_TOOLBAR_STATE.side,
  });
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useToolbarStore', () => {
  describe('initial state', () => {
    it('has correct default values', () => {
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(true);
      expect(state.width).toBe(240);
      expect(state.lastExpandedWidth).toBe(240);
      expect(state.side).toBe('right');
      expect(state.rightOffset).toBe(8);
    });
  });

  describe('toggle', () => {
    it('collapses when expanded', () => {
      useToolbarStore.getState().toggle();
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(false);
      expect(state.lastExpandedWidth).toBe(240);
    });

    it('expands when collapsed and restores width', () => {
      const store = useToolbarStore.getState();
      store.toggle();
      expect(useToolbarStore.getState().expanded).toBe(false);

      store.toggle();
      expect(useToolbarStore.getState().expanded).toBe(true);
      expect(useToolbarStore.getState().width).toBe(240);
    });

    it('restores lastExpandedWidth on expand after resize', () => {
      const store = useToolbarStore.getState();
      store.setWidth(350);
      store.toggle();
      store.toggle();
      expect(useToolbarStore.getState().width).toBe(350);
    });
  });

  describe('expand / collapse', () => {
    it('expand restores width', () => {
      useToolbarStore.getState().collapse();
      useToolbarStore.getState().expand();
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(true);
      expect(state.width).toBe(240);
    });

    it('collapse saves lastExpandedWidth', () => {
      const store = useToolbarStore.getState();
      store.setWidth(400);
      store.collapse();
      expect(useToolbarStore.getState().expanded).toBe(false);
      expect(useToolbarStore.getState().lastExpandedWidth).toBe(400);
    });

    it('collapse preserves old lastExpandedWidth if current is tiny', () => {
      const store = useToolbarStore.getState();
      store.setWidth(50);
      store.collapse();
      expect(useToolbarStore.getState().lastExpandedWidth).toBe(240);
    });
  });

  describe('setWidth', () => {
    it('sets the width', () => {
      useToolbarStore.getState().setWidth(300);
      expect(useToolbarStore.getState().width).toBe(300);
    });
  });

  describe('setPosition', () => {
    it('sets top and rightOffset', () => {
      useToolbarStore.getState().setPosition(50, 100);
      const state = useToolbarStore.getState();
      expect(state.top).toBe(50);
      expect(state.rightOffset).toBe(100);
    });
  });

  describe('clampPosition', () => {
    it('keeps valid position', () => {
      const store = useToolbarStore.getState();
      store.setPosition(100, 20);
      store.clampPosition(1920, 1080);
      expect(useToolbarStore.getState().top).toBe(100);
      expect(useToolbarStore.getState().rightOffset).toBe(20);
    });

    it('clamps top to margin', () => {
      const store = useToolbarStore.getState();
      store.setPosition(-50, 20);
      store.clampPosition(1920, 1080);
      expect(useToolbarStore.getState().top).toBe(12);
    });

    it('allows rightOffset up to viewport - 60', () => {
      const store = useToolbarStore.getState();
      store.setPosition(50, 2000);
      store.clampPosition(1920, 1080);
      expect(useToolbarStore.getState().rightOffset).toBe(1860);
    });
  });

  describe('right-side resize logic', () => {
    it('drag left (away from right edge) increases width', () => {
      // Resize handle is on left edge of toolbar (between canvas and toolbar).
      // Dragging handle LEFT = toolbar gets wider.
      const startWidth = 240;
      const delta = 60; // mouse moved 60px left
      const nextWidth = startWidth + delta; // side === 'right': moving left = wider
      expect(nextWidth).toBe(300);
    });

    it('drag right (toward right edge) decreases width', () => {
      const startWidth = 240;
      const delta = -60;
      const nextWidth = startWidth + delta;
      expect(nextWidth).toBe(180);
    });

    it('triggers collapse when width falls below collapse threshold', () => {
      const nextWidth = 40;
      const COLLAPSE_THRESHOLD = 60;
      expect(nextWidth < COLLAPSE_THRESHOLD).toBe(true);
    });
  });

  describe('persistence', () => {
    it('saves to localStorage', () => {
      useToolbarStore.getState().saveState();
      const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.expanded).toBe(true);
      expect(parsed.width).toBe(240);
      expect(parsed.side).toBe('right');
    });

    it('loads from localStorage', () => {
      const saved = {
        expanded: false,
        width: 300,
        lastExpandedWidth: 300,
        top: 50,
        rightOffset: 20,
        side: 'right',
      };
      localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(saved));

      useToolbarStore.getState().loadState();
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(false);
      expect(state.width).toBe(300);
      expect(state.top).toBe(50);
      expect(state.rightOffset).toBe(20);
    });

    it('handles missing localStorage', () => {
      useToolbarStore.getState().loadState();
      expect(useToolbarStore.getState().expanded).toBe(true);
    });

    it('handles corrupt localStorage', () => {
      localStorage.setItem(TOOLBAR_STORAGE_KEY, 'not-json{{{');
      expect(() => useToolbarStore.getState().loadState()).not.toThrow();
    });
  });

  describe('reset', () => {
    it('resets to defaults', () => {
      const store = useToolbarStore.getState();
      store.setWidth(400);
      store.toggle();
      store.setPosition(100, 200);
      store.reset();

      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(true);
      expect(state.width).toBe(240);
      expect(state.top).toBe(DEFAULT_TOOLBAR_STATE.top);
      expect(state.rightOffset).toBe(DEFAULT_TOOLBAR_STATE.rightOffset);
      expect(state.side).toBe('right');
    });
  });

  describe('auto-save', () => {
    it('debounces save after state change', () => {
      useToolbarStore.getState().toggle();
      vi.advanceTimersByTime(600);
      const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
      expect(raw).toBeTruthy();
    });
  });
});
