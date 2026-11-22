import React, { useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { useNoteStore } from '../store';
import NoteCard from './NoteCard';
import { useGlassEntrance } from './useGlassEntrance';
import { fs, fsn } from '../utils';

const PADDING = 36;
const DRAG_THRESHOLD = 5;

interface NoteDrag {
  noteId: string;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  scale: number;
  x: number;
  y: number;
  active: boolean;
}

const NoteGrid: React.FC = () => {
  const { notes, activeTag, selectNote, selectedNoteId, settings } = useNoteStore();
  const gfs = settings.fontSize;
  const [containerW, setContainerW] = useState(0);

  // Cell sizes: proportional to container width (same relative size on any screen)
  const TARGET_COLS = 3;
  const CELL_W = Math.round((containerW - PADDING * 2 - fsn(27, gfs) * (TARGET_COLS - 1)) / TARGET_COLS);
  const CELL_H = Math.round(CELL_W * (fsn(100, gfs) / fsn(130, gfs)));
  const GAP = fsn(27, gfs);

  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const dragRef = useRef<NoteDrag | null>(null);
  const dragFrame = useRef<number>();
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  const filteredNotes = useMemo(
    () => (activeTag === 'all' ? notes : notes.filter((n) => n.tag === activeTag)),
    [notes, activeTag]
  );

  const draggingNote = draggingNoteId ? filteredNotes.find((note) => note.id === draggingNoteId) : undefined;
  const glassGridRef = useGlassEntrance(containerW > 0 && filteredNotes.length > 0);

  // Measure the real width synchronously before first paint, so cards render at
  // their final positions immediately — otherwise each mount re-plays the
  // left/top transition from a stale default width ("fly in" from a corner).
  useLayoutEffect(() => {
    if (containerRef.current) setContainerW(containerRef.current.clientWidth);
  }, []);

  React.useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setContainerW(entry.contentRect.width));
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Flow layout that respects each note's actual size
  const notePositions = useMemo(() => {
    const positions: { x: number; y: number }[] = [];
    let rowY = PADDING;
    let rowH = 0;
    let colX = PADDING;
    const maxRight = (containerRef.current?.clientWidth || 900) - PADDING;

    for (let i = 0; i < filteredNotes.length; i++) {
      const note = filteredNotes[i];
      const nw = (note.customSize ? note.width : CELL_W) - fsn(12, gfs);
      const nh = (note.customSize ? note.height : CELL_H) - fsn(12, gfs);

      // Wrap to next row if doesn't fit
      if (colX + nw > maxRight && i > 0) {
        rowY += rowH + GAP;
        colX = PADDING;
        rowH = 0;
      }

      positions.push({ x: colX, y: rowY });
      colX += nw + GAP;
      rowH = Math.max(rowH, nh);
    }

    return positions;
  }, [filteredNotes, CELL_W, CELL_H, GAP, gfs]);

  const indexToPos = useCallback((idx: number) => {
    return notePositions[idx] || { x: PADDING, y: PADDING };
  }, [notePositions]);

  // Total rows height
  const totalHeight = useMemo(() => {
    if (notePositions.length === 0) return PADDING * 2;
    const lastY = notePositions[notePositions.length - 1].y;
    const lastNote = filteredNotes[filteredNotes.length - 1];
    const lastH = lastNote ? (lastNote.height || CELL_H) - fsn(12, gfs) : CELL_H;
    return lastY + lastH + PADDING;
  }, [notePositions, filteredNotes, CELL_H, gfs]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if ((window as any).__imgDragJustEnded) return;
    const target = e.target as HTMLElement;
    if (target.dataset?.gridBg === 'true' || target === containerRef.current) selectNote(null);
  }, [selectNote]);

  const paintDrag = useCallback(() => {
    const drag = dragRef.current;
    const ghost = ghostRef.current;
    if (!drag?.active || !ghost) return;
    const x = (drag.x - drag.originX) / drag.scale;
    const y = (drag.y - drag.originY) / drag.scale;
    ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  useLayoutEffect(() => {
    if (draggingNoteId) paintDrag();
  }, [draggingNoteId, paintDrag]);

  useLayoutEffect(() => () => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
  }, []);

  const handleCardDragStart = useCallback((e: React.PointerEvent, noteId: string) => {
    const grid = containerRef.current;
    const card = e.currentTarget.closest('.note-card-wrapper');
    if (e.button !== 0 || dragRef.current || !grid || !card) return;
    e.preventDefault(); e.stopPropagation();
    const rect = card.getBoundingClientRect();
    const viewport = grid.getBoundingClientRect();
    grid.setPointerCapture(e.pointerId);
    dragRef.current = {
      noteId, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      originX: viewport.left + e.clientX - rect.left,
      originY: viewport.top + e.clientY - rect.top,
      scale: useNoteStore.getState().uiScale,
      x: e.clientX, y: e.clientY, active: false,
    };
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.max(Math.abs(drag.x - drag.startX), Math.abs(drag.y - drag.startY)) <= DRAG_THRESHOLD) return;
      drag.active = true;
      selectNote(null);
      setDraggingNoteId(drag.noteId);
      return;
    }
    if (dragFrame.current !== undefined) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = undefined;
      paintDrag();
    });
  }, [paintDrag, selectNote]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    setDraggingNoteId(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    endDrag(e);
    const grid = containerRef.current;
    if (drag.active && grid) {
      const { noteId } = drag;
      const rect = grid.getBoundingClientRect();
      const absX = (e.clientX - rect.left) / drag.scale + grid.scrollLeft;
      const absY = (e.clientY - rect.top) / drag.scale + grid.scrollTop;
      // Find nearest note by actual position
      let targetIdx = filteredNotes.length;
      let bestDist = Infinity;
      for (let i = 0; i < notePositions.length; i++) {
        const p = notePositions[i];
        const ni = filteredNotes[i];
        const nw = ni.customSize ? (ni.width || CELL_W) : CELL_W;
        const nh = ni.customSize ? (ni.height || CELL_H) : CELL_H;
        const dist = Math.hypot(absX - (p.x + nw / 2), absY - (p.y + nh / 2));
        if (dist < bestDist && filteredNotes[i].id !== noteId) {
          bestDist = dist;
          targetIdx = i;
        }
      }
      const srcIdx = filteredNotes.findIndex((n) => n.id === noteId);
      if (srcIdx !== -1 && targetIdx !== srcIdx && targetIdx < filteredNotes.length) {
        const srcFullIdx = notes.findIndex((n) => n.id === noteId);
        const targetNote = filteredNotes[targetIdx];
        const targetFullIdx = notes.findIndex((n) => n.id === targetNote.id);
        if (srcFullIdx !== -1 && targetFullIdx !== -1 && srcFullIdx !== targetFullIdx) {
          useNoteStore.getState().reorderNotes(srcFullIdx, targetFullIdx);
        }
      }
    }
  }, [endDrag, filteredNotes, notePositions, notes, CELL_W, CELL_H]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={containerRef} data-glass-scroll-container onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
        onPointerCancel={endDrag} onLostPointerCapture={endDrag} onClick={handleContainerClick}
        style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', zIndex: 1, touchAction: 'none' }}>
        <div ref={glassGridRef} style={{ position: 'relative', minHeight: totalHeight }} data-grid-bg="true">
          {containerW > 0 && filteredNotes.map((note, idx) => {
            const pos = indexToPos(idx);
            const isBeingDragged = draggingNoteId === note.id;
            const isSelected = selectedNoteId === note.id;
            const isExpanded = isSelected;
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
            const nw = contentW;
            const nh = contentH;
            const w = isExpanded ? nw + expandW : nw - shrink;
            const h = isExpanded ? nh : nh - shrink;
            const ox = isExpanded ? -expandW / 2 : 0;
            const oy = isExpanded ? -10 : 0;

            return (
              <div key={note.id} className="note-card-wrapper" style={{
                position: 'absolute', left: pos.x + ox, top: pos.y + oy, width: w, height: h,
                transition: 'left 0.25s ease, top 0.25s ease',
                opacity: isBeingDragged ? 0.25 : 1,
                zIndex: isExpanded ? 10 : isBeingDragged ? 0 : 2,
              }}>
                <NoteCard note={note} isDragPlaceholder={isBeingDragged} isExpanded={isExpanded} onDragStart={handleCardDragStart} />
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
      {draggingNote && (
        <div ref={ghostRef} style={{
          position: 'absolute', left: 0, top: 0, zIndex: 9999, pointerEvents: 'none', willChange: 'transform',
          width: ((draggingNote.customSize ? draggingNote.width || CELL_W : CELL_W) - fsn(12, gfs)) * 0.92,
          height: ((draggingNote.customSize ? draggingNote.height || CELL_H : CELL_H) - fsn(12, gfs)) * 0.92,
        }}>
          <NoteCard note={draggingNote} isDragGhost />
        </div>
      )}
    </div>
  );
};

export default NoteGrid;
