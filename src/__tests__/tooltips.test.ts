import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltips } from '../tooltips';

describe('renderer tooltips', () => {
  let dispose: () => void;
  let fixture: HTMLDivElement;
  let button: HTMLButtonElement;
  beforeEach(() => {
    vi.useFakeTimers();
    fixture = document.createElement('div');
    fixture.innerHTML = '<button aria-label="设置" aria-describedby="existing"><span>+</span></button>';
    document.body.append(fixture);
    button = fixture.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 30, 20));
    dispose = installTooltips();
  });
  afterEach(() => {
    dispose();
    fixture.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the visible control label, clamps to the viewport and dismisses on input', () => {
    fireEvent.pointerOver(button.firstElementChild!, { pointerType: 'mouse', buttons: 0 });
    vi.advanceTimersByTime(399);
    expect(screen.queryByRole('tooltip')).toBeNull();
    vi.advanceTimersByTime(1);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('设置');
    expect(parseFloat(tip.style.top)).toBeGreaterThanOrEqual(8);
    expect(button).toHaveAttribute('aria-describedby', 'existing noteapp-tooltip');
    fireEvent.pointerDown(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button).toHaveAttribute('aria-describedby', 'existing');
  });

  it('reads an explicit description on dynamic buttons and hides when the editor unmounts', async () => {
    button.dataset.tooltip = '激光笔 · 笔迹会自动消失';
    fireEvent.pointerOver(button, { pointerType: 'mouse', buttons: 0 });
    vi.advanceTimersByTime(400);
    expect(screen.getByRole('tooltip')).toHaveTextContent(button.dataset.tooltip);
    button.remove();
    await Promise.resolve();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ignores touches and buttons pressed during a drag', () => {
    fireEvent.pointerOver(button, { pointerType: 'touch', buttons: 0 });
    fireEvent.pointerOver(button, { pointerType: 'pen', buttons: 1 });
    vi.advanceTimersByTime(400);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
