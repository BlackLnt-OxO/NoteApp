/**
 * Toolbar — Brush settings and tool panel content.
 *
 * This is the inner content that gets embedded inside ToolbarShell.
 * It does NOT manage its own positioning, collapse state, or event isolation —
 * those are handled by ToolbarShell.
 */

import React, { useState } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { DOT_DENSITY_OPTIONS } from './constants';
import type { ToolType } from './types';

// ---- Constants (local to this component) --------------------------------------

const TOOLS: { id: ToolType; label: string; icon: string }[] = [
  { id: 'pen', label: '笔刷', icon: '✏️' },
  { id: 'eraser', label: '橡皮', icon: '🧹' },
  { id: 'text', label: '文本', icon: '📝' },
  { id: 'pan', label: '平移', icon: '✋' },
];

const PRESET_COLORS = [
  '#ffffff', '#e0e0e0', '#cccccc',
  '#ff6b6b', '#f06595', '#e64980',
  '#ff922b', '#fcc419', '#ffd43b',
  '#51cf66', '#20c997', '#38d9a9',
  '#339af0', '#5c7cfa', '#7950f2',
  '#845ef7', '#6b5ce7', '#111111',
];

// ---- Shared styles ------------------------------------------------------------

const trackStyle: React.CSSProperties = {
  width: '100%',
  height: '4px',
  WebkitAppearance: 'none',
  appearance: 'none' as any,
  background: 'var(--glass-bg-light)',
  borderRadius: '2px',
  outline: 'none',
  cursor: 'pointer',
  margin: '2px 0 6px 0',
};

const labelStyle: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--text-secondary)',
  marginBottom: '1px',
  display: 'flex',
  justifyContent: 'space-between',
};

const sectionStyle: React.CSSProperties = {
  marginBottom: '10px',
};

