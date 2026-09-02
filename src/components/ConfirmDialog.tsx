/**
 * ConfirmDialog — app-styled confirmation dialog (replaces window.confirm).
 *
 * Usage: call askConfirm({ title, message, onConfirm }) from anywhere; a single
 * <ConfirmHost /> mounted at the app root renders the dialog.
 */

import React from 'react';
import { create } from 'zustand';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** true (default) → red confirm button labelled "删除"; false → accent "确定". */
  danger?: boolean;
  /** Optional middle button (e.g. "保存并关闭") between cancel and confirm. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: () => void;
}

interface ConfirmStore {
  req: ConfirmOptions | null;
  ask: (opts: ConfirmOptions) => void;
  close: () => void;
}

const useConfirmStore = create<ConfirmStore>((set) => ({
  req: null,
  ask: (opts) => set({ req: opts }),
  close: () => set({ req: null }),
}));

/** Programmatic app-style confirm — call this instead of window.confirm. */
export function askConfirm(opts: ConfirmOptions): void {
  useConfirmStore.getState().ask(opts);
}

export const ConfirmHost: React.FC = () => {
  const req = useConfirmStore((s) => s.req);
  const close = useConfirmStore((s) => s.close);
  if (!req) return null;

  const confirm = () => {
    close();
    req.onConfirm();
  };

  return (
    <div
      className="dialog-overlay"
      style={{ zIndex: 20000 }}
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.md = e.target === e.currentTarget ? '1' : '0'; }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.md === '1') close();
      }}
    >
      <div className="dialog" style={{ maxWidth: 380, padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: 16, marginBottom: 10, color: 'var(--text-primary)' }}>{req.title}</h3>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 18 }}>{req.message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="glass-btn" onClick={close} style={{ fontSize: 13 }}>
            {req.cancelLabel ?? '取消'}
          </button>
          {req.secondaryLabel && (
            <button
              onClick={() => { close(); req.onSecondary?.(); }}
              style={{
                padding: '8px 18px', borderRadius: '8px', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: 'transparent', color: 'var(--accent)',
                border: '1px solid var(--accent)',
              }}
            >
              {req.secondaryLabel}
            </button>
          )}
          <button
            onClick={confirm}
            className={req.danger !== false ? 'btn-danger' : 'btn-accent'}
            style={{
              padding: '8px 18px', borderRadius: '8px', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              color: '#fff',
            }}
          >
            {req.confirmLabel ?? (req.danger === false ? '确定' : '删除')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmHost;
