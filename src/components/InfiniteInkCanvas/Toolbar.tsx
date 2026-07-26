import React, { useState } from 'react';
import { useCanvasStore } from './useCanvasStore';
import { DOT_DENSITY_OPTIONS, ERASER_RADIUS } from './constants';
import type { ToolType } from './types';

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

  const [collapsed, setCollapsed] = useState(false);

  const canUndo = history.length > 0;
  const canRedo = redoStack.length > 0;

  // Track color input value
  const [colorInput, setColorInput] = useState(brushSettings.color);

  const update = (partial: Partial<typeof brushSettings>) =>
    setBrushSettings(partial);

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

  if (collapsed) {
    return (
      <div
        style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          zIndex: 100,
        }}
      >
        <button
          onClick={() => setCollapsed(false)}
          style={{
            width: '34px',
            height: '34px',
            borderRadius: '50%',
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(16px)',
            border: '1px solid var(--glass-border)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--glass-shadow)',
          }}
          title="展开工具栏"
        >
          🎨
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: '10px',
        left: '10px',
        zIndex: 100,
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--glass-border)',
        borderRadius: '12px',
        padding: '12px',
        boxShadow: 'var(--glass-shadow)',
        width: '220px',
        maxHeight: 'calc(100vh - 40px)',
        overflowY: 'auto',
        color: 'var(--text-primary)',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600 }}>工具栏</span>
        <button
          onClick={() => setCollapsed(true)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: '14px',
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Tool selector */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
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

      {/* Color palette */}
      <div style={labelStyle}>
        <span>颜色</span>
      </div>
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
          marginBottom: '8px',
        }}
      />

      {/* Brush Size */}
      <div style={labelStyle}><span>大小</span><span>{brushSettings.size}</span></div>
      <input type="range" min={1} max={100} value={brushSettings.size}
        onChange={(e) => update({ size: Number(e.target.value) })} style={trackStyle} />

      {/* Opacity */}
      <div style={labelStyle}><span>透明度</span><span>{Math.round(brushSettings.opacity * 100)}%</span></div>
      <input type="range" min={1} max={100} value={Math.round(brushSettings.opacity * 100)}
        onChange={(e) => update({ opacity: Number(e.target.value) / 100 })} style={trackStyle} />

      {/* Hardness */}
      <div style={labelStyle}><span>硬度</span><span>{Math.round(brushSettings.hardness * 100)}%</span></div>
      <input type="range" min={1} max={100} value={Math.round(brushSettings.hardness * 100)}
        onChange={(e) => update({ hardness: Number(e.target.value) / 100 })} style={trackStyle} />

      {/* Spacing */}
      <div style={labelStyle}><span>间距</span><span>{brushSettings.spacing.toFixed(2)}</span></div>
      <input type="range" min={1} max={100} value={Math.round(brushSettings.spacing * 100)}
        onChange={(e) => update({ spacing: Number(e.target.value) / 100 })} style={trackStyle} />

      {/* Smoothing */}
      <div style={labelStyle}><span>平滑</span><span>{Math.round(brushSettings.smoothing * 100)}%</span></div>
      <input type="range" min={0} max={100} value={Math.round(brushSettings.smoothing * 100)}
        onChange={(e) => update({ smoothing: Number(e.target.value) / 100 })} style={trackStyle} />

      {/* Pressure toggles */}
      <div style={{ display: 'flex', gap: '6px', marginTop: '6px', marginBottom: '4px' }}>
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

      {/* Dot density */}
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
          marginBottom: '6px',
          outline: 'none',
        }}
      >
        {DOT_DENSITY_OPTIONS.map((d) => (
          <option key={d} value={d}>{d} px</option>
        ))}
      </select>

      {/* Undo / Redo */}
      <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
        <button onClick={undo} disabled={!canUndo}
          style={{ ...actionBtnStyle, opacity: canUndo ? 1 : 0.4 }}>
          ↩ 撤销
        </button>
        <button onClick={redo} disabled={!canRedo}
          style={{ ...actionBtnStyle, opacity: canRedo ? 1 : 0.4 }}>
          ↪ 重做
        </button>
      </div>

      {/* Clear */}
      <button
        onClick={() => {
          if (confirm('确定要清除画布吗？此操作可以撤销。')) {
            useCanvasStore.getState().clearCanvas();
          }
        }}
        style={{
          ...actionBtnStyle,
          width: '100%',
          marginTop: '4px',
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
