import React from 'react';
import { create } from 'zustand';

const KEY = 'stickynotes-shape-recognition';
const DEFAULT_HOLD_MS = 500;
function load() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { enabled: value.enabled !== false, delay: typeof value.delay === 'number' && Number.isFinite(value.delay) ? Math.min(3000, Math.max(500, value.delay)) : DEFAULT_HOLD_MS };
  } catch { return { enabled: true, delay: DEFAULT_HOLD_MS }; }
}
export const useInkShapePreferences = create<{ enabled: boolean; delay: number; update: (patch: { enabled?: boolean; delay?: number }) => void }>((set) => ({
  ...load(),
  update: patch => set(s => {
    const value = { enabled: patch.enabled ?? s.enabled, delay: Number.isFinite(patch.delay) ? Math.min(3000, Math.max(500, patch.delay!)) : s.delay };
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* preferences remain usable in memory */ }
    return value;
  }),
}));

export function InkShapePreferences() {
  const enabled = useInkShapePreferences(s => s.enabled), delay = useInkShapePreferences(s => s.delay);
  const update = useInkShapePreferences(s => s.update);
  return <div style={{ padding: '8px 0', borderTop: '1px solid var(--glass-border)', fontSize: 11, color: 'var(--text-secondary)' }}>
    <label title="画完后保持按下不动，自动规整为可编辑图形" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
      <input type="checkbox" checked={enabled} onChange={e => update({ enabled: e.target.checked })} style={{ accentColor: 'var(--accent)' }} />停笔规整
    </label>
    {enabled && <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
      <span>按住停留 {(delay / 1000).toFixed(1)} 秒</span>
      <input aria-label="图形识别等待时间" type="range" min={500} max={3000} step={100} value={delay} onChange={e => update({ delay: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
    </label>}
  </div>;
}
