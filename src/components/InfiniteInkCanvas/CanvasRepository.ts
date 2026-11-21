import { CanvasDatabase, parseLegacyCanvas, type CanvasChanges, type CanvasData } from './CanvasDatabase';
import type { StorageRequest } from './CanvasStorageWorker';
import type { CanvasObject, Camera } from './types';
import { canvasDataKey, canvasViewKey } from './constants';

type Request = StorageRequest extends infer T ? T extends StorageRequest ? Omit<T, 'requestId'> : never : never;
const migrationKey = (id: string) => `stickynotes-inkcanvas-db-${id}`;
/** The renderer sends changed objects only; parsing and IDB transactions run in a worker. */
export class CanvasRepository {
  private worker: Worker | null = null;
  private database = new CanvasDatabase();
  private sequence = 0;
  private waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; objects: CanvasObject[] }>();
  private snapshots = new Map<string, CanvasData>();
  private deleted = new Set<string>();
  private legacy = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  readonly migrationErrors = new Map<string, string>();
  readonly background: boolean;
  constructor() {
    try {
      if (typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined') {
        this.worker = new Worker(new URL('./CanvasStorageWorker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          const pending = this.waiting.get(data.requestId);
          if (!pending) return;
          if (data.chunk) { pending.objects.push(...data.chunk); return; }
          this.waiting.delete(data.requestId);
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve(data.result?.streamed ? { ...data.result, objects: pending.objects } : data.result);
        };
        const failed = () => {
          this.worker?.terminate(); this.worker = null;
          for (const request of this.waiting.values()) request.reject(new Error('后台保存失败，请重试'));
          this.waiting.clear();
        };
        this.worker.onerror = failed; this.worker.onmessageerror = failed;
      }
    } catch { this.worker = null; }
    this.background = !!this.worker;
  }
  private async request(message: Request): Promise<any> {
    if (this.worker) return new Promise((resolve, reject) => {
      const requestId = ++this.sequence;
      this.waiting.set(requestId, { resolve, reject, objects: [] });
      try { this.worker!.postMessage({ ...message, requestId }); }
      catch (error) { this.waiting.delete(requestId); reject(error); }
    });
    if (message.type === 'load') return this.database.load(message.id);
    if (message.type === 'save') return this.database.save(message.change);
    if (message.type === 'migrate') return this.database.migrate(message.id, message.raw, message.viewRaw);
    if (message.type === 'delete') return this.database.delete(message.id);
    return this.database.close();
  }
  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    // A completed load promise must not retain an entire document forever.
    const tail = next.then(() => undefined); void tail.catch(() => {});
    this.queues.set(id, tail);
    return next;
  }
  private remember(id: string, data: CanvasData): void {
    this.snapshots.delete(id); this.snapshots.set(id, data);
    while (this.snapshots.size > 2) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
  async load(id: string): Promise<CanvasData> {
    if (this.deleted.has(id)) throw new Error('画布已删除');
    const data = await this.enqueue(id, async () => {
      let raw: string | null = null, viewRaw: string | null = null;
      if (typeof indexedDB !== 'undefined') {
        let stored: CanvasData | null, available = true;
        try { stored = await this.request({ type: 'load', id }); }
        catch (error) {
          // Once IDB may hold newer edits, a legacy backup must never silently replace it.
          if (localStorage.getItem(migrationKey(id))) throw error;
          raw = localStorage.getItem(canvasDataKey(id));
          if (!raw) throw error;
          this.legacy.add(id);
          this.migrationErrors.set(id, '异步存储不可用，继续使用旧存储；下次打开时重试迁移。');
          stored = null; available = false;
        }
        if (stored) { localStorage.setItem(migrationKey(id), 'ready'); return stored; }
        if (localStorage.getItem(migrationKey(id))) throw new Error('异步画布数据缺失，已保留旧备份，请恢复数据后重试');
        // Recovery bodies can be tens of MB; read them only when IDB has no document.
        raw ??= localStorage.getItem(canvasDataKey(id));
        viewRaw = localStorage.getItem(canvasViewKey(id));
        if (raw && available) {
          try {
            localStorage.setItem(migrationKey(id), 'pending');
            const migrated = await this.request({ type: 'migrate', id, raw, viewRaw });
            localStorage.setItem(migrationKey(id), 'ready');
            this.legacy.delete(id); this.migrationErrors.delete(id); return migrated as CanvasData;
          } catch (error) {
            if (localStorage.getItem(migrationKey(id))) {
              const committed = await this.request({ type: 'load', id });
              if (committed) { localStorage.setItem(migrationKey(id), 'ready'); return committed; }
              localStorage.removeItem(migrationKey(id));
            }
            this.legacy.add(id);
            this.migrationErrors.set(id, `迁移失败，继续使用旧存储；下次打开时重试。${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else {
        this.legacy.add(id);
        raw = localStorage.getItem(canvasDataKey(id)); viewRaw = localStorage.getItem(canvasViewKey(id));
      }
      return parseLegacyCanvas(raw, viewRaw);
    });
    this.remember(id, data);
    return data;
  }
  save(id: string, objects: CanvasObject[], camera: Camera, showDotGrid: boolean): Promise<void> {
    return this.enqueue(id, async () => {
      if (this.deleted.has(id)) throw new Error('画布已删除，拒绝迟到的保存');
      const old = this.snapshots.get(id);
      if (old?.objects === objects && old.camera === camera && old.showDotGrid === showDotGrid) return;
      if (typeof indexedDB === 'undefined' || this.legacy.has(id)) {
        if (old?.objects !== objects) localStorage.setItem(canvasDataKey(id), JSON.stringify({ objects }));
        localStorage.setItem(canvasViewKey(id), JSON.stringify({ camera, showDotGrid }));
        this.remember(id, { objects, camera, showDotGrid, revision: (old?.revision ?? 0) + 1 });
        return;
      }
      const previous = new Map(old?.objects.map(object => [object.id, object]) ?? []);
      const ids = new Set(objects.map(object => object.id));
      const change: CanvasChanges = { id, added: objects.filter(object => previous.get(object.id) !== object),
        removed: [...previous.keys()].filter(key => !ids.has(key)), order: [...ids], camera, showDotGrid };
      if (!localStorage.getItem(migrationKey(id))) localStorage.setItem(migrationKey(id), 'pending');
      const revision = await this.request({ type: 'save', change });
      localStorage.setItem(migrationKey(id), 'ready');
      this.remember(id, { objects, camera, showDotGrid, revision });
    });
  }
  delete(id: string): Promise<void> {
    this.deleted.add(id);
    return this.enqueue(id, async () => {
      try {
        if (typeof indexedDB !== 'undefined') await this.request({ type: 'delete', id });
        this.snapshots.delete(id);
        localStorage.removeItem(migrationKey(id));
      } catch (error) { this.deleted.delete(id); throw error; }
    });
  }
  async flush(): Promise<void> { await Promise.all([...this.queues.values()]); }
  async close(): Promise<void> { await this.flush(); await this.request({ type: 'close' }); }
}
export const canvasRepository = new CanvasRepository();
