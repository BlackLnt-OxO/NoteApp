import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type { PdfJsDocument } from '../PdfAnnotation/PdfLoader';
import type { PdfPageSize } from '../PdfAnnotation/PdfTypes';
import type { PageFingerprints } from './annotationFiles';

export interface OpenedPdf {
  doc: PdfJsDocument;
  firstPage: PdfPageSize;
  dispose: () => void;
}

export const PDF_PAGE_READY = 'noteapp:pdf-page-ready';
const PAGE_TIMEOUT = 30_000;

export function awaitPdfOperation<T>(operation: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(signal?.reason);
    timer = setTimeout(() => reject(new Error(message)), PAGE_TIMEOUT);
    signal?.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject);
    if (signal?.aborted) abort();
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });
}

export async function inspectPdf(data: ArrayBuffer, signal?: AbortSignal): Promise<OpenedPdf> {
  const { getDocument, PDFWorker } = await import('pdfjs-dist');
  signal?.throwIfAborted();
  const port = new PdfWorker();
  // pdf.js 4 infers a null-only port from its default parameter, but the
  // constructor accepts an existing Worker (as does GlobalWorkerOptions).
  const worker = new PDFWorker({ port: port as never });
  const task = getDocument({ data: new Uint8Array(data), worker, isEvalSupported: false });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    void task.destroy().catch(() => {}).finally(() => { worker.destroy(); port.terminate(); });
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    const doc = await awaitPdfOperation(task.promise, signal, '读取 PDF 超时，请重试。');
    const page = await awaitPdfOperation(doc.getPage(1), signal, '读取 PDF 首页超时，请重试。');
    const { width, height } = page.getViewport({ scale: 1 });
    page.cleanup();
    return { doc, firstPage: { width, height }, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

interface FingerprintOptions {
  signal: AbortSignal;
  progress: (page: number, total: number) => void;
  beforePage?: () => Promise<void>;
  retainPage?: (page: number) => boolean;
}

export async function fingerprintPages(doc: PdfJsDocument, options: FingerprintOptions): Promise<PageFingerprints> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法生成页面指纹。');
  const pages: string[] = [];
  try {
    for (let number = 1; number <= doc.numPages; number++) {
      await options.beforePage?.();
      options.signal.throwIfAborted();
      options.progress(number, doc.numPages);
      let page: Awaited<ReturnType<PdfJsDocument['getPage']>> | undefined;
      let render: import('pdfjs-dist').RenderTask | undefined;
      let active = true;
      try {
        const key = await awaitPdfOperation((async () => {
          page = await doc.getPage(number);
          if (!active) {
            if (!options.retainPage?.(number)) page.cleanup();
            return '';
          }
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 3072 / Math.max(base.width, base.height)) });
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          render = page.render({ canvasContext: ctx, viewport, background: '#fff' });
          await render.promise;
          render = undefined;
          if (!active) return '';
          const pixelBytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const hash = await crypto.subtle.digest('SHA-256', pixelBytes);
          return [base.width, base.height, canvas.width, canvas.height,
            ...Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0'))].join(':');
        })(), options.signal, `第 ${number} 页处理超时。`);
        pages.push(key);
      } finally {
        active = false;
        render?.cancel();
        if (!options.retainPage?.(number)) page?.cleanup();
      }
    }
  } finally { canvas.width = canvas.height = 1; }
  return { version: 1, pages };
}
