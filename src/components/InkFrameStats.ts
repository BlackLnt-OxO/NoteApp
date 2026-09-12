/**
 * InkFrameStats — what the ink layer actually did on the last frame.
 *
 * Published from the render loop into a mutable singleton rather than through
 * React state: the render loop must not re-render anything to report, and the
 * reader (the diagnostic panel) is a passive observer that may not even be open.
 * Nothing here is allocated per frame beyond a single object reuse.
 */

export interface InkFrameStats {
  /** Milliseconds the last frame spent drawing the ink layer (tiles + the live
   *  stroke), and the worst seen since the last reset. */
  drawMs: number;
  worstDrawMs: number;
  /** Tiles rasterized and held by the layer. */
  tileCount: number;
  /** How many of them the last frame actually drew. */
  visibleTiles: number;
  /** Estimated bytes held by the layer's canvases. */
  tileBytes: number;
  /** Current bake scale, in tile pixels per world unit. */
  bakeScale: number;
}

const EMPTY: InkFrameStats = {
  drawMs: 0, worstDrawMs: 0, tileCount: 0, visibleTiles: 0, tileBytes: 0, bakeScale: 0,
};

let stats: InkFrameStats = { ...EMPTY };

export function reportInkFrame(partial: Partial<InkFrameStats>): void {
  stats = { ...stats, ...partial };
  if (stats.drawMs > stats.worstDrawMs) stats.worstDrawMs = stats.drawMs;
}

export function readInkFrame(): InkFrameStats {
  return stats;
}

/** Called when the editor unmounts, so a stale readout cannot be mistaken for a
 *  running one. */
export function resetInkFrame(): void {
  stats = { ...EMPTY };
}
