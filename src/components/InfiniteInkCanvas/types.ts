/**
 * Canvas view types.
 *
 * The ink data shapes themselves (`Stroke`, `StrokePoint`, `Camera`, the insert
 * objects) now live in `InkCore/inkTypes.ts`, shared with the PDF annotation
 * view — they used to be two parallel declarations of the same thing. They are
 * re-exported here under their historical names so every call site, component
 * prop and store signature in this folder is unchanged.
 *
 * Only the genuinely canvas-only types remain declared here (multi-canvas
 * library metadata, persisted payload).
 */

import type {
  InkBrush,
  InkBrushType,
  InkCamera,
  InkCommittedStrokeStyle,
  InkEraserMode,
  InkImageObject,
  InkInsertMode,
  InkItem,
  InkPoint,
  InkSelectionMode,
  InkStroke,
  InkTextObject,
  InkTool,
} from '../InkCore/inkTypes';

// ---- Re-exported ink types (historical names) ----------------------------------

export type Camera = InkCamera;
export type BrushSettings = InkBrush;
export type BrushType = InkBrushType;
export type CommittedStrokeStyle = InkCommittedStrokeStyle;
export type StrokePoint = InkPoint;
export type Stroke = InkStroke;
export type TextNodeData = InkTextObject;
export type ImageObject = InkImageObject;
export type CanvasObject = InkItem;

/** The canvas view DOES expose a standalone text tool. */
export type ToolType = InkTool;
export type SelectionMode = InkSelectionMode;
export type InsertMode = InkInsertMode;
export type EraserMode = InkEraserMode;

// ---- Persisted canvas data -----------------------------------------------------

export interface PersistedCanvasData {
  objects: CanvasObject[];
  camera: Camera;
  dotDensity: number;
}

// ---- Multi-canvas library ------------------------------------------------------

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
