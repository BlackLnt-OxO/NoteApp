import { useState, type ReactNode } from 'react';
import { PDF_ANNOTATION_BLUE } from '../../themeColors';
import { InkShapePreferences } from '../InkShapePreferences';
import InkDisclosure from './InkDisclosure';
import InkToolButton from './InkToolButton';
import type { BrushSettings, BrushType, InsertMode, SelectionMode, ToolType } from './types';
import type { AlternatePen } from './useToolbarStore';

export type ToolSlot = 'marker' | 'alternate' | 'laser' | 'eraser' | 'select' | 'insert';
type MainTool = Exclude<ToolType, 'text'>;

export interface InkToolbarControls {
  tool: ToolType;
  brush: BrushType;
  settings: BrushSettings;
  alternatePen: AlternatePen;
  setAlternatePen: (pen: AlternatePen) => void;
  setTool: (tool: MainTool) => void;
  setBrush: (brush: BrushType) => void;
  update: (patch: Partial<BrushSettings>) => void;
  selectionMode: SelectionMode;
  setSelectionMode: (mode: SelectionMode) => void;
  eraserMode: 'free' | 'stroke';
  setEraserMode: (mode: 'free' | 'stroke') => void;
  insertMode: InsertMode;
  setInsertMode: (mode: InsertMode) => void;
  showDotGrid: boolean;
  setShowDotGrid: (show: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  clearLabel: string;
  clear: () => void;
}

const COLORS = [
  '#ffffff', '#e0e0e0', '#cccccc', '#ff6b6b', '#f06595', '#e64980',
  '#ff922b', '#fcc419', '#ffd43b', '#51cf66', '#20c997', '#38d9a9',
  '#339af0', PDF_ANNOTATION_BLUE, '#5c7cfa', '#7950f2', '#845ef7', '#6b5ce7', '#111111',
];

export function toolLabel(slot: ToolSlot, alternate: AlternatePen) {
  return {
    marker: '笔刷', alternate: alternate === 'pencil' ? '铅笔' : '钢笔',
    laser: '激光笔', eraser: '橡皮', select: '选择', insert: '插入',
  }[slot];
}

function Options<T extends string>({ label, value, choices, onChange }: {
  label: string; value: T; choices: { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  return <fieldset className="ink-tool-options">
    <legend>{label}</legend>
    <div className="ink-tool-choice-row">
      {choices.map(choice => <button type="button" key={choice.value} className="ink-tool-choice"
        aria-pressed={choice.value === value} onClick={() => onChange(choice.value)}>{choice.label}</button>)}
    </div>
  </fieldset>;
}

function RangeField({ label, value, display, min = 1, max = 100, onChange }: {
  label: string; value: number; display?: string; min?: number; max?: number; onChange: (value: number) => void;
}) {
  return <label className="ink-tool-range">
    <span>{label}<span className="ink-tool-value">{display ?? value}</span></span>
    <input aria-label={label} type="range" min={min} max={max} value={value}
      onChange={event => onChange(Number(event.target.value))} />
  </label>;
}

function CheckField({ children, checked, onChange }: {
  children: ReactNode; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="ink-tool-check">
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    {children}
  </label>;
}

function SizeFields({ controls, eraser }: { controls: InkToolbarControls; eraser: boolean }) {
  const [editing, setEditing] = useState(false);
  const [presetIndex, setPresetIndex] = useState(0);
  const sizeKey = eraser ? 'eraserSize' : 'size';
  const presetKey = eraser ? 'eraserQuickSizes' : 'quickSizes';
  const size = controls.settings[sizeKey];
  const presets = controls.settings[presetKey] ?? (eraser ? [12, 20, 60] : [8, 20, 40]);
  return <>
    <div className="ink-size-presets">
      {presets.map((value, index) => <InkToolButton key={index} className="ink-size-preset"
        label={value + ' 像素预设'} pressed={size === value} expanded={editing && presetIndex === index} holdMs={500}
        onPress={() => { setEditing(false); controls.update({ [sizeKey]: value }); }}
        onHold={() => { setPresetIndex(index); setEditing(true); }}>
        <span style={{ width: Math.max(5, Math.min(value, 28)), height: Math.max(5, Math.min(value, 28)) }} />
      </InkToolButton>)}
    </div>
    <InkDisclosure visible={editing}>
      <RangeField label={'预设 ' + (presetIndex + 1) + ' 粗细'} value={presets[presetIndex]}
        onChange={value => controls.update({ [presetKey]: presets.map((preset, i) => i === presetIndex ? value : preset) })} />
    </InkDisclosure>
    <RangeField label={eraser ? '橡皮大小' : '大小'} value={size}
      onChange={value => controls.update({ [sizeKey]: value })} />
  </>;
}

function ColorFields({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  return <fieldset className="ink-tool-options">
    <legend>颜色</legend>
    <div className="ink-color-swatches">
      {COLORS.map(swatch => <button type="button" className="ink-color-swatch" key={swatch} data-tooltip={swatch} aria-label={swatch}
        aria-pressed={color.toLowerCase() === swatch.toLowerCase()} style={{ background: swatch }}
        onClick={() => onChange(swatch)} />)}
      <input type="color" aria-label="自定义颜色" data-tooltip="自定义颜色"
        value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff'} onChange={event => onChange(event.target.value)} />
    </div>
  </fieldset>;
}

export default function InkToolbarOptions({ slot, controls }: { slot: ToolSlot; controls: InkToolbarControls }) {
  if (slot === 'select') return <>
    <Options label="选择方式" value={controls.selectionMode} choices={[
      { value: 'box', label: '框选' }, { value: 'click', label: '点选' },
    ]} onChange={controls.setSelectionMode} />
    <p className="ink-tool-help">Shift 加选，Ctrl 减选</p>
  </>;
  if (slot === 'insert') return <Options label="插入内容" value={controls.insertMode} choices={[
    { value: 'text', label: '文本框' }, { value: 'image', label: '图片' },
  ]} onChange={controls.setInsertMode} />;
  if (slot === 'eraser') return <>
    <Options label="橡皮模式" value={controls.eraserMode} choices={[
      { value: 'free', label: '自由擦除' }, { value: 'stroke', label: '擦除笔画' },
    ]} onChange={controls.setEraserMode} />
    <SizeFields controls={controls} eraser />
  </>;

  const settings = controls.settings;
  const update = controls.update;
  const style = slot === 'alternate' ? controls.alternatePen : slot;
  const percentage = (value: number) => Math.round(value * 100);
  return <>
    {slot === 'alternate' && <Options label="换笔" value={controls.alternatePen} choices={[
      { value: 'fountain', label: '钢笔' }, { value: 'pencil', label: '铅笔' },
    ]} onChange={pen => { controls.setAlternatePen(pen); controls.setBrush(pen); }} />}
    <ColorFields color={settings.color} onChange={color => update({ color })} />
    <SizeFields controls={controls} eraser={false} />
    <RangeField label="透明度" value={percentage(settings.opacity)} display={percentage(settings.opacity) + '%'}
      onChange={value => update({ opacity: value / 100 })} />
    {style !== 'laser' && <InkShapePreferences />}
    <RangeField label="平滑" value={percentage(settings.smoothing)} display={percentage(settings.smoothing) + '%'}
      min={0} max={20} onChange={value => update({ smoothing: value / 100 })} />
    <InkDisclosure visible={style !== 'pencil'}>
      <CheckField checked={settings.edgeFeather !== false} onChange={edgeFeather => update({ edgeFeather })}>边缘羽化</CheckField>
      <InkDisclosure visible={settings.edgeFeather !== false}>
        <RangeField label="羽化大小" value={Math.round((settings.featherSize ?? 0.4) * 100)}
          display={(settings.featherSize ?? 0.4).toFixed(2)} min={0} max={200} onChange={value => update({ featherSize: value / 100 })} />
      </InkDisclosure>
    </InkDisclosure>
    <InkDisclosure visible={style === 'fountain'}>
      <RangeField label="出墨速度" value={percentage(settings.inkSpeed)} display={percentage(settings.inkSpeed) + '%'}
        min={0} onChange={value => update({ inkSpeed: value / 100 })} />
    </InkDisclosure>
    <InkDisclosure visible={style === 'marker' || style === 'fountain'}>
      <CheckField checked={settings.pressureOpacity} onChange={pressureOpacity => update({ pressureOpacity })}>压感控制透明度</CheckField>
    </InkDisclosure>
  </>;
}
