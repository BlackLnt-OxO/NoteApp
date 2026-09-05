import { describe, it, expect, beforeEach } from 'vitest';
import { usePdfStore, clampAnchorPages } from '../PdfStore';
import type { PdfStroke, PdfTextObject } from '../PdfTypes';
import { PDF_ANNOTATION_BLUE } from '../../../themeColors';

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
    expect(s.items).toEqual({});
    expect(s.activeTool).toBe('pen');
    expect(s.renderEpoch).toBe(0);
    expect(s.brush.color).toBe(PDF_ANNOTATION_BLUE); // fixed PDF default (not theme)
  });
});

describe('commitStroke', () => {
  it('appends to the given page and records history', () => {
    const stroke = makeStroke('a');
    usePdfStore.getState().commitStroke(1, stroke);
    const s = usePdfStore.getState();
    expect(s.items[1]).toEqual([stroke]);
    expect(s.history[1]).toHaveLength(1);
  });

  it('is additive per page (pages are isolated)', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('p1'));
    usePdfStore.getState().commitStroke(2, makeStroke('p2'));
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(1);
    expect(s.items[2]).toHaveLength(1);
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
    const after = usePdfStore.getState().items[1];
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
    expect(usePdfStore.getState().items[1]).toHaveLength(2);
    expect(usePdfStore.getState().items[2]).toHaveLength(0);
  });

  it('redo restores the undone stroke', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().items[1]).toHaveLength(0);
    usePdfStore.getState().redo();
    expect(usePdfStore.getState().items[1]).toHaveLength(1);
  });

  it('undo is a no-op with empty history', () => {
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().renderEpoch).toBe(e);
  });
});

describe('insert text object', () => {
  it('addTextNode creates a blue text card, sets editingTextId, records history', () => {
    const id = usePdfStore.getState().addTextNode(1, 12, 34);
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(1);
    const node = s.items[1][0] as PdfTextObject;
    expect(node.type).toBe('text');
    expect(node.x).toBe(12);
    expect(node.y).toBe(34);
    expect(node.color).toBe(PDF_ANNOTATION_BLUE);
    expect(node.content).toBe('');
    expect(s.editingTextId).toBe(id);
    expect(s.history[1]).toHaveLength(1); // undo will remove it
    expect(s.dirty).toBe(true);
  });

  it('is isolated per page', () => {
    usePdfStore.getState().addTextNode(1, 0, 0);
    usePdfStore.getState().addTextNode(2, 5, 5);
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(1);
    expect(s.items[2]).toHaveLength(1);
  });

  it('updateTextNode does NOT bump renderEpoch and marks dirty', () => {
    const id = usePdfStore.getState().addTextNode(1, 0, 0);
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().updateTextNode(1, id, { content: 'hello' });
    const s = usePdfStore.getState();
    expect((s.items[1][0] as PdfTextObject).content).toBe('hello');
    expect(s.renderEpoch).toBe(e);
    expect(s.dirty).toBe(true);
  });

  it('deleteTextNode removes it, clears editingTextId, and does NOT bump epoch', () => {
    const id = usePdfStore.getState().addTextNode(1, 0, 0);
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().deleteTextNode(1, id);
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(0);
    expect(s.editingTextId).toBeNull();
    expect(s.renderEpoch).toBe(e); // text is DOM-only → no tile rebuild
  });

  it('undo removes the inserted text card; redo restores it', () => {
    const id = usePdfStore.getState().addTextNode(1, 0, 0);
    usePdfStore.setState({ currentPage: 1 });
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().items[1]).toHaveLength(0);
    usePdfStore.getState().redo();
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(1);
    expect((s.items[1][0] as PdfTextObject).id).toBe(id);
  });
});

