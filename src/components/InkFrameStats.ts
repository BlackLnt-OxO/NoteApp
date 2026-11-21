/**
 * InkFrameStats — what the ink layer did on the last frame, plus the frame
 * intervals it painted at.
 *
 * Published from the render loop into a mutable singleton rather than through
 * React state: the render loop must not re-render anything in order to report,
 * and the reader (the diagnostic panel) is a passive observer that is usually
 * closed.
 *
 * The frame intervals are sampled BY the render loop, not by a monitor of their
 * own. That has three consequences worth the comment: it costs nothing extra (no
 * second rAF loop burning a frame's worth of work forever), it measures only
 * frames the app actually painted — which is exactly the set a person can
 * perceive — and it keeps sampling whether or not the panel is open, so a stutter
 * can be reproduced by simply using the canvas and then looking. (The panel is an
 * overlay: with it open the canvas cannot be scrolled at all, so anything that
 * only sampled while it was visible would measure nothing.)
 *
 * `drawMs` is kept separate from the interval on purpose: it answers ONE
 * question. When panning or zooming feels slow, a small `drawMs` next to a bad
 * interval rules the ink layer out and points elsewhere (other components, or the
 * process being throttled); a `drawMs` as large as the interval indicts it.
 */

/** One frame-window's summary. */
export interface FrameWindow {
  frames: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
  over33: number;
  over50: number;
}

export interface InkFrameStats {
  backend: 'worker' | 'fallback';
  queuedTiles: number;
  tileBuildMs: number;
  tileWaitMs: number;
  cacheHits: number;
  workerBytes: number;
  totalInkBytes: number;
  inputMs: number;
  liveMs: number;
  inputP95Ms: number;
  liveP95Ms: number;
  longTasks: number;
  longestTaskMs: number;
  /** Milliseconds the last frame spent drawing the ink layer (committed tiles +
   *  the live stroke), and the worst seen since the last reset. */
  drawMs: number;
  worstDrawMs: number;
  /** Worst ink draw time observed WHILE the camera was moving — the figure that
   *  matters for a pan or a zoom. */
  movingWorstDrawMs: number;
  /** Milliseconds the last materialization pass spent rasterizing (budgeted,
   *  but a single stroke raster can overshoot), and the worst since reset. */
  matMs: number;
  worstMatMs: number;
  /** The canvas paint the ink metrics do NOT cover: clear + background + dot
   *  grid. When frame intervals are bad but 墨迹绘制 is small, this row says
   *  whether the rest of the canvas paint is the reason. */
  paintMs: number;
  /** Last persistence write: the document body and the small view state.
   *  A dense body costs a join + a blocking storage hop — when frame intervals
   *  spike ~a second after a gesture, this is where it shows. */
  saveBodyMs: number;
  saveViewMs: number;
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
 *  cover one wheel gesture's momentum, not so long that idle frames join in. */
export const CAMERA_MOVE_WINDOW_MS = 150;

/** How long the camera must be still before the ink layer may spend real time on
 *  it — re-rasterizing tiles at a sharper bake scale, reclaiming distant tiles.
 *  Long enough to cover the gaps inside one wheel/pan gesture (so a gesture is
 *  never interrupted), short enough that the sharpening lands while the user is
 *  still looking at the spot they zoomed to. */
export const CAMERA_SETTLE_MS = 220;

/** ~10 s at 60 Hz. Bounded so the numbers on screen are always about recent use
 *  and the arrays cannot grow without limit. */
const WINDOW = 600;
/** A gap longer than this means the app was not being used (window hidden, debug
 *  paused, developer tools). Recording it would poison the worst-case figure. */
const MAX_PLAUSIBLE_FRAME_MS = 1000;

const EMPTY: InkFrameStats = {
  backend: 'fallback', queuedTiles: 0, tileBuildMs: 0, tileWaitMs: 0,
  cacheHits: 0, workerBytes: 0, totalInkBytes: 0, inputMs: 0, liveMs: 0,
  inputP95Ms: 0, liveP95Ms: 0, longTasks: 0, longestTaskMs: 0,
  drawMs: 0, worstDrawMs: 0, movingWorstDrawMs: 0, matMs: 0, worstMatMs: 0,
  paintMs: 0, saveBodyMs: 0, saveViewMs: 0,
  tileCount: 0, visibleTiles: 0, tileBytes: 0, bakeScale: 0,
  zoom: 1, dpr: 1, surface: 'canvas',
};

let stats: InkFrameStats = { ...EMPTY };
let cameraMovedAt = -Infinity;
let lastFrameAt = -Infinity;
const movingFrames: number[] = [];
const otherFrames: number[] = [];
const inputTimes: number[] = [], liveTimes: number[] = [];
if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { stats.longTasks++; stats.longestTaskMs = Math.max(stats.longestTaskMs, entry.duration); }
  });
  observer.observe({ type: 'longtask' });
}

