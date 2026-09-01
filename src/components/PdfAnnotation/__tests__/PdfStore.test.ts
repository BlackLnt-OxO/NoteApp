import { describe, it, expect, beforeEach } from 'vitest';
import { usePdfStore } from '../PdfStore';
import type { PdfStroke } from '../PdfTypes';

function makeStroke(id = 's1'): PdfStroke {
  return {
    id, type: 'stroke',
    points: [{ x: 10, y: 20, pressure: 0.8, t: 1 }, { x: 30, y: 40, pressure: 0.8, t: 17 }],
    color: '#ffffff', size: 8, opacity: 1, smoothing: 0.35,
    compositeOperation: 'source-over', createdAt: Date.now(),
  };
}

beforeEach(() => {
  usePdfStore.getState().reset();
});

describe('initial state', () => {
  it('has sane defaults', () => {
    const s = usePdfStore.getState();
    expect(s.fileName).toBeNull();
    expect(s.numPages).toBe(0);
    expect(s.currentPage).toBe(1);
    expect(s.strokes).toEqual({});
    expect(s.activeTool).toBe('pen');
    expect(s.renderEpoch).toBe(0);
  });
});

describe('commitStroke', () => {
  it('appends to the given page and records history', () => {
    const stroke = makeStroke('a');
    usePdfStore.getState().commitStroke(1, stroke);
    const s = usePdfStore.getState();
    expect(s.strokes[1]).toEqual([stroke]);
    expect(s.history[1]).toHaveLength(1);
  });

  it('is additive per page (pages are isolated)', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('p1'));
    usePdfStore.getState().commitStroke(2, makeStroke('p2'));
    const s = usePdfStore.getState();
    expect(s.strokes[1]).toHaveLength(1);
    expect(s.strokes[2]).toHaveLength(1);
  });

  it('does NOT bump renderEpoch (canvas rasterized it already)', () => {
    const before = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().commitStroke(1, makeStroke());
    expect(usePdfStore.getState().renderEpoch).toBe(before);
  });

  it('clears the page redo stack', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().redoStack[1]).toHaveLength(1);
    usePdfStore.getState().commitStroke(1, makeStroke('b'));
    expect(usePdfStore.getState().redoStack[1]).toHaveLength(0);
  });
});

describe('undo / redo', () => {
  it('undo restores the previous array by reference (no deep clone)', () => {
    const s1 = makeStroke('a');
    const s2 = makeStroke('b');
    usePdfStore.getState().commitStroke(1, s1);
    usePdfStore.getState().commitStroke(1, s2);
    const historyEntry = usePdfStore.getState().history[1][1]; // state containing only s1
    usePdfStore.getState().undo();
    const after = usePdfStore.getState().strokes[1];
    // The history entry IS the previous array and stroke — same references,
    // no deep clone happened.
    expect(after).toBe(historyEntry);
    expect(after[0]).toBe(s1);
  });

  it('undo/redo bump renderEpoch', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    const e1 = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().renderEpoch).toBe(e1 + 1);
    usePdfStore.getState().redo();
    expect(usePdfStore.getState().renderEpoch).toBe(e1 + 2);
  });

  it('undo is per current page', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('p1a'));
    usePdfStore.getState().commitStroke(1, makeStroke('p1b'));
    usePdfStore.getState().commitStroke(2, makeStroke('p2a'));
    usePdfStore.setState({ currentPage: 2 });
    usePdfStore.getState().undo();
    // Page 1 untouched, page 2 reverted to its previous (empty) state
    expect(usePdfStore.getState().strokes[1]).toHaveLength(2);
    expect(usePdfStore.getState().strokes[2]).toHaveLength(0);
  });

  it('redo restores the undone stroke', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().strokes[1]).toHaveLength(0);
    usePdfStore.getState().redo();
    expect(usePdfStore.getState().strokes[1]).toHaveLength(1);
  });

  it('undo is a no-op with empty history', () => {
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().renderEpoch).toBe(e);
  });
});

describe('removeStroke / deleteSelected / clearPage', () => {
  it('removeStroke deletes a single stroke', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().removeStroke(1, 'a');
    expect(usePdfStore.getState().strokes[1]).toHaveLength(0);
  });

  it('deleteSelected removes selected strokes and clears selection', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().commitStroke(1, makeStroke('b'));
    usePdfStore.setState({ selectedIds: ['a', 'b'] });
    usePdfStore.getState().deleteSelected();
    expect(usePdfStore.getState().strokes[1]).toHaveLength(0);
    expect(usePdfStore.getState().selectedIds).toEqual([]);
  });

  it('clearPage empties only the current page', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().commitStroke(2, makeStroke('b'));
    usePdfStore.setState({ currentPage: 1 });
    usePdfStore.getState().clearPage();
    expect(usePdfStore.getState().strokes[1]).toHaveLength(0);
    expect(usePdfStore.getState().strokes[2]).toHaveLength(1);
  });
});

describe('moveStrokes', () => {
  it('moveStrokesLive moves without recording history', () => {
    const s = makeStroke('a');
    usePdfStore.getState().commitStroke(1, s);
    usePdfStore.getState().moveStrokesLive(1, ['a'], 5, 7);
    const st = usePdfStore.getState();
    expect(st.strokes[1][0].points[0].x).toBe(15);
    expect(st.history[1]).toHaveLength(1); // only the original commit
  });

  it('moveStrokes records history and bumps epoch', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().moveStrokes(1, ['a'], 10, 0);
    const st = usePdfStore.getState();
    expect(st.strokes[1][0].points[0].x).toBe(20);
    expect(st.history[1]).toHaveLength(2);
    expect(st.renderEpoch).toBe(e + 1);
    // undo restores the original position
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().strokes[1][0].points[0].x).toBe(10);
  });
});

describe('MAX_HISTORY', () => {
  it('evicts oldest entries when the limit is exceeded', () => {
    for (let i = 0; i < 55; i++) {
      usePdfStore.getState().commitStroke(1, makeStroke(`s${i}`));
    }
    expect(usePdfStore.getState().history[1].length).toBeLessThanOrEqual(50);
  });
});
