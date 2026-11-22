import { createInkCanvas } from '../InkCanvasSurface';

export type GraphitePaper = { light: HTMLCanvasElement; dense: HTMLCanvasElement };
const PAPER_COLORS = 2;
let masks: GraphitePaper | undefined;
const papers = new Map<string, GraphitePaper>();
const PENCIL_TEXTURE_SCALE = 3;
const PENCIL_TEXTURE_SIZE = 384;
let pencilTexture: HTMLCanvasElement | undefined;
const pencilPatterns = new Map<string, { canvas: HTMLCanvasElement; pattern: CanvasPattern }>();

function noise(x: number, y: number): number {
  let n = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function paperCanvas(pixels: number): HTMLCanvasElement {
  const canvas = createInkCanvas();
  canvas.width = canvas.height = pixels;
  // Source and streamed masks are CPU surfaces; keep blits on the same backend.
  canvas.getContext('2d', { willReadFrequently: true });
  return canvas;
}

function paperNoise(x: number, y: number, step: number): number {
  const period = PENCIL_TEXTURE_SIZE / step;
  const ix = Math.floor(x / step), iy = Math.floor(y / step);
  const nx = (ix + 1) % period, ny = (iy + 1) % period;
  const u = x / step - ix, v = y / step - iy;
  const fx = u * u * (3 - 2 * u), fy = v * v * (3 - 2 * v);
  const salt = step * PENCIL_TEXTURE_SIZE;
  const a = noise(salt + ix, iy) * (1 - fx) + noise(salt + nx, iy) * fx;
  const b = noise(salt + ix, ny) * (1 - fx) + noise(salt + nx, ny) * fx;
  return a * (1 - fy) + b * fy;
}

function makePencilTexture(): HTMLCanvasElement {
  const size = PENCIL_TEXTURE_SIZE;
  const texture = paperCanvas(size);
  const ctx = texture.getContext('2d')!;
  const pixels = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tooth = 0.54 * paperNoise(x, y, 3) + 0.32 * paperNoise(x, y, 6) + 0.14 * noise(x, y);
      // The paper leaves subtle pits in a continuous deposit, with no empty texels.
      const pore = Math.max(0, (0.66 - tooth) / 0.66);
      pixels.data[(y * size + x) * 4 + 3] = 255 * (0.96 - 0.68 * pore);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return texture;
}

/** Phase the sheet to the world origin of the target raster or drawing space. */
export function pencilPaperPattern(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, scale: number): CanvasPattern | null {
  let entry = pencilPatterns.get(color);
  if (!entry) {
    pencilTexture ??= makePencilTexture();
    const canvas = colorPaper(pencilTexture, color);
    const pattern = ctx.createPattern(canvas, 'repeat');
    if (!pattern) return null;
    if (pencilPatterns.size >= PAPER_COLORS) {
      const oldest = pencilPatterns.keys().next().value!;
      pencilPatterns.get(oldest)!.canvas.width = 0;
      pencilPatterns.delete(oldest);
    }
    entry = { canvas, pattern };
  }
  pencilPatterns.delete(color);
  pencilPatterns.set(color, entry);
  const phase = (world: number) => ((world * PENCIL_TEXTURE_SCALE % PENCIL_TEXTURE_SIZE) + PENCIL_TEXTURE_SIZE) % PENCIL_TEXTURE_SIZE;
  const u = phase(x), v = phase(y);
  const texel = scale / PENCIL_TEXTURE_SCALE;
  entry.pattern.setTransform({ a: texel, b: 0, c: 0, d: texel, e: -u * texel, f: -v * texel });
  return entry.pattern;
}

/** Color the coverage with the same sheet of paper in live cells and cropped rasters. */
export function applyPencilTexture(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, scale: number): boolean {
  const pattern = pencilPaperPattern(ctx, color, x, y, scale);
  if (!pattern) return false;
  ctx.save();
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  return true;
}

/** The gutter repeats the neighboring cell's texels. Both graphite densities
 * sample the same paper, at the same world density, across cell boundaries. */
function makeMasks(pixels: number, gutter: number): GraphitePaper {
  const period = pixels - 2 * gutter;
  const light = paperCanvas(pixels), dense = paperCanvas(pixels);
  const lightCtx = light.getContext('2d')!, denseCtx = dense.getContext('2d')!;
  const lightPixels = lightCtx.createImageData(pixels, pixels);
  const densePixels = denseCtx.createImageData(pixels, pixels);
  for (let y = 0; y < pixels; y++) {
    for (let x = 0; x < pixels; x++) {
      const u = (x - gutter + period) % period, v = (y - gutter + period) % period;
      const tooth = 0.72 * noise(u, v) + 0.28 * noise((u >> 1) + period, v >> 1);
      const alpha = (y * pixels + x) * 4 + 3;
      lightPixels.data[alpha] = 255 * Math.max(0, (tooth - 0.14) * 0.82);
      densePixels.data[alpha] = 255 * (0.25 + tooth * 0.68);
    }
  }
  lightCtx.putImageData(lightPixels, 0, 0);
  denseCtx.putImageData(densePixels, 0, 0);
  return { light, dense };
}

function colorPaper(mask: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const result = paperCanvas(mask.width);
  const ctx = result.getContext('2d')!;
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, result.width, result.height);
  return result;
}

function releasePaper(paper: GraphitePaper): void {
  paper.light.width = paper.dense.width = 0;
}

/** Prepare two reusable solid-color deposits once per color, not per cell. */
export function graphitePaper(color: string, pixels: number, gutter: number): GraphitePaper {
  const existing = papers.get(color);
  if (existing) {
    papers.delete(color);
    papers.set(color, existing);
    return existing;
  }
  masks ??= makeMasks(pixels, gutter);
  if (papers.size >= PAPER_COLORS) {
    const oldest = papers.keys().next().value!;
    releasePaper(papers.get(oldest)!);
    papers.delete(oldest);
  }
  const paper = { light: colorPaper(masks.light, color), dense: colorPaper(masks.dense, color) };
  papers.set(color, paper);
  return paper;
}

export function graphitePaperBytes(): number {
  const legacyBytes = masks ? masks.light.width * masks.light.height * 8 * (1 + papers.size) : 0;
  const pencilBytes = pencilTexture ? pencilTexture.width * pencilTexture.height * 4 * (1 + pencilPatterns.size) : 0;
  return legacyBytes + pencilBytes;
}

export function clearGraphitePaper(): void {
  for (const entry of pencilPatterns.values()) entry.canvas.width = 0;
  pencilPatterns.clear();
  if (pencilTexture) pencilTexture.width = 0;
  pencilTexture = undefined;
  if (masks) releasePaper(masks);
  masks = undefined;
  for (const paper of papers.values()) releasePaper(paper);
  papers.clear();
}