function push(window: number[], value: number): void {
  window.push(value);
  if (window.length > WINDOW) window.shift();
}

/** Called at the top of the ink layer's render, so the intervals measured are
 *  the app's real paint cadence. */
export function noteInkFrame(): void {
  const now = performance.now();
  const dt = now - lastFrameAt;
  lastFrameAt = now;
  if (dt > 0 && dt < MAX_PLAUSIBLE_FRAME_MS) {
    push(cameraMoving() ? movingFrames : otherFrames, dt);
  }
}

export function reportInkFrame(partial: Partial<InkFrameStats>): void {
  if (partial.inputMs !== undefined) push(inputTimes, partial.inputMs);
  if (partial.liveMs !== undefined) push(liveTimes, partial.liveMs);
  if (partial.cacheHits !== undefined) partial.cacheHits += stats.cacheHits;
  Object.assign(stats, partial);
  if (stats.drawMs > stats.worstDrawMs) stats.worstDrawMs = stats.drawMs;
  if (cameraMoving() && stats.drawMs > stats.movingWorstDrawMs) {
    stats.movingWorstDrawMs = stats.drawMs;
  }
  if (stats.matMs > stats.worstMatMs) stats.worstMatMs = stats.matMs;
}

/** Called on every camera change (pan / zoom), from the input path. */
export function noteCameraMove(): void {
  cameraMovedAt = performance.now();
}

/** True while the camera has recently been moving — i.e. this frame belongs to a
 *  pan or a zoom gesture rather than to writing or a cursor blink. */
export function cameraMoving(): boolean {
  return performance.now() - cameraMovedAt < CAMERA_MOVE_WINDOW_MS;
}

/** Milliseconds since the last camera change (Infinity if there has been none). */
export function msSinceCameraMove(): number {
  return performance.now() - cameraMovedAt;
}

/** Whether the camera has been still long enough to do expensive work for it. */
export function cameraSettled(): boolean {
  return msSinceCameraMove() >= CAMERA_SETTLE_MS;
}

function summarize(frames: number[]): FrameWindow {
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10 : 0);
  return {
    frames: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    worstMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : 0,
    over33: frames.filter((f) => f > 33).length,
    over50: frames.filter((f) => f > 50).length,
  };
}

/** Frame intervals painted while the camera was moving, and while it was not
 *  (writing, erasing, transient cursor/laser repaints). */
export function readFrameWindows(): { moving: FrameWindow; other: FrameWindow } {
  return { moving: summarize(movingFrames), other: summarize(otherFrames) };
}

export function readInkFrame(): InkFrameStats {
  stats.inputP95Ms = summarize(inputTimes).p95Ms;
  stats.liveP95Ms = summarize(liveTimes).p95Ms;
  return stats;
}

/** Clear the accumulators and the interval windows — for measuring one gesture. */
export function resetInkFrame(): void {
  stats = { ...EMPTY, zoom: stats.zoom, dpr: stats.dpr, surface: stats.surface };
  cameraMovedAt = -Infinity;
  lastFrameAt = -Infinity;
  movingFrames.length = 0;
  otherFrames.length = 0;
  inputTimes.length = 0; liveTimes.length = 0;
}
