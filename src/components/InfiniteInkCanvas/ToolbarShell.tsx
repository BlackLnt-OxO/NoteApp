import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { isInkPointerActive, INK_STROKE_START } from '../inkInputActivity';
import { DEFAULT_INK_TOOLBAR_POSITION, nearestInkToolbarPosition, type InkToolbarPosition } from '../../inkToolbarPosition';
import InkToolButton from './InkToolButton';
import InkToolbarOptions, { toolLabel, type InkToolbarControls, type ToolSlot } from './InkToolbarOptions';
import { INK_TOOLBAR_LAYOUT, saveInkToolbarPosition, useInkToolbarPosition } from './inkToolbarLayout';
import type { AlternatePen } from './useToolbarStore';
import IconAction from '../IconAction';
import './inkToolbar.css';

const LEAVE_DELAY = 650;
const instruments: ToolSlot[] = ['marker', 'alternate', 'laser', 'eraser'];
type Panel = ToolSlot | 'more';

const iconPaths = {
  marker: 'M3 3c2.4 1 5-1 7.4 1.4a4.2 4.2 0 0 1 0 6 4.2 4.2 0 0 1-6 0C2 8 4 5.4 3 3Zm8.4 4.6 9.1 9.1a2.3 2.3 0 0 1-3.3 3.3l-9.1-9.1',
  fountain: 'M12 2 6 11l3 7h6l3-7-6-9v8m-3 8v4h6v-4m-2-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  pencil: 'M8 8l4-6 4 6v12l-2 2h-4l-2-2Zm0 0h8m-4 1v8m-4 1h8',
  eraser: 'M5 10V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M5 10h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z',
  select: 'M4 4l15 7-7 2-2 7L4 4z',
  insert: 'M5 12h14m-7-7v14',
  undo: 'M9 5l-5 5 5 5M4 10h10a5 5 0 0 1 0 10h-3',
  redo: 'M15 5l5 5-5 5m5-5H10a5 5 0 0 0 0 10h3',
  trash: 'M5 7h14m-12 0 1 13h8l1-13M9 7V4h6v3m-4 4v5m2-5v5',
} as const;

function Icon({ name }: { name: keyof typeof iconPaths | 'more' | 'laser' }) {
  if (name === 'laser') return <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true"
    className="ink-laser-icon" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <circle cx="7" cy="6" r="2.7" fill="currentColor" stroke="none" />
    <path d="M7 1v1m-5 4h1m8 0h1m-8.5 4 1-1" />
    <path d="M9.5 9a15 15 0 0 0 3.6 5.6" opacity=".82" />
    <path d="m15.5 16.8 2 1.5" opacity=".58" />
    <circle cx="20.5" cy="20" r="1" fill="currentColor" stroke="none" opacity=".48" />
  </svg>;
  return <svg viewBox="0 0 24 24" width="21" height="21" fill="none" aria-hidden="true"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {name === 'more' ? [5, 12, 19].map(x => <circle key={x} cx={x} cy={12} r="1.3" fill="currentColor" stroke="none" />)
      : <path d={iconPaths[name]} />}
  </svg>;
}

function PenVariants({ pen, render }: { pen: AlternatePen; render: (variant: AlternatePen) => ReactNode }) {
  return <span className="ink-pen-variants" aria-hidden="true">
    <span data-current={pen === 'fountain'}>{render('fountain')}</span>
    <span data-current={pen === 'pencil'}>{render('pencil')}</span>
  </span>;
}

function nearDockEdge(handle: HTMLButtonElement | null, x: number, y: number) {
  const edge = handle?.getBoundingClientRect();
  return edge && edge.width > 0 && x >= edge.left - 20 && x <= edge.right + 20
    && y >= edge.top - 14 && y <= edge.bottom + 14;
}

