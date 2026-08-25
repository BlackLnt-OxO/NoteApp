// ---- Tool & Interaction Types ------------------------------------------------

export type ToolType = 'pen' | 'eraser' | 'text' | 'select';

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
  compositeOperation: GlobalCompositeOperation;
  createdAt: number;
}

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

// ---- Unified Object Type -----------------------------------------------------

export type CanvasObject = Stroke | TextNodeData;

// ---- Persisted Canvas Data ---------------------------------------------------

export interface PersistedCanvasData {
  objects: CanvasObject[];
  camera: Camera;
  dotDensity: number;
}
