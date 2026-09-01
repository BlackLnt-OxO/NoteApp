/**
 * Toolbar — Brush settings + tool panel content.
 * Embedded inside ToolbarShell.
 */

import React, { useState } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { askConfirm } from '../ConfirmDialog';
import type { ToolType } from './types';

// ---- SVG Icons ---------------------------------------------------------------

const PenIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" />
  </svg>
);

const EraserIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
    <path d="M22 21H7" /><path d="m5 11 9 9" />
  </svg>
);

const TextIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 7 4 4 20 4 20 7" /><line x1="9.5" x2="14.5" y1="20" y2="20" /><line x1="12" x2="12" y1="4" y2="20" />
  </svg>
);

const SelectIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 11 14 8 8 2 2" />
    <polygon points="22 3 14 3 11 14 8 8" opacity="0.4" />
  </svg>
);

const UndoIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

const RedoIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
  </svg>
);

const TrashIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

const PRESET_COLORS = [
  '#ffffff', '#e0e0e0', '#cccccc', '#ff6b6b', '#f06595', '#e64980',
  '#ff922b', '#fcc419', '#ffd43b', '#51cf66', '#20c997', '#38d9a9',
  '#339af0', '#5c7cfa', '#7950f2', '#845ef7', '#6b5ce7', '#111111',
];

// ---- Expandable tool button (PS-style small triangle) -------------------------

interface ExpandableToolButtonProps {
  label: string;
  Icon: React.FC;
  active: boolean;
  onMain: () => void;
  options: { label: string; active: boolean; onClick: () => void }[];
}

