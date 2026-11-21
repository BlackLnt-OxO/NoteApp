import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CanvasView from '../CanvasView';
import { useCanvasStore } from '../useCanvasStore';
import { useCanvasLibrary } from '../useCanvasLibrary';
vi.mock('../InfiniteInkCanvas', () => ({ default: () => <div>editor</div> }));
vi.mock('../CanvasHome', () => ({ default: ({ onOpen }: { onOpen: (id: string) => void }) => <button onClick={() => onOpen('target')}>open</button> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('asynchronous canvas navigation', () => {
  it('blocks duplicate opens and keyboard edits until the save/load barrier finishes', async () => {
    vi.stubGlobal('electronAPI', { isFullScreen: vi.fn().mockResolvedValue(false), onFullScreenChanged: () => () => {} });
    useCanvasLibrary.setState({ currentCanvasId: null, canvases: [{ id: 'target', name: 'target', createdAt: 1, updatedAt: 1, categoryId: null }] });
    vi.spyOn(useCanvasLibrary.getState(), 'loadLibrary').mockImplementation(() => {});
    let finish!: () => void;
    const switchCanvas = vi.spyOn(useCanvasStore.getState(), 'switchCanvas').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<CanvasView />); fireEvent.click(screen.getByText('open'));
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.click(screen.getByText('open')); expect(switchCanvas).toHaveBeenCalledTimes(1);
    const key = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    document.dispatchEvent(key); expect(key.defaultPrevented).toBe(true);
    await act(async () => finish());
    expect(screen.queryByRole('status')).toBeNull(); expect(screen.getByText('editor')).toBeTruthy();
    const nextKey = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    document.dispatchEvent(nextKey); expect(nextKey.defaultPrevented).toBe(false);
  });
});
