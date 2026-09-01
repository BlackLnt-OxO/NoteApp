import { describe, it, expect, beforeEach } from 'vitest';
import { usePdfLibrary } from '../PdfLibrary';

beforeEach(() => {
  usePdfLibrary.getState().reset();
  localStorage.clear();
});

describe('items', () => {
  it('adds an item at the front', () => {
    const id = usePdfLibrary.getState().addItem({
      name: 'a.pdf', path: 'C:\\docs\\a.pdf', categoryId: null, pageCount: 3, sizeBytes: 100,
    });
    const s = usePdfLibrary.getState();
    expect(s.items).toHaveLength(1);
    expect(s.items[0].id).toBe(id);
    expect(s.items[0].name).toBe('a.pdf');
    expect(s.items[0].path).toBe('C:\\docs\\a.pdf');
  });

  it('dedupes by path (re-import refreshes the entry)', () => {
    const first = usePdfLibrary.getState().addItem({
      name: 'a.pdf', path: 'C:\\docs\\a.pdf', categoryId: null, pageCount: 1, sizeBytes: 100,
    });
    const second = usePdfLibrary.getState().addItem({
      name: 'a.pdf', path: 'C:\\docs\\a.pdf', categoryId: null, pageCount: 5, sizeBytes: 200,
    });
    expect(second).toBe(first);
    expect(usePdfLibrary.getState().items).toHaveLength(1);
    expect(usePdfLibrary.getState().items[0].pageCount).toBe(5);
  });

  it('removeItem removes by id', () => {
    const id = usePdfLibrary.getState().addItem({
      name: 'a.pdf', path: 'a', categoryId: null, pageCount: 1, sizeBytes: 10,
    });
    usePdfLibrary.getState().removeItem(id);
    expect(usePdfLibrary.getState().items).toHaveLength(0);
  });

  it('touchLastOpened updates the timestamp without reordering', () => {
    usePdfLibrary.getState().addItem({ name: 'a', path: '/a', categoryId: null, pageCount: 1, sizeBytes: 1 });
    const idB = usePdfLibrary.getState().addItem({ name: 'b', path: '/b', categoryId: null, pageCount: 1, sizeBytes: 1 });
    // b was added later → index 0
    expect(usePdfLibrary.getState().items[0].id).toBe(idB);
    const idA = usePdfLibrary.getState().items[1].id;
    usePdfLibrary.getState().touchLastOpened(idA);
    // Order preserved — the home screen keeps the user's drag-to-reorder sequence.
    expect(usePdfLibrary.getState().items[0].id).toBe(idB);
    expect(usePdfLibrary.getState().items[1].id).toBe(idA);
  });

  it('setItemCategory / updateItemPath mutate the item', () => {
    const id = usePdfLibrary.getState().addItem({
      name: 'a.pdf', path: '/old', categoryId: null, pageCount: 1, sizeBytes: 10,
    });
    const catId = usePdfLibrary.getState().addCategory('笔记');
    usePdfLibrary.getState().setItemCategory(id, catId);
    usePdfLibrary.getState().updateItemPath(id, '/new');
    const item = usePdfLibrary.getState().items[0];
    expect(item.categoryId).toBe(catId);
    expect(item.path).toBe('/new');
  });
});

describe('categories', () => {
  it('adds and renames categories', () => {
    const id = usePdfLibrary.getState().addCategory('笔记');
    usePdfLibrary.getState().renameCategory(id, '论文');
    expect(usePdfLibrary.getState().categories[0].name).toBe('论文');
  });

  it('deleteCategory clears the categoryId on its items', () => {
    const id = usePdfLibrary.getState().addCategory('旧');
    usePdfLibrary.getState().addItem({ name: 'a', path: '/a', categoryId: id, pageCount: 1, sizeBytes: 1 });
    usePdfLibrary.getState().deleteCategory(id);
    expect(usePdfLibrary.getState().categories).toHaveLength(0);
    expect(usePdfLibrary.getState().items[0].categoryId).toBeNull();
  });
});

describe('persistence', () => {
  it('round-trips via localStorage', () => {
    usePdfLibrary.setState({ loaded: true });
    const catId = usePdfLibrary.getState().addCategory('工作');
    usePdfLibrary.getState().addItem({ name: 'a.pdf', path: 'C:\\a.pdf', categoryId: catId, pageCount: 7, sizeBytes: 123 });
    usePdfLibrary.getState().saveState();

    usePdfLibrary.getState().reset();
    usePdfLibrary.getState().loadState();

    const s = usePdfLibrary.getState();
    expect(s.items).toHaveLength(1);
    expect(s.items[0].name).toBe('a.pdf');
    expect(s.items[0].path).toBe('C:\\a.pdf');
    expect(s.categories).toHaveLength(1);
    expect(s.categories[0].name).toBe('工作');
    expect(s.items[0].categoryId).toBe(catId);
  });

  it('loadState with empty storage leaves the library empty', () => {
    usePdfLibrary.getState().loadState();
    expect(usePdfLibrary.getState().items).toEqual([]);
    expect(usePdfLibrary.getState().loaded).toBe(true);
  });
});
