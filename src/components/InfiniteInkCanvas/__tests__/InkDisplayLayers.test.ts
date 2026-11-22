import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { InkDisplayLayers, PAN_BUFFER_BUDGET, panBufferMargin, type InkLayerPaint } from '../../InkDisplayLayers';

function surface(): HTMLCanvasElement {
  const canvas = createCanvas(1, 1) as any;
  canvas.style = {};
  return canvas;
}
function fixture(): InkLayerPaint {
  const tile = surface(); tile.width = tile.height = 512;
  const ctx = tile.getContext('2d')!; ctx.fillStyle = 'rgba(20, 60, 160, 0.5)'; ctx.fillRect(20, 30, 50, 20);
  return { background: surface(), ink: surface(), tiles: new Map([['0:0', tile]]), camera: { x: 0, y: 0, zoom: 1 },
    width: 600, height: 400, dpr: 1, backgroundColor: '#fff', dotColor: '#eee', showDotGrid: false };
}
describe('bounded retained display layers', () => {
  it.each([[1000, 720, 1], [1920, 1080, 2], [3840, 2160, 3], [100, 100, 1], [1333, 777, 1.25]])(
    'bounds the combined border memory at %sx%s DPR %s', (width, height, dpr) => {
      const margin = panBufferMargin(width, height, dpr);
      const extra = 8 * (Math.ceil((width + 2 * margin) * dpr) * Math.ceil((height + 2 * margin) * dpr)
        - Math.ceil(width * dpr) * Math.ceil(height * dpr));
      expect(extra).toBeLessThanOrEqual(PAN_BUFFER_BUDGET); expect(margin).toBeLessThanOrEqual(192);
    });
  it('moves retained pixels without repaints until the viewport leaves the fixed border', () => {
    const p = fixture(), layers = new InkDisplayLayers();
    const background = vi.spyOn(p.background.getContext('2d')!, 'fillRect');
    const ink = vi.spyOn(p.ink.getContext('2d')!, 'drawImage');
    layers.paint(p); expect(ink).toHaveBeenCalledTimes(1); expect(background).toHaveBeenCalledTimes(1);
    const width = p.ink.width, height = p.ink.height;
    layers.paint({ ...p, camera: { ...p.camera, x: 25, y: 20 } });
    expect(ink).toHaveBeenCalledTimes(1); expect(background).toHaveBeenCalledTimes(1);
    expect(p.ink.style.transform).toBe('translate(25px, 20px)');
    expect([p.ink.width, p.ink.height]).toEqual([width, height]);
    layers.paint({ ...p, camera: { ...p.camera, x: panBufferMargin(p.width, p.height, p.dpr) + 1 } });
    expect(ink).toHaveBeenCalledTimes(2); expect(background).toHaveBeenCalledTimes(2);
    expect(p.ink.style.transform).toBe('translate(0px, 0px)');
  });
  it('reveals cached and newly published ink when the visible box grows within its capacity', () => {
    const p = { ...fixture(), width: 445, height: 350, capacity: { width: 760, height: 460 } };
    const layers = new InkDisplayLayers();
    const ink = p.ink.getContext('2d')!;
    const draw = vi.spyOn(ink, 'drawImage');
    const background = vi.spyOn(p.background.getContext('2d')!, 'fillRect');
    layers.paint(p);
    const size = [p.ink.width, p.ink.height, p.background.width, p.background.height];
    for (const width of [510, 592, 720, 760, 445]) layers.paint({ ...p, width, height: 460 });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(background).toHaveBeenCalledTimes(1);
    expect([p.ink.width, p.ink.height, p.background.width, p.background.height]).toEqual(size);

    p.tiles.set('1:0', p.tiles.get('0:0')!);
    layers.invalidate(new Set(['1:0']));
    layers.paint({ ...p, width: 760 });
    const margin = panBufferMargin(p.capacity.width, p.capacity.height, 1);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(ink.getImageData(margin + 542, margin + 35, 1, 1).data[3]).toBeGreaterThan(120);
    expect(ink.getImageData(margin + 30, margin + 35, 1, 1).data[3]).toBeGreaterThan(120);
  });
  it('refreshes the background independently and only redraws ink once at the new density', () => {
    const p = fixture(), layers = new InkDisplayLayers();
    const ink = vi.spyOn(p.ink.getContext('2d')!, 'drawImage');
    const background = vi.spyOn(p.background.getContext('2d')!, 'clearRect');
    layers.paint(p);
    const dark = { ...p, backgroundColor: '#16162a', dotColor: '#282843' };
    layers.paint(dark);
    layers.paint({ ...dark, showDotGrid: true });
    expect(background).toHaveBeenCalledTimes(3);
    expect(ink).toHaveBeenCalledTimes(1);

    const denser = { ...dark, showDotGrid: true, dpr: 1.25 };
    layers.paint(denser);
    layers.paint(denser);
    expect(ink).toHaveBeenCalledTimes(2);
    expect(background).toHaveBeenCalledTimes(4);
  });
  it('repaints dirty tiles in retained coordinates without double-darkening transparent ink', () => {
    const p = fixture(), layers = new InkDisplayLayers(); layers.paint(p);
    const margin = panBufferMargin(p.width, p.height, 1), ctx = p.ink.getContext('2d')!;
    const sample = () => Array.from(ctx.getImageData(margin + 30, margin + 35, 1, 1).data);
    const before = sample();
    layers.invalidate(new Set(['0:0'])); layers.paint({ ...p, camera: { ...p.camera, x: 25, y: 20 } });
    expect(sample()).toEqual(before); expect(before[3]).toBeGreaterThan(120);
    const tile = p.tiles.get('0:0')!; tile.getContext('2d')!.clearRect(0, 0, 512, 512);
    layers.invalidate(new Set(['0:0'])); layers.paint({ ...p, camera: { ...p.camera, x: 25, y: 20 } });
    expect(sample()[3]).toBe(0);
  });
  it('keeps buffer alignment under UI scaling and refreshes after zoom', () => {
    const p = { ...fixture(), uiScale: 2, dpr: 1.25 }, layers = new InkDisplayLayers();
    const draw = vi.fn((ctx: CanvasRenderingContext2D, _key: string, tile: HTMLCanvasElement, x: number, y: number, w: number, h: number) => ctx.drawImage(tile, x, y, w, h));
    layers.paint({ ...p, drawTile: draw });
    layers.paint({ ...p, drawTile: draw, camera: { ...p.camera, x: 30, y: 10 } });
    expect(draw).toHaveBeenCalledTimes(1); expect(p.ink.style.transform).toBe('translate(15px, 5px)');
    layers.paint({ ...p, drawTile: draw, camera: { x: 30, y: 10, zoom: 1.2 } });
    expect(draw).toHaveBeenCalledTimes(2); expect(p.ink.style.transform).toBe('translate(0px, 0px)');
  });
  it('draws only the changed LOD tile and preserves neighboring translucent pixels', () => {
    const p = fixture(), layers = new InkDisplayLayers();
    const neighbor = surface(); neighbor.width = neighbor.height = 512;
    const neighborCtx = neighbor.getContext('2d')!;
    neighborCtx.fillStyle = 'rgba(20, 60, 160, 0.5)'; neighborCtx.fillRect(20, 30, 50, 20);
    p.tiles.set('1:0', neighbor); layers.paint(p);
    const ctx = p.ink.getContext('2d')!, margin = panBufferMargin(p.width, p.height, 1);
    const before = Array.from(ctx.getImageData(margin + 542, margin + 35, 1, 1).data);
    const draw = vi.spyOn(ctx, 'drawImage');
    p.tiles.get('0:0')!.getContext('2d')!.clearRect(0, 0, 512, 512);
    layers.invalidate(new Set(['0:0'])); layers.paint(p);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(ctx.getImageData(margin + 30, margin + 35, 1, 1).data[3]).toBe(0);
    expect(Array.from(ctx.getImageData(margin + 542, margin + 35, 1, 1).data)).toEqual(before);
    expect(before[3]).toBeGreaterThan(120);
  });
});
