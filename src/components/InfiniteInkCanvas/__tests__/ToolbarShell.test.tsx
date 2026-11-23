import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyInkStrokeStart, setPointerHold } from '../../inkInputActivity';
import { useNoteStore } from '../../../store';
import { DEFAULT_INK_TOOLBAR_POSITION } from '../../../inkToolbarPosition';
import ToolbarShell from '../ToolbarShell';
import type { InkToolbarControls } from '../InkToolbarOptions';
import { useCanvasStore } from '../useCanvasStore';

function mountToolbar(allowLeftDock = true) {
  const controls: InkToolbarControls = {
    tool: 'pen', brush: 'marker', settings: useCanvasStore.getState().brushSettings,
    alternatePen: 'fountain', setAlternatePen: vi.fn(), setTool: vi.fn(), setBrush: vi.fn(),
    update: vi.fn(), selectionMode: 'box', setSelectionMode: vi.fn(),
    eraserMode: 'free', setEraserMode: vi.fn(), insertMode: 'text', setInsertMode: vi.fn(),
    showDotGrid: true, setShowDotGrid: vi.fn(), canUndo: true, canRedo: false,
    undo: vi.fn(), redo: vi.fn(), clearLabel: '清空画布', clear: vi.fn(),
  };
  const view = (values: InkToolbarControls, allowLeft = allowLeftDock) => <div>
    <ToolbarShell controls={values} allowLeftDock={allowLeft} /><div data-testid="viewport" />
  </div>;
  const { rerender } = render(view(controls));
  const grip = () => screen.getByRole('button', { name: '展开手写工具栏' });
  const row = () => screen.getByRole('toolbar');
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  return {
    controls, grip, row, advance,
    updateControls: (patch: Partial<InkToolbarControls>) => rerender(view({ ...controls, ...patch })),
    setAllowLeftDock: (allowLeft: boolean) => rerender(view(controls, allowLeft)),
  };
}

describe('ink toolbar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNoteStore.getState().updateSettings({ inkToolbarPosition: DEFAULT_INK_TOOLBAR_POSITION });
  });
  afterEach(() => vi.useRealTimers());

  it('displays a saved left dock at bottom center only when left docking is unavailable', () => {
    const saved = { edge: 'left', offset: .28 } as const;
    useNoteStore.getState().updateSettings({ inkToolbarPosition: saved });
    const { grip, setAllowLeftDock } = mountToolbar(false);
    const band = grip().closest<HTMLElement>('[data-ink-toolbar]')!;
    expect(band).toHaveAttribute('data-dock', 'bottom');
    expect(band.style.getPropertyValue('--ink-dock-offset')).toBe('50%');
    expect(useNoteStore.getState().settings.inkToolbarPosition).toEqual(saved);
    setAllowLeftDock(true);
    expect(band).toHaveAttribute('data-dock', 'left');
    expect(parseFloat(band.style.getPropertyValue('--ink-dock-offset'))).toBeCloseTo(28);
  });

  it('constrains the drag preview and saved position to supported edges', () => {
    const { grip, advance } = mountToolbar(false);
    const handle = grip();
    const band = handle.closest<HTMLElement>('[data-ink-toolbar]')!;
    vi.spyOn(band, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 240));
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 200, clientY: 238 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2, clientY: 60 });
    advance(32);
    expect(band).toHaveAttribute('data-dragging', 'true');
    expect(band).toHaveAttribute('data-dock', 'top');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 2, clientY: 60 });
    expect(useNoteStore.getState().settings.inkToolbarPosition).toEqual({ edge: 'top', offset: .005 });
  });

  it('uses a 350 ms hold to open just the selected instrument settings', () => {
    const { grip, row, controls, advance } = mountToolbar();
    fireEvent.click(grip());
    const pen = within(row()).getByRole('button', { name: '钢笔' });
    fireEvent.pointerDown(pen, { button: 0, pointerId: 1 });
    advance(349);
    expect(screen.queryByRole('dialog')).toBeNull();
    advance(1);
    fireEvent.pointerUp(pen, { button: 0, pointerId: 1 });
    fireEvent.click(pen, { detail: 1 });
    const panel = screen.getByRole('dialog', { name: '钢笔工具盘' });
    fireEvent.click(within(panel).getByRole('button', { name: '铅笔' }));
    expect(controls.setAlternatePen).toHaveBeenCalledWith('pencil');
    expect(controls.setBrush).toHaveBeenLastCalledWith('pencil');
    expect(within(panel).queryByLabelText('橡皮大小')).toBeNull();
  });

  it('delays hiding, keeps the tool panel open on re-entry and hides as a stroke starts', () => {
    const { grip, row, advance } = mountToolbar();
    fireEvent.keyDown(window, { key: 'n' });
    const eraser = within(row()).getByRole('button', { name: '橡皮' });
    fireEvent.contextMenu(eraser);
    const panel = screen.getByRole('dialog', { name: '橡皮工具盘' });
    const viewport = screen.getByTestId('viewport');
    fireEvent.pointerOut(panel, { relatedTarget: viewport });
    advance(649);
    expect(row()).toBeInTheDocument();
    fireEvent.pointerOver(panel, { relatedTarget: viewport });
    advance(650);
    expect(panel).toBeInTheDocument();
    act(() => notifyInkStrokeStart(1));
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    setPointerHold(true);
    try {
      fireEvent.click(grip());
      expect(screen.queryByRole('toolbar')).toBeNull();
    } finally {
      setPointerHold(false);
    }
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    fireEvent.click(grip());
    fireEvent.pointerOut(row(), { relatedTarget: viewport });
    advance(650);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('keeps focus and the outgoing controls mounted while the alternate pen changes', () => {
    const { grip, row, updateControls } = mountToolbar();
    fireEvent.click(grip());
    fireEvent.contextMenu(within(row()).getByRole('button', { name: '钢笔' }));
    const panel = screen.getByRole('dialog', { name: '钢笔工具盘' });
    const pencil = within(panel).getByRole('button', { name: '铅笔' });
    const flow = within(panel).getByRole('slider', { name: '出墨速度' });
    pencil.focus();
    fireEvent.click(pencil);
    updateControls({ alternatePen: 'pencil', brush: 'pencil' });
    expect(screen.getByRole('dialog', { name: '铅笔工具盘' })).toBe(panel);
    expect(pencil).toHaveFocus();
    expect(flow.closest('[data-visible]')).toHaveAttribute('aria-hidden', 'true');
    expect(within(row()).getByRole('button', { name: '铅笔' })).toHaveAttribute('aria-pressed', 'true');
  });
});
