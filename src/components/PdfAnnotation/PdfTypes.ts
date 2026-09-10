/**
 * PDF annotation view types.
 *
 * The ink data shapes themselves (`PdfStroke`, `PdfPoint`, `PdfCamera`, the
 * insert objects) now live in `InkCore/inkTypes.ts`, shared with the infinite
 * canvas — they used to be two parallel declarations of the same thing, and the
 * canvas view had in fact been importing this folder's engine all along, so the
 * "no dependency between the two" claim this header used to make was already
 * false. They are re-exported here under their historical names so every call
 * site, component prop and store signature in this folder is unchanged.
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
  InkPageSize,
  InkPoint,
  InkSelectionMode,
  InkStroke,
  InkTextObject,
  InkTool,
} from '../InkCore/inkTypes';

// ---- Re-exported ink types (historical names) ----------------------------------

export type PdfPoint = InkPoint;
export type PdfStroke = InkStroke;
export type PdfCamera = InkCamera;
export type PdfBrush = InkBrush;
export type PdfBrushType = InkBrushType;
export type PdfCommittedStrokeStyle = InkCommittedStrokeStyle;
export type PdfTextObject = InkTextObject;
export type PdfImageObject = InkImageObject;
export type PdfItem = InkItem;
export type PdfPageSize = InkPageSize;
export type PdfEraserMode = InkEraserMode;
export type PdfSelectionMode = InkSelectionMode;
export type PdfInsertMode = InkInsertMode;

/** The PDF view has no standalone text tool — it reaches text via
 *  `insert` + `insertMode: 'text'`. */
export type PdfTool = Exclude<InkTool, 'text'>;

// ---- PDF-only -------------------------------------------------------------------

/** Opaque reference to a pdf.js page object (used only inside the canvas). */
export type PdfJsPage = unknown;
