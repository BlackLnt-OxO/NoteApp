/**
 * inkTypes — the single source of truth for the ink pipeline's data shapes.
 *
 * Both ink surfaces (the infinite canvas and the PDF annotation view) used to
 * declare their own near-identical copies of these (`Stroke`/`PdfStroke`,
 * `Camera`/`PdfCamera`, …) along with two parallel implementations of the
 * geometry, the brush rasterizers and the tile layer. Those are now shared here,
 * so a stroke drawn on one surface is literally the same shape as on the other.
 *
 * The old per-surface names still exist — as type ALIASES in
 * `InfiniteInkCanvas/types.ts` and `PdfAnnotation/PdfTypes.ts` — so every call
 * site, component prop and store signature is unchanged. Only the duplicated
 * implementation bodies were removed.
 */

// ---- Geometry ------------------------------------------------------------------

export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
  /** Timestamp (ms) — drives the 1€ filter's speed estimate. */
  t: number;
}

export interface InkCamera {
  x: number;
  y: number;
  zoom: number;
}

// ---- Stroke --------------------------------------------------------------------

export type InkCommittedStrokeStyle = 'marker' | 'fountain' | 'pencil';

/** 'laser' is transient (never committed / persisted) so it is excluded from the
 *  committed stroke styles but valid as a selectable brush. */
export type InkBrushType = InkCommittedStrokeStyle | 'laser';

export interface InkStroke {
  id: string;
  type: 'stroke';
  points: InkPoint[];
  color: string;
  size: number;
  opacity: number;
  smoothing: number;
  /** 'destination-out' marks an eraser carve. It must only ever be applied to
   *  the ink layer, never to a background. */
  compositeOperation: 'source-over' | 'destination-out';
  /** Optional brush style. Legacy strokes (without this field) render as marker. */
  style?: InkCommittedStrokeStyle;
  /** Fountain only: ink-speed sensitivity captured at draw time. */
  inkSpeed?: number;
  /** Marker/fountain: pressure→opacity flag captured at draw time. */
  pressureOpacity?: boolean;
  /** Soft edge feather flag captured at draw time (defaults to ON). */
  edgeFeather?: boolean;
  createdAt: number;
}

// ---- Brush settings ------------------------------------------------------------

export interface InkBrush {
  size: number;
  opacity: number;
  color: string;
  smoothing: number; // 0-1, maps to 1€ filter minCutoff (PS-style)
  /** Fountain only: how strongly fast writing thins the line (0-1). */
  inkSpeed: number;
  /** Marker only: enable pressure-driven opacity (0 → light ink, 1 → full). */
  pressureOpacity: boolean;
  /** Soft edge: apply a short, width-proportional feather to ink edges. */
  edgeFeather?: boolean;
  /** Three quick-size presets (default 8 / 20 / 40). */
  quickSizes: number[];
}

// ---- Insertable objects ---------------------------------------------------------

export interface InkTextObject {
  id: string;
  type: 'text';
  /** World coordinates; box top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  fontSize: number;
  color: string;
  backgroundColor: string;
  createdAt: number;
  updatedAt: number;
}

export interface InkImageObject {
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

/** Anything on an ink surface: a rasterized stroke or a DOM-only insert object. */
export type InkItem = InkStroke | InkTextObject | InkImageObject;

// ---- Tool / interaction ---------------------------------------------------------

/** Superset: the PDF view has no standalone `'text'` tool (it reaches text via
 *  `insert` + `insertMode: 'text'`). */
export type InkTool = 'pen' | 'eraser' | 'text' | 'select' | 'insert';

export type InkEraserMode = 'free' | 'stroke';
export type InkSelectionMode = 'box' | 'click';
export type InkInsertMode = 'text' | 'image';

// ---- Misc -----------------------------------------------------------------------

export interface InkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface InkPageSize {
  width: number;
  height: number;
}
