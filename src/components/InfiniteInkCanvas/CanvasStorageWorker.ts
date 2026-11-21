import { CanvasDatabase, type CanvasChanges } from './CanvasDatabase';
import { postInkTask } from '../InkCooperativeWork';
export type StorageRequest = { requestId: number } & (
  | { type: 'load'; id: string }
  | { type: 'save'; change: CanvasChanges }
  | { type: 'migrate'; id: string; raw: string; viewRaw: string | null }
  | { type: 'delete'; id: string }
  | { type: 'close' });
const port = self as unknown as { onmessage: ((event: MessageEvent<StorageRequest>) => void) | null; postMessage(message: unknown): void };
const database = new CanvasDatabase();
let queue = Promise.resolve();
port.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      let result: any;
      if (data.type === 'load') result = await database.load(data.id);
      else if (data.type === 'save') result = await database.save(data.change);
      else if (data.type === 'migrate') result = await database.migrate(data.id, data.raw, data.viewRaw);
      else if (data.type === 'delete') result = await database.delete(data.id);
      else result = await database.close();
      if (result?.objects) {
        for (let i = 0; i < result.objects.length; i += 256) {
          port.postMessage({ requestId: data.requestId, chunk: result.objects.slice(i, i + 256) });
          await new Promise<void>(resolve => postInkTask(resolve));
        }
        result = { ...result, objects: undefined, streamed: true };
      }
      port.postMessage({ requestId: data.requestId, result });
    } catch (error) {
      port.postMessage({ requestId: data.requestId, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