describe('insert image object', () => {
  it('addImageObject appends, clears pending, records history by default', () => {
    usePdfStore.getState().queueImageInsert('data:image/png;base64,x', 100, 60);
    usePdfStore.getState().addImageObject(1, { dataUrl: 'data:image/png;base64,x', x: 0, y: 0, width: 100, height: 60 });
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(1);
    expect((s.items[1][0] as { type: string }).type).toBe('image');
    expect(s.pendingImageInsert).toBeNull();
    expect(s.history[1]).toHaveLength(1);
  });

  it('supports batched inserts under ONE history entry (recordHistory=false)', () => {
    usePdfStore.getState().pushHistory(1);
    usePdfStore.getState().addImageObject(1, { dataUrl: 'a', x: 0, y: 0, width: 10, height: 10 }, false);
    usePdfStore.getState().addImageObject(1, { dataUrl: 'b', x: 5, y: 5, width: 10, height: 10 }, false);
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(2);
    expect(s.history[1]).toHaveLength(1);
  });

  it('updateImageObject does NOT bump renderEpoch', () => {
    usePdfStore.getState().addImageObject(1, { dataUrl: 'a', x: 0, y: 0, width: 10, height: 10 });
    const imageId = (usePdfStore.getState().items[1][0] as { id: string }).id;
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().updateImageObject(1, imageId, { x: 30, y: 40 });
    const s = usePdfStore.getState();
    expect((s.items[1][0] as { x: number }).x).toBe(30);
    expect(s.renderEpoch).toBe(e);
  });
});

describe('mixed stroke + object operations', () => {
  it('deleteObject bumps epoch and clears selection', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().addTextNode(1, 0, 0);
    const textId = (usePdfStore.getState().items[1][1] as PdfTextObject).id;
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.setState({ selectedIds: [textId] });
    usePdfStore.getState().deleteObject(1, textId);
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(1);
    expect(s.selectedIds).toEqual([]);
    expect(s.renderEpoch).toBe(e + 1);
  });

  it('deleteSelected removes strokes AND objects together', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    const tid = usePdfStore.getState().addTextNode(1, 0, 0);
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.setState({ selectedIds: ['a', tid] });
    usePdfStore.getState().deleteSelected();
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(0);
    expect(s.renderEpoch).toBe(e + 1);
  });

  it('clearPage empties objects too', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().addTextNode(1, 0, 0);
    usePdfStore.setState({ currentPage: 1 });
    usePdfStore.getState().clearPage();
    expect(usePdfStore.getState().items[1]).toHaveLength(0);
  });

  it('moveObjectsLive translates objects without recording history or bumping epoch', () => {
    usePdfStore.getState().addTextNode(1, 10, 20);
    const tid = (usePdfStore.getState().items[1][0] as PdfTextObject).id;
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().moveObjectsLive(1, [tid], 5, 7);
    const s = usePdfStore.getState();
    expect((s.items[1][0] as PdfTextObject).x).toBe(15);
    expect((s.items[1][0] as PdfTextObject).y).toBe(27);
    expect(s.renderEpoch).toBe(e);
    expect(s.history[1]).toHaveLength(1); // only the original add
  });
});

describe('persistence (save / load / legacy)', () => {
  it('saveAnnotations writes the new { items } shape', async () => {
    usePdfStore.setState({ currentItemId: 'item-x' });
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().addTextNode(1, 0, 0);
    const ok = await usePdfStore.getState().saveAnnotations();
    expect(ok.ok).toBe(true);
    const raw = localStorage.getItem('pdf-annotation-item-x')!;
    const data = JSON.parse(raw);
    expect(data.items[1]).toHaveLength(2);
    expect(data.items[1][1].type).toBe('text');
    expect(data.savedAt).toBeTruthy();
  });

  it('loadAnnotations migrates a legacy { strokes } payload into items', async () => {
    localStorage.setItem('pdf-annotation-item-legacy', JSON.stringify({ strokes: { 2: [makeStroke('old')] } }));
    await usePdfStore.getState().loadAnnotations('item-legacy');
    const s = usePdfStore.getState();
    expect(s.items[2]).toHaveLength(1);
    expect((s.items[2][0] as PdfStroke).id).toBe('old');
  });
});