export default function ToolbarShell({ controls, allowLeftDock = true }: {
  controls: InkToolbarControls;
  allowLeftDock?: boolean;
}) {
  const savedPosition = useInkToolbarPosition();
  const restingPosition = !allowLeftDock && savedPosition.edge === 'left' ? DEFAULT_INK_TOOLBAR_POSITION : savedPosition;
  const [previewPosition, setPreviewPosition] = useState<InkToolbarPosition | null>(null);
  const { edge: dock, offset } = previewPosition ?? restingPosition;
  const vertical = dock === 'left' || dock === 'right';
  const band = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLElement>(null);
  const previousPanelHeight = useRef<number>();
  const resizeAnimation = useRef<Animation>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const writingPointer = useRef<number | null>(null);
  const expandedRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [writing, setWriting] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; element: HTMLButtonElement; moved: boolean }>();
  const dragFrame = useRef<number>();
  const ignoreGripClick = useRef(false);

  const stopTimer = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; }, []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const collapse = useCallback(() => {
    stopTimer();
    expandedRef.current = false;
    setExpanded(false);
    closePanel();
  }, [closePanel, stopTimer]);

  const expand = useCallback(() => {
    if (writingPointer.current !== null || isInkPointerActive() || document.querySelector('[data-file-dialog], .dialog-overlay')) return;
    stopTimer();
    expandedRef.current = true;
    setExpanded(true);
  }, [stopTimer]);

  const hideLater = useCallback(() => {
    if (drag.current?.moved || !expandedRef.current || timer.current !== undefined) return;
    timer.current = setTimeout(collapse, LEAVE_DELAY);
  }, [collapse]);

  const finishDockDrag = useCallback((position?: InkToolbarPosition) => {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = undefined;
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    if (gesture.element.hasPointerCapture?.(gesture.id)) gesture.element.releasePointerCapture(gesture.id);
    if (!gesture.moved) return;
    ignoreGripClick.current = true;
    setPreviewPosition(null);
    if (position) saveInkToolbarPosition(position);
    hideLater();
  }, [hideLater]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (drag.current) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          finishDockDrag();
        }
        return;
      }
      if (document.querySelector('[data-file-dialog], .dialog-overlay')) return;
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
      if (event.key === 'Escape' && popupRef.current?.dataset.open === 'true') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closePanel();
      }
      if (event.key.toLowerCase() === 'n' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (expandedRef.current) collapse(); else expand();
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !band.current?.contains(event.target)) closePanel();
    };
    const startWriting = (event: Event) => {
      finishDockDrag();
      writingPointer.current = (event as CustomEvent<number>).detail;
      setWriting(true);
      collapse();
    };
    const stopWriting = () => {
      writingPointer.current = null;
      setWriting(false);
    };
    const blur = () => { stopWriting(); finishDockDrag(); };
    const release = (event: PointerEvent) => {
      if (writingPointer.current !== event.pointerId) return;
      if (event.type !== 'lostpointercapture' || event.target instanceof HTMLCanvasElement) stopWriting();
    };
    window.addEventListener(INK_STROKE_START, startWriting);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('lostpointercapture', release, true);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', shortcut, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      stopTimer();
      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
      window.removeEventListener(INK_STROKE_START, startWriting);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('lostpointercapture', release, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', shortcut, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [collapse, closePanel, expand, finishDockDrag, stopTimer]);

  useEffect(() => { closePanel(); }, [dock, closePanel]);
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;
    popup.inert = !panelOpen;
    const previousHeight = previousPanelHeight.current;
    previousPanelHeight.current = undefined;
    resizeAnimation.current?.cancel();
    if (!panelOpen || previousHeight === undefined || typeof popup.animate !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const nextHeight = popup.offsetHeight;
    if (previousHeight === nextHeight) return;
    resizeAnimation.current = popup.animate(
      [{ height: previousHeight + 'px' }, { height: nextHeight + 'px' }],
      { duration: 210, easing: 'cubic-bezier(.2,.75,.25,1)' },
    );
    resizeAnimation.current.onfinish = notifyLayout;
  }, [panel, panelOpen]);
  useEffect(() => {
    const element = band.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const rail = parent.querySelector<HTMLElement>('[data-pdf-page-sidebar]');
    const update = () => {
      element.style.setProperty('--ink-editor-height', parent.clientHeight + 'px');
      element.style.setProperty('--ink-panel-height', Math.max(48, parent.clientHeight - (vertical ? 16 : 82)) + 'px');
      element.style.setProperty('--ink-rail-width', (rail?.offsetWidth ?? 0) + 'px');
      element.style.setProperty('--ink-left-start', rail && !rail.offsetWidth ? '50px' : '8px');
      element.style.setProperty('--ink-row-length', (vertical ? rowRef.current?.offsetHeight : rowRef.current?.offsetWidth) + 'px');
      element.style.setProperty('--ink-popup-height', (popupRef.current?.offsetHeight ?? 0) + 'px');
      notifyLayout();
    };
    const approach = (event: PointerEvent) => {
      if (drag.current || event.pointerType === 'touch' || event.buttons !== 0 || isInkPointerActive()) return;
      if (expandedRef.current && event.target instanceof Node && element.contains(event.target)) {
        stopTimer();
        return;
      }
      if (nearDockEdge(handle.current, event.clientX, event.clientY)) {
        expand();
      } else {
        hideLater();
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    if (rail) observer.observe(rail);
    if (rowRef.current) observer.observe(rowRef.current);
    if (popupRef.current) observer.observe(popupRef.current);
    parent.addEventListener('pointermove', approach, { passive: true });
    return () => {
      observer.disconnect();
      parent.removeEventListener('pointermove', approach);
    };
  }, [expand, hideLater, stopTimer, vertical, panel]);
  useEffect(() => {
    notifyLayout();
  }, [dock, offset, expanded, panelOpen, panel]);

  const dragHandlers = {
    onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
      ignoreGripClick.current = false;
      if (event.button !== 0 || drag.current || writing || isInkPointerActive()) return;
      event.stopPropagation();
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, element: event.currentTarget, moved: false };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
      const gesture = drag.current;
      if (!gesture || gesture.id !== event.pointerId || !band.current) return;
      if (!gesture.moved) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
        gesture.moved = true;
        stopTimer();
        closePanel();
      }
      const next = nearestInkToolbarPosition(band.current.getBoundingClientRect(), event.clientX, event.clientY, dock, allowLeftDock);
      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
      dragFrame.current = requestAnimationFrame(() => { dragFrame.current = undefined; setPreviewPosition(next); });
    },
    onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
      if (drag.current?.id !== event.pointerId) return;
      const rect = band.current?.getBoundingClientRect();
      finishDockDrag(rect ? nearestInkToolbarPosition(rect, event.clientX, event.clientY, dock, allowLeftDock) : undefined);
    },
    onPointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
      if (drag.current?.id === event.pointerId) finishDockDrag();
    },
    onLostPointerCapture(event: ReactPointerEvent<HTMLButtonElement>) {
      if (drag.current?.id === event.pointerId) finishDockDrag();
    },
  };

  function activate(slot: ToolSlot) {
    if (slot === 'select' || slot === 'insert' || slot === 'eraser') {
      controls.setTool(slot);
      return;
    }
    const brush = slot === 'alternate' ? controls.alternatePen : slot;
    controls.setBrush(brush);
    controls.setTool('pen');
  }

  function active(slot: ToolSlot) {
    if (slot === 'select' || slot === 'insert' || slot === 'eraser') return controls.tool === slot;
    if (controls.tool !== 'pen') return false;
    return slot === 'alternate' ? controls.brush === 'fountain' || controls.brush === 'pencil' : controls.brush === slot;
  }

  function hold(slot: ToolSlot) {
    stopTimer();
    activate(slot);
    openPanel(slot);
  }

  function openPanel(next: Panel) {
    if (panelOpen && panel !== next) previousPanelHeight.current = popupRef.current?.offsetHeight;
    setPanel(next);
    setPanelOpen(true);
  }

  function button(slot: ToolSlot) {
    return <InkToolButton key={slot} label={toolLabel(slot, controls.alternatePen)}
      tooltip={slot === 'select' ? '选择 · 选中后按 C 创建注释框' : slot === 'laser' ? '激光笔 · 笔迹会自动消失' : undefined}
      disabled={!expanded} pressed={active(slot)} expanded={panelOpen && panel === slot}
      onPress={() => { activate(slot); closePanel(); }} onHold={() => hold(slot)}>
      {slot === 'select' || slot === 'insert' ? <Icon name={slot} /> : <span className="ink-directional-icon">
        {slot === 'alternate'
          ? <PenVariants pen={controls.alternatePen} render={variant => <Icon name={variant} />} />
          : <Icon name={slot} />}
      </span>}
    </InkToolButton>;
  }

  const history = () => <>
    <InkToolButton label="撤销" onPress={controls.undo} disabled={!expanded || !controls.canUndo}><Icon name="undo" /></InkToolButton>
    <InkToolButton label="重做" onPress={controls.redo} disabled={!expanded || !controls.canRedo}><Icon name="redo" /></InkToolButton>
  </>;

  return <div className="ink-toolbar-band" data-ink-toolbar data-dock={dock}
    data-expanded={expanded} data-writing={writing} data-dragging={previewPosition !== null}
    style={{ '--ink-dock-offset': offset * 100 + '%' } as CSSProperties}
    ref={band}
    onTransitionEnd={event => { if (event.propertyName === 'transform' || event.propertyName === 'grid-template-rows') notifyLayout(); }}
    onPointerLeave={event => {
      if (event.pointerType === 'touch') return;
      if (event.relatedTarget instanceof Node && band.current?.parentElement?.contains(event.relatedTarget)
        && nearDockEdge(handle.current, event.clientX, event.clientY)) return;
      hideLater();
    }}>
    <div className="ink-toolbar-dock">
      <div ref={rowRef} className="ink-toolbar-row" role="toolbar" aria-label="手写工具栏"
        aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-hidden={!expanded}
        onPointerEnter={stopTimer} onPointerMove={stopTimer}>
        <button type="button" className="ink-toolbar-drag-grip" aria-label="拖动手写工具栏" data-tooltip="拖动手写工具栏"
          disabled={!expanded || writing} {...dragHandlers}>⠿</button>
        <div className="ink-toolbar-instruments">{instruments.map(button)}</div>
        <span className="ink-toolbar-divider" />
        <div className="ink-toolbar-aux">{button('select')}{button('insert')}{history()}</div>
        <InkToolButton label="更多" onPress={() => panel === 'more' && panelOpen ? closePanel() : openPanel('more')}
          expanded={panelOpen && panel === 'more'} disabled={!expanded}>
          <Icon name="more" />
        </InkToolButton>
      </div>
      <button type="button" ref={handle} className="ink-toolbar-handle" aria-label="展开手写工具栏" data-tooltip="展开手写工具栏（N）"
        disabled={writing} aria-expanded={expanded} {...dragHandlers}
        onClick={() => { if (!expanded && !ignoreGripClick.current) expand(); ignoreGripClick.current = false; }} />
    </div>
    {panel && <section ref={popupRef} className="ink-toolbar-popover"
      data-ink-tool-popover data-open={panelOpen} aria-hidden={!panelOpen} role="dialog"
      aria-label={panel === 'more' ? '更多工具' : toolLabel(panel, controls.alternatePen) + '工具盘'}
      onPointerEnter={stopTimer} onPointerMove={stopTimer} onPointerDown={stopTimer}>
      <header className="ink-toolbar-popover-header">
        <strong>{panel === 'more' ? '更多工具' : panel === 'alternate'
          ? <PenVariants pen={controls.alternatePen} render={variant => toolLabel('alternate', variant)} />
          : toolLabel(panel, controls.alternatePen)}</strong>
        <IconAction label="关闭工具盘" onClick={closePanel} />
      </header>
      <div className="ink-toolbar-panel-content" key={panel}>{panel === 'more'
        ? <>
          <div className="ink-tool-choice-row">{button('select')}{button('insert')}{history()}
            <InkToolButton label={controls.clearLabel} onPress={() => { collapse(); controls.clear(); }}><Icon name="trash" /></InkToolButton>
          </div>
          <label className="ink-tool-check">
            <input type="checkbox" checked={controls.showDotGrid} onChange={event => controls.setShowDotGrid(event.target.checked)} />
            显示点阵背景
          </label>
        </>
        : <InkToolbarOptions slot={panel} controls={controls} />}
      </div>
    </section>}
  </div>;
}

function notifyLayout() {
  window.dispatchEvent(new Event(INK_TOOLBAR_LAYOUT));
}
