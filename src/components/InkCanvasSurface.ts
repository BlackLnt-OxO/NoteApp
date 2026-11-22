/** Raster surfaces use only the Canvas 2D contract, never DOM layout APIs.
 * Keep the adapter here so the exact same brush code runs in a worker. */
let workerCPU = true;
export function setWorkerInkCPU(enabled: boolean): boolean {
  const changed = workerCPU !== enabled; workerCPU = enabled; return changed;
}
export function createInkCanvas(): HTMLCanvasElement {
  if (typeof document !== 'undefined') return document.createElement('canvas');
  const canvas = new OffscreenCanvas(1, 1);
  // CPU previews reduce contention with live GPU surfaces. Complete tiles retain
  // GPU defaults: Chromium's CPU/GPU feather filters produce different edge pixels.
  if (workerCPU) canvas.getContext('2d', { willReadFrequently: true });
  return canvas as unknown as HTMLCanvasElement;
}

export function inkPixelTransform(ctx: CanvasRenderingContext2D): DOMMatrix | null {
  const transform = ctx.getTransform();
  return transform.b === 0 && transform.c === 0 && transform.a > 0 && transform.d > 0 ? transform : null;
}

export const INK_MEMORY_BUDGET = 256 * 1024 * 1024;
export const INK_WORKER_MEMORY_RESERVE = 64 * 1024 * 1024;
export const TILE_CACHE_BUDGET = 512 * 1024 * 1024;

const reusable = new Map<string, HTMLCanvasElement>();
export function reusableInkCanvas(key: string, width: number, height: number): HTMLCanvasElement {
  let canvas = reusable.get(key);
  if (!canvas) { canvas = createInkCanvas(); reusable.set(key, canvas); }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}
export function reusableInkBytes(): number {
  let bytes = 0; for (const canvas of reusable.values()) bytes += canvas.width * canvas.height * 4; return bytes;
}
export function releaseReusableInkCanvases(): void {
  for (const canvas of reusable.values()) releaseInkCanvas(canvas); reusable.clear();
}

export function releaseInkCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = canvas.height = 0;
}
