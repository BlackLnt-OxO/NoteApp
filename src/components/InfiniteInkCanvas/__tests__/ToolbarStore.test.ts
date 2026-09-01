import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCanvasToolbarStore as useToolbarStore, usePdfToolbarStore } from '../useToolbarStore';
import { DEFAULT_TOOLBAR_STATE, TOOLBAR_STORAGE_KEY } from '../constants';

beforeEach(() => {
  useToolbarStore.setState({
    expanded: DEFAULT_TOOLBAR_STATE.expanded,
    width: DEFAULT_TOOLBAR_STATE.width,
    lastExpandedWidth: DEFAULT_TOOLBAR_STATE.lastExpandedWidth,
    top: DEFAULT_TOOLBAR_STATE.top,
    offset: DEFAULT_TOOLBAR_STATE.offset,
    side: DEFAULT_TOOLBAR_STATE.side,
    isDragging: false,
  });
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useToolbarStore', () => {
  describe('initial state', () => {
    it('has correct defaults', () => {
      const s = useToolbarStore.getState();
      expect(s.expanded).toBe(true);
      expect(s.width).toBe(240);
      expect(s.side).toBe('right');
      expect(s.offset).toBe(8);
      expect(s.isDragging).toBe(false);
    });
  });

  describe('toggle', () => {
    it('toggles expand ↔ collapse and preserves width', () => {
      const s = useToolbarStore.getState();
      s.toggle();
      expect(useToolbarStore.getState().expanded).toBe(false);
      s.toggle();
      expect(useToolbarStore.getState().expanded).toBe(true);
      expect(useToolbarStore.getState().width).toBe(240);
    });
  });

  describe('expand / collapse', () => {
    it('collapse saves lastExpandedWidth', () => {
      useToolbarStore.getState().setWidth(350);
      useToolbarStore.getState().collapse();
      expect(useToolbarStore.getState().lastExpandedWidth).toBe(350);
    });
  });

  describe('setSide', () => {
    it('changes dock side', () => {
      useToolbarStore.getState().setSide('left');
      expect(useToolbarStore.getState().side).toBe('left');
    });
  });

  describe('setIsDragging', () => {
    it('toggles drag state', () => {
      useToolbarStore.getState().setIsDragging(true);
      expect(useToolbarStore.getState().isDragging).toBe(true);
    });
  });

  describe('setPosition', () => {
    it('sets top and offset', () => {
      useToolbarStore.getState().setPosition(50, 20);
      const s = useToolbarStore.getState();
      expect(s.top).toBe(50);
      expect(s.offset).toBe(20);
    });
  });

  describe('clampPosition', () => {
    it('clamps negative top', () => {
      useToolbarStore.getState().setPosition(-50, 20);
      useToolbarStore.getState().clampPosition(1920, 1080);
      expect(useToolbarStore.getState().top).toBe(12);
    });
  });

  describe('persistence', () => {
    it('saves and loads to/from localStorage', () => {
      useToolbarStore.getState().setSide('left');
      useToolbarStore.getState().setWidth(300);
      useToolbarStore.getState().saveState();

      useToolbarStore.getState().reset();
      useToolbarStore.getState().loadState();

      const s = useToolbarStore.getState();
      expect(s.side).toBe('left');
      expect(s.width).toBe(300);
    });

    it('handles corrupt data', () => {
      localStorage.setItem(TOOLBAR_STORAGE_KEY, 'garbage');
      expect(() => useToolbarStore.getState().loadState()).not.toThrow();
    });

    it('migrates old rightOffset key to offset', () => {
      localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify({
        expanded: false, width: 300, lastExpandedWidth: 300, top: 10, rightOffset: 40, side: 'right',
      }));
      useToolbarStore.getState().loadState();
      expect(useToolbarStore.getState().offset).toBe(40);
    });
  });

  describe('reset', () => {
    it('resets to defaults', () => {
      const s = useToolbarStore.getState();
      s.setWidth(400); s.setSide('left'); s.toggle(); s.setIsDragging(true);
      s.reset();
      expect(useToolbarStore.getState().side).toBe('right');
      expect(useToolbarStore.getState().width).toBe(240);
      expect(useToolbarStore.getState().isDragging).toBe(false);
    });
  });

  describe('auto-save', () => {
    it('debounces save', () => {
      useToolbarStore.getState().toggle();
      vi.advanceTimersByTime(600);
      expect(localStorage.getItem(TOOLBAR_STORAGE_KEY)).toBeTruthy();
    });
  });

  describe('per-interface stores', () => {
    it('canvas and PDF toolbars keep independent memory', () => {
      useToolbarStore.getState().setSide('left');
      useToolbarStore.getState().setWidth(300);
      usePdfToolbarStore.getState().setSide('right');
      usePdfToolbarStore.getState().setWidth(200);

      expect(useToolbarStore.getState().side).toBe('left');
      expect(usePdfToolbarStore.getState().side).toBe('right');
      expect(useToolbarStore.getState().width).toBe(300);
      expect(usePdfToolbarStore.getState().width).toBe(200);
    });
  });
});
