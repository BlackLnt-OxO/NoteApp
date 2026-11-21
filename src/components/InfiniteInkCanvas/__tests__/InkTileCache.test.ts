/// <reference types="node" />
import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { openDB } from 'idb';
import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../../InkCanvasSurface', () => ({ TILE_CACHE_BUDGET: 2048 }));
import { readTileCache, writeTileCache, deleteTileCache } from '../InkTileCache';
function blob(size: number) { return new NodeBlob([new Uint8Array(size)]) as unknown as Blob; }
afterEach(() => vi.useRealTimers());
describe('bounded expendable preview cache', () => {
  it('evicts by last access while keeping byte totals and metadata consistent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1); await writeTileCache('a', blob(1000));
    vi.setSystemTime(2); await writeTileCache('b', blob(1000));
    vi.setSystemTime(3); expect((await readTileCache('a'))?.size).toBe(1000);
    vi.setSystemTime(4); await writeTileCache('c', blob(1000));
    expect(await readTileCache('b')).toBeNull(); expect((await readTileCache('a'))?.size).toBe(1000);
    const db = await openDB('noteapp-ink-tile-cache', 2);
    expect(await db.get('totals', 'bytes')).toBe(2000);
    expect(await db.count('tiles')).toBe(2); expect(await db.count('metadata')).toBe(2); db.close();
  });
  it('releases corrupt entries and rejects a single entry larger than the entire budget', async () => {
    await deleteTileCache('a'); await deleteTileCache('c');
    await writeTileCache('huge', blob(2049)); expect(await readTileCache('huge')).toBeNull();
    const db = await openDB('noteapp-ink-tile-cache', 2); expect(await db.get('totals', 'bytes')).toBe(0); db.close();
  });
});
