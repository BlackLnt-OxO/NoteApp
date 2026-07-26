import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCanvasStore } from '../useCanvasStore';
import type { Stroke, TextNodeData } from '../types';

// Reset store before each test
beforeEach(() => {
  useCanvasStore.setState({
    objects: [],
    camera: { x: 0, y: 0, zoom: 1 },
    activeTool: 'pen',
    brushSettings: {
      size: 8,
      opacity: 1,
      hardness: 0.8,
      spacing: 0.3,
      smoothing: 0.5,
      color: 'rgba(255,255,255,0.95)',
      pressureSize: true,
      pressureOpacity: false,
    },
    showDotGrid: true,
    editingTextId: null,
    history: [],
    redoStack: [],
    loaded: false,
  });
  localStorage.clear();
});

function makeStroke(id = 's1'): Stroke {
  return {
    id,
    type: 'stroke',
    points: [
      { x: 10, y: 20, size: 8, opacity: 1, pressure: 0.8, tiltX: 0, tiltY: 0 },
      { x: 30, y: 40, size: 8, opacity: 1, pressure: 0.8, tiltX: 0, tiltY: 0 },
    ],
    brushSettings: {
      size: 8,
      opacity: 1,
      hardness: 0.8,
      spacing: 0.3,
      smoothing: 0.5,
      color: '#ffffff',
      pressureSize: true,
      pressureOpacity: false,
    },
    compositeOperation: 'source-over',
    createdAt: Date.now(),
  };
}

