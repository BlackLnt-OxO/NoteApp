import type { PdfStroke } from '../PdfAnnotation/PdfTypes';

export interface TileJob {
  key: string; tx: number; ty: number; scale: number; version: number;
  epoch: number; priority: number; requestedAt: number;
  quality: 'preview' | 'complete';
}
export type RenderRequest =
  | { type: 'reset'; epoch: number }
  | { type: 'changes'; epoch: number; added: PdfStroke[]; removed: string[]; append?: boolean }
  | { type: 'order'; epoch: number; ids: string[]; completeKeys?: string[] }
  | { type: 'viewport'; epoch: number; jobs: TileJob[] }
  | { type: 'dispose' };
export type RenderReply =
  | { type: 'tile'; job: TileJob; bitmap: ImageBitmap; cacheHit: boolean; buildMs: number; workerBytes: number }
  | { type: 'memory'; epoch: number; workerBytes: number }
  | { type: 'error'; message: string };

export const tileKey = (tx: number, ty: number) => `${tx}:${ty}`;
