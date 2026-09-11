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
  /** 2 = streaming marker/fountain/pencil coverage; absent = legacy ribbon. */
  renderVersion?: 2;
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
  /** Feather radius in WORLD px, captured at draw time. Absent on legacy ink,
   *  which falls back to the width-derived value. 0 = no feather. */
  featherSize?: number;
  createdAt: number;
}

export type PdfCommittedStrokeStyle = 'marker' | 'fountain' | 'pencil';

export type PdfBrushType = PdfCommittedStrokeStyle | 'laser';

export type PdfTool = 'pen' | 'eraser' | 'select' | 'insert';

export type PdfEraserMode = 'free' | 'stroke';
export type PdfSelectionMode = 'box' | 'click';
export type PdfInsertMode = 'text' | 'image';

// ---- Insertable objects (text card / image) --------------------------------

/** A committed text card placed on the PDF page (page world coordinates). */
export interface PdfTextObject {
  id: string;
  type: 'text';
  /** Page world units; box top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  fontSize: number;
  /** Fixed PDF_ANNOTATION_BLUE by default (never theme-adaptive). */
  color: string;
  backgroundColor: string;
  createdAt: number;
  updatedAt: number;
}

/** A raster image placed on the PDF page (page world coordinates). */
export interface PdfImageObject {
  id: string;
  type: 'image';
  x: number;
  y: number;
  /** World-space width/height (pre-zoom). */
  width: number;
  height: number;
  /** Inline PNG data URL (downscaled ≤ 1280 px wide on insert). */
  dataUrl: string;
  createdAt: number;
}

/** Anything drawn / placed on one PDF page: ink strokes or insert objects. */
export type PdfItem = PdfStroke | PdfTextObject | PdfImageObject;

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
  /** Feather radius in WORLD px for new strokes (the 羽化大小 control).
   *  Larger = softer edge; 0 = none. */
  featherSize: number;
  /** Three quick-size presets (default 8 / 20 / 40). */
  quickSizes: number[];
  /**
   * Eraser diameter in world units. The eraser has its OWN size rather than
   * reusing `size`: the toolbar's size controls re-target on the active tool, so
   * a 2px pen and a 40px eraser coexist and each survives a tool switch.
   */
  eraserSize: number;
  /** Quick-size presets for the eraser (its own, mirroring `quickSizes`). */
  eraserQuickSizes: number[];
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
