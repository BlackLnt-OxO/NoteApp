import { create } from 'zustand';
import InkDisclosure from './InfiniteInkCanvas/InkDisclosure';

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
  return <div className="ink-shape-preferences">
    <label className="ink-tool-check" data-tooltip="画完后保持按下不动，自动规整为可编辑图形">
      <input type="checkbox" checked={enabled} onChange={e => update({ enabled: e.target.checked })} />停笔规整
    </label>
    <InkDisclosure visible={enabled}>
      <label className="ink-tool-range">
        <span>按住停留 <span className="ink-tool-value">{(delay / 1000).toFixed(1)} 秒</span></span>
        <input aria-label="图形识别等待时间" type="range" min={500} max={3000} step={100} value={delay} onChange={e => update({ delay: Number(e.target.value) })} />
      </label>
    </InkDisclosure>
  </div>;
}
