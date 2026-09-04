/**
 * themeColors — shared theme-adaptive colors for the ink workbenches.
 *
 * The canvas / PDF backgrounds were hard-coded to a dark navy. When the user
 * switches to the light theme the workbench should turn light too, and the
 * default brush + dot-grid must flip contrast so they stay visible.
 */

export type ThemeName = 'dark' | 'light';

export const CANVAS_BG_DARK = '#1a1a2e';
export const CANVAS_BG_LIGHT = '#e7e4df';

export const DOT_COLOR_DARK = 'rgba(255,255,255,0.18)';
export const DOT_COLOR_LIGHT = 'rgba(30,30,40,0.18)';

/** Default brush ink — near-white on dark workbenches, near-black on light. */
export const DEFAULT_BRUSH_DARK = 'rgba(255,255,255,0.95)';
export const DEFAULT_BRUSH_LIGHT = 'rgba(30,30,40,0.95)';

/** True when the brush is still on its default color (so a theme flip can swap it). */
export function isDefaultBrushColor(color: string): boolean {
  return color === DEFAULT_BRUSH_DARK || color === DEFAULT_BRUSH_LIGHT;
}

/**
 * PDF annotation default ink + text-card color. FIXED regardless of app theme
 * (blue-600: clearly visible on a white PDF page, but not deep). Change here to
 * retint PDF annotations; the canvas default color still follows the theme.
 * Also inserted as a shared palette swatch (see Toolbar / PdfToolbar).
 */
export const PDF_ANNOTATION_BLUE = '#2563eb';

export function themeCanvasColors(theme: ThemeName): {
  background: string;
  dotColor: string;
  defaultBrush: string;
} {
  const light = theme === 'light';
  return {
    background: light ? CANVAS_BG_LIGHT : CANVAS_BG_DARK,
    dotColor: light ? DOT_COLOR_LIGHT : DOT_COLOR_DARK,
    defaultBrush: light ? DEFAULT_BRUSH_LIGHT : DEFAULT_BRUSH_DARK,
  };
}
