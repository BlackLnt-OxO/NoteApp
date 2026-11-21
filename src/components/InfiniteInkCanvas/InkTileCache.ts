import { openDB } from 'idb';
import { TILE_CACHE_BUDGET } from '../InkCanvasSurface';

export const INK_RENDER_VERSION = 'ink-4-preview-union';
interface Entry { key: string; blob: Blob; bytes: number; used: number }
let database: ReturnType<typeof openDB> | undefined;
function db() {
  return database ??= openDB('noteapp-ink-tile-cache', 2, {
    upgrade(database) {
      if (database.objectStoreNames.contains('tiles')) database.deleteObjectStore('tiles');
      database.createObjectStore('tiles', { keyPath: 'key' });
      database.createObjectStore('metadata', { keyPath: 'key' }).createIndex('used', 'used');
      database.createObjectStore('totals');
    },
  });
}

/** Cache failures never affect source data or prevent vector reconstruction. */
export async function readTileCache(key: string): Promise<Blob | null> {
  try {
    const database = await db();
    const tx = database.transaction(['tiles', 'metadata'], 'readwrite');
    const entry = await tx.objectStore('tiles').get(key) as Entry | undefined;
    if (entry) await tx.objectStore('metadata').put({ key, bytes: entry.bytes, used: Date.now() });
    await tx.done;
    if (!entry) return null;
    return entry.blob;
  } catch { return null; }
}
export async function deleteTileCache(key: string): Promise<void> {
  try {
    const database = await db(), tx = database.transaction(['tiles', 'metadata', 'totals'], 'readwrite');
    const metadata = tx.objectStore('metadata'), totals = tx.objectStore('totals');
    const old = await metadata.get(key), bytes = await totals.get('bytes') ?? 0;
    await metadata.delete(key); await tx.objectStore('tiles').delete(key);
    await totals.put(Math.max(0, bytes - (old?.bytes ?? 0)), 'bytes'); await tx.done;
  } catch { /* expendable cache */ }
}

export async function writeTileCache(key: string, blob: Blob): Promise<void> {
  try {
    const database = await db();
    if (blob.size > TILE_CACHE_BUDGET) return;
    const tx = database.transaction(['tiles', 'metadata', 'totals'], 'readwrite');
    const metadata = tx.objectStore('metadata'), tiles = tx.objectStore('tiles'), totals = tx.objectStore('totals');
    const old = await metadata.get(key);
    let bytes = (await totals.get('bytes') ?? 0) - (old?.bytes ?? 0) + blob.size;
    await tiles.put({ key, blob, bytes: blob.size, used: Date.now() } satisfies Entry);
    await metadata.put({ key, bytes: blob.size, used: Date.now() });
    let cursor = await metadata.index('used').openCursor();
    while (bytes > TILE_CACHE_BUDGET && cursor) {
      bytes -= cursor.value.bytes;
      await tiles.delete(cursor.primaryKey);
      await cursor.delete(); cursor = await cursor.continue();
    }
    await totals.put(bytes, 'bytes');
    await tx.done;
  } catch { /* a derived cache is expendable */ }
}
