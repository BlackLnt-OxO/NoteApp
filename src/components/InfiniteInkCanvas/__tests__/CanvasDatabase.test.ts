import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CanvasDatabase } from '../CanvasDatabase';
import { CanvasRepository } from '../CanvasRepository';
import type { Stroke } from '../types';
import { canvasDataKey } from '../constants';
let serial = 0;
const opened: CanvasDatabase[] = [];
function database() { const db = new CanvasDatabase(`ink-test-${++serial}`); opened.push(db); return db; }
const camera = { x: 15, y: -4, zoom: 1.7 };
function stroke(id: string): Stroke {
  return { id, type: 'stroke', points: [{ x: 20, y: 50, pressure: 0.373, t: 17 }], color: '#123456',
    size: 8, opacity: 0.4, smoothing: 0.35, compositeOperation: 'source-over', createdAt: 0, renderVersion: 2 };
}
afterEach(async () => { await Promise.all(opened.splice(0).map(db => db.close())); localStorage.clear(); });
describe('atomic canvas documents', () => {
  it('opens an existing async document without materializing its large legacy recovery body', async () => {
    const repository = new CanvasRepository(), id = `no-legacy-read-${++serial}`;
    await repository.save(id, [stroke('new')], camera, true);
    localStorage.setItem(canvasDataKey(id), 'untouched recovery body');
    const read = vi.spyOn(Storage.prototype, 'getItem');
    try {
      expect((await repository.load(id)).objects).toEqual([stroke('new')]);
      expect(read.mock.calls.some(([key])=>key===canvasDataKey(id)||key===canvasDataKey(id)+'-view')).toBe(false);
    } finally { read.mockRestore(); await repository.close(); }
    expect(localStorage.getItem(canvasDataKey(id))).toBe('untouched recovery body');
  });
  it('migrates pressure, order and separate view without touching the recovery key', async () => {
    const db = database(), objects = [stroke('b'), stroke('a')];
    const raw = JSON.stringify({ objects, camera: { x: 0 }, showDotGrid: true });
    localStorage.setItem(canvasDataKey('migration'), raw);
    const data = await db.migrate('migration', raw, JSON.stringify({ camera, showDotGrid: false }));
    expect(data.objects).toEqual(objects); expect(data.camera).toEqual(camera); expect(data.showDotGrid).toBe(false);
    expect(localStorage.getItem(canvasDataKey('migration'))).toBe(raw);
    expect((await db.migrate('migration', '{}', null)).objects).toEqual(objects);
  });
  it('commits replacement, deletion and order together, and survives reopening', async () => {
    const db = database(), a = stroke('a'), b = stroke('b');
    await db.save({ id: 'one', added: [a, b], removed: [], order: ['a', 'b'], camera, showDotGrid: true });
    const changed = { ...b, opacity: 0.9 };
    await db.save({ id: 'one', added: [changed], removed: ['a'], order: ['b'], camera, showDotGrid: false });
    await db.close();
    expect(await db.load('one')).toMatchObject({ objects: [changed], camera, showDotGrid: false, revision: 2 });
  });
  it('rejects an incomplete manifest while retaining the last confirmed state', async () => {
    const db = database();
    await db.save({ id: 'one', added: [stroke('a')], removed: [], order: ['a'], camera, showDotGrid: true });
    await expect(db.save({ id: 'one', added: [], removed: ['a'], order: ['missing'], camera, showDotGrid: false })).rejects.toThrow('缺失');
    expect((await db.load('one'))?.objects[0].id).toBe('a');
  });
  it('tombstones deleted documents so a delayed writer cannot resurrect them', async () => {
    const db = database(); await db.delete('gone');
    await expect(db.save({ id: 'gone', added: [stroke('a')], removed: [], order: ['a'], camera, showDotGrid: true })).rejects.toThrow('已删除');
    await expect(db.load('gone')).rejects.toThrow('已删除');
  });
  it('rejects invalid migrations without creating a successful manifest', async () => {
    const db = database(); await expect(db.migrate('bad', JSON.stringify({ objects: [stroke('a'), stroke('a')] }), null)).rejects.toThrow('重复');
    expect(await db.load('bad')).toBeNull();
    await expect(db.migrate('bad-view', JSON.stringify({ objects: [stroke('a')], camera: { zoom: 0 } }), null)).rejects.toThrow('视图');
    expect(await db.load('bad-view')).toBeNull();
  });
  it('rejects a stale legacy backup when a migrated document is missing', async () => {
    const repository = new CanvasRepository(), id = `missing-${++serial}`;
    const raw = JSON.stringify({ objects: [stroke('old')] });
    localStorage.setItem(canvasDataKey(id), raw);
    localStorage.setItem(`stickynotes-inkcanvas-db-${id}`, 'ready');
    await expect(repository.load(id)).rejects.toThrow('数据缺失');
    expect(localStorage.getItem(canvasDataKey(id))).toBe(raw);
    // A failed load is intentionally preserved in the barrier.
    await expect(repository.flush()).rejects.toThrow('数据缺失');
  });
  it('serializes saves arriving during a save and confirms the latest edit', async () => {
    const repository = new CanvasRepository(), id = `queue-${++serial}`, first = stroke('first'), next = stroke('next');
    await repository.load(id);
    const a = repository.save(id, [first], camera, true);
    const b = repository.save(id, [first, next], { ...camera, x: 30 }, false);
    await Promise.all([a, b]); await repository.flush();
    expect((await repository.load(id)).objects).toEqual([first, next]);
    await repository.delete(id); await expect(repository.save(id, [first], camera, true)).rejects.toThrow('已删除');
    // Failed saves remain visible to barriers; a subsequent successful transaction replaces the failure.
    await expect(repository.flush()).rejects.toThrow();
  });
  it('keeps failed writes dirty and retries the complete missing delta', async () => {
    const repository = new CanvasRepository(), id = `retry-${++serial}`, objects = [stroke('retry')];
    await repository.load(id);
    const save = vi.spyOn(CanvasDatabase.prototype, 'save').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(repository.save(id, objects, camera, true)).rejects.toThrow('disk full');
      await repository.save(id, objects, camera, true); await repository.flush();
      expect((await repository.load(id)).objects).toEqual(objects);
    } finally { save.mockRestore(); await repository.close(); }
  });
});
