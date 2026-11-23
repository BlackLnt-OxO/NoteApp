import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Note, NoteImage } from '../types';
import { useNoteStore } from '../store';
import { fs, fsn } from '../utils';
import LiquidGlassCard from './LiquidGlassCard';
import { usePreviewGesture } from './usePreviewGesture';
import IconAction from './IconAction';
import { externalFileTarget, receiveExternalFiles } from './FileLibrary/externalFiles';
import { appendNoteDrop, NoteAttachments, openNoteAttachment } from './FileLibrary/noteAttachments';

const QUICK_COLORS = ['#2d2d44', '#6b5ce7', '#e8a0b4', '#95a5a6'];
const ALL_COLORS = ['#2d2d44', '#6b5ce7', '#e74c3c', '#e67e22', '#2ecc71', '#3498db', '#1abc9c', '#e91e63', '#9b59b6', '#95a5a6', '#f39c12', '#34495e'];

interface NoteCardProps {
  note: Note;
  isDragGhost?: boolean;
  isDragPlaceholder?: boolean;
  isExpanded?: boolean;
  onDragStart?: (e: React.PointerEvent, noteId: string) => void;
  onResizePreview?: (id: string, size: Pick<Note, 'width' | 'height'> | null) => void;
  onEditStart?: (id: string) => void;
  onEditEnd?: (id: string) => void;
}