const Toolbar: React.FC = () => {
  const {
    activeTool,
    brushSettings,
    dotDensity,
    setActiveTool,
    setBrushSettings,
    setDotDensity,
    undo,
    redo,
    history,
    redoStack,
  } = useCanvasStore();

  const canUndo = history.length > 0;
  const canRedo = redoStack.length > 0;

  const [colorInput, setColorInput] = useState(brushSettings.color);

  const update = (partial: Partial<typeof brushSettings>) =>
    setBrushSettings(partial);

  const btnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '6px 4px',
    background: active ? 'var(--accent)' : 'var(--glass-bg-light)',
    border: active ? 'none' : '1px solid var(--glass-border)',
    borderRadius: '6px',
    color: active ? '#fff' : 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    transition: 'all var(--transition)',
  });

  const actionBtnStyle: React.CSSProperties = {
    flex: 1,
    padding: '4px 6px',
    background: 'var(--glass-bg-light)',
    border: '1px solid var(--glass-border)',
    borderRadius: '6px',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'inherit',
    transition: 'all var(--transition)',
  };

  return (
    <div
      style={{
        padding: '12px',
        color: 'var(--text-primary)',
      }}
    >
      {/* ---- Header ---- */}
      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text-secondary)' }}>
        笔刷工具
      </div>

      {/* ---- Tool selector ---- */}
      <div style={{ display: 'flex', gap: '4px', ...sectionStyle }}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTool(t.id)}
            style={btnStyle(activeTool === t.id)}
            title={t.label}
          >
            {t.icon}
          </button>
        ))}
      </div>

      {/* ---- Color palette ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>颜色</span></div>
        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginBottom: '6px' }}>
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                setColorInput(c);
                update({ color: c });
              }}
              style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                background: c,
                border: brushSettings.color === c ? '2px solid #fff' : '1px solid var(--glass-border)',
                cursor: 'pointer',
                padding: 0,
                outline: 'none',
                boxShadow: brushSettings.color === c ? '0 0 0 2px var(--accent)' : 'none',
              }}
            />
          ))}
        </div>
        <input
          type="color"
          value={brushSettings.color.startsWith('#') ? brushSettings.color : '#ffffff'}
          onChange={(e) => {
            setColorInput(e.target.value);
            update({ color: e.target.value });
          }}
          style={{
            width: '100%',
            height: '24px',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            background: 'transparent',
            padding: 0,
          }}
        />
      </div>

      {/* ---- Brush Size ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>大小</span><span>{brushSettings.size}</span></div>
        <input type="range" min={1} max={100} value={brushSettings.size}
          onChange={(e) => update({ size: Number(e.target.value) })} style={trackStyle} />
      </div>

      {/* ---- Opacity ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>透明度</span><span>{Math.round(brushSettings.opacity * 100)}%</span></div>
        <input type="range" min={1} max={100} value={Math.round(brushSettings.opacity * 100)}
          onChange={(e) => update({ opacity: Number(e.target.value) / 100 })} style={trackStyle} />
      </div>

      {/* ---- Hardness ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>硬度</span><span>{Math.round(brushSettings.hardness * 100)}%</span></div>
        <input type="range" min={1} max={100} value={Math.round(brushSettings.hardness * 100)}
          onChange={(e) => update({ hardness: Number(e.target.value) / 100 })} style={trackStyle} />
      </div>

      {/* ---- Spacing ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>间距</span><span>{brushSettings.spacing.toFixed(2)}</span></div>
        <input type="range" min={1} max={100} value={Math.round(brushSettings.spacing * 100)}
          onChange={(e) => update({ spacing: Number(e.target.value) / 100 })} style={trackStyle} />
      </div>

      {/* ---- Smoothing ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>平滑</span><span>{Math.round(brushSettings.smoothing * 100)}%</span></div>
        <input type="range" min={0} max={100} value={Math.round(brushSettings.smoothing * 100)}
          onChange={(e) => update({ smoothing: Number(e.target.value) / 100 })} style={trackStyle} />
      </div>

      {/* ---- Pressure toggles ---- */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={brushSettings.pressureSize}
            onChange={(e) => update({ pressureSize: e.target.checked })}
            style={{ accentColor: 'var(--accent)' }} />
          压感大小
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={brushSettings.pressureOpacity}
            onChange={(e) => update({ pressureOpacity: e.target.checked })}
            style={{ accentColor: 'var(--accent)' }} />
          压感透明
        </label>
      </div>

      {/* ---- Dot density ---- */}
      <div style={sectionStyle}>
        <div style={labelStyle}><span>点阵密度</span></div>
        <select
          value={dotDensity}
          onChange={(e) => setDotDensity(Number(e.target.value))}
          style={{
            width: '100%',
            padding: '4px 6px',
            borderRadius: '6px',
            border: '1px solid var(--glass-border)',
            background: 'var(--glass-bg-light)',
            color: 'var(--text-primary)',
            fontSize: '11px',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        >
          {DOT_DENSITY_OPTIONS.map((d) => (
            <option key={d} value={d}>{d} px</option>
          ))}
        </select>
      </div>

      {/* ---- Undo / Redo ---- */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
        <button onClick={undo} disabled={!canUndo}
          style={{ ...actionBtnStyle, opacity: canUndo ? 1 : 0.4 }}>
          ↩ 撤销
        </button>
        <button onClick={redo} disabled={!canRedo}
          style={{ ...actionBtnStyle, opacity: canRedo ? 1 : 0.4 }}>
          ↪ 重做
        </button>
      </div>

      {/* ---- Clear ---- */}
      <button
        onClick={() => {
          if (confirm('确定要清除画布吗？此操作可以撤销。')) {
            useCanvasStore.getState().clearCanvas();
          }
        }}
        style={{
          ...actionBtnStyle,
          width: '100%',
          color: 'var(--danger, #e74c3c)',
          borderColor: 'rgba(231,76,60,0.3)',
        }}
      >
        🗑 清空画布
      </button>
    </div>
  );
};

export default Toolbar;
