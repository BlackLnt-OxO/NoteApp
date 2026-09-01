/**
 * PdfAnnotation — types.
 *
 * Self-contained module: the PDF note-taking view intentionally has NO
 * dependency on the InfiniteInkCanvas writing pipeline, so it can be replaced
 * / promoted later without touching the existing canvas code.
 */

export interface PdfPoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
}

export interface PdfStroke {
  id: string;
  type: 'stroke';
  points: PdfPoint[];
  color: string;
  size: number;
  opacity: number;
  smoothing: number;
  /** 'destination-out' marks an eraser stroke (must be applied to inkLayer only). */
  compositeOperation: 'source-over' | 'destination-out';
  createdAt: number;
}

export type PdfTool = 'pen' | 'eraser' | 'select';

export type PdfEraserMode = 'free' | 'stroke';
export type PdfSelectionMode = 'box' | 'click';

export interface PdfBrush {
  size: number;
  opacity: number;
  color: string;
  smoothing: number;
}

export interface PdfCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface PdfPageSize {
  width: number;
  height: number;
}

/** Opaque reference to a pdf.js page object (used only inside the canvas). */
export type PdfJsPage = unknown;
