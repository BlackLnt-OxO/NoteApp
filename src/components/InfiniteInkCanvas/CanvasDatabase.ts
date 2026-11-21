import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { CanvasObject, Camera } from './types';

export interface CanvasDocument {
  id: string; revision: number; order: string[]; camera: Camera; showDotGrid: boolean;
  migrated?: boolean; deleted?: boolean;
}
export interface CanvasData { objects: CanvasObject[]; camera: Camera; showDotGrid: boolean; revision: number }
export interface CanvasChanges {
  id: string; added: CanvasObject[]; removed: string[]; order: string[];
  camera: Camera; showDotGrid: boolean;
}
interface Schema extends DBSchema {
  documents: { key: string; value: CanvasDocument };
  objects: { key: [string, string]; value: { canvasId: string; id: string; value: CanvasObject }; indexes: { canvasId: string } };
}

/** Shared by migration and its fallback, so invalid legacy data is never saved as an empty canvas. */
export function parseLegacyCanvas(raw: string | null, viewRaw: string | null): CanvasData {
  const body = raw ? JSON.parse(raw) : { objects: [] };
  let view: any = null;
  if (viewRaw) { try { view = JSON.parse(viewRaw); } catch { /* retain legacy body view */ } }
  if (!Array.isArray(body?.objects) || body.objects.some((object: any) => !object || typeof object.id !== 'string')) throw new Error('旧画布数据格式无效');
  if (new Set(body.objects.map((object: CanvasObject) => object.id)).size !== body.objects.length) throw new Error('旧画布存在重复对象编号');
  const camera = { x: 0, y: 0, zoom: 1, ...(view?.camera ?? body.camera) };
  if (![camera.x, camera.y, camera.zoom].every(Number.isFinite) || camera.zoom <= 0) throw new Error('旧画布视图数据无效');
  return { objects: body.objects, camera, showDotGrid: view?.showDotGrid ?? body.showDotGrid ?? true, revision: 0 };
}

/** Transactions atomically advance the manifest and its changed object records. */
export class CanvasDatabase {
  private connection?: Promise<IDBPDatabase<Schema>>;
  constructor(private name = 'noteapp-ink-documents') {}
  private db(): Promise<IDBPDatabase<Schema>> {
    return this.connection ??= openDB<Schema>(this.name, 1, { upgrade(database) {
      database.createObjectStore('documents', { keyPath: 'id' });
      database.createObjectStore('objects', { keyPath: ['canvasId', 'id'] }).createIndex('canvasId', 'canvasId');
    } });
  }

  async load(id: string): Promise<CanvasData | null> {
    const db = await this.db(), tx = db.transaction(['documents', 'objects']);
    const doc = await tx.objectStore('documents').get(id);
    if (!doc) return null;
    if (doc.deleted) throw new Error('画布已删除');
    const records = await tx.objectStore('objects').index('canvasId').getAll(id);
    await tx.done;
    const byId = new Map(records.map(record => [record.id, record.value]));
    if (doc.order.some(key => !byId.has(key))) throw new Error('画布数据不完整，已保留原数据');
    return { objects: doc.order.map(key => byId.get(key)!), camera: doc.camera, showDotGrid: doc.showDotGrid, revision: doc.revision };
  }

  async save(change: CanvasChanges, migrated = false): Promise<number> {
    if (new Set(change.order).size !== change.order.length) throw new Error('画布对象顺序存在重复编号');
    const db = await this.db(), tx = db.transaction(['documents', 'objects'], 'readwrite');
    const docs = tx.objectStore('documents'), objects = tx.objectStore('objects');
    const old = await docs.get(change.id);
    if (old?.deleted) { tx.abort(); await tx.done.catch(() => {}); throw new Error('画布已删除，拒绝迟到的保存'); }
    const available = new Set(old?.order ?? []);
    for (const id of change.removed) available.delete(id);
    for (const object of change.added) available.add(object.id);
    if (change.order.some(id => !available.has(id))) {
      tx.abort(); await tx.done.catch(() => {}); throw new Error('画布增量事务缺失对象');
    }
    const revision = (old?.revision ?? 0) + 1;
    const order = new Set(change.order);
    // Also reconcile a manifest after an inactive document's identity cache was evicted.
    const removed = new Set([...change.removed, ...(old?.order.filter(id => !order.has(id)) ?? [])]);
    for (const id of removed) await objects.delete([change.id, id]);
    for (const value of change.added) await objects.put({ canvasId: change.id, id: value.id, value });
    await docs.put({ id: change.id, revision, order: change.order, camera: change.camera,
      showDotGrid: change.showDotGrid, migrated: migrated || old?.migrated });
    await tx.done;
    return revision;
  }

  async migrate(id: string, raw: string, viewRaw: string | null): Promise<CanvasData> {
    const existing = await this.load(id);
    if (existing) return existing;
    const data = parseLegacyCanvas(raw, viewRaw), ids = data.objects.map(object => object.id);
    const db = await this.db(), tx = db.transaction(['documents', 'objects'], 'readwrite');
    try {
      const documents = tx.objectStore('documents'), objects = tx.objectStore('objects');
      if (await documents.get(id)) { tx.abort(); await tx.done.catch(() => {}); return (await this.load(id))!; }
      for (const value of data.objects) await objects.put({ canvasId: id, id: value.id, value });
      const records = await objects.index('canvasId').getAll(id);
      const byId = new Map(records.map(record => [record.id, record.value]));
      const restored = ids.map((key: string) => byId.get(key)!);
      if (records.length !== ids.length || JSON.stringify(restored) !== JSON.stringify(data.objects)) throw new Error('画布迁移对象校验失败');
      await documents.put({ id, revision: 1, order: ids, camera: data.camera, showDotGrid: data.showDotGrid });
      const saved = (await documents.get(id))!;
      if (JSON.stringify(saved.camera) !== JSON.stringify(data.camera) || saved.showDotGrid !== data.showDotGrid) throw new Error('画布迁移视图校验失败');
      await documents.put({ ...saved, migrated: true }); await tx.done;
      return { ...data, objects: restored, revision: 1 };
    } catch (error) {
      try { tx.abort(); } catch { /* already aborted */ }
      await tx.done.catch(() => {}); throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const db = await this.db(), tx = db.transaction(['documents', 'objects'], 'readwrite');
    const documents = tx.objectStore('documents'), old = await documents.get(id);
    await documents.put({ id, revision: (old?.revision ?? 0) + 1, order: [], camera: { x: 0, y: 0, zoom: 1 }, showDotGrid: true, deleted: true });
    let cursor = await tx.objectStore('objects').index('canvasId').openCursor(id);
    while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    await tx.done;
  }

  async close(): Promise<void> { if (this.connection) (await this.connection).close(); this.connection = undefined; }
}
