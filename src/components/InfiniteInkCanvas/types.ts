// ---- Tool & Interaction Types ------------------------------------------------

export type ToolType = 'pen' | 'eraser' | 'text';

// ---- Coordinate System -------------------------------------------------------

export interface Camera {
  x: number;       // world offset in screen pixels
  y: number;
  zoom: number;    // 0.1 to 8
}

// ---- Brush Settings ----------------------------------------------------------

export interface BrushSettings {
  size: number;              // 1–200 px (world units)
  opacity: number;           // 0–1
  hardness: number;          // 0–1 (0 = soft edge, 1 = hard edge)
  spacing: number;           // fraction of size (0.01–1), lower = denser stamps
  smoothing: number;         // 0–1 (0 = none, 1 = maximum)
  color: string;             // rgba or hex
  pressureSize: boolean;     // pressure affects size
  pressureOpacity: boolean;  // pressure affects opacity
}

// ---- Stamp / Stroke Types ----------------------------------------------------

/** A single stamp point stored in world coordinates. */
export interface StampPoint {
  x: number;
  y: number;
  size: number;       // computed size after pressure mapping
  opacity: number;    // computed opacity after pressure mapping
  pressure: number;   // raw pressure 0–1
  tiltX: number;
  tiltY: number;
}

export interface Stroke {
  id: string;
  type: 'stroke';
  points: StampPoint[];
  brushSettings: BrushSettings;  // snapshot of settings at time of drawing
  compositeOperation: GlobalCompositeOperation; // 'source-over' | 'destination-out'
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
  fontSize: number;   // world units
  color: string;
  backgroundColor: string;
  createdAt: number;
  updatedAt: number;
}

// ---- Unified Object Type -----------------------------------------------------

export type CanvasObject = Stroke | TextNodeData;

// ---- Raw Pointer Sample (before processing) ----------------------------------

export interface PointerSample {
  x: number;       // world coords
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  timestamp: number;
}

// ---- Persisted Canvas Data ---------------------------------------------------

export interface PersistedCanvasData {
  objects: CanvasObject[];
  camera: Camera;
  dotDensity: number;
}