const ExpandableToolButton: React.FC<ExpandableToolButtonProps> = ({ label, Icon, active, onMain, options }) => {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative', flex: '1 1 auto', minWidth: 32, display: 'flex' }}>
      <button
        onClick={onMain}
        title={label}
        style={{
          flex: 1, padding: '7px 6px', paddingRight: 14,
          background: active ? 'var(--accent)' : 'var(--glass-bg-light)',
          border: active ? 'none' : '1px solid var(--glass-border)',
          borderRadius: '6px', color: active ? '#fff' : 'var(--text-secondary)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: '3px', fontFamily: 'inherit', fontSize: '10px',
          transition: 'all var(--transition, 0.2s ease)',
        }}
      >
        <Icon /><span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      </button>
      <button
        onClick={() => setOpen(v => !v)}
        title="更多选项"
        style={{
          position: 'absolute', right: 2, bottom: 2, width: 12, height: 10,
          padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
          color: active ? '#fff' : 'var(--text-muted)', fontSize: 7,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        ▼
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
          marginTop: 4, background: 'var(--dropdown-bg, rgba(30,30,50,0.98))',
          border: '1px solid var(--glass-border)', borderRadius: '8px',
          padding: 4, boxShadow: 'var(--glass-shadow)', display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {options.map(o => (
            <button key={o.label} onClick={() => { o.onClick(); setOpen(false); }}
              style={{
                textAlign: 'left', padding: '6px 8px', border: 0, borderRadius: '6px',
                background: o.active ? 'var(--accent)' : 'transparent',
                color: o.active ? '#fff' : 'var(--text-secondary)', cursor: 'pointer',
                fontSize: '10px', fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ---- Simple tool button ------------------------------------------------------

function SimpleToolButton({ label, Icon, active, onClick }: { label: string; Icon: React.FC; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label}
      style={{
        flex: '1 1 auto', minWidth: 32, padding: '7px 6px',
        background: active ? 'var(--accent)' : 'var(--glass-bg-light)',
        border: active ? 'none' : '1px solid var(--glass-border)', borderRadius: '6px',
        color: active ? '#fff' : 'var(--text-secondary)', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px',
        fontFamily: 'inherit', fontSize: '10px', transition: 'all var(--transition, 0.2s ease)',
      }}>
      <Icon /><span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

// ---- Styles ------------------------------------------------------------------

const labelStyle: React.CSSProperties = { fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '1px', display: 'flex', justifyContent: 'space-between' };
const sectionStyle: React.CSSProperties = { marginBottom: '10px' };
const trackStyle: React.CSSProperties = { width: '100%', height: '4px', WebkitAppearance: 'none', appearance: 'none' as any, background: 'var(--glass-bg-light)', borderRadius: '2px', outline: 'none', cursor: 'pointer', margin: '2px 0 6px 0' };

// ---- Component ---------------------------------------------------------------

const Toolbar: React.FC = () => {
  const {
    activeTool, brushSettings, showDotGrid, selectionMode, eraserMode,
    setActiveTool, setBrushSettings, setShowDotGrid, setSelectionMode, setEraserMode,
    undo, redo, history, redoStack,
  } = useCanvasStore();

  const canUndo = history.length > 0;
  const canRedo = redoStack.length > 0;
  const update = (p: Partial<typeof brushSettings>) => setBrushSettings(p);

  return (
    <div style={{ padding: '10px 14px 12px', color: 'var(--text-primary)' }}>
      {/* ---- Tool selector ---- */}
      <div style={{ display: 'flex', gap: '4px', ...sectionStyle }}>
        <ExpandableToolButton
          label="选择" Icon={SelectIcon}
          active={activeTool === 'select'}
          onMain={() => setActiveTool('select')}
          options={[
            { label: '框选', active: selectionMode === 'box', onClick: () => { setActiveTool('select'); setSelectionMode('box'); } },
            { label: '点选', active: selectionMode === 'click', onClick: () => { setActiveTool('select'); setSelectionMode('click'); } },
          ]}
        />
        <SimpleToolButton label="笔刷" Icon={PenIcon} active={activeTool === 'pen'} onClick={() => setActiveTool('pen')} />
        <ExpandableToolButton
          label="橡皮" Icon={EraserIcon}
          active={activeTool === 'eraser'}
          onMain={() => setActiveTool('eraser')}
          options={[
            { label: '自由擦除', active: eraserMode === 'free', onClick: () => { setActiveTool('eraser'); setEraserMode('free'); } },
            { label: '擦除笔画', active: eraserMode === 'stroke', onClick: () => { setActiveTool('eraser'); setEraserMode('stroke'); } },
          ]}
        />
        <SimpleToolButton label="文本" Icon={TextIcon} active={activeTool === 'text'} onClick={() => setActiveTool('text')} />
      </div>

      {/* ---- Color palette ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>颜色</span></div>
        <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap', marginBottom: '6px' }}>
          {PRESET_COLORS.map((c) => (
            <button key={c} onClick={() => update({ color: c })} title={c}
              style={{ width: '18px', height: '18px', borderRadius: '50%', background: c,
                border: brushSettings.color === c ? '2px solid var(--text-primary)' : '1px solid var(--glass-border)',
                cursor: 'pointer', padding: 0, outline: 'none', flexShrink: 0,
                boxShadow: brushSettings.color === c ? '0 0 0 2px var(--accent)' : 'none' }} />
          ))}
        </div>
        <input type="color" value={brushSettings.color.startsWith('#') ? brushSettings.color : '#ffffff'}
          onChange={(e) => update({ color: e.target.value })}
          style={{ width: '100%', height: '22px', border: 'none', borderRadius: '4px', cursor: 'pointer', background: 'transparent', padding: 0 }} />
      </div>

      {/* ---- Brush Size ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>大小</span><span>{brushSettings.size}</span></div>
        <input type="range" min={1} max={100} value={brushSettings.size} onChange={(e) => update({ size: Number(e.target.value) })} style={trackStyle} />
      </div>

      {/* ---- Opacity ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>透明度</span><span>{Math.round(brushSettings.opacity * 100)}%</span></div>
        <input type="range" min={1} max={100} value={Math.round(brushSettings.opacity * 100)} onChange={(e) => update({ opacity: Number(e.target.value) / 100 })} style={trackStyle} />
      </div>

      {/* ---- Smoothing ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>平滑</span><span>{Math.round(brushSettings.smoothing * 100)}%</span></div>
        <input type="range" min={0} max={100} value={Math.round(brushSettings.smoothing * 100)} onChange={(e) => update({ smoothing: Number(e.target.value) / 100 })} style={trackStyle} />
      </div>

      {/* ---- Dot grid show/hide ---- */}
      <div style={sectionStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showDotGrid} onChange={(e) => setShowDotGrid(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
          显示点阵背景
        </label>
      </div>

      {/* ---- Undo / Redo ---- */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
        <button onClick={undo} disabled={!canUndo} style={{ flex: 1, padding: '5px 8px', background: 'var(--glass-bg-light)', border: '1px solid var(--glass-border)', borderRadius: '6px', color: 'var(--text-secondary)', cursor: canUndo ? 'pointer' : 'default', fontSize: '11px', fontFamily: 'inherit', opacity: canUndo ? 1 : 0.35, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px' }}>
          <UndoIcon />撤销
        </button>
        <button onClick={redo} disabled={!canRedo} style={{ flex: 1, padding: '5px 8px', background: 'var(--glass-bg-light)', border: '1px solid var(--glass-border)', borderRadius: '6px', color: 'var(--text-secondary)', cursor: canRedo ? 'pointer' : 'default', fontSize: '11px', fontFamily: 'inherit', opacity: canRedo ? 1 : 0.35, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px' }}>
          <RedoIcon />重做
        </button>
      </div>

      {/* ---- Delete selected / clear ---- */}
      <button onClick={() => askConfirm({
        title: '清空画布',
        message: '确定要清除画布上的所有内容吗？此操作可以撤销。',
        confirmLabel: '清空',
        danger: false,
        onConfirm: () => useCanvasStore.getState().clearCanvas(),
      })}
        style={{ width: '100%', padding: '5px 8px', background: 'var(--glass-bg-light)', border: '1px solid rgba(231,76,60,0.3)', borderRadius: '6px', color: 'var(--danger, #e74c3c)', cursor: 'pointer', fontSize: '11px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
        <TrashIcon />清空画布
      </button>
    </div>
  );
};

export default Toolbar;
