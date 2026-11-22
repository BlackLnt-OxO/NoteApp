import { describe, expect, it, vi } from 'vitest';
import { InkLaserTrail } from '../components/InkLaserTrail';
import { inkPositionWeight, smoothingToMinCutoff } from '../components/PdfAnnotation/PdfEngine';

function recordingContext() {
  const actions = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
  return { actions, ctx: actions as unknown as CanvasRenderingContext2D };
}

describe('laser trail', () => {
  it('filters each finished sample like the brush and keeps the live tip at the pointer', () => {
    const { actions, ctx } = recordingContext();
    const laser = new InkLaserTrail('#ff0000', 3, 0.2);
    laser.append(0, 0, 0);
    laser.append(24, 12, 16);
    laser.append(44, 0, 32);
    laser.draw(ctx, 1);

    const weight = inkPositionWeight(smoothingToMinCutoff(0.2), 24, 12, 0.016);
    expect(actions.lineTo.mock.calls).toEqual([[24 * weight, 12 * weight], [44, 0]]);
    expect(actions.stroke).toHaveBeenCalledOnce();
    actions.lineTo.mockClear();
    laser.append(66, 12, 48);
    laser.draw(ctx, 0.5);
    expect(actions.lineTo.mock.calls[0]).toEqual([24 * weight, 12 * weight]);
    expect(actions.lineTo).toHaveBeenLastCalledWith(66, 12);
    expect(ctx.globalAlpha).toBe(0.5);
  });

  it('responds to the smoothing setting and renders a tap as a dot', () => {
    const centers = [0, 0.2].map(smoothing => {
      const { actions, ctx } = recordingContext();
      const laser = new InkLaserTrail('#ff0000', 4, smoothing);
      laser.append(0, 0, 0);
      laser.draw(ctx, 1);
      expect(actions.arc).toHaveBeenCalledWith(0, 0, 2, 0, Math.PI * 2);
      laser.append(25, 10, 32);
      laser.append(50, 0, 64);
      laser.draw(ctx, 1);
      return actions.lineTo.mock.calls[0][1];
    });
    expect(centers[1]).toBeLessThan(centers[0]);
  });
});
