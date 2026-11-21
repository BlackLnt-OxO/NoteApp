import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PdfStroke, PdfCamera } from './PdfAnnotation/PdfTypes';
import { SHAPE_NAMES, shapeBounds, shapePathPoints, withShape, type ShapePoint } from './InkShapeGeometry';
import { dragShapeHandle, setShapeDimension, shapeDimensions, shapeHandles } from './InkShapeEditing';
import { setPointerHold } from './inkInputActivity';
import { useCanvasToolbarStore, usePdfToolbarStore } from './InfiniteInkCanvas/useToolbarStore';

const fieldStyle: React.CSSProperties = { width: 68, minWidth: 0, padding: '4px 5px', borderRadius: 5, border: '1px solid var(--glass-border)', background: 'var(--glass-bg-light)', color: 'var(--text-primary)', font: 'inherit' };
function NumberField({ label, value, onCommit, min, max }: { label: string; value: number; onCommit: (v: number) => boolean; min?: number; max?: number }) {
  const display = String(Math.round(value * 100) / 100);
  const [draft, setDraft] = useState(display), dirty = useRef(false);
  const draftRef = useRef(display);
  useEffect(() => { if (!dirty.current) { draftRef.current = display; setDraft(display); } }, [display]);
  const submit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const v = draftRef.current.trim() === '' ? NaN : Number(draftRef.current);
    if (!Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max) || !onCommit(v)) setDraft(display);
  };
  return <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
    <span>{label}</span><input aria-label={label} type="number" step="any" min={min} max={max} value={draft} style={fieldStyle}
      onChange={e => { dirty.current = true; draftRef.current = e.target.value; setDraft(e.target.value); }} onBlur={submit}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { submit(); e.currentTarget.blur(); } if (e.key === 'Escape') { dirty.current = false; draftRef.current = display; setDraft(display); e.currentTarget.blur(); } }} />
  </label>;
}
interface Props {
  stroke: PdfStroke;
  camera: PdfCamera;
  uiScale: number;
  container: React.RefObject<HTMLElement>;
  original?: PdfStroke | null;
  onPreview: (next: PdfStroke, original: PdfStroke) => void;
  onFinish: (next: PdfStroke, original: PdfStroke, recordHistory: boolean) => void;
  onDismiss: () => void;
}
/** The editor owns transient state; large document stores change only on drop. */
export default function InkShapeEditor({ stroke, camera, uiScale, container, original, onPreview, onFinish, onDismiss }: Props) {
  const [preview, setPreview] = useState<PdfStroke | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasDock = useCanvasToolbarStore(s => `${s.expanded}/${s.width}/${s.top}/${s.offset}/${s.side}`);
  const pdfDock = usePdfToolbarStore(s => `${s.expanded}/${s.width}/${s.top}/${s.offset}/${s.side}`);
  const [layout, setLayout] = useState({ width: window.innerWidth / uiScale, height: window.innerHeight / uiScale,
    panelWidth: 198, panelHeight: 300, obstacles: [] as { x: number; y: number; width: number; height: number }[] });
  useLayoutEffect(() => {
    const measure = () => {
      const r = container.current?.getBoundingClientRect(), panel = panelRef.current?.getBoundingClientRect();
      if (!r || !r.width || !r.height) return;
      const obstacles = [...document.querySelectorAll('.canvas-toolbar-shell.is-expanded')].map(el => el.getBoundingClientRect())
        .filter(b => b.width && b.height && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom)
        .map(b => ({ x: (b.left - r.left) / uiScale, y: (b.top - r.top) / uiScale, width: b.width / uiScale, height: b.height / uiScale }));
      const next = { width: r.width / uiScale, height: r.height / uiScale, panelWidth: panel?.width ? panel.width / uiScale : 198,
        panelHeight: panel?.height ? panel.height / uiScale : 300, obstacles };
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    if (panelRef.current) observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [container, uiScale, canvasDock, pdfDock]);
  const colorDraft = useRef<string | null>(null);
  const toHex = (color: string) => {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return rgb ? '#' + rgb.slice(1, 4).map(v => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('') : '#ffffff';
  };
  const [color, setColor] = useState(() => toHex(stroke.color));
  useEffect(() => { setColor(toHex(stroke.color)); colorDraft.current = null; }, [stroke.color]);
  const drag = useRef<{ pointer: number; key: string; start: ShapePoint; handleStart?: ShapePoint; original: PdfStroke; latest: PdfStroke; camera: PdfCamera } | null>(null);
  const latest = useRef({ onFinish, onDismiss, container }); latest.current = { onFinish, onDismiss, container };
  const raf = useRef(0);
  const shown = preview ?? stroke, geometry = shown.geometry!;
  const end = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null; if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0;
    setPointerHold(false); setPreview(null);
    const changed = d.latest !== d.original;
    latest.current.onFinish(commit && changed ? d.latest : d.original, d.original, commit && changed);
  };
  useEffect(() => {
    const flush = () => {
      const input = document.activeElement;
      if (input instanceof HTMLInputElement && input.closest('[data-ink-shape-editor]')) input.blur();
      end(true);
    };
    const cancel = () => end(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) { end(false); latest.current.onDismiss(); } };
    window.addEventListener('ink:flush-gesture', flush); window.addEventListener('blur', cancel); window.addEventListener('keydown', key);
    return () => { end(false); window.removeEventListener('ink:flush-gesture', flush); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => { if (drag.current && (drag.current.original !== stroke || drag.current.camera !== camera)) end(false); }, [stroke, camera, uiScale]);
  const world = (e: React.PointerEvent, cam = camera) => {
    const r = container.current?.getBoundingClientRect();
    return { x: (e.clientX - (r?.left ?? 0) - cam.x) / cam.zoom, y: (e.clientY - (r?.top ?? 0) - cam.y) / cam.zoom };
  };
  const down = (e: React.PointerEvent<SVGElement>, key: string) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, key, start: world(e), handleStart: shapeHandles(stroke.geometry!, camera.zoom).find(h => h.key === key), original: stroke, latest: stroke, camera };
    setPointerHold(true);
    // Clear just the original ink immediately, even before the first move.
    onPreview(stroke, stroke);
  };
  const move = (e: React.PointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    e.stopPropagation();
    const at = world(e, d.camera), dx = at.x - d.start.x, dy = at.y - d.start.y;
    const target = d.handleStart && d.key !== 'rotate' ? { x: d.handleStart.x + dx, y: d.handleStart.y + dy } : at;
    d.latest = Math.hypot(dx, dy) < 1e-7 ? d.original : withShape(d.original, dragShapeHandle(d.original.geometry!, d.key, target, d.start));
    onPreview(d.latest, d.original);
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; if (drag.current) setPreview(drag.current.latest); });
  };
  const handlers = (key: string) => ({ onPointerDown: (e: React.PointerEvent<SVGElement>) => down(e, key), onPointerMove: move,
    onPointerUp: (e: React.PointerEvent<SVGElement>) => { if (drag.current?.pointer !== e.pointerId) return; move(e); end(true); },
    onPointerCancel: () => end(false), onLostPointerCapture: () => end(false) });
  const screen = (p: ShapePoint) => ({ x: (p.x * camera.zoom + camera.x) / uiScale, y: (p.y * camera.zoom + camera.y) / uiScale });
  const path = shapePathPoints(geometry).map((p, i) => { const v = screen(p); return `${i ? 'L' : 'M'}${v.x} ${v.y}`; }).join(' ');
  const b = shapeBounds(geometry), topLeft = screen({ x: b.minX, y: b.minY }), bottomRight = screen({ x: b.maxX, y: b.maxY });
  const { width, height, panelWidth, panelHeight } = layout;
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const candidates = [[bottomRight.x + 14, topLeft.y], [topLeft.x - panelWidth - 14, topLeft.y],
    [topLeft.x, bottomRight.y + 14], [topLeft.x, topLeft.y - panelHeight - 14], [8, 8]]
    .map(([x, y]) => ({ x: Math.max(8, Math.min(Math.max(8, width - panelWidth - 8), x)),
      y: Math.max(8, Math.min(Math.max(8, height - panelHeight - 8), y)), width: panelWidth, height: panelHeight }));
  candidates.sort((a, b) => layout.obstacles.reduce((sum, o) => sum + overlap(a, o), 0) - layout.obstacles.reduce((sum, o) => sum + overlap(b, o), 0));
  const panelX = candidates[0].x, panelY = candidates[0].y;
  const commit = (next: PdfStroke) => {
    if (next.size === stroke.size && next.opacity === stroke.opacity && next.color === stroke.color && JSON.stringify(next.geometry) === JSON.stringify(stroke.geometry)) return;
    onFinish(next, stroke, true);
  };
  return <div data-ink-shape-editor style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    <svg aria-label={`${SHAPE_NAMES[geometry.kind]}控制点`} style={{ position: 'absolute', inset: 0, zIndex: 20, width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none', touchAction: 'none' }}>
      <path d={path} fill="none" stroke="transparent" strokeWidth={Math.max(14 / uiScale, shown.size * camera.zoom / uiScale)} style={{ pointerEvents: 'stroke', cursor: 'move' }} {...handlers('move')} />
      <rect x={topLeft.x} y={topLeft.y} width={Math.max(0, bottomRight.x - topLeft.x)} height={Math.max(0, bottomRight.y - topLeft.y)} fill="none" stroke="var(--accent, #6b5ce7)" strokeWidth={1 / uiScale} strokeDasharray="4 3" />
      {shapeHandles(geometry, camera.zoom).map(h => {
        const p = screen(h);
        return <g key={h.key} style={{ pointerEvents: 'all', cursor: h.key === 'rotate' ? 'grab' : 'crosshair' }} {...handlers(h.key)}>
          <title>{h.label}</title><circle cx={p.x} cy={p.y} r={12 / uiScale} fill="transparent" />
          <circle cx={p.x} cy={p.y} r={(h.key === 'rotate' ? 5 : 4) / uiScale} fill="var(--dropdown-bg, #fff)" stroke="var(--accent, #6b5ce7)" strokeWidth={1.5 / uiScale} />
        </g>;
      })}
    </svg>
    <div ref={panelRef} role="group" data-ink-shape-panel aria-label="图形参数" onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
      style={{ position: 'absolute', zIndex: 110, left: panelX, top: panelY, width: 176, maxHeight: Math.max(96, height - panelY - 24), overflowY: 'auto',
        pointerEvents: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 7,
        color: 'var(--text-primary)', background: 'var(--dropdown-bg, rgba(30,30,50,.98))', border: '1px solid var(--glass-border)', borderRadius: 10, boxShadow: 'var(--glass-shadow)', fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{SHAPE_NAMES[geometry.kind]}</strong><button className="glass-btn" aria-label="完成图形编辑" onClick={onDismiss}>完成</button>
      </div>
      <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>尺寸单位：画布／页面单位</span>
      {shapeDimensions(geometry).map(f => <NumberField key={f.key} label={f.label} value={f.value} min={f.key === 'angle' ? undefined : 0.1} max={f.key === 'angle' ? undefined : 1_000_000}
        onCommit={v => { const g = setShapeDimension(stroke.geometry!, f.key, v); if (!g) return false; commit(withShape(stroke, g)); return true; }} />)}
      <NumberField label="线宽" value={shown.size} min={0.1} max={100} onCommit={v => { commit({ ...stroke, size: v }); return true; }} />
      <NumberField label="不透明度 %" value={shown.opacity * 100} min={1} max={100} onCommit={v => { commit({ ...stroke, opacity: v / 100 }); return true; }} />
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>颜色<input aria-label="图形颜色" type="color" value={color}
        onChange={e => { setColor(e.target.value); colorDraft.current = e.target.value; }} onBlur={() => { if (colorDraft.current) { commit({ ...stroke, color: colorDraft.current }); colorDraft.current = null; } }} style={{ ...fieldStyle, padding: 0, height: 26 }} /></label>
      {original?.id === stroke.id && <button className="glass-btn" onClick={() => { commit(original); onDismiss(); }}>恢复手绘</button>}
    </div>
  </div>;
}