describe('removeStroke / deleteSelected / clearPage', () => {
  it('removeStroke deletes a single stroke', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().removeStroke(1, 'a');
    expect(usePdfStore.getState().items[1]).toHaveLength(0);
  });

  it('deleteSelected removes selected strokes and clears selection', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().commitStroke(1, makeStroke('b'));
    usePdfStore.setState({ selectedIds: ['a', 'b'] });
    usePdfStore.getState().deleteSelected();
    expect(usePdfStore.getState().items[1]).toHaveLength(0);
    expect(usePdfStore.getState().selectedIds).toEqual([]);
  });

  it('clearPage empties only the current page', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().commitStroke(2, makeStroke('b'));
    usePdfStore.setState({ currentPage: 1 });
    usePdfStore.getState().clearPage();
    expect(usePdfStore.getState().items[1]).toHaveLength(0);
    expect(usePdfStore.getState().items[2]).toHaveLength(1);
  });
});

describe('moveStrokes', () => {
  it('moveStrokesLive moves without recording history', () => {
    const s = makeStroke('a');
    usePdfStore.getState().commitStroke(1, s);
    usePdfStore.getState().moveStrokesLive(1, ['a'], 5, 7);
    const st = usePdfStore.getState();
    expect((st.items[1][0] as PdfStroke).points[0].x).toBe(15);
    expect(st.history[1]).toHaveLength(1); // only the original commit
  });

  it('moveStrokes records history and bumps epoch', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    const e = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().moveStrokes(1, ['a'], 10, 0);
    const st = usePdfStore.getState();
    expect((st.items[1][0] as PdfStroke).points[0].x).toBe(20);
    expect(st.history[1]).toHaveLength(2);
    expect(st.renderEpoch).toBe(e + 1);
    // undo restores the original position
    usePdfStore.getState().undo();
    expect((usePdfStore.getState().items[1][0] as PdfStroke).points[0].x).toBe(10);
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

describe('whole-stroke eraser (beginStrokeErase + eraseStrokesLive)', () => {
  it('removes ink strokes live WITHOUT a full-rebuild epoch bump', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.getState().commitStroke(1, makeStroke('b'));
    const before = usePdfStore.getState().renderEpoch;
    usePdfStore.getState().beginStrokeErase(1);
    usePdfStore.getState().eraseStrokesLive(1, ['a', 'b']);
    const s = usePdfStore.getState();
    expect(s.items[1]).toHaveLength(0);
    // renderEpoch stays put: during a wipe PdfCanvas clears the erased strokes
    // out of its ink tiles locally, not via a page-wide rebuild.
    expect(s.renderEpoch).toBe(before);
    expect(s.dirty).toBe(true);
  });

  it('one wipe gesture = ONE undo restores every erased stroke', () => {
    const a = makeStroke('a');
    const b = makeStroke('b');
    usePdfStore.getState().commitStroke(1, a);
    usePdfStore.getState().commitStroke(1, b);
    // Wipe erases two strokes, sharing a single history snapshot.
    usePdfStore.getState().beginStrokeErase(1);
    usePdfStore.getState().eraseStrokesLive(1, ['a']);
    usePdfStore.getState().eraseStrokesLive(1, ['b']);
    expect(usePdfStore.getState().items[1]).toHaveLength(0);
    usePdfStore.getState().undo();
    expect(usePdfStore.getState().items[1]).toEqual([a, b]);
  });

  it('removes the stroke from the selection when erased', () => {
    usePdfStore.getState().commitStroke(1, makeStroke('a'));
    usePdfStore.setState({ selectedIds: ['a'] });
    usePdfStore.getState().beginStrokeErase(1);
    usePdfStore.getState().eraseStrokesLive(1, ['a']);
    expect(usePdfStore.getState().selectedIds).toEqual([]);
  });
});

describe('clampAnchorPages', () => {
  it('filters out pages outside [1, numPages] and non-integers', () => {
    expect(clampAnchorPages([1, 5, 12, 0, -3, 2.5], 10)).toEqual([1, 5]);
  });
  it('returns [] for undefined / empty', () => {
    expect(clampAnchorPages(undefined, 10)).toEqual([]);
    expect(clampAnchorPages([], 10)).toEqual([]);
  });
});
