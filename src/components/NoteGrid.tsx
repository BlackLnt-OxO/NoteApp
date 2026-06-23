import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useNoteStore } from '../store';
import NoteCard from './NoteCard';
import { fs, fsn } from '../utils';

const PADDING = 36;
const DRAG_THRESHOLD = 5;

const NoteGrid: React.FC = () => {
  const { notes, activeTag, selectNote, selectedNoteId, settings } = useNoteStore();
  const gfs = settings.fontSize;
  const [containerW, setContainerW] = useState(1200);

  // Cell sizes: proportional to container width (same relative size on any screen)
  const TARGET_COLS = 3;
  const CELL_W = Math.round((containerW - PADDING * 2 - fsn(27, gfs) * (TARGET_COLS - 1)) / TARGET_COLS);
  const CELL_H = Math.round(CELL_W * (fsn(100, gfs) / fsn(130, gfs)));
  const GAP = fsn(27, gfs);

  const [pendingDrag, setPendingDrag] = useState<{
    noteId: string; startX: number; startY: number;
    offsetX: number; offsetY: number; pointerId: number;
  } | null>(null);
  const [dragging, setDragging] = useState<{
    noteId: string; ghostX: number; ghostY: number;
    offsetX: number; offsetY: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  const filteredNotes = useMemo(
    () => (activeTag === 'all' ? notes : notes.filter((n) => n.tag === activeTag)),
    [notes, activeTag]
  );

  const [cols, setCols] = useState(3);
  const [sidePad, setSidePad] = useState(PADDING);

  React.useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cw = entry.contentRect.width;
        const w = cw - PADDING * 2;
        setContainerW(cw);
        setCols(Math.max(1, Math.floor((w + GAP) / (CELL_W + GAP))));
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [CELL_W, GAP]);

  // Flow layout that respects each note's actual size
  const notePositions = useMemo(() => {
    const positions: { x: number; y: number }[] = [];
    let rowY = PADDING;
    let rowH = 0;
    let colX = sidePad;
    const maxRight = (containerRef.current?.clientWidth || 900) - sidePad;

    for (let i = 0; i < filteredNotes.length; i++) {
      const note = filteredNotes[i];
      const nw = (note.customSize ? note.width : CELL_W) - fsn(12, gfs);
      const nh = (note.customSize ? note.height : CELL_H) - fsn(12, gfs);

      // Wrap to next row if doesn't fit
      if (colX + nw > maxRight && i > 0) {
        rowY += rowH + GAP;
        colX = sidePad;
        rowH = 0;
      }

      positions.push({ x: colX, y: rowY });
      colX += nw + GAP;
      rowH = Math.max(rowH, nh);
    }

    return positions;
  }, [filteredNotes, sidePad, CELL_W, CELL_H, GAP, gfs]);

  const indexToPos = useCallback((idx: number) => {
    return notePositions[idx] || { x: sidePad, y: PADDING };
  }, [notePositions, sidePad]);

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

  const handleCardDragStart = useCallback((e: any, noteId: string) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const card = (e.currentTarget as HTMLElement).closest('.note-card-wrapper') as HTMLElement;
    const rect = card?.getBoundingClientRect();
    const offsetX = rect ? e.clientX - rect.left : CELL_W / 2;
    const offsetY = rect ? e.clientY - rect.top : 30;
    if (containerRef.current) containerRef.current.setPointerCapture(e.nativeEvent?.pointerId || 1);
    setPendingDrag({ noteId, startX: e.clientX, startY: e.clientY, offsetX, offsetY, pointerId: e.nativeEvent?.pointerId || 1 });
  }, [CELL_W]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (pendingDrag && !dragging) {
      const dx = e.clientX - pendingDrag.startX;
      const dy = e.clientY - pendingDrag.startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        selectNote(null);
        setDragging({ noteId: pendingDrag.noteId, ghostX: e.clientX - pendingDrag.offsetX, ghostY: e.clientY - pendingDrag.offsetY, offsetX: pendingDrag.offsetX, offsetY: pendingDrag.offsetY });
      }
      return;
    }
    if (!dragging) return;
    setDragging((prev) => prev ? { ...prev, ghostX: e.clientX - prev.offsetX, ghostY: e.clientY - prev.offsetY } : null);
  }, [pendingDrag, dragging, selectNote]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent) => {
    if (containerRef.current && containerRef.current.hasPointerCapture(e.pointerId)) containerRef.current.releasePointerCapture(e.pointerId);
    if (pendingDrag && !dragging) { setPendingDrag(null); return; }
    if (!dragging) return;
    const { noteId } = dragging;

    if (containerRef.current) {
      const crect = containerRef.current.getBoundingClientRect();
      const st = containerRef.current.scrollTop;
      const sl = containerRef.current.scrollLeft;
      const absX = e.clientX - crect.left + sl;
      const absY = e.clientY - crect.top + st;
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
    setDragging(null); setPendingDrag(null);
  }, [pendingDrag, dragging, cols, sidePad, CELL_W, CELL_H, GAP, filteredNotes, notes, selectNote]);

  return (
    <div ref={containerRef} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
      onClick={handleContainerClick} onPointerLeave={() => { }}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', zIndex: 1, touchAction: 'none' }}>
      <div style={{ position: 'relative', minHeight: totalHeight }} data-grid-bg="true">
        {filteredNotes.map((note, idx) => {
          const pos = indexToPos(idx);
          const isBeingDragged = dragging?.noteId === note.id;
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
              <NoteCard note={note} isDragGhost={false} isExpanded={isExpanded} onDragStart={handleCardDragStart} />
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
      {dragging && (() => {
          const ghostNote = filteredNotes.find((n) => n.id === dragging.noteId);
          const gw = ghostNote ? ((ghostNote.customSize ? (ghostNote.width || CELL_W) : CELL_W) - fsn(12, gfs)) * 0.92 : (CELL_W - fsn(12, gfs)) * 0.92;
          const gh = ghostNote ? ((ghostNote.customSize ? (ghostNote.height || CELL_H) : CELL_H) - fsn(12, gfs)) * 0.92 : (CELL_H - fsn(12, gfs)) * 0.92;
          return (
        <div style={{ position: 'fixed', left: dragging.ghostX, top: dragging.ghostY, width: gw, height: gh, zIndex: 9999, pointerEvents: 'auto', opacity: 0.88, filter: 'drop-shadow(0 12px 32px rgba(0,0,0,0.5))' }}>
          {(() => { const note = filteredNotes.find((n) => n.id === dragging.noteId); return note ? <NoteCard note={note} isDragGhost /> : null; })()}
        </div>
      )})()}
    </div>
  );
};

export default NoteGrid;