describe('useCanvasStore', () => {
  describe('initial state', () => {
    it('has correct defaults', () => {
      const state = useCanvasStore.getState();
      expect(state.objects).toEqual([]);
      expect(state.camera).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(state.activeTool).toBe('pen');
      expect(state.brushSettings.size).toBe(8);
      expect(state.showDotGrid).toBe(true);
      expect(state.history).toEqual([]);
      expect(state.redoStack).toEqual([]);
    });
  });

  describe('setCamera', () => {
    it('partially updates camera', () => {
      useCanvasStore.getState().setCamera({ zoom: 2 });
      expect(useCanvasStore.getState().camera.zoom).toBe(2);
      expect(useCanvasStore.getState().camera.x).toBe(0); // unchanged
    });
  });

  describe('setActiveTool', () => {
    it('changes the active tool', () => {
      useCanvasStore.getState().setActiveTool('eraser');
      expect(useCanvasStore.getState().activeTool).toBe('eraser');
    });
  });

  describe('setBrushSettings', () => {
    it('partially updates brush settings', () => {
      useCanvasStore.getState().setBrushSettings({ size: 20, color: '#ff0000' });
      const bs = useCanvasStore.getState().brushSettings;
      expect(bs.size).toBe(20);
      expect(bs.color).toBe('#ff0000');
      expect(bs.opacity).toBe(1); // unchanged
    });
  });

  describe('addStroke', () => {
    it('appends a stroke and pushes history', () => {
      const stroke = makeStroke();
      useCanvasStore.getState().addStroke(stroke);
      const state = useCanvasStore.getState();
      expect(state.objects).toHaveLength(1);
      expect(state.objects[0]).toEqual(stroke);
      expect(state.history).toHaveLength(1); // pushed previous empty state
    });
  });

  describe('addTextNode', () => {
    it('creates a text node at the given position', () => {
      const id = useCanvasStore.getState().addTextNode(100, 200);
      const state = useCanvasStore.getState();
      expect(state.objects).toHaveLength(1);
      expect(state.objects[0].type).toBe('text');
      if (state.objects[0].type === 'text') {
        expect(state.objects[0].x).toBe(100);
        expect(state.objects[0].y).toBe(200);
      }
      expect(state.editingTextId).toBe(id);
    });
  });

  describe('updateTextNode', () => {
    it('updates text node fields', () => {
      const id = useCanvasStore.getState().addTextNode(0, 0);
      useCanvasStore.getState().updateTextNode(id, { content: 'Hello', width: 200 });
      const obj = useCanvasStore.getState().objects.find((o) => o.id === id);
      expect(obj).toBeDefined();
      if (obj?.type === 'text') {
        expect(obj.content).toBe('Hello');
        expect(obj.width).toBe(200);
      }
    });
  });

  describe('deleteTextNode', () => {
    it('removes a text node', () => {
      const id = useCanvasStore.getState().addTextNode(0, 0);
      useCanvasStore.getState().deleteTextNode(id);
      expect(useCanvasStore.getState().objects).toHaveLength(0);
    });
  });

  describe('undo / redo', () => {
    it('undo restores previous state', () => {
      const stroke = makeStroke('s1');
      useCanvasStore.getState().addStroke(stroke);
      expect(useCanvasStore.getState().objects).toHaveLength(1);

      useCanvasStore.getState().undo();
      expect(useCanvasStore.getState().objects).toHaveLength(0);
    });

    it('redo restores the undone state', () => {
      const stroke = makeStroke('s1');
      useCanvasStore.getState().addStroke(stroke);
      useCanvasStore.getState().undo();
      expect(useCanvasStore.getState().objects).toHaveLength(0);

      useCanvasStore.getState().redo();
      expect(useCanvasStore.getState().objects).toHaveLength(1);
    });

    it('undo is a no-op with empty history', () => {
      useCanvasStore.getState().undo();
      expect(useCanvasStore.getState().objects).toHaveLength(0);
    });

    it('redo is a no-op with empty redoStack', () => {
      useCanvasStore.getState().redo();
      expect(useCanvasStore.getState().objects).toHaveLength(0);
    });

    it('redo stack is cleared after a new action', () => {
      const s1 = makeStroke('s1');
      const s2 = makeStroke('s2');
      useCanvasStore.getState().addStroke(s1);
      useCanvasStore.getState().undo();
      expect(useCanvasStore.getState().redoStack).toHaveLength(1);

      useCanvasStore.getState().addStroke(s2);
      expect(useCanvasStore.getState().redoStack).toHaveLength(0);
    });
  });

  describe('clearCanvas', () => {
    it('empties all objects', () => {
      useCanvasStore.getState().addStroke(makeStroke('s1'));
      useCanvasStore.getState().addStroke(makeStroke('s2'));
      useCanvasStore.getState().clearCanvas();
      expect(useCanvasStore.getState().objects).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('saves to localStorage', async () => {
      useCanvasStore.setState({ loaded: true });
      useCanvasStore.getState().addStroke(makeStroke('s1'));
      await useCanvasStore.getState().saveCanvasData();

      const raw = localStorage.getItem('stickynotes-inkcanvas');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.objects).toHaveLength(1);
    });

    it('loads from localStorage', async () => {
      const data = {
        objects: [makeStroke('loaded')],
        camera: { x: 5, y: 10, zoom: 2 },
        showDotGrid: false,
      };
      localStorage.setItem('stickynotes-inkcanvas', JSON.stringify(data));

      await useCanvasStore.getState().loadCanvasData();
      const state = useCanvasStore.getState();
      expect(state.loaded).toBe(true);
      expect(state.objects).toHaveLength(1);
      expect(state.camera.x).toBe(5);
      expect(state.camera.zoom).toBe(2);
      expect(state.showDotGrid).toBe(false);
    });

    it('handles empty localStorage on load', async () => {
      await useCanvasStore.getState().loadCanvasData();
      expect(useCanvasStore.getState().loaded).toBe(true);
      expect(useCanvasStore.getState().objects).toEqual([]);
    });
  });

  describe('MAX_HISTORY limit', () => {
    it('evicts oldest history entries when limit is exceeded', () => {
      for (let i = 0; i < 55; i++) {
        useCanvasStore.getState().addStroke(makeStroke(`s${i}`));
      }
      // History should be capped at 50
      expect(useCanvasStore.getState().history.length).toBeLessThanOrEqual(50);
    });
  });
});
