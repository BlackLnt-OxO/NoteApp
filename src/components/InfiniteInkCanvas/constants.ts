import type { Camera, BrushSettings } from './types';

// ---- Defaults ----------------------------------------------------------------

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export const DEFAULT_BRUSH: BrushSettings = {
  size: 8,
  opacity: 1,
  color: 'rgba(255,255,255,0.95)',
  smoothing: 0.05,
  inkSpeed: 0.5,
  pressureOpacity: false,
  edgeFeather: true,
  featherSize: 0.4,
  quickSizes: [8, 20, 40],
  eraserSize: 20,
  eraserQuickSizes: [12, 20, 60],
};

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export const STORAGE_KEY = 'stickynotes-inkcanvas'; // legacy single-canvas key (migrated)

export const CANVAS_LIST_KEY = 'stickynotes-inkcanvas-list';
export const canvasDataKey = (id: string): string => `stickynotes-inkcanvas-${id}`;

export const ERASER_RADIUS = 20; // world units

export const TEXT_DEFAULTS = {
  fontSize: 16,
  minWidth: 100,
  minHeight: 40,
  color: 'var(--text-primary)',
  backgroundColor: 'var(--glass-bg)',
};

export const MAX_HISTORY = 50;

// ---- Toolbar ------------------------------------------------------------------

export const TOOLBAR_STORAGE_KEY = 'stickynotes-inkcanvas-toolbar';

export const MIN_TOOLBAR_WIDTH = 180;         // narrowest before content gets cut off
export const TOOLBAR_COLLAPSE_WIDTH = 80;     // below this the resize triggers collapse
export const MAX_TOOLBAR_WIDTH = 420;
export const AUTO_COLLAPSE_EDGE_PX = 30;      // distance from right edge to auto-collapse
export const RESIZE_HANDLE_WIDTH = 6;

/** Toolbar defaults — docked to the right side of the canvas area. */
export const DEFAULT_TOOLBAR_STATE = {
  expanded: true,
  width: 240,
  lastExpandedWidth: 240,
  top: 16,
  /** Distance from the docked edge (left or right) in px. */
  offset: 8,
  side: 'right' as const,
};

// ---- Coordinate Transforms ---------------------------------------------------

/**
 * Convert screen (CSS-pixel) coordinates to world coordinates.
 * `screenX/Y` are relative to the canvas element's top-left corner.
 */
export function screenToWorld(
  screenX: number,
  screenY: number,
  camera: Camera,
): { x: number; y: number } {
  return {
    x: (screenX - camera.x) / camera.zoom,
    y: (screenY - camera.y) / camera.zoom,
  };
}

/**
 * Convert world coordinates to screen (CSS-pixel) coordinates,
 * relative to the canvas element's top-left corner.
 */
export function worldToScreen(
  worldX: number,
  worldY: number,
  camera: Camera,
): { x: number; y: number } {
  return {
    x: worldX * camera.zoom + camera.x,
    y: worldY * camera.zoom + camera.y,
  };
}

/** Clamp zoom to allowed range. */
export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/**
 * Zoom the camera so that the world point under `screenX,screenY` stays fixed.
 * `screenX/Y` are relative to the canvas top-left.
 */
export function zoomAt(
  camera: Camera,
  screenX: number,
  screenY: number,
  nextZoom: number,
): Camera {
  const worldX = (screenX - camera.x) / camera.zoom;
  const worldY = (screenY - camera.y) / camera.zoom;
  return {
    zoom: nextZoom,
    x: screenX - worldX * nextZoom,
    y: screenY - worldY * nextZoom,
  };
}

// ---- Utility: parse colour string to r,g,b -----------------------------------

export function parseRGBA(color: string): { r: number; g: number; b: number; a: number } {
  // rgba() / rgb()
  const rgba = color.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/,
  );
  if (rgba) {
    return {
      r: parseInt(rgba[1], 10),
      g: parseInt(rgba[2], 10),
      b: parseInt(rgba[3], 10),
      a: rgba[4] !== undefined ? parseFloat(rgba[4]) : 1,
    };
  }

  // hex
  const hex = color.replace('#', '');
  if (/^[0-9a-fA-F]+$/.test(hex)) {
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1,
      };
    }
  }

  return { r: 0, g: 0, b: 0, a: 1 };
}
