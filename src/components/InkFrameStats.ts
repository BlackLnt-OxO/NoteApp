/**
 * InkFrameStats — what the ink layer did on the last frame, plus what the camera
 * is doing.
 *
 * Published from the render loop into a mutable singleton rather than through
 * React state: the render loop must not re-render anything in order to report,
 * and the reader (the diagnostic panel) is a passive observer that may not even
 * be open.
 *
 * The point of separating `drawMs` from the frame interval is to answer ONE
 * question: when panning or zooming feels slow, is the ink layer the reason, or
 * is the frame time going somewhere else (DOM/React work, compositing, or the
 * process being throttled)? A small `drawMs` with a bad frame interval rules the
 * ink layer out; a `drawMs` as large as the frame interval indicts it.
 */

export interface InkFrameStats {
  /** Milliseconds the last frame spent drawing the ink layer (committed tiles +
   *  the live stroke), and the worst seen since the last reset. */
  drawMs: number;
  worstDrawMs: number;
  /** Worst ink draw time observed WHILE the camera was moving — the figure that
   *  matters for a pan or a zoom. */
  movingWorstDrawMs: number;
  /** Tiles rasterized and held by the layer. */
  tileCount: number;
  /** How many of them the last frame actually drew. */
  visibleTiles: number;
  /** Estimated bytes held by the layer's canvases. */
  tileBytes: number;
  /** Current bake scale, in tile pixels per world unit. */
  bakeScale: number;
  /** Camera state the numbers above were produced at. */
  zoom: number;
  dpr: number;
  /** Which editor reported last (only one is mounted at a time). */
  surface: 'canvas' | 'pdf';
}

/** How long after a camera change a frame still counts as "moving". Chosen to
 *  cover one wheel-gesture's momentum, not so long that idle frames get counted. */
export const CAMERA_MOVE_WINDOW_MS = 150;

const EMPTY: InkFrameStats = {
  drawMs: 0, worstDrawMs: 0, movingWorstDrawMs: 0,
  tileCount: 0, visibleTiles: 0, tileBytes: 0, bakeScale: 0,
  zoom: 1, dpr: 1, surface: 'canvas',
};

let stats: InkFrameStats = { ...EMPTY };
let cameraMovedAt = -Infinity;

export function reportInkFrame(partial: Partial<InkFrameStats>): void {
  stats = { ...stats, ...partial };
  if (stats.drawMs > stats.worstDrawMs) stats.worstDrawMs = stats.drawMs;
  if (cameraMoving() && stats.drawMs > stats.movingWorstDrawMs) {
    stats.movingWorstDrawMs = stats.drawMs;
  }
}

/** Called on every camera change (pan / zoom), from the input path. */
export function noteCameraMove(): void {
  cameraMovedAt = performance.now();
}

/** True while the camera has recently been moving — i.e. this frame is part of a
 *  pan or a zoom gesture rather than an idle repaint. */
export function cameraMoving(): boolean {
  return performance.now() - cameraMovedAt < CAMERA_MOVE_WINDOW_MS;
}

export function readInkFrame(): InkFrameStats {
  return stats;
}

/** Clear the accumulators (worst-frame figures), for measuring one gesture. */
export function resetInkFrame(): void {
  stats = { ...EMPTY, zoom: stats.zoom, dpr: stats.dpr, surface: stats.surface };
  cameraMovedAt = -Infinity;
}
