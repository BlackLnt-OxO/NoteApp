import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Note } from '../types';
import { useNoteStore } from '../store';
import { fs, fsn } from '../utils';

const QUICK_COLORS = ['#2d2d44', '#6b5ce7', '#e8a0b4', '#95a5a6'];
const ALL_COLORS = ['#2d2d44', '#6b5ce7', '#e74c3c', '#e67e22', '#2ecc71', '#3498db', '#1abc9c', '#e91e63', '#9b59b6', '#95a5a6', '#f39c12', '#34495e'];

interface NoteCardProps {
  note: Note;
  isDragGhost?: boolean;
  isExpanded?: boolean;
  onDragStart?: (e: React.MouseEvent, noteId: string) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
}

const NoteCard: React.FC<NoteCardProps> = ({ note, isDragGhost, isExpanded, onDragStart, onEditStart, onEditEnd }) => {
  const { updateNote, deleteNote, selectNote, selectedNoteId, setNoteFloating } = useNoteStore();
  const [content, setContent] = useState(note.content);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [isEditing, setIsEditing] = useState(false);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [lightboxScale, setLightboxScale] = useState(1);
  const [lbPan, setLbPan] = useState({ x: 0, y: 0 });
  const lbPanRef = useRef({ x: 0, y: 0 });
  const lbScaleRef = useRef(1);
  const lbDragging = useRef(false);
  const lbOnImg = useRef(false);
  const lbStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const [cardW, setCardW] = useState(note.width || 260);
  const [cardH, setCardH] = useState(note.height || 200);
  const contentRef = useRef<HTMLDivElement>(null);
  const undoStack = useRef<string[]>([]);
  const composing = useRef(false);
  const imgDragMoved = useRef(false);
  const imgDragJustEnded = useRef(false);
  const rightClickStart = useRef({ x: 0, y: 0 });

  const isSelected = selectedNoteId === note.id;
  const showExpanded = isExpanded || isEditing;
  const tags = useNoteStore((s) => s.tags);
  const tag = tags.find((t) => t.id === note.tag);
  const gfs = useNoteStore((s) => s.settings.fontSize);
  const settings = useNoteStore((s) => s.settings);

  useEffect(() => { setContent(note.content); }, [note.content]);
  useEffect(() => { setCardW(note.width || 260); setCardH(note.height || 200); }, [note.width, note.height]);
  useEffect(() => {
    if (showExpanded && contentRef.current) {
      contentRef.current.focus();
      if (!undoStack.current.length || undoStack.current[undoStack.current.length - 1] !== note.content) {
        undoStack.current.push(note.content);
        if (undoStack.current.length > 50) undoStack.current.shift();
      }
    }
  }, [showExpanded]);

  const update = useCallback((id: string, data: Partial<Note>) => {
    updateNote(id, data);
  }, [updateNote]);

  const remove = useCallback((id: string) => {
    deleteNote(id);
  }, [deleteNote]);

  // Ctrl+Z undo
  // Save undo snapshot
  const saveUndo = useCallback((text: string) => {
    if (undoStack.current.length === 0 || undoStack.current[undoStack.current.length - 1] !== text) {
      undoStack.current.push(text);
      if (undoStack.current.length > 50) undoStack.current.shift();
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      if (undoStack.current.length > 1) {
        undoStack.current.pop();
        const prev = undoStack.current[undoStack.current.length - 1];
        setContent(prev);
        if (contentRef.current) {
          contentRef.current.textContent = prev;
          const el = contentRef.current;
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }
    }
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
  }, []);

  const handleCompositionStart = () => { composing.current = true; };
  const handleCompositionEnd = (e: React.CompositionEvent<HTMLDivElement>) => {
    composing.current = false;
    const text = e.currentTarget.innerText || '';
    setContent(text);
    saveUndo(text);
  };

  const handleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    if (composing.current) return;
    const text = e.currentTarget.innerText || '';
    setContent(text);
    // Debounced undo snapshot
    saveUndo(text);
  }, [saveUndo]);

  // Header drag - only from non-interactive areas, no selection on drag start
  const handleHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.color-dot') || target.closest('.resize-handle')) return;
    e.stopPropagation();
    if (onDragStart) onDragStart(e as any, note.id);
  }, [note.id, onDragStart]);

  // Content click
  const handleContentPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectNote(note.id);
    setIsEditing(true);
    if (onEditStart) onEditStart();
  }, [note.id, onEditStart, selectNote]);

  const handleContentBlur = () => {
    setIsEditing(false);
    if (content !== note.content) { update(note.id, { content }); saveUndo(content); }
    if (onEditEnd) onEditEnd();
  };

  // Image drag between notes (pointer-based, no browser DnD)
  const handleImagePointerDown = useCallback((imgIdx: number, img: any) => (ev: React.PointerEvent) => {
    ev.preventDefault(); ev.stopPropagation();
    selectNote(note.id);
    const imgH = img._previewH || 100;
    const ghostH = imgH * 0.92;
    const ghost = document.createElement('img');
    ghost.src = img.dataUrl;
    ghost.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;opacity:0.8;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
    ghost.style.height = ghostH + 'px'; ghost.style.width = 'auto';
    const imgEl = ev.currentTarget as HTMLElement;
    const imgRect = imgEl.getBoundingClientRect();
    const offX = ev.clientX - imgRect.left;
    const offY = ev.clientY - imgRect.top;
    const scaleRatio = ghostH / (img._previewH || 100);
    const ghostOffX = offX * scaleRatio;
    const ghostOffY = offY * scaleRatio;
    ghost.style.left = (ev.clientX - ghostOffX) + 'px'; ghost.style.top = (ev.clientY - ghostOffY) + 'px';
    imgDragMoved.current = false;
    document.body.appendChild(ghost);

    const onMove = (e: PointerEvent) => {
      imgDragMoved.current = true;
      ghost.style.left = (e.clientX - ghostOffX) + 'px'; ghost.style.top = (e.clientY - ghostOffY) + 'px';
    };
    const onUp = (e: PointerEvent) => {
      ghost.remove();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!imgDragMoved.current) return;
      (window as any).__imgDragJustEnded = true;
      setTimeout(() => { (window as any).__imgDragJustEnded = false; }, 200);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el?.closest('.note-card-wrapper');
      if (!card) { const state = useNoteStore.getState(); const myIdx = state.notes.findIndex(n => n.id === note.id); const myCard = document.querySelectorAll('.note-card-wrapper')[myIdx]; if (myCard) { const myRect = myCard.getBoundingClientRect(); const newX = e.clientX - myRect.left - offX; const newY = e.clientY - myRect.top - offY; const imgs = [...note.images]; imgs[imgIdx] = { ...imgs[imgIdx], _imgX: newX, _imgY: newY }; const ih = img._previewH || 100; const ratio = (img.width && img.height) ? img.width / img.height : 1.5; const iw = ih * ratio; update(note.id, { images: imgs }); } return; }
      const noteEls = document.querySelectorAll('.note-card-wrapper');
      let targetIdx = -1;
      noteEls.forEach((n, i) => { if (n === card) targetIdx = i; });
      if (targetIdx < 0) return;
      const state = useNoteStore.getState();
      const targetNote = state.notes[targetIdx];
      if (!targetNote) return;
      if (targetNote.id === note.id) {
        const cardRect = card.getBoundingClientRect();
        const imgs = [...note.images];
        const newX = e.clientX - cardRect.left - offX; const newY = e.clientY - cardRect.top - offY;
        imgs[imgIdx] = { ...imgs[imgIdx], _imgX: newX, _imgY: newY };
        const ih = img._previewH || 100; const ratio = (img.width && img.height) ? img.width / img.height : 1.5; const iw = ih * ratio;
        update(note.id, { images: imgs });
      } else {
        state.updateNote(targetNote.id, { images: [...targetNote.images, { id: 'img_' + Date.now(), dataUrl: img.dataUrl, fileName: img.fileName || 'image.png', _imgX: e.clientX - card.getBoundingClientRect().left - offX, _imgY: e.clientY - card.getBoundingClientRect().top - offY, _previewH: imgH }] });
        state.updateNote(note.id, { images: note.images.filter((_:any, i:number) => i !== imgIdx) });
        selectNote(targetNote.id);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [note.id, note.images, selectNote]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowMenu(true);
    selectNote(note.id);
  };

  const floatClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePinToScreen = async () => {
    setShowMenu(false);
    if (floatClickTimer.current) {
      // Double-click: always reset floating to default and reopen
      clearTimeout(floatClickTimer.current);
      floatClickTimer.current = null;
      if (window.electronAPI) {
        if (note.isFloating) await window.electronAPI.closeFloatingNote(note.id);
        await window.electronAPI.resetFloatState(note.id);
        setNoteFloating(note.id, false, undefined);
        await new Promise(r => setTimeout(r, 100));
        await window.electronAPI.createFloatingNote({
          ...note, content, tag: tag?.name || note.tag || '通用', fontSize: settings.fontSize, settingsBgOpacity: settings.backgroundOpacity,
          floatCloseKey: settings.floatCloseKey, floatPenetrateKey: settings.floatPenetrateKey,
        });
        setNoteFloating(note.id, true, '');
      }
      return;
    }
    floatClickTimer.current = setTimeout(async () => {
      floatClickTimer.current = null;
      // Single click: normal toggle
      if (note.isFloating) {
        if (window.electronAPI) await window.electronAPI.closeFloatingNote(note.id);
        setNoteFloating(note.id, false, undefined);
      } else {
        if (window.electronAPI) {
          await window.electronAPI.createFloatingNote({
            ...note, content, tag: tag?.name || note.tag || '通用', fontSize: settings.fontSize, settingsBgOpacity: settings.backgroundOpacity,
            floatCloseKey: settings.floatCloseKey, floatPenetrateKey: settings.floatPenetrateKey,
          });
          setNoteFloating(note.id, true, '');
        }
      }
    }, 250);
  };

  const handleDelete = () => { setShowMenu(false); remove(note.id); };

  // Resize
  const resizing = useRef(false);
  const resizeState = useRef({ sx: 0, sy: 0, sw: 0, sh: 0 });

  const handleResizeDown = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    selectNote(null);
    resizing.current = true;
    resizeState.current = { sx: e.clientX, sy: e.clientY, sw: cardW, sh: cardH };

    const onMove = (ev: PointerEvent) => {
      const dw = ev.clientX - resizeState.current.sx;
      const dh = ev.clientY - resizeState.current.sy;
      const w = Math.max(180, resizeState.current.sw + dw);
      const h = Math.max(120, resizeState.current.sh + dh);
      setCardW(w); setCardH(h);
      update(note.id, { width: w, height: h, customSize: true });
    };
    const onUp = () => {
      resizing.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleColorChange = (color: string) => {
    update(note.id, { color });
    // Sync floating window color
    if (note.isFloating && window.electronAPI) {
      window.electronAPI.updateFloatingNote(note.id, { ...note, color, content, settingsBgOpacity: settings.backgroundOpacity });
    }
  };

  const clampedMenuX = Math.min(menuPos.x, window.innerWidth - 180);
  const clampedMenuY = Math.min(menuPos.y, window.innerHeight - 280);

  return (
    <>
      <div onContextMenu={handleContextMenu} style={{
        minWidth: '100%',
        width: showExpanded ? 'auto' : '100%',
        minHeight: '100%',
        height: showExpanded ? 'auto' : '100%',
        borderRadius: '14px',
        background: note.color === 'transparent' ? 'rgba(0,0,0,0.3)' : `${note.color}99`,
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        border: isSelected ? '2px solid rgba(255,255,255,0.55)' : '1px solid rgba(255,255,255,0.18)',
        boxShadow: isDragGhost ? '0 16px 48px rgba(0,0,0,0.5)' : isSelected ? '0 10px 32px rgba(0,0,0,0.4)' : '0 4px 12px rgba(0,0,0,0.2)',
        display: 'flex', flexDirection: 'column', transition: 'box-shadow 0.2s, border 0.2s',
        position: 'relative', userSelect: 'none', overflow: 'hidden',
      }}>
        {/* Header — fixed above scrollable area, always visible */}
        <div onPointerDown={handleHeaderPointerDown} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: `${fs(4, gfs)} ${fs(8, gfs)}`,
          background: 'rgba(0,0,0,0.1)', cursor: 'grab', flexShrink: 0, minHeight: fs(24, gfs),
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: fs(4, gfs) }}>
            <span style={{
              fontSize: fs(10, gfs), color: 'rgba(255,255,255,0.8)',
              background: 'rgba(255,255,255,0.12)', padding: `0 ${fs(6, gfs)}`, borderRadius: '8px', fontWeight: 500,
            }}>{tag?.name || note.tag || '通用'}</span>
            {note.isFloating && <span style={{ width: fs(4, gfs), height: fs(4, gfs), borderRadius: '50%', background: 'rgba(255,255,255,0.7)' }} />}
          </div>
          <div style={{ display: 'flex', gap: fs(1, gfs), alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: fs(2, gfs), marginRight: fs(4, gfs) }}>
              {QUICK_COLORS.map((c) => (
                <div key={c} className="color-dot" onClick={(ev) => { ev.stopPropagation(); handleColorChange(c); }}
                  style={{ width: fs(11, gfs), height: fs(11, gfs), borderRadius: '50%', background: c, cursor: 'pointer',
                    border: note.color === c ? '2px solid white' : '1px solid rgba(255,255,255,0.25)' }} />
              ))}
            </div>
            <button onClick={(ev) => { ev.stopPropagation(); handlePinToScreen(); }}
              style={{ background: 'none', border: 'none', color: note.isFloating ? '#fff' : 'rgba(255,255,255,0.5)',
                cursor: 'pointer', fontSize: fs(11, gfs), padding: `0 ${fs(2, gfs)}`, fontFamily: 'inherit', lineHeight: 1 }}>o</button>
            <button onClick={(ev) => { ev.stopPropagation(); handleDelete(); }}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.45)', cursor: 'pointer',
                fontSize: fs(14, gfs), padding: `0 ${fs(2, gfs)}`, fontFamily: 'inherit', lineHeight: 1 }}
              onMouseEnter={(e2) => { e2.currentTarget.style.color = '#fff'; }}
              onMouseLeave={(e2) => { e2.currentTarget.style.color = 'rgba(255,255,255,0.45)'; }}>x</button>
          </div>
        </div>

        {/* Scrollable area — content + images scroll below the fixed header */}
        <div className="note-scroll-area" style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
          {/* Content */}
          <div ref={contentRef} contentEditable={showExpanded} suppressContentEditableWarning
            onPointerDown={handleContentPointerDown} onBlur={handleContentBlur}
            onInput={handleInput} onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart} onCompositionEnd={handleCompositionEnd}
            style={{
              padding: fs(8, gfs) + ' ' + fs(10, gfs),
              color: 'rgba(255,255,255,0.93)',
              fontSize: (showExpanded ? gfs : gfs - 1) + 'px', lineHeight: 1.5,
              outline: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              minHeight: fs(40, gfs),
              cursor: showExpanded ? 'text' : 'pointer',
              userSelect: showExpanded ? 'text' : 'none',
            }}
          >{note.content || (showExpanded ? '' : '点击编辑...')}</div>

          {/* Images — absolutely positioned inside the scroll area, contribute to overflow */}
          {note.images.map((img, imgIdx) => {
            const imgH = img._previewH || 100;
            const imgX = img._imgX !== undefined ? img._imgX : fsn(10, gfs);
            const imgY = img._imgY !== undefined ? img._imgY : fsn(10, gfs) + imgIdx * (imgH + fsn(8, gfs));
            return (
              <div key={img.id} className="note-image-wrap" style={{
                position: 'absolute', left: imgX, top: imgY, zIndex: 5,
                lineHeight: 0, pointerEvents: 'auto',
              }}>
                <img src={img.dataUrl} alt=""
                  onPointerDown={handleImagePointerDown(imgIdx, img)}
                  onClick={(ev) => { ev.stopPropagation(); if (imgDragMoved.current) { imgDragMoved.current = false; return; } setLightboxImg(img.dataUrl); setLightboxScale(1); setLbPan({x:0,y:0}); lbScaleRef.current=1; lbPanRef.current={x:0,y:0}; }}
                  style={{ height: imgH, width: 'auto', borderRadius: '5px', cursor: 'grab', display: 'block' }} />
                  <button onClick={(ev) => { ev.stopPropagation(); update(note.id, { images: note.images.filter((_, i) => i !== imgIdx) }); }}
                    className="note-img-del" style={{ position: 'absolute', top: '2px', right: '2px', width: '18px', height: '18px',
                      borderRadius: '50%', background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff', fontSize: '10px',
                      cursor: 'pointer', opacity: 0, transition: 'opacity 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>x</button>
                  <div className="note-img-size note-img-size-tl"
                    onPointerDown={(ev: React.PointerEvent) => {
                      ev.preventDefault(); ev.stopPropagation();
                      const wrapper = (ev.target as HTMLElement).closest('.note-image-wrap') as HTMLElement;
                      const startX = ev.clientX; const startY = ev.clientY; const startH = imgH;
                      const startImgX = wrapper ? wrapper.offsetLeft : imgX;
                      const startImgY = wrapper ? wrapper.offsetTop : imgY;
                      const ratio = (img.width && img.height) ? img.width / img.height : 1;
                      const startW = startH * ratio;
                      const onMove = (e: PointerEvent) => {
                        const d = Math.max(startX - e.clientX, startY - e.clientY);
                        const newH = Math.max(30, startH + d);
                        const newW = newH * ratio;
                        const imgs = [...note.images]; imgs[imgIdx] = {
                          ...imgs[imgIdx], _previewH: newH,
                          _imgX: startImgX + startW - newW,
                          _imgY: startImgY + startH - newH,
                        };
                        update(note.id, { images: imgs });
                      };
                      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
                      window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
                    }}
                    style={{
                      position: 'absolute', top: 0, left: 0,
                      opacity: 0, transition: 'opacity 0.15s',
                      width: '14px', height: '14px', cursor: 'nwse-resize',
                      background: 'linear-gradient(135deg, rgba(255,255,255,0.4) 50%, transparent 50%)',
                    }} />
                  <div className="note-img-size"
                    onPointerDown={(ev: React.PointerEvent) => {
                      ev.preventDefault(); ev.stopPropagation();
                      const startX = ev.clientX; const startY = ev.clientY; const startH = imgH;
                      const onMove = (e: PointerEvent) => {
                        const d = Math.max(e.clientX - startX, e.clientY - startY);
                        const newH = Math.max(30, startH + d);
                        const imgs = [...note.images]; imgs[imgIdx] = { ...imgs[imgIdx], _previewH: newH };
                        update(note.id, { images: imgs });
                      };
                      const onUp = () => {
                        window.removeEventListener('pointermove', onMove);
                        window.removeEventListener('pointerup', onUp);
                      };
                      window.addEventListener('pointermove', onMove);
                      window.addEventListener('pointerup', onUp);
                    }}
                    style={{
                      position: 'absolute', bottom: '1px', right: '1px',
                      opacity: 0, transition: 'opacity 0.15s',
                      width: '14px', height: '14px', cursor: 'nwse-resize',
                      background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.4) 50%)',
                    }} />
                </div>
              );
            })}
        </div>

        {/* Add-image button — always at bottom, outside scroll area */}
        {showExpanded && (
          <div style={{ padding: `0 ${fs(8, gfs)} ${fs(3, gfs)}`, flexShrink: 0 }}>
            <button className="glass-btn" onClick={async (ev) => { ev.stopPropagation();
              if (window.electronAPI) {
                const r = await window.electronAPI.pickImage();
                if (r?.dataUrl) update(note.id, { images: [...note.images, { id: 'img_' + Date.now(), dataUrl: r.dataUrl, fileName: r.filePath?.split(/[\\/]/).pop() || 'image.png' }] });
              }
            }} style={{ padding: `${fs(3, gfs)} ${fs(8, gfs)}`, fontSize: fs(10, gfs), width: '100%' }}>+ 图片</button>
          </div>
        )}

        {/* Timestamp — fixed at bottom-right of card */}
        <div style={{
          position: 'absolute', bottom: fs(3, gfs), right: fsn(24, gfs),
          fontSize: fs(8, gfs), color: 'rgba(255,255,255,0.25)', zIndex: 9,
          pointerEvents: 'none',
        }}>
          {new Date(note.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </div>

        {/* Resize handle — always at bottom-right */}
        <div onPointerDown={handleResizeDown} className="resize-handle" style={{
          position: 'absolute', bottom: 0, right: 0,
          width: '20px', height: '20px', cursor: 'nwse-resize', zIndex: 10,
          background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.25) 50%)',
          borderRadius: '0 0 14px 0',
        }} />

      </div>

      {/* Image lightbox with scroll zoom + drag pan */}
      {lightboxImg && createPortal(
        <div className="img-lightbox-overlay" style={{ cursor: lightboxScale > 1 ? 'grab' : 'default', userSelect: 'none' }}
          onClick={(e) => { if (!lbDragging.current && e.target === e.currentTarget && !lbOnImg.current) setLightboxImg(null); lbDragging.current = false; lbOnImg.current = false; }}
          onWheel={(e) => {
            e.stopPropagation(); e.preventDefault();
            const ns = Math.max(0.3, Math.min(10, lbScaleRef.current * (e.deltaY > 0 ? 0.85 : 1.15)));
            lbScaleRef.current = ns;
            setLightboxScale(ns);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            lbDragging.current = false;
            lbOnImg.current = !!(e.target as HTMLElement).closest('img');
            lbStart.current = { x: e.clientX, y: e.clientY, px: lbPanRef.current.x, py: lbPanRef.current.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const dx = e.clientX - lbStart.current.x, dy = e.clientY - lbStart.current.y;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) lbDragging.current = true;
            const np = { x: lbStart.current.px + dx, y: lbStart.current.py + dy };
            lbPanRef.current = np; setLbPan(np);
          }}
          onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); }}
        >
          <img key={lightboxImg} src={lightboxImg} alt="" draggable={false} style={{
            transform: `translate(${lbPan.x}px, ${lbPan.y}px) scale(${lightboxScale})`,
            pointerEvents: 'none', userSelect: 'none',
            transition: lbDragging.current ? 'none' : 'transform 0.1s ease-out',
          }} />
        </div>, document.body
      )}

      {/* Context menu */}
      {showMenu && createPortal(<>
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setShowMenu(false)} onContextMenu={(ev) => { ev.preventDefault(); setShowMenu(false); }} />
        <div className="context-menu" style={{ left: clampedMenuX, top: clampedMenuY }}>
          <button className="context-menu-item" onClick={() => { setShowMenu(false); setIsEditing(true); onEditStart?.(); }} style={{ fontSize: fs(13, gfs) }}>编辑</button>
          <button className="context-menu-item" onClick={handlePinToScreen} style={{ fontSize: fs(13, gfs) }}>{note.isFloating ? '取消固定' : '固定到屏幕'}</button>
          <div className="context-menu-divider" />
          <div style={{ padding: '4px 10px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
            {ALL_COLORS.map(c => (
              <div key={c} className="color-swatch" style={{ background: c, width: '20px', height: '20px', borderColor: note.color === c ? 'white' : 'transparent' }}
                onClick={() => { handleColorChange(c); setShowMenu(false); }} />
            ))}
          </div>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={handleDelete} style={{ color: 'var(--danger)', fontSize: fs(13, gfs) }}>删除</button>
        </div>
      </>, document.body)}
    </>
  );
};

export default NoteCard;
