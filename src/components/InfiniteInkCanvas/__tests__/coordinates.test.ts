import { describe, it, expect } from 'vitest';
import {
  screenToWorld,
  worldToScreen,
  clampZoom,
  zoomAt,
  parseRGBA,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../constants';
import type { Camera } from '../types';

describe('screenToWorld', () => {
  const baseCam: Camera = { x: 0, y: 0, zoom: 1 };

  it('returns the same coordinates with identity camera', () => {
    const result = screenToWorld(100, 200, baseCam);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('handles camera offset', () => {
    const cam: Camera = { x: 50, y: -30, zoom: 1 };
    const result = screenToWorld(100, 200, cam);
    expect(result.x).toBe(50);
    expect(result.y).toBe(230);
  });

  it('handles camera zoom', () => {
    const cam: Camera = { x: 0, y: 0, zoom: 2 };
    const result = screenToWorld(200, 400, cam);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('handles combined offset and zoom', () => {
    const cam: Camera = { x: 20, y: 10, zoom: 0.5 };
    const result = screenToWorld(70, 60, cam);
    expect(result.x).toBe(100);
    expect(result.y).toBe(100);
  });
});

describe('worldToScreen', () => {
  it('is the inverse of screenToWorld (round-trip)', () => {
    const cam: Camera = { x: 15, y: -8, zoom: 1.5 };
    const world = { x: 37, y: 112 };
    const screen = worldToScreen(world.x, world.y, cam);
    const roundTrip = screenToWorld(screen.x, screen.y, cam);
    expect(roundTrip.x).toBeCloseTo(world.x, 10);
    expect(roundTrip.y).toBeCloseTo(world.y, 10);
  });

  it('returns identity with zero camera', () => {
    const cam: Camera = { x: 0, y: 0, zoom: 1 };
    const result = worldToScreen(55, 99, cam);
    expect(result.x).toBe(55);
    expect(result.y).toBe(99);
  });
});

describe('clampZoom', () => {
  it('returns the zoom when in range', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(4)).toBe(4);
  });

  it('clamps below minimum', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  });

  it('clamps above maximum', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the mouse fixed', () => {
    const cam: Camera = { x: 0, y: 0, zoom: 1 };
    const screenX = 200;
    const screenY = 150;
    const nextZoom = 2;

    const nextCam = zoomAt(cam, screenX, screenY, nextZoom);

    // The world point under the mouse before zoom should equal the world point under the mouse after zoom
    const worldBefore = screenToWorld(screenX, screenY, cam);
    const worldAfter = screenToWorld(screenX, screenY, nextCam);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10);
  });

  it('handles zoom-out', () => {
    const cam: Camera = { x: 50, y: 30, zoom: 2 };
    const screenX = 150;
    const screenY = 200;
    const nextZoom = 0.5;

    const nextCam = zoomAt(cam, screenX, screenY, nextZoom);
    const worldBefore = screenToWorld(screenX, screenY, cam);
    const worldAfter = screenToWorld(screenX, screenY, nextCam);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10);
  });
});

describe('parseRGBA', () => {
  it('parses rgba string', () => {
    const result = parseRGBA('rgba(255, 128, 64, 0.5)');
    expect(result).toEqual({ r: 255, g: 128, b: 64, a: 0.5 });
  });

  it('parses rgb string', () => {
    const result = parseRGBA('rgb(10, 20, 30)');
    expect(result).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('parses short hex', () => {
    const result = parseRGBA('#f80');
    expect(result).toEqual({ r: 255, g: 136, b: 0, a: 1 });
  });

  it('parses full hex', () => {
    const result = parseRGBA('#ff8800');
    expect(result).toEqual({ r: 255, g: 136, b: 0, a: 1 });
  });

  it('parses hex with alpha', () => {
    const result = parseRGBA('#ff880080');
    expect(result.r).toBe(255);
    expect(result.g).toBe(136);
    expect(result.b).toBe(0);
    expect(result.a).toBeCloseTo(0.502, 2);
  });

  it('returns black for unknown format', () => {
    const result = parseRGBA('hsl(0,0,0)');
    expect(result).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });
});
