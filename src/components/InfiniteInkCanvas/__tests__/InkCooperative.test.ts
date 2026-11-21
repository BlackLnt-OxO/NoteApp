import { createCanvas, Path2D } from '@napi-rs/canvas';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { clearInkRasterCache, getStrokeRaster, requestStrokeRaster, pumpStrokeRasterBuilds, pendingRasterBuilds, cancelPendingInkRasters, inkRasterCacheStats } from '../../PdfAnnotation/InkRasterCache';
import { clearStreamingInk } from '../../PdfAnnotation/StreamingInkStroke';
import type { Stroke } from '../types';
beforeEach(() => {
  clearInkRasterCache(); clearStreamingInk(); vi.stubGlobal('Path2D', Path2D);
  vi.spyOn(document, 'createElement').mockImplementation(((name: string) => name === 'canvas' ? createCanvas(1, 1) : undefined) as any);
});
afterEach(() => { clearInkRasterCache(); clearStreamingInk(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('cooperative raster pixel parity', () => {
  it('releases an unfinished long stroke when its viewport job is cancelled', () => {
    const stroke: Stroke = { id: 'cancel', type: 'stroke', renderVersion: 2, style: 'pencil', size: 8, opacity: .6, color: '#124567',
      smoothing: .35, compositeOperation: 'source-over', createdAt: 0,
      points: Array.from({ length: 16384 }, (_, i) => ({ x: i/4, y:40+Math.sin(i*.1)*20, pressure:.5, t:i*4 })) };
    expect(requestStrokeRaster(stroke,0,0,512,.5)).toBeNull();
    pumpStrokeRasterBuilds(performance.now()+100, { points: 512 });
    expect(pendingRasterBuilds()).toBeGreaterThan(0);
    cancelPendingInkRasters(new Set([stroke]));
    expect(pendingRasterBuilds()).toBe(0); expect(inkRasterCacheStats().buildingBytes).toBe(0);
    expect(requestStrokeRaster(stroke,0,0,512,.5)).toBeNull();
  });
  for (const version of [undefined, 2] as const) for (const style of ['marker', 'fountain', 'pencil'] as const) {
    it(`${style} v${version ?? 'legacy'} keeps synchronous pixels`, () => {
      const stroke: Stroke = { id: 'parity', type: 'stroke', renderVersion: version, style, size: 8, opacity: .6, color: '#124567',
        smoothing: .35, compositeOperation: 'source-over', createdAt: 0,
        points: Array.from({ length: 256 }, (_, i) => ({ x: 20+i*.5, y:40+Math.sin(i*.1)*20, pressure:.3+(i%13)*.04, t:i*4 })) };
      const expected = getStrokeRaster(stroke, 0, 0, 512, .5);
      const pixels = expected.image.getContext('2d')!.getImageData(0,0,expected.image.width,expected.image.height).data.slice();
      expect(pixels.some((value, i) => i % 4 === 3 && value > 0)).toBe(true);
      clearInkRasterCache(); clearStreamingInk();
      expect(requestStrokeRaster(stroke,0,0,512,.5)).toBeNull();
      for (let i=0; i<2000 && pendingRasterBuilds(); i++) pumpStrokeRasterBuilds(performance.now()+100, {points:512});
      expect(pendingRasterBuilds()).toBe(0);
      const actual = requestStrokeRaster(stroke,0,0,512,.5)!;
      expect(actual).toBeTruthy();
      const result = actual.image.getContext('2d')!.getImageData(0,0,actual.image.width,actual.image.height).data;
      expect(Array.from(result)).toEqual(Array.from(pixels));
    });
  }
});
