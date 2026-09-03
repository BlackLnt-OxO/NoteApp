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
  /**
   * Optional brush style. Legacy strokes (without this field) render as marker.
   * 'laser' is excluded here because it is transient and never committed.
   */
  style?: PdfCommittedStrokeStyle;
  /** Fountain only: ink-speed sensitivity captured at draw time. */
  inkSpeed?: number;
  /** Marker only: pressure→opacity flag captured at draw time. */
  pressureOpacity?: boolean;
  /** Soft edge feather flag captured at draw time (defaults to ON). */
  edgeFeather?: boolean;
  createdAt: number;
}

export type PdfCommittedStrokeStyle = 'marker' | 'fountain' | 'pencil';

export type PdfBrushType = PdfCommittedStrokeStyle | 'laser';

export type PdfTool = 'pen' | 'eraser' | 'select';

export type PdfEraserMode = 'free' | 'stroke';
export type PdfSelectionMode = 'box' | 'click';

export interface PdfBrush {
  size: number;
  opacity: number;
  color: string;
  smoothing: number;
  /** Fountain only: how strongly fast writing thins the line (0-1). */
  inkSpeed: number;
  /** Marker only: enable pressure-driven opacity (0 → light ink, 1 → full). */
  pressureOpacity: boolean;
  /** Soft edge: apply a short, width-proportional feather to ink edges. */
  edgeFeather?: boolean;
  /** Three quick-size presets (default 8 / 20 / 40). */
  quickSizes: number[];
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
