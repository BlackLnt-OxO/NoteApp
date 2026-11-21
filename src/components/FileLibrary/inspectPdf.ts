import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type { PdfJsDocument } from '../PdfAnnotation/PdfLoader';
import type { PdfPageSize } from '../PdfAnnotation/PdfTypes';
import type { PageFingerprints } from './annotationFiles';

export interface OpenedPdf {
  doc: PdfJsDocument;
  firstPage: PdfPageSize;
  dispose: () => void;
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
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const { width, height } = page.getViewport({ scale: 1 });
    page.cleanup();
    return { doc, firstPage: { width, height }, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export async function fingerprintPages(doc: PdfJsDocument, check: () => void): Promise<PageFingerprints> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法生成页面指纹。');
  const pages: string[] = [];
  try {
    for (let number = 1; number <= doc.numPages; number++) {
      check();
      const page = await doc.getPage(number);
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 3072 / Math.max(base.width, base.height)) });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        await page.render({ canvasContext: ctx, viewport, background: '#fff' }).promise;
        const pixelBytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const hash = await crypto.subtle.digest('SHA-256', pixelBytes);
        pages.push([base.width, base.height, canvas.width, canvas.height,
          ...Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0'))].join(':'));
      } finally { page.cleanup(); }
    }
  } finally { canvas.width = canvas.height = 1; }
  return { version: 1, pages };
}
