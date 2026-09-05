/**
 * PdfLoader — thin wrapper around pdf.js so PdfStore never has to know the
 * library.  Loads the worker lazily on first use (keeps tests light).
 */
import type { PdfPageSize } from './PdfTypes';

// Vite bundles the pdf.js worker as a real Worker. This works in dev AND in
// production file:// builds (unlike workerSrc pointing at an emitted asset).
// eslint-disable-next-line import/no-unresolved
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

type PdfJsModule = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfJsModule['getDocument']>>['promise'] extends Promise<infer T> ? T : never;
export type PdfJsDocument = PdfDocument;

let pdfjs: PdfJsModule | null = null;
let workerConfigured = false;

async function getLib(): Promise<PdfJsModule> {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist');
  }
  if (!workerConfigured && pdfjs.GlobalWorkerOptions) {
    try {
      pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
    } catch {
      /* fall back to pdf.js's own worker handling (fake worker) */
    }
    workerConfigured = true;
  }
  return pdfjs;
}

let activeLoadAbort: (() => void) | null = null;

/**
 * Best-effort abort of the currently in-flight pdf.js document load (if any).
 * Used by the "中断" button shown after a PDF import has been spinning 10s —
 * destroys the loading task so a stuck getDocument() rejects and unwinds.
 */
export function abortActivePdfLoad(): void {
  const a = activeLoadAbort;
  activeLoadAbort = null;
  if (a) { try { a(); } catch { /* ignore */ } }
}

/** Parse a PDF from an ArrayBuffer. Returns the pdf.js document + page 1 size. */
export async function loadPdfDocument(
  buffer: ArrayBuffer,
): Promise<{ doc: PdfJsDocument; numPages: number; firstPage: PdfPageSize }> {
  const lib = await getLib();
  // pdf.js v6+ requires a TypedArray, not a bare ArrayBuffer.
  const loadingTask = lib.getDocument({ data: new Uint8Array(buffer) });
  activeLoadAbort = () => { try { (loadingTask as any).destroy(); } catch { /* ignore */ } };
  try {
    const doc = await loadingTask.promise;
    activeLoadAbort = null;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const firstPage: PdfPageSize = { width: vp.width, height: vp.height };
    page.cleanup();
    return { doc: doc as unknown as PdfJsDocument, numPages: doc.numPages, firstPage };
  } catch (e) {
    activeLoadAbort = null;
    throw e;
  }
}

/** Render a single page to the given offscreen canvas at a scale factor. */
export async function renderPageToCanvas(
  doc: PdfJsDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number,
): Promise<void> {
  const page = await (doc as any).getPage(pageNumber);
  const vp = page.getViewport({ scale });
  if (canvas.width !== Math.round(vp.width) || canvas.height !== Math.round(vp.height)) {
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
}

/** Get the world size (scale 1 viewport) of a page. */
export async function getPageSize(doc: PdfJsDocument, pageNumber: number): Promise<PdfPageSize> {
  const page = await (doc as any).getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  page.cleanup();
  return { width: vp.width, height: vp.height };
}

/** Release the page's resources (fonts/images) after leaving it. */
export async function cleanupPage(doc: PdfJsDocument, pageNumber: number): Promise<void> {
  try {
    const page = await (doc as any).getPage(pageNumber);
    page.cleanup();
  } catch {
    /* page may already be gone */
  }
}

/** Render a small thumbnail (fixed target width in CSS px) onto a canvas. */
export async function renderThumbnail(
  doc: PdfJsDocument,
  pageNumber: number,
  targetWidth: number,
): Promise<HTMLCanvasElement> {
  const page = await (doc as any).getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
  }
  return canvas;
}
