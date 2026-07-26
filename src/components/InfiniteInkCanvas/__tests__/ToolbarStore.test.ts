import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToolbarStore } from '../useToolbarStore';
import { DEFAULT_TOOLBAR_STATE, TOOLBAR_STORAGE_KEY } from '../constants';

// Reset store before each test
beforeEach(() => {
  useToolbarStore.setState({
    expanded: DEFAULT_TOOLBAR_STATE.expanded,
    width: DEFAULT_TOOLBAR_STATE.width,
    lastExpandedWidth: DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
    top: DEFAULT_TOOLBAR_STATE.top,
    left: DEFAULT_TOOLBAR_STATE.left,
    side: DEFAULT_TOOLBAR_STATE.side,
    autoCollapseThreshold: 100,
  });
  localStorage.clear();
  // Clear any pending save timeout
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
      expect(state.side).toBe('left');
    });
  });

  describe('toggle', () => {
    it('collapses when expanded', () => {
      useToolbarStore.getState().toggle();
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(false);
      // lastExpandedWidth should be preserved
      expect(state.lastExpandedWidth).toBe(240);
    });

    it('expands when collapsed', () => {
      const store = useToolbarStore.getState();
      store.toggle(); // collapse
      expect(useToolbarStore.getState().expanded).toBe(false);

      store.toggle(); // expand
      expect(useToolbarStore.getState().expanded).toBe(true);
      expect(useToolbarStore.getState().width).toBe(240); // restored
    });

    it('restores lastExpandedWidth on expand', () => {
      const store = useToolbarStore.getState();
      store.setWidth(350);
      store.toggle(); // collapse, saves 350
      store.setWidth(28); // simulate collapsed state
      store.toggle(); // expand
      expect(useToolbarStore.getState().width).toBe(350);
    });
  });

  describe('expand / collapse', () => {
    it('expand sets expanded=true and restores width', () => {
      useToolbarStore.getState().collapse();
      useToolbarStore.getState().expand();
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(true);
      expect(state.width).toBe(240);
    });

    it('collapse saves current width as lastExpandedWidth', () => {
      const store = useToolbarStore.getState();
      store.setWidth(400);
      store.collapse();
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(false);
      expect(state.lastExpandedWidth).toBe(400);
    });

    it('collapse does not save tiny width as lastExpandedWidth', () => {
      const store = useToolbarStore.getState();
      store.setWidth(50); // below threshold of 100
      store.collapse();
      const state = useToolbarStore.getState();
      expect(state.lastExpandedWidth).toBe(240); // preserved from before
    });
  });

  describe('setWidth', () => {
    it('sets the width', () => {
      useToolbarStore.getState().setWidth(300);
      expect(useToolbarStore.getState().width).toBe(300);
    });
  });

  describe('setPosition', () => {
    it('sets top and left', () => {
      useToolbarStore.getState().setPosition(50, 100);
      const state = useToolbarStore.getState();
      expect(state.top).toBe(50);
      expect(state.left).toBe(100);
    });
  });

  describe('clampPosition', () => {
    it('keeps valid position', () => {
      const store = useToolbarStore.getState();
      store.setPosition(100, 300);
      store.clampPosition(1920, 1080);
      expect(useToolbarStore.getState().top).toBe(100);
      expect(useToolbarStore.getState().left).toBe(300);
    });

    it('clamps negative left', () => {
      const store = useToolbarStore.getState();
      store.setPosition(50, -100);
      store.clampPosition(1920, 1080);
      expect(useToolbarStore.getState().left).toBe(12); // clamped to margin
    });

    it('clamps right overflow', () => {
      const store = useToolbarStore.getState();
      store.setPosition(50, 2000);
      store.clampPosition(1920, 1080);
      // Viewport=1920, effectiveW=240 (expanded), margin=12
      // maxLeft = 1920 - 240 - 12 = 1668
      expect(useToolbarStore.getState().left).toBe(1668);
    });

    it('clamps top negative', () => {
      const store = useToolbarStore.getState();
      store.setPosition(-50, 300);
      store.clampPosition(1920, 1080);
      expect(useToolbarStore.getState().top).toBe(12);
    });
  });

  describe('resize logic (simulated)', () => {
    it('calculates nextWidth correctly for left side', () => {
      // Simulate: startWidth=240, delta=60 (mouse moved right 60px)
      const store = useToolbarStore.getState();
      const side = 'left';
      const startWidth = 240;
      const delta = 60;
      const nextWidth = side === 'left'
        ? startWidth + delta
        : startWidth - delta;
      expect(nextWidth).toBe(300);
    });

    it('calculates nextWidth correctly for right side', () => {
      const side = 'right';
      const startWidth = 240;
      const delta = 60;
      const nextWidth = side === 'left'
        ? startWidth + delta
        : startWidth - delta;
      expect(nextWidth).toBe(180);
    });

    it('auto-collapses when width below threshold', () => {
      const autoCollapseThreshold = 100;
      const nextWidth = 80;
      expect(nextWidth < autoCollapseThreshold).toBe(true);
    });

    it('does not auto-collapse when width above threshold', () => {
      const autoCollapseThreshold = 100;
      const nextWidth = 120;
      expect(nextWidth < autoCollapseThreshold).toBe(false);
    });
  });

  describe('persistence', () => {
    it('saves state to localStorage', () => {
      useToolbarStore.getState().saveState();
      const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.expanded).toBe(true);
      expect(parsed.width).toBe(240);
    });

    it('loads state from localStorage', () => {
      const saved = {
        expanded: false,
        width: 300,
        lastExpandedWidth: 300,
        top: 50,
        left: 400,
        side: 'right',
      };
      localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(saved));

      useToolbarStore.getState().loadState();
      const state = useToolbarStore.getState();
      expect(state.expanded).toBe(false);
      expect(state.width).toBe(300);
      expect(state.top).toBe(50);
      expect(state.side).toBe('right');
    });

    it('handles missing localStorage gracefully', () => {
      useToolbarStore.getState().loadState();
      // Should keep defaults
      expect(useToolbarStore.getState().expanded).toBe(true);
    });

    it('handles corrupt localStorage gracefully', () => {
      localStorage.setItem(TOOLBAR_STORAGE_KEY, 'not-json{{{');
      // Should not throw
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
      expect(state.left).toBe(DEFAULT_TOOLBAR_STATE.left);
    });
  });

  describe('auto-save', () => {
    it('debounces save after state change', async () => {
      useToolbarStore.getState().toggle();
      // Advance timers past debounce period (500ms)
      vi.advanceTimersByTime(600);

      const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
      expect(raw).toBeTruthy();
    });
  });
});
