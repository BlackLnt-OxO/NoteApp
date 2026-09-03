// ---- Tool & Interaction Types ------------------------------------------------

export type ToolType = 'pen' | 'eraser' | 'text' | 'select' | 'insert';

export type InsertMode = 'text' | 'image';

export type SelectionMode = 'box' | 'click';

// ---- Coordinate System -------------------------------------------------------

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

// ---- Brush Settings (toolbar UI) ---------------------------------------------

export interface BrushSettings {
  size: number;
  opacity: number;
  color: string;
  smoothing: number; // 0-1, maps to 1€ filter minCutoff (PS-style)
}

// ---- Stroke ------------------------------------------------------------------

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  t: number; // timestamp ms (for 1€ filter)
}

export interface Stroke {
  id: string;
  type: 'stroke';
  points: StrokePoint[];
  color: string;
  size: number;
  opacity: number;
  smoothing: number;
  compositeOperation: 'source-over' | 'destination-out';
  /**
   * Optional brush style. Legacy strokes (without this field) render as marker.
   * 'laser' is excluded because it is transient and never committed.
   */
  style?: CommittedStrokeStyle;
  createdAt: number;
}

// ---- Brush style --------------------------------------------------------------

export type CommittedStrokeStyle = 'marker' | 'fountain' | 'pencil';

export type BrushType = CommittedStrokeStyle | 'laser';

// ---- Text Node ---------------------------------------------------------------

export interface TextNodeData {
  id: string;
  type: 'text';
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

export interface ImageObject {
  id: string;
  type: 'image';
  x: number;
  y: number;
  /** World-space width/height (pre-zoom). */
  width: number;
  height: number;
  dataUrl: string;
  createdAt: number;
}

// ---- Unified Object Type -----------------------------------------------------

export type CanvasObject = Stroke | TextNodeData | ImageObject;

// ---- Persisted Canvas Data ---------------------------------------------------

export interface PersistedCanvasData {
  objects: CanvasObject[];
  camera: Camera;
  dotDensity: number;
}

// ---- Multi-canvas library ----------------------------------------------------

export interface CanvasCategory {
  id: string;
  name: string;
  createdAt: number;
}

export interface CanvasMeta {
  id: string;
  name: string;
  categoryId: string | null;
  createdAt: number;
  updatedAt: number;
}
