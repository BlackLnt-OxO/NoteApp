import React, { useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { useNoteStore } from '../store';
import NoteCard from './NoteCard';
import { useGlassEntrance } from './useGlassEntrance';
import { useCardGridMotion } from './useCardGridMotion';
import { useCardDrag } from './useCardDrag';
import { fs, fsn } from '../utils';

const PADDING = 36;

const NoteGrid: React.FC = () => {
  const notes = useNoteStore(s => s.notes);
  const activeTag = useNoteStore(s => s.activeTag);
  const selectNote = useNoteStore(s => s.selectNote);
  const selectedNoteId = useNoteStore(s => s.selectedNoteId);
  const gfs = useNoteStore(s => s.settings.fontSize);
  const [containerW, setContainerW] = useState(0);

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

  const glassGridRef = useGlassEntrance(containerW > 0 && filteredNotes.length > 0);

  // Resolve the layout before preparing the first visible cards' filters.
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
    const positions: { x: number; y: number; width: number; height: number }[] = [];
    let rowY = PADDING;
    let rowH = 0;
    let colX = PADDING;
    const maxRight = containerW - PADDING;

    for (let i = 0; i < filteredNotes.length; i++) {
      const note = filteredNotes[i];
      const nw = note.customSize ? note.width || CELL_W : CELL_W - fsn(12, gfs);
      const nh = note.customSize ? note.height || CELL_H : CELL_H - fsn(12, gfs);

      // Wrap to next row if doesn't fit
      if (colX + nw > maxRight && i > 0) {
        rowY += rowH + GAP;
        colX = PADDING;
        rowH = 0;
      }

      positions.push({ x: colX, y: rowY, width: nw, height: nh });
      colX += nw + GAP;
      rowH = Math.max(rowH, nh);
    }

    return positions;
  }, [filteredNotes, containerW, CELL_W, CELL_H, GAP, gfs]);

  const cardPositions = useMemo(() => new Map(containerW > 0 ? filteredNotes.map((note, index) => {
    const pos = notePositions[index];
    return [note.id, selectedNoteId === note.id ? { x: pos.x - fsn(20, gfs) / 2, y: pos.y - 10 } : pos];
  }) : []), [containerW, filteredNotes, notePositions, selectedNoteId, gfs]);

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

  const clearSelection = useCallback(() => selectNote(null), [selectNote]);
  const { preview, start, setGhost, landing } = useCardDrag(containerRef, activeTag, reorder, clearSelection);
  const draggingNote = preview && filteredNotes.find(note => note.id === preview.id);
  useCardGridMotion(containerRef, glassGridRef, activeTag, cardPositions, preview?.id ?? null, landing);

  // Total rows height
  const totalHeight = useMemo(() => {
    return notePositions.reduce((bottom, point) => Math.max(bottom, point.y + point.height), PADDING) + PADDING;
  }, [notePositions]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if ((window as any).__imgDragJustEnded) return;
    const target = e.target as HTMLElement;
    if (target.dataset?.gridBg === 'true' || target === containerRef.current) selectNote(null);
  }, [selectNote]);

  const handleCardDragStart = useCallback((e: React.PointerEvent, noteId: string) => {
    const card = e.currentTarget.closest<HTMLElement>('.note-card-wrapper');
    if (e.button !== 0 || !card) return;
    e.preventDefault(); e.stopPropagation();
    start(e, noteId, card);
  }, [start]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={containerRef} data-glass-scroll-container data-grid-dragging={preview ? '' : undefined} onClick={handleContainerClick}
        style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', scrollbarGutter: 'stable', zIndex: 1, touchAction: 'none' }}>
        <div ref={glassGridRef} style={{ position: 'relative', minHeight: totalHeight }} data-grid-bg="true">
          {containerW > 0 && filteredNotes.map(note => {
            const pos = cardPositions.get(note.id)!;
            const isBeingDragged = preview?.id === note.id;
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
            return (
              <div key={note.id} data-note-id={note.id} data-grid-card-id={note.id} className="note-card-wrapper" style={{
                position: 'absolute', left: pos.x, top: pos.y, width: w, height: h,
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
