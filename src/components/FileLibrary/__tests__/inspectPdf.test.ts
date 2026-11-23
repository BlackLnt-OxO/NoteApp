import { describe, expect, it, vi } from 'vitest';
import { awaitPdfOperation } from '../inspectPdf';

describe('PDF operations', () => {
  it('settles a stalled worker after the page budget', async () => {
    vi.useFakeTimers();
    try {
      const pending = awaitPdfOperation(new Promise(() => {}), undefined, '处理超时');
      const checked = expect(pending).rejects.toThrow('处理超时');
      await vi.advanceTimersByTimeAsync(30_000);
      await checked;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can cancel even when the worker never settles', async () => {
    const abort = new AbortController();
    const pending = awaitPdfOperation(new Promise(() => {}), abort.signal, '处理超时');
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
