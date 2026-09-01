/**
 * CanvasHome — multi-canvas home screen (mirrors PdfLibrary's LibraryHome).
 *
 * Card grid of ink canvases: click to open, hover shows rename / delete
 * controls. New canvases are auto-named "未命名1/2/3…".
 */

import React, { useState } from 'react';
import { useCanvasLibrary } from './useCanvasLibrary';

const fmtTime = (t: number): string => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const CanvasHome: React.FC<{ onOpen: (id: string) => void; onNew: () => void }> = ({ onOpen, onNew }) => {
  const canvases = useCanvasLibrary((s) => s.canvases);
  const renameCanvas = useCanvasLibrary((s) => s.renameCanvas);
  const deleteCanvas = useCanvasLibrary((s) => s.deleteCanvas);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [hoverId, setHoverId] = useState<string | null>(null);

  return (
    <div style={{
      position: 'absolute', inset: 0, overflowY: 'auto', padding: '28px 32px',
      background: 'var(--page-bg)', color: 'var(--text-primary)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: '18px', fontWeight: 600 }}>画布</span>
        <button onClick={onNew} style={{
          marginLeft: 'auto', padding: '8px 18px', borderRadius: '8px',
          background: 'var(--accent)', border: 'none', color: '#fff', cursor: 'pointer',
          fontSize: '13px', fontWeight: 600, fontFamily: 'inherit',
        }}>+ 新建画布</button>
      </div>

      {canvases.length === 0 ? (
        <div style={{ marginTop: 60, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', lineHeight: 2 }}>
          还没有画布<br />点击右上角「+ 新建画布」开始
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {canvases.map((c) => (
            <div
              key={c.id}
              onClick={() => { if (renamingId !== c.id) onOpen(c.id); }}
              onMouseEnter={() => setHoverId(c.id)}
              onMouseLeave={() => setHoverId(null)}
              style={{
                width: 180, height: 120, borderRadius: '12px', cursor: 'pointer',
                background: 'var(--glass-bg)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
                border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)',
                position: 'relative', display: 'flex', flexDirection: 'column',
                justifyContent: 'space-between', padding: '12px 14px',
                transition: 'all var(--transition)',
              }}
            >
              {renamingId === c.id ? (
                <input
                  autoFocus
                  defaultValue={c.name}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { const v = draft.trim(); if (v) renameCanvas(c.id, v); setRenamingId(null); }
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => setRenamingId(null)}
                  style={{
                    width: '100%', padding: '3px 6px', fontSize: '13px', fontFamily: 'inherit',
                    background: 'var(--glass-bg-light)', color: 'var(--text-primary)',
                    border: '1px solid var(--accent)', borderRadius: '6px', outline: 'none',
                  }}
                />
              ) : (
                <span style={{ fontSize: '14px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              )}

              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{fmtTime(c.updatedAt)}</span>

              {hoverId === c.id && renamingId !== c.id && (
                <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6 }}>
                  <button
                    title="重命名"
                    onClick={(e) => { e.stopPropagation(); setDraft(c.name); setRenamingId(c.id); }}
                    style={{
                      width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer',
                      background: 'rgba(120,120,120,0.6)', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
                  <button
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`删除画布「${c.name}」？此操作不可撤销。`)) deleteCanvas(c.id);
                    }}
                    style={{
                      width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer',
                      background: 'rgba(231,76,60,0.8)', color: '#fff', fontSize: '12px', lineHeight: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CanvasHome;