const NoteCard: React.FC<NoteCardProps> = ({ note, isDragGhost, isDragPlaceholder, isExpanded, onDragStart, onResizePreview, onEditStart, onEditEnd }) => {
  const updateNote = useNoteStore(s => s.updateNote);
  const deleteNote = useNoteStore(s => s.deleteNote);
  const selectNote = useNoteStore(s => s.selectNote);
  const setNoteFloating = useNoteStore(s => s.setNoteFloating);
  const [content, setContent] = useState(note.content);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  // Right-click on an embedded image → "另存为…" (distinct from the card menu).
  const [imgSaveMenu, setImgSaveMenu] = useState<{
    x: number; y: number; dataUrl: string; fileName?: string;
  } | null>(null);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [lightboxScale, setLightboxScale] = useState(1);
  const [lbPan, setLbPan] = useState({ x: 0, y: 0 });
  const lbPanRef = useRef({ x: 0, y: 0 });
  const lbScaleRef = useRef(1);
  const lbDragging = useRef(false);
  const lbOnImg = useRef(false);
  const lbStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const contentRef = useRef<HTMLDivElement>(null);
  const startPreview = usePreviewGesture(note.id);
  const undoStack = useRef<string[]>([]);
  const composing = useRef(false);
  const imgDragMoved = useRef(false);
  const rightClickStart = useRef({ x: 0, y: 0 });

  const isSelected = useNoteStore(s => s.selectedNoteId === note.id);
  const showExpanded = Boolean(isExpanded);
  const tags = useNoteStore((s) => s.tags);
  const tag = tags.find((t) => t.id === note.tag);
  const gfs = useNoteStore((s) => s.settings.fontSize);
  const floatCloseKey = useNoteStore(s => s.settings.floatCloseKey);
  const floatPenetrateKey = useNoteStore(s => s.settings.floatPenetrateKey);

  useEffect(() => { setContent(note.content); }, [note.content]);
  useEffect(() => {
    if (showExpanded && contentRef.current) {
      contentRef.current.focus({ preventScroll: true });
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
    if (composing.current || e.nativeEvent.isComposing) return;
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
  }, []);

  useEffect(() => {
    if (!showExpanded && !showMenu) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || composing.current ||
        document.querySelector('.dialog-overlay, [data-file-dialog], [data-lightbox], .img-lightbox-overlay')) return;
      if (showMenu) {
        event.preventDefault();
        event.stopPropagation();
        setShowMenu(false);
        contentRef.current?.focus({ preventScroll: true });
      } else {
        event.preventDefault();
        const editor = contentRef.current;
        if (document.activeElement === editor) editor?.blur();
        else onEditEnd?.(note.id);
      }
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [showExpanded, showMenu, onEditEnd, note.id]);

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
    onDragStart?.(e, note.id);
  }, [note.id, onDragStart]);

  // Content click
  const handleContentPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectNote(note.id);
    onEditStart?.(note.id);
  }, [note.id, onEditStart, selectNote]);

  const handleContentBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const text = event.currentTarget.innerText ?? content;
    if (text !== note.content) { update(note.id, { content: text }); saveUndo(text); }
    if (!showMenu && !event.relatedTarget?.closest('.note-editor-body')) onEditEnd?.(note.id);
  };

  // Image drag between notes (pointer-based, no browser DnD)
  const handleImagePointerDown = useCallback((img: NoteImage) => (ev: React.PointerEvent<HTMLImageElement>) => {
    // Left button only — a right click opens the "另存为…" menu, never a drag.
    if (ev.button !== 0) return;
    const image = ev.currentTarget;
    const card = image.closest<HTMLElement>('.note-card-wrapper');
    const scale = useNoteStore.getState().uiScale;
    const imageBounds = image.getBoundingClientRect();
    const grabX = ev.clientX - imageBounds.left;
    const grabY = ev.clientY - imageBounds.top;
    const ratio = .92;
    const ghost = document.createElement('img');
    ghost.src = img.dataUrl;
    ghost.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;opacity:.8;border-radius:6px;box-shadow:0 8px 24px rgb(0 0 0 / .4);will-change:transform;';
    ghost.style.height = `${imageBounds.height * ratio}px`;
    ghost.style.left = `${ev.clientX - grabX * ratio}px`;
    ghost.style.top = `${ev.clientY - grabY * ratio}px`;
    imgDragMoved.current = false;
    const active = startPreview(ev, {
      paint(dx, dy) {
        if (!imgDragMoved.current && Math.hypot(dx, dy) < 3) return;
        imgDragMoved.current = true;
        if (!ghost.isConnected) document.body.appendChild(ghost);
        ghost.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      },
      finish(dx, dy, e) {
        if (!imgDragMoved.current && Math.hypot(dx, dy) < 3) return;
        imgDragMoved.current = true;
        (window as any).__imgDragJustEnded = true;
        setTimeout(() => { (window as any).__imgDragJustEnded = false; }, 200);
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.note-card-wrapper') ?? card;
        const content = target?.querySelector<HTMLElement>('.note-scroll-area');
        if (!target || !content) return;
        const state = useNoteStore.getState();
        const source = state.notes.find(item => item.id === note.id);
        const destination = state.notes.find(item => item.id === target.dataset.noteId);
        const moved = source?.images.find(item => item.id === img.id);
        if (!source || !moved || !destination) return;
        const rect = content.getBoundingClientRect();
        const position = {
          _imgX: (e.clientX - rect.left - grabX) / scale + content.scrollLeft,
          _imgY: (e.clientY - rect.top - grabY) / scale + content.scrollTop,
        };
        if (destination === source) {
          state.updateNote(source.id, { images: source.images.map(item => item.id === moved.id ? { ...item, ...position } : item) });
        } else {
          const id = destination.images.some(item => item.id === moved.id) ? crypto.randomUUID() : moved.id;
          state.updateNote(destination.id, { images: [...destination.images, { ...moved, ...position, id }] });
          state.updateNote(source.id, { images: source.images.filter(item => item.id !== moved.id) });
          selectNote(destination.id);
        }
      },
      reset: () => ghost.remove(),
    });
    if (active) selectNote(note.id);
  }, [note.id, selectNote, startPreview]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowMenu(true);
    selectNote(note.id);
    onEditStart?.(note.id);
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
          ...note, content, tag: tag?.name || note.tag || '通用', fontSize: gfs,
          floatCloseKey, floatPenetrateKey,
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
            ...note, content, tag: tag?.name || note.tag || '通用', fontSize: gfs,
            floatCloseKey, floatPenetrateKey,
          });
          setNoteFloating(note.id, true, '');
        }
      }
    }, 250);
  };

  const handleDelete = () => { setShowMenu(false); remove(note.id); };

  // "另存为…": write the image's data-URL to a user-chosen location via IPC.
  const saveImageToDisk = useCallback(async (m: { x: number; y: number; dataUrl: string; fileName?: string }) => {
    setImgSaveMenu(null);
    const api = window.electronAPI;
    if (!api?.saveImageAs) return;
    try {
      const r = await api.saveImageAs(m.dataUrl, m.fileName || '');
      if (r?.ok) {
        api.showToast('已保存：' + r.filePath);
      } else if (r?.error) {
        api.showToast('保存失败：' + r.error);
      }
      // canceled → silently do nothing
    } catch (err) {
      console.error('Save image as failed:', err);
      api.showToast('保存失败');
    }
  }, []);

  // Resize
  const handleResizeDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const wrapper = event.currentTarget.closest<HTMLElement>('.note-card-wrapper');
    if (!wrapper || !onResizePreview) return;
    const scale = useNoteStore.getState().uiScale;
    const startW = wrapper.offsetWidth;
    const startH = wrapper.offsetHeight;
    const dimensions = (x: number, y: number) => ({
      width: Math.max(180, Math.round(startW + x / scale)),
      height: Math.max(120, Math.round(startH + y / scale)),
    });
    startPreview(event, {
      paint: (dx, dy) => onResizePreview(note.id, dimensions(dx, dy)),
      reset: () => onResizePreview(note.id, null),
      finish(dx, dy) {
        selectNote(null);
        onEditEnd?.(note.id);
        update(note.id, { ...dimensions(dx, dy), customSize: true });
      },
    });
  };

  const resizeImage = (event: React.PointerEvent<HTMLDivElement>, img: NoteImage, topLeft: boolean) => {
    const wrap = event.currentTarget.closest<HTMLElement>('.note-image-wrap');
    const image = wrap?.querySelector('img');
    if (!wrap || !image) return;
    const scale = useNoteStore.getState().uiScale;
    const start = { x: wrap.offsetLeft, y: wrap.offsetTop, w: image.offsetWidth, h: image.offsetHeight };
    const { left, top } = wrap.style;
    const { height } = image.style;
    const dimensions = (dx: number, dy: number) => {
      const delta = topLeft ? Math.max(-dx, -dy) : Math.max(dx, dy);
      const h = Math.max(30, start.h + delta / scale);
      return {
        _previewH: h,
        _imgX: topLeft ? start.x + (1 - h / start.h) * start.w : start.x,
        _imgY: topLeft ? start.y + start.h - h : start.y,
      };
    };
    startPreview(event, {
      paint(dx, dy) {
        const size = dimensions(dx, dy);
        image.style.height = `${size._previewH}px`;
        if (topLeft) { wrap.style.left = `${size._imgX}px`; wrap.style.top = `${size._imgY}px`; }
      },
      finish(dx, dy) {
        const images = useNoteStore.getState().notes.find(item => item.id === note.id)?.images;
        if (images) update(note.id, { images: images.map(item => item.id === img.id ? { ...item, ...dimensions(dx, dy) } : item) });
      },
      reset() { image.style.height = height; wrap.style.left = left; wrap.style.top = top; },
    });
  };

  const handleColorChange = (color: string) => {
    update(note.id, { color });
    // Sync floating window color
    if (note.isFloating && window.electronAPI) {
      window.electronAPI.updateFloatingNote(note.id, { ...note, color, content });
    }
  };

  const clampedMenuX = Math.min(menuPos.x, window.innerWidth - 180);
  const clampedMenuY = Math.min(menuPos.y, window.innerHeight - 280);

  return (
    <>
      <LiquidGlassCard className="liquid-glass-card--note" radius={14} noteTint={note.color}
        data-selected={isSelected || undefined} dragState={isDragGhost ? 'preview' : isDragPlaceholder ? 'placeholder' : undefined}
        {...(!isDragGhost && !isDragPlaceholder && externalFileTarget(event => {
          const textBottom = contentRef.current?.offsetHeight ?? 0;
          receiveExternalFiles(event.dataTransfer, items => appendNoteDrop(note.id, items, textBottom));
        }))}
        onContextMenu={handleContextMenu} style={{
        minWidth: '100%',
        width: '100%',
        minHeight: '100%',
        height: '100%',
        display: 'flex', flexDirection: 'column',
        transition: 'box-shadow 0.2s, border-color 0.2s',
        position: 'relative', userSelect: 'none', overflow: 'hidden',
      } as React.CSSProperties}>
        <div className="note-glass-backplate" aria-hidden="true" />
        <div className="note-editor-body" data-note-editing={showExpanded || undefined}>
        {/* Header — fixed above scrollable area, always visible */}
        <div onPointerDown={handleHeaderPointerDown} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: `${fs(4, gfs)} ${fs(8, gfs)}`,
          background: 'rgba(0,0,0,0.1)', cursor: 'grab', flexShrink: 0, minHeight: fs(24, gfs),
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: fs(4, gfs), minWidth: 0 }}>
            <span style={{
              fontSize: fs(10, gfs), color: 'rgba(255,255,255,0.8)',
              background: 'rgba(255,255,255,0.12)', padding: `0 ${fs(6, gfs)}`, borderRadius: '8px', fontWeight: 500,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{tag?.name || note.tag || '通用'}</span>
            {note.isFloating && <span style={{ width: fs(4, gfs), height: fs(4, gfs), borderRadius: '50%', background: 'rgba(255,255,255,0.7)' }} />}
          </div>
          <div style={{ display: 'flex', gap: fs(1, gfs), alignItems: 'center', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: fs(2, gfs), marginRight: fs(4, gfs) }}>
              {QUICK_COLORS.map((c) => (
                <div key={c} className="color-dot" onClick={(ev) => { ev.stopPropagation(); handleColorChange(c); }}
                  style={{ width: fs(11, gfs), height: fs(11, gfs), borderRadius: '50%', background: c, cursor: 'pointer',
                    border: note.color === c ? '2px solid white' : '1px solid rgba(255,255,255,0.25)',
                    transition: 'border-color 0.2s, transform 0.2s' }} />
              ))}
            </div>
            <IconAction className="note-action" icon="pin" aria-pressed={note.isFloating}
              label={note.isFloating ? '取消固定' : '固定到屏幕'} onClick={ev => { ev.stopPropagation(); void handlePinToScreen(); }} />
            <IconAction className="note-action" label="删除便笺" danger onClick={ev => { ev.stopPropagation(); handleDelete(); }} />
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
              fontSize: gfs + 'px', lineHeight: 1.5,
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
              }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation(); // don't bubble to the card's own menu
                  selectNote(note.id);
                  setImgSaveMenu({ x: ev.clientX, y: ev.clientY, dataUrl: img.dataUrl, fileName: img.fileName });
                }}>
                <img src={img.dataUrl} alt="" loading={isDragGhost ? 'eager' : 'lazy'} decoding="async"
                  onPointerDown={handleImagePointerDown(img)}
                  onClick={(ev) => { ev.stopPropagation(); if (imgDragMoved.current) { imgDragMoved.current = false; return; } setLightboxImg(img.dataUrl); setLightboxScale(1); setLbPan({x:0,y:0}); lbScaleRef.current=1; lbPanRef.current={x:0,y:0}; }}
                  style={{ height: imgH, width: 'auto', borderRadius: '5px', cursor: 'grab', display: 'block' }} />
                  <IconAction label="移除图片" danger className="note-img-del"
                    onClick={ev => { ev.stopPropagation(); update(note.id, { images: note.images.filter((_, i) => i !== imgIdx) }); }} />
                  <div className="note-img-size note-img-size-tl"
                    onPointerDown={event => resizeImage(event, img, true)}
                    style={{
                      position: 'absolute', top: 0, left: 0,
                      opacity: 0, transition: 'opacity 0.15s',
                      width: '14px', height: '14px', cursor: 'nwse-resize',
                      background: 'linear-gradient(135deg, rgba(255,255,255,0.4) 50%, transparent 50%)',
                    }} />
                  <div className="note-img-size"
                    onPointerDown={event => resizeImage(event, img, false)}
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
        <NoteAttachments items={note.attachments ?? []} onOpen={id => openNoteAttachment(note.id, id)}
          onRemove={showExpanded ? id => {
            const latest = useNoteStore.getState().notes.find(item => item.id === note.id);
            if (latest) update(note.id, { attachments: latest.attachments?.filter(item => item.id !== id) });
          } : undefined} />

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
      </LiquidGlassCard>

      {/* Image lightbox with scroll zoom + drag pan */}
      {lightboxImg && createPortal(
        <div className="img-lightbox-overlay" style={{ cursor: lightboxScale > 1 ? 'grab' : 'default', userSelect: 'none' }}
          onClick={(e) => { if (!lbDragging.current && e.target === e.currentTarget && !lbOnImg.current) setLightboxImg(null); lbDragging.current = false; lbOnImg.current = false; }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (lightboxImg) setImgSaveMenu({ x: e.clientX, y: e.clientY, dataUrl: lightboxImg });
          }}
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
        <div className="context-menu" data-pointer-scope style={{ left: clampedMenuX, top: clampedMenuY }}
          onMouseDown={event => event.preventDefault()}>
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

      {/* Image "另存为…" menu (right-click an embedded image / lightbox preview) */}
      {imgSaveMenu && createPortal(<>
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000 }} onClick={() => setImgSaveMenu(null)}
          onContextMenu={(ev) => { ev.preventDefault(); setImgSaveMenu(null); }} />
        <div className="context-menu" data-pointer-scope style={{
          left: Math.min(imgSaveMenu.x, window.innerWidth - 180),
          top: Math.min(imgSaveMenu.y, window.innerHeight - 60),
        }}>
          <button className="context-menu-item" style={{ fontSize: fs(13, gfs) }} onClick={() => saveImageToDisk(imgSaveMenu)}>
            另存为…
          </button>
        </div>
      </>, document.body)}
    </>
  );
};

export default React.memo(NoteCard);
