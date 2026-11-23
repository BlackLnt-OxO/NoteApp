import React, { useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { useNoteStore } from '../store';
import type { Note } from '../types';
import NoteCard from './NoteCard';
import { useGlassEntrance } from './useGlassEntrance';
import { GRID_MOVE_DURATION, useCardGridMotion } from './useCardGridMotion';
import { useCardDrag } from './useCardDrag';
import { GLASS_LAYOUT_RESIZE, useSharedGlass } from './useSharedGlass';
import { fs, fsn } from '../utils';
import { finishNoteMeasure, startNoteMeasure } from './noteMotionMetrics';

const PADDING = 36;
type ResizeSize = Pick<Note, 'width' | 'height'>;

const NoteGrid: React.FC<{ expandingSidebarOnEntry?: boolean }> = ({ expandingSidebarOnEntry }) => {
  const notes = useNoteStore(s => s.notes);
  const activeTag = useNoteStore(s => s.activeTag);
  const selectNote = useNoteStore(s => s.selectNote);
  const selectedNoteId = useNoteStore(s => s.selectedNoteId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const startEditing = useCallback((id: string) => setEditingId(id), []);
  const endEditing = useCallback((id: string) => setEditingId(current => current === id ? null : current), []);
  const gfs = useNoteStore(s => s.settings.fontSize);
  const [{ width: containerW, height: viewportH, top: viewportTop }, setViewport] = useState({ width: 0, height: 0, top: 0 });
  const holdExpandedLayout = useRef(expandingSidebarOnEntry);
  const [resizePreview, setResizePreview] = useState<(ResizeSize & { id: string }) | null>(null);
  const handleResizePreview = useCallback((id: string, size: ResizeSize | null) => {
    if (!size) {
      setResizePreview(current => current?.id === id ? null : current);
      return;
    }
    // Paint the whole layout in the same animation frame as the pointer sample.
    flushSync(() => setResizePreview(current => current?.id === id && current.width === size.width && current.height === size.height
      ? current : { id, ...size }));
  }, []);

  // Cell sizes: proportional to container width (same relative size on any screen)
  const TARGET_COLS = 3;
  const CELL_W = Math.round((containerW - PADDING * 2 - fsn(27, gfs) * (TARGET_COLS - 1)) / TARGET_COLS);
  const CELL_H = Math.round(CELL_W * (fsn(100, gfs) / fsn(130, gfs)));
  const GAP = fsn(27, gfs);

  const containerRef = useRef<HTMLDivElement>(null);

  const filteredNotes = useMemo(
    () => (activeTag === 'all' ? notes : notes.filter((n) => n.tag === activeTag)),
    [notes, activeTag]
  );

  const glassGridRef = useGlassEntrance(containerW > 0 && filteredNotes.length > 0, false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const workspace = container.closest<HTMLElement>('[data-ink-workspace]');
    const track = workspace?.querySelector<HTMLElement>('.workspace-sidebar-track');
    const rail = track?.firstElementChild as HTMLElement | undefined;
    let frame: number | undefined;
    const measure = () => {
      const actualWidth = container.clientWidth;
      const expandedWidth = workspace && rail
        ? workspace.clientWidth - rail.offsetWidth - (container.offsetWidth - actualWidth) : actualWidth;
      if (workspace?.dataset.sidebarCollapsed === 'true' || !track || !rail
        || Math.abs(actualWidth - expandedWidth) <= 1 && track.clientWidth >= rail.offsetWidth) {
        holdExpandedLayout.current = false;
      }
      const width = holdExpandedLayout.current ? Math.max(0, expandedWidth) : actualWidth;
      const height = holdExpandedLayout.current && workspace ? workspace.clientHeight : container.clientHeight;
      const step = Math.max(1, Math.floor(height / 4));
      const top = Math.floor(container.scrollTop / step) * step;
      setViewport(current => current.width === width && current.height === height && current.top === top
        ? current : { width, height, top });
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; measure(); });
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    container.addEventListener('scroll', schedule, { passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener('scroll', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  // Flow layout that respects each note's actual size
  const notePositions = useMemo(() => {
    const measure = startNoteMeasure();
    const positions: { x: number; y: number; width: number; height: number; row: number }[] = [];
    let rowY = PADDING;
    let rowH = 0;
    let row = 0;
    let colX = PADDING;
    const maxRight = containerW - PADDING;

    for (let i = 0; i < filteredNotes.length; i++) {
      const note = filteredNotes[i];
      const draft = resizePreview?.id === note.id ? resizePreview : null;
      const nw = draft?.width ?? (note.customSize ? note.width || CELL_W : CELL_W - fsn(12, gfs));
      const nh = draft?.height ?? (note.customSize ? note.height || CELL_H : CELL_H - fsn(12, gfs));

      // Wrap to next row if doesn't fit
      if (colX + nw > maxRight && i > 0) {
        row++;
        rowY += rowH + GAP;
        colX = PADDING;
        rowH = 0;
      }

      positions.push({ x: colX, y: rowY, width: nw, height: nh, row });
      colX += nw + GAP;
      rowH = Math.max(rowH, nh);
    }

    finishNoteMeasure('note-layout', measure);
    return positions;
  }, [filteredNotes, containerW, CELL_W, CELL_H, GAP, gfs, resizePreview]);

  const totalHeight = useMemo(() => notePositions.reduce((bottom, point) =>
    Math.max(bottom, point.y + point.height), PADDING) + PADDING, [notePositions]);
  const top = Math.min(viewportTop, Math.max(0, totalHeight - viewportH));
  const cardPositions = useMemo(() => new Map(containerW > 0 ? filteredNotes.map((note, index) => {
    const pos = notePositions[index];
    return [note.id, editingId === note.id ? { ...pos, x: pos.x - fsn(20, gfs) / 2, y: pos.y - 10 } : pos];
  }) : []), [containerW, filteredNotes, notePositions, editingId, gfs]);

  const reorder = useCallback((id: string, x: number, y: number) => {
    let target: string | undefined;
    let distance = Infinity;
    filteredNotes.forEach((note, index) => {
      if (note.id === id) return;
      const point = notePositions[index];
      const next = Math.hypot(x - point.x - point.width / 2, y - point.y - point.height / 2);
      if (next < distance) {
        distance = next;
        target = note.id;
      }
    });
    const from = notes.findIndex(note => note.id === id);
    const to = notes.findIndex(note => note.id === target);
    if (from !== -1 && to !== -1) useNoteStore.getState().reorderNotes(from, to);
  }, [filteredNotes, notePositions, notes]);

  const clearSelection = useCallback(() => { selectNote(null); setEditingId(null); }, [selectNote]);
  const { preview, start, setGhost, landing } = useCardDrag(containerRef, activeTag, reorder, clearSelection);
  const draggingNote = preview && filteredNotes.find(note => note.id === preview.id);
  const committedWindow = useRef<{ tag: string; visible: ReadonlySet<string>; carried: ReadonlySet<string> }>();
  const [settled, setSettled] = useState<{ tag: string }>();
  const previousWindow = committedWindow.current;
  const carried = previousWindow?.tag !== activeTag
    ? new Set(previousWindow && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? [...previousWindow.carried, ...previousWindow.visible] : [])
    : previousWindow.carried;
  const visible = new Set<string>();
  const mounted = new Set<string>();
  // Put the first viewport on screen before mounting the rest of the scroll buffer.
  const overscan = settled?.tag === activeTag || viewportTop > 0 ? viewportH : 0;
  if (containerW > 0 && viewportH > 0) for (const [id, point] of cardPositions) {
    const bottom = point.y + point.height;
    if (bottom > top && point.y < top + viewportH * 1.25) visible.add(id);
    if ((bottom > top - overscan && point.y < top + viewportH * 1.25 + overscan)
      || carried.has(id) || id === selectedNoteId || id === editingId || id === preview?.id || id === resizePreview?.id) mounted.add(id);
  }
  useLayoutEffect(() => { committedWindow.current = { tag: activeTag, visible, carried }; });
  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSettled({ tag: activeTag });
      return;
    }
    const timer = window.setTimeout(() => {
      if (committedWindow.current?.tag !== activeTag) return;
      committedWindow.current.carried = new Set();
      setSettled({ tag: activeTag });
    }, GRID_MOVE_DURATION + 34);
    return () => clearTimeout(timer);
  }, [activeTag]);
  useCardGridMotion(containerRef, glassGridRef, activeTag, cardPositions, preview?.id ?? null, landing, mounted);
  const sharedGlass = useSharedGlass(containerRef, glassGridRef, true);
  const wasResizing = useRef(false);
  useLayoutEffect(() => {
    if (resizePreview || wasResizing.current) glassGridRef.current?.dispatchEvent(new Event(GLASS_LAYOUT_RESIZE));
    wasResizing.current = !!resizePreview;
  }, [resizePreview, glassGridRef]);

  const lastEditLayout = useRef<{ id: string | null; boxes: Map<string, Record<string, string>> }>();
  const editAnimations = useRef(new Map<string, Animation>());
  useLayoutEffect(() => {
    const grid = glassGridRef.current;
    if (!grid) return;
    const boxes = new Map<string, Record<string, string>>();
    const previous = lastEditLayout.current;
    const changed = previous?.id !== editingId;
    for (const card of grid.querySelectorAll<HTMLElement>('.note-card-wrapper')) {
      const id = card.dataset.noteId!;
      const props = ['left', 'top', 'width', 'height'] as const;
      const to = Object.fromEntries(props.map(key => [key, card.style[key]]));
      boxes.set(id, to);
      const active = editAnimations.current.get(id);
      if (preview?.id === id || resizePreview?.id === id) {
        active?.cancel();
        editAnimations.current.delete(id);
        delete card.dataset.noteEditMoving;
        continue;
      }
      if (!changed || (id !== editingId && id !== previous?.id) || !previous?.boxes.has(id)) continue;
      const computed = active ? getComputedStyle(card) : null;
      const from = computed ? Object.fromEntries(props.map(key => [key, computed[key]])) : previous.boxes.get(id)!;
      active?.cancel();
      editAnimations.current.delete(id);
      delete card.dataset.noteEditMoving;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !card.animate) continue;
      const animation = card.animate([from, to], { duration: 200, easing: 'cubic-bezier(.2,.7,.25,1)' });
      card.dataset.noteEditMoving = '';
      editAnimations.current.set(id, animation);
      animation.onfinish = () => {
        if (editAnimations.current.get(id) === animation) {
          editAnimations.current.delete(id);
          delete card.dataset.noteEditMoving;
        }
        grid.dispatchEvent(new Event(GLASS_LAYOUT_RESIZE));
      };
    }
    lastEditLayout.current = { id: editingId, boxes };
  });
  useLayoutEffect(() => () => {
    for (const animation of editAnimations.current.values()) animation.cancel();
    editAnimations.current.clear();
  }, []);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if ((window as any).__imgDragJustEnded) return;
    const target = e.target as HTMLElement;
    if (target.dataset?.gridBg === 'true' || target === containerRef.current) clearSelection();
  }, [clearSelection]);

  const handleCardDragStart = useCallback((e: React.PointerEvent, noteId: string) => {
    const card = e.currentTarget.closest<HTMLElement>('.note-card-wrapper');
    if (e.button !== 0 || !card) return;
    e.preventDefault(); e.stopPropagation();
    start(e, noteId, card);
  }, [start]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <canvas ref={sharedGlass} className="shared-glass-layer" hidden aria-hidden="true" />
      <div ref={containerRef} data-glass-scroll-container data-grid-dragging={preview ? '' : undefined} onClick={handleContainerClick}
        style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', scrollbarGutter: 'stable', zIndex: 1, touchAction: 'none' }}>
        <div ref={glassGridRef} style={{ position: 'relative', minHeight: totalHeight }} data-note-grid data-grid-bg="true" data-grid-resizing={resizePreview ? '' : undefined}>
          {filteredNotes.filter(note => mounted.has(note.id)).map(note => {
            const pos = cardPositions.get(note.id)!;
            const isBeingDragged = preview?.id === note.id;
            const isSelected = selectedNoteId === note.id;
            const isExpanded = editingId === note.id;
            let imgMaxR = 0, imgMaxB = 0;
            if (isExpanded) {
              for (const img of note.images) {
                const ih = img._previewH || 100;
                const ratio = (img.width && img.height) ? img.width / img.height : 1.5;
                const iw = ih * ratio;
                const ix = img._imgX || 0;
                const iy = img._imgY || 0;
                imgMaxR = Math.max(imgMaxR, ix + iw);
                imgMaxB = Math.max(imgMaxB, iy + ih);
              }
            }
            const pad = fsn(16, gfs);
            const expandW = fsn(20, gfs);
            const baseW = note.customSize ? (note.width || CELL_W) : CELL_W;
            const baseH = note.customSize ? (note.height || CELL_H) : CELL_H;
            // Auto-size: expand to fit images. CustomSize: use exact stored size.
            const autoW = Math.max(baseW, imgMaxR + pad);
            const autoH = note.customSize
              ? Math.max(baseH, imgMaxB + pad + fsn(36, gfs))
              : Math.max(baseH, CELL_H, imgMaxB + pad + fsn(36, gfs));
            // Edit mode: always include image positions. Preview: use stored size only.
            const contentW = isExpanded ? autoW : (note.customSize ? baseW : CELL_W);
            const contentH = isExpanded ? autoH : (note.customSize ? baseH : CELL_H);
            const shrink = note.customSize ? 0 : fsn(12, gfs);
            const draft = resizePreview?.id === note.id ? resizePreview : null;
            const w = draft?.width ?? (isExpanded ? contentW + expandW : contentW - shrink);
            const h = draft?.height ?? (isExpanded ? contentH : contentH - shrink);
            return (
              <div key={note.id} data-note-id={note.id} data-grid-card-id={note.id} className="note-card-wrapper" style={{
                position: 'absolute', left: pos.x, top: pos.y, width: w, height: h,
                opacity: isBeingDragged ? 0.25 : 1,
                zIndex: isExpanded ? 10 : isBeingDragged ? 0 : isSelected ? 3 : 2,
              }}>
                <NoteCard note={note} isDragPlaceholder={isBeingDragged} isExpanded={isExpanded}
                  onDragStart={handleCardDragStart} onResizePreview={handleResizePreview}
                  onEditStart={startEditing} onEditEnd={endEditing} />
              </div>
            );
          })}
          {filteredNotes.length === 0 && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', color: 'var(--text-muted)', pointerEvents: 'none', zIndex: 1, width: '100%' }}>
              <div style={{ fontSize: fs(30, gfs), marginBottom: fs(8, gfs), opacity: 0.35 }}>+</div>
              <div style={{ fontSize: fs(14, gfs) }}>暂无便笺</div>
              <div style={{ fontSize: fs(12, gfs) }}>点击左侧「新建便笺」开始记录</div>
            </div>
          )}
        </div>
      </div>
      {draggingNote && preview && (
        <div ref={setGhost} aria-hidden="true" style={{
          position: 'absolute', left: 0, top: 0, zIndex: 9999, pointerEvents: 'none', willChange: 'transform',
          width: preview.width,
          height: preview.height,
        }}>
          <NoteCard note={draggingNote} isDragGhost />
        </div>
      )}
    </div>
  );
};

export default React.memo(NoteGrid);
