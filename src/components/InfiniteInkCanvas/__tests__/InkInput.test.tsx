import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useBrushCursor } from '../../useBrushCursor';
import { useInkInputActivity } from '../../inkInputActivity';
import { useCanvasStore } from '../useCanvasStore';

afterEach(() => vi.useRealTimers());

describe('high-rate ink input', () => {
  it('moves the cursor without React renders and keeps UI scale/tool changes correct', () => {
    const el = document.createElement('div');
    let renders = 0;
    const { result, rerender } = renderHook(({ scale, enabled }) => {
      renders++;
      const cursor = useBrushCursor(scale, enabled);
      Object.defineProperty(cursor.ringRef, 'current', { value: el, writable: true });
      return cursor;
    }, { initialProps: { scale: 2, enabled: true } });
    const initialRenders = renders;
    act(() => {
      for (let i = 0; i < 240; i++) result.current.moveCursor(i * 2, i);
    });
    expect(renders).toBe(initialRenders);
    expect(el.style.transform).toBe('translate(239px, 119.5px) translate(-50%, -50%)');
    expect(el.style.visibility).toBe('visible');
    rerender({ scale: 1, enabled: false });
    expect(el.style.visibility).toBe('hidden');
    rerender({ scale: 1, enabled: true });
    expect(el.style.transform).toBe('translate(478px, 239px) translate(-50%, -50%)');
    act(() => result.current.hideCursor());
    expect(el.style.visibility).toBe('hidden');
  });

  it('postpones automatic serialization until pen-up, then saves the latest document', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    function Canvas() {
      const ref = useRef<HTMLCanvasElement>(null);
      useInkInputActivity(ref);
      return <canvas ref={ref} data-testid="ink" />;
    }
    const save = vi.fn().mockResolvedValue(undefined);
    const old = useCanvasStore.getState();
    const view = render(<Canvas />);
    try {
      useCanvasStore.setState({ loaded: true, currentCanvasId: 'input-test', saveCanvasData: save });
      fireEvent.pointerDown(view.getByTestId('ink'), { pointerId: 1 });
      act(() => vi.advanceTimersByTime(2500));
      expect(save).not.toHaveBeenCalled();
      fireEvent.pointerUp(window, { pointerId: 1 });
      act(() => vi.advanceTimersByTime(500));
      expect(save).toHaveBeenCalledTimes(1);
      useCanvasStore.getState().setActiveTool('select');
      act(() => vi.advanceTimersByTime(1500));
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      useCanvasStore.setState(old, true);
      vi.clearAllTimers();
    }
  });
});
