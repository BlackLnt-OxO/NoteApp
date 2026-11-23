import { beforeEach, describe, expect, it } from 'vitest';
import { useNoteStore } from '../../../store';
import { useCanvasStore } from '../../InfiniteInkCanvas/useCanvasStore';
import { usePdfStore } from '../../PdfAnnotation/PdfStore';
import { resizeInkImage } from '../../InkImageControls';
import { resolveAsset, useAssetLibrary } from '../assetLibrary';
import { placeDroppedItems } from '../externalFiles';
import { appendNoteDrop } from '../noteAttachments';

const path = 'C:/fixtures/outline.txt';
const image = { path: 'C:/fixtures/picture.png', image: { width: 200, height: 100, dataUrl: 'data:image/png;base64,AA==' } };

beforeEach(() => {
  useAssetLibrary.setState({ assets: [], aliases: {}, available: {} });
});

describe('placement and library membership', () => {
  it('retains old references, avoids duplicates and restores a removed entry at the insertion point', () => {
    const assets = useAssetLibrary.getState;
    assets().add([path, 'C:/fixtures/report.pdf']);
    const [first, second] = assets().assets;
    assets().remove(first.id);
    expect(resolveAsset(assets(), first.id)).toMatchObject({ path, hidden: true });
    assets().add(['c:\\fixtures\\outline.txt', path], second.id);
    expect(assets().assets).toEqual([first, second]);
  });

  it('adds image and linked document to a canvas as one undoable operation, independently of the library', () => {
    const canvas = useCanvasStore.getState;
    useCanvasStore.setState({ objects: [], history: [], redoStack: [] });
    const objects = placeDroppedItems([image, { path }], { x: 12, y: 45 });
    canvas().addDroppedObjects(objects);
    expect(canvas().objects).toMatchObject([
      { type: 'image', x: 12, y: 45, dataUrl: image.image.dataUrl },
      { type: 'asset', x: 12, y: 157, sourcePath: path },
    ]);
    canvas().undo();
    expect(canvas().objects).toEqual([]);
    canvas().redo();
    expect(canvas().objects).toEqual(objects);
    expect(useAssetLibrary.getState().assets).toEqual([]);
  });

  it('writes to the original PDF page while preserving the current page and its annotations', () => {
    const pdf = usePdfStore.getState;
    usePdfStore.setState({ currentPage: 3, items: {}, history: {}, redoStack: {} });
    const objects = placeDroppedItems([image, { path }], { x: 400, y: 590 }, { width: 420, height: 600 });
    pdf().addDroppedObjects(2, objects);
    expect(pdf().items[2]).toEqual(objects);
    expect(pdf().items[2][0]).toMatchObject({ x: 220, y: 500 });
    expect(pdf().items[2][1]).toMatchObject({ x: 200, y: 424 });
    expect(pdf().currentPage).toBe(3);
    usePdfStore.setState({ currentPage: 2 });
    pdf().undo();
    expect(pdf().items[2]).toEqual([]);
  });

  it('appends files and embedded images to the latest note without replacing its text', () => {
    const note = useNoteStore.getState().addNote({ content: '草稿' });
    useNoteStore.getState().updateNote(note.id, { content: '最新内容' });
    appendNoteDrop(note.id, [image, { path }]);
    expect(useNoteStore.getState().notes.find(item => item.id === note.id)).toMatchObject({
      content: '最新内容', images: [{ fileName: 'picture.png', dataUrl: image.image.dataUrl }], attachments: [{ path }],
    });
    expect(useAssetLibrary.getState().assets).toEqual([]);
  });
});

describe('image resize', () => {
  it('allows independent dimensions and projects Shift sizing to the starting proportions', () => {
    expect(resizeInkImage(100, 50, 0, 30, false)).toEqual({ width: 100, height: 80 });
    const locked = resizeInkImage(100, 50, 0, 30, true);
    expect(locked.width).toBeGreaterThan(100);
    expect(locked.width / locked.height).toBe(2);
    expect(resizeInkImage(100, 50, -200, -200, true)).toEqual({ width: 60, height: 30 });
  });
});
