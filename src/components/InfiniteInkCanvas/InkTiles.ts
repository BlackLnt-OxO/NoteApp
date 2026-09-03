/**
 * InkTiles — sparse rasterized ink layer for the infinite canvas, ported from
 * PdfCanvas's tiled two-layer model.
 *
 * Strokes are stamped into a sparse grid of offscreen canvases (TILE×TILE world
 * units each, baked at SCALE×). Pen = source-over, free-eraser =
 * destination-out (only ever touches ink). The main canvas draws only the
 * visible tiles per frame, so writing/erasing is O(1) instead of re-rendering
 * every stroke's vector every frame.
 *
 * Text nodes are NOT rasterized here — they keep their vector/DOM path.
 */

import type { Camera, Stroke } from './types';
import { screenToWorld } from './constants';
import { drawAnnotatedStroke } from '../PdfAnnotation/PdfBrushRenderers';
import {
  drawEraserSegment,
  drawEraserDot,
  getStrokeBounds,
} from '../PdfAnnotation/PdfEngine';

const TILE = 512; // world units per tile
const SCALE = 3;  // bake supersampling (matches PDF_BAKE_SCALE)

function tileKey(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

function getTile(tiles: Map<string, HTMLCanvasElement>, tx: number, ty: number): HTMLCanvasElement {
  const key = tileKey(tx, ty);
  let c = tiles.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = Math.round(TILE * SCALE);
    c.height = Math.round(TILE * SCALE);
    tiles.set(key, c);
  }
  return c;
}

function tileCtx(tiles: Map<string, HTMLCanvasElement>, tx: number, ty: number): CanvasRenderingContext2D {
  return getTile(tiles, tx, ty).getContext('2d')!;
}

/** Draw a stroke into whichever tiles it intersects. */
export function stampStroke(tiles: Map<string, HTMLCanvasElement>, stroke: Stroke): void {
  const b = getStrokeBounds(stroke);
  const tx0 = Math.floor(b.minX / TILE), tx1 = Math.floor(b.maxX / TILE);
  const ty0 = Math.floor(b.minY / TILE), ty1 = Math.floor(b.maxY / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ctx = tileCtx(tiles, tx, ty);
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
      drawAnnotatedStroke(ctx, stroke);
    }
  }
}

/** Erase a segment (destination-out) across the tiles it touches. */
export function eraseSegTiles(
  tiles: Map<string, HTMLCanvasElement>,
  x1: number, y1: number, x2: number, y2: number, size: number,
): void {
  const pad = size / 2 + 2;
  const tx0 = Math.floor((Math.min(x1, x2) - pad) / TILE), tx1 = Math.floor((Math.max(x1, x2) + pad) / TILE);
  const ty0 = Math.floor((Math.min(y1, y2) - pad) / TILE), ty1 = Math.floor((Math.max(y1, y2) + pad) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ctx = tileCtx(tiles, tx, ty);
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
      drawEraserSegment(ctx, x1, y1, x2, y2, size);
    }
  }
}

/** Erase a single dot (destination-out) across the tiles it touches. */
export function eraseDotTiles(
  tiles: Map<string, HTMLCanvasElement>,
  x: number, y: number, size: number,
): void {
  const pad = size / 2 + 2;
  const tx0 = Math.floor((x - pad) / TILE), tx1 = Math.floor((x + pad) / TILE);
  const ty0 = Math.floor((y - pad) / TILE), ty1 = Math.floor((y + pad) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ctx = tileCtx(tiles, tx, ty);
      ctx.setTransform(SCALE, 0, 0, SCALE, -tx * TILE * SCALE, -ty * TILE * SCALE);
      drawEraserDot(ctx, x, y, size);
    }
  }
}

/** Draw all ink tiles that intersect the current viewport (camera already applied). */
export function drawVisibleTiles(
  ctx: CanvasRenderingContext2D,
  tiles: Map<string, HTMLCanvasElement>,
  cam: Camera,
  vw: number,
  vh: number,
): void {
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vw, vh, cam);
  const tx0 = Math.floor(tl.x / TILE), tx1 = Math.floor(br.x / TILE);
  const ty0 = Math.floor(tl.y / TILE), ty1 = Math.floor(br.y / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = tiles.get(tileKey(tx, ty));
      if (c) ctx.drawImage(c, tx * TILE, ty * TILE, TILE, TILE);
    }
  }
}

/** Rebuild the tile map from the vector source of truth (structural ops). */
export function rebuildTiles(
  strokes: Stroke[],
  excludeIds?: Set<string>,
): Map<string, HTMLCanvasElement> {
  const tiles = new Map<string, HTMLCanvasElement>();
  for (const s of strokes) {
    if (excludeIds?.has(s.id)) continue;
    stampStroke(tiles, s);
  }
  return tiles;
}
