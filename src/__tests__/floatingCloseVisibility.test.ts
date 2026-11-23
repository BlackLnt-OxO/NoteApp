import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { closeVisibility, BUTTON } = createRequire(import.meta.url)('../../electron/floatingCloseVisibility.js') as {
  closeVisibility(cursor: { x: number; y: number }, bounds: { x: number; y: number; width: number; height: number }): number;
  BUTTON: { top: number; right: number; size: number };
};

describe('transparent magnetic note close visibility', () => {
  const bounds = { x: -420, y: 110, width: 260, height: 220 };
  const right = bounds.x + bounds.width - BUTTON.right;
  const top = bounds.y + BUTTON.top;

  it('fades continuously from the edge and reaches zero at 56 DIP', () => {
    expect(closeVisibility({ x: right + 57, y: top }, bounds)).toBe(0);
    expect(closeVisibility({ x: right + 56, y: top }, bounds)).toBe(0);
    expect(closeVisibility({ x: right + 28, y: top }, bounds)).toBe(.5);
    expect(closeVisibility({ x: right + 14, y: top }, bounds)).toBeGreaterThan(.5);
    expect(closeVisibility({ x: right - 1, y: top + 1 }, bounds)).toBe(1);
  });

  it('uses distance to the corner when the cursor is outside on both axes', () => {
    expect(closeVisibility({ x: right + 48, y: top - 48 }, bounds)).toBe(0);
    const diagonal = closeVisibility({ x: right + 20, y: top - 20 }, bounds);
    expect(diagonal).toBeGreaterThan(0);
    expect(diagonal).toBeLessThan(closeVisibility({ x: right + 20, y: top }, bounds));
  });
});
