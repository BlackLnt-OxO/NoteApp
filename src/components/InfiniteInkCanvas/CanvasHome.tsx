/**
 * CanvasHome — multi-canvas home screen (mirrors the PDF library home).
 *
 * Cards use the PDF-library card style (SVG icon + name + meta), support
 * categories (chips + rename/delete via right-click), drag-to-reorder via
 * FlowGrid, and per-card hover actions (rename / delete with confirm).
 * New canvases are auto-named "未命名1/2/3…".
 */

import React, { useState, useEffect } from 'react';
import { useNoteStore } from "../../store";
import { fs } from "../../utils";
import { useCanvasLibrary } from './useCanvasLibrary';
import FlowGrid from '../FlowGrid';
import { askConfirm } from '../ConfirmDialog';

const CARD_W = 220;
const CARD_H = 110;

const CanvasCardIcon: React.FC = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" opacity="0.5" />
    <path d="M7 16c1.5-4 3-6 4.5-6s2.5 2.5 4.5 2.5c2 0 3.5-1 5.5-1.5" />
  </svg>
);

const fmtTime = (t: number): string => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const MenuItem: React.FC<{ onClick: () => void; danger?: boolean; children: React.ReactNode }> = ({ onClick, danger, children }) => {
  const gfs = useNoteStore((s) => s.settings.fontSize);
  return (
    <button onClick={onClick} style={{
      display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: '6px',
      cursor: 'pointer', color: danger ? 'var(--danger)' : 'var(--text-primary)',
      fontSize: fs(12, gfs), fontFamily: 'inherit', border: 'none', background: 'transparent',
    }}>{children}</button>
  );
};

const CanvasHome: React.FC<{ onOpen: (id: string) => void; onNew: () => void }> = ({ onOpen, onNew }) => {
  const gfs = useNoteStore((s) => s.settings.fontSize);
  const canvases = useCanvasLibrary((s) => s.canvases);
  const categories = useCanvasLibrary((s) => s.categories);
  const renameCanvas = useCanvasLibrary((s) => s.renameCanvas);
  const deleteCanvas = useCanvasLibrary((s) => s.deleteCanvas);
  const setCanvasCategory = useCanvasLibrary((s) => s.setCanvasCategory);
  const addCategory = useCanvasLibrary((s) => s.addCategory);
  const renameCategory = useCanvasLibrary((s) => s.renameCategory);
  const deleteCategory = useCanvasLibrary((s) => s.deleteCategory);
  const reorderCanvases = useCanvasLibrary((s) => s.reorderCanvases);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [creatingCat, setCreatingCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [catMenu, setCatMenu] = useState<{ x: number; y: number; id: string; name: string } | null>(null);
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; id: string; name: string; categoryId: string | null } | null>(null);
  const [addToCatOpen, setAddToCatOpen] = useState(false);

  useEffect(() => {
    const close = () => { setCardMenu(null); setCatMenu(null); setAddToCatOpen(false); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const filtered = selectedCategory
    ? canvases.filter((c) => c.categoryId === selectedCategory)
    : canvases;

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: '14px', cursor: 'pointer', fontSize: fs(12, gfs),
    fontFamily: 'inherit', border: active ? 'none' : '1px solid var(--glass-border)',
    background: active ? 'var(--accent)' : 'var(--glass-bg-light)',
    color: active ? '#fff' : 'var(--text-secondary)',
    transition: 'all var(--transition)',
  });

  const createCategory = () => {
    const name = newCatName.trim();
    if (name) addCategory(name);
    setCreatingCat(false);
    setNewCatName('');
  };

  return (
    <div style={{
      position: 'absolute', inset: 0, overflowY: 'auto', padding: '28px 32px',
      background: 'var(--page-bg)', color: 'var(--text-primary)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: fs(18, gfs), fontWeight: 600 }}>画布</span>
        <button onClick={onNew} className="btn-accent" style={{
          marginLeft: 'auto', padding: '8px 18px', borderRadius: '8px',
          color: '#fff', cursor: 'pointer',
          fontSize: fs(13, gfs), fontWeight: 600, fontFamily: 'inherit',
        }}>+ 新建画布</button>
      </div>

      {/* Category chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
        <button style={chipStyle(selectedCategory === null)} onClick={() => setSelectedCategory(null)}>
          全部 <span style={{ opacity: 0.7 }}>({canvases.length})</span>
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            style={chipStyle(selectedCategory === c.id)}
            onClick={() => setSelectedCategory(c.id === selectedCategory ? null : c.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCatMenu({ x: e.clientX, y: e.clientY, id: c.id, name: c.name });
            }}
          >
            {c.name} <span style={{ opacity: 0.7 }}>({canvases.filter((i) => i.categoryId === c.id).length})</span>
          </button>
        ))}

        {creatingCat ? (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              autoFocus value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createCategory(); if (e.key === 'Escape') setCreatingCat(false); }}
              placeholder="分类名称"
              style={{ padding: '5px 10px', borderRadius: '6px', border: '1px solid var(--glass-border)', background: 'var(--glass-bg-light)', color: 'var(--text-primary)', fontSize: fs(12, gfs), fontFamily: 'inherit', outline: 'none', width: 120 }}
            />
            <button onClick={createCategory} className="btn-accent" style={{ padding: '5px 10px', borderRadius: '6px', color: '#fff', cursor: 'pointer', fontSize: fs(12, gfs), fontFamily: 'inherit' }}>添加</button>
          </div>
        ) : (
          <button onClick={() => setCreatingCat(true)} title="新建分类"
            style={{
              width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', fontSize: fs(14, gfs),
              border: '1px dashed var(--glass-border)', background: 'transparent', color: 'var(--text-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
            }}>
            +
          </button>
        )}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: fs(13, gfs) }}>
          {canvases.length === 0 ? '还没有画布，点击右上角「+ 新建画布」开始。' : '这个分类下还没有画布。'}
        </div>
      )}

      {/* Cards */}
      {filtered.length > 0 && (
        <FlowGrid
          items={filtered}
          itemWidth={CARD_W}
          itemHeight={CARD_H}
          gap={14}
          getId={(c) => c.id}
          onReorder={reorderCanvases}
          onCardClick={(c) => onOpen(c.id)}
          renderCard={(c, _idx, hovered) => (
            <div
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCardMenu({ x: e.clientX, y: e.clientY, id: c.id, name: c.name, categoryId: c.categoryId });
              }}
              style={{
                width: '100%', height: '100%', boxSizing: 'border-box',
                padding: '16px', borderRadius: '12px', cursor: 'pointer',
                background: hovered ? 'var(--glass-bg-hover)' : 'var(--glass-bg-light)',
                border: hovered ? '1px solid var(--glass-border-active)' : '1px solid var(--glass-border)',
                transition: 'all var(--transition)',
                display: 'flex', flexDirection: 'column', gap: 10,
                position: 'relative', userSelect: 'none',
              }}>
              {hovered && renamingId !== c.id && (
                <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6 }}>
                  <button
                    title="重命名"
                    onClick={(e) => { e.stopPropagation(); setDraft(c.name); setRenamingId(c.id); }}
                    style={{
                      width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer',
                      background: 'rgba(120,120,120,0.6)', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
                  <button
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      askConfirm({
                        title: '删除画布',
                        message: `删除画布「${c.name}」？此操作不可撤销。`,
                        onConfirm: () => deleteCanvas(c.id),
                      });
                    }}
                    style={{
                      width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer',
                      background: 'rgba(231,76,60,0.8)', color: '#fff', fontSize: fs(12, gfs), lineHeight: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ color: 'var(--accent)', flexShrink: 0 }}><CanvasCardIcon /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {renamingId === c.id ? (
                    <input
                      autoFocus
                      defaultValue={c.name}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { const v = draft.trim(); if (v) renameCanvas(c.id, v); setRenamingId(null); }
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => setRenamingId(null)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: '100%', padding: '3px 6px', fontSize: fs(13, gfs), fontFamily: 'inherit',
                        background: 'var(--glass-bg-light)', color: 'var(--text-primary)',
                        border: '1px solid var(--accent)', borderRadius: '6px', outline: 'none',
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: fs(13, gfs), fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                  )}
                  <div style={{ fontSize: fs(11, gfs), color: 'var(--text-muted)', marginTop: 2 }}>
                    {c.categoryId ? (categories.find((cat) => cat.id === c.categoryId)?.name ?? '') : '未分类'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: fs(11, gfs), color: 'var(--text-muted)' }}>
                <span>{fmtTime(c.updatedAt)}</span>
              </div>
            </div>
          )}
        />
      )}

      {/* Card context menu */}
      {cardMenu && (
        <div style={{
          position: 'fixed', left: cardMenu.x, top: cardMenu.y, zIndex: 2000, minWidth: 170,
          background: 'var(--dropdown-bg)', border: '1px solid var(--glass-border)',
          borderRadius: '8px', padding: 4, boxShadow: 'var(--glass-shadow)', fontSize: fs(12, gfs),
        }} onClick={(e) => e.stopPropagation()}>
          <MenuItem onClick={() => { onOpen(cardMenu.id); setCardMenu(null); }}>打开</MenuItem>
          <MenuItem onClick={() => setAddToCatOpen((v) => !v)}>添加到分类 ▸</MenuItem>
          {addToCatOpen && (
            <div style={{ padding: '2px 0 4px', margin: '0 4px', borderTop: '1px solid var(--glass-border)' }}>
              {categories.map((cat) => (
                <MenuItem key={cat.id} onClick={() => { setCanvasCategory(cardMenu.id, cat.id); setCardMenu(null); }}>{cat.name}</MenuItem>
              ))}
              <MenuItem
                onClick={() => {
                  const name = prompt('新分类名称');
                  if (name && name.trim()) {
                    const id = addCategory(name.trim());
                    setCanvasCategory(cardMenu.id, id);
                  }
                  setCardMenu(null);
                }}
              >+ 新建分类…</MenuItem>
            </div>
          )}
          {cardMenu.categoryId && (
            <MenuItem onClick={() => { setCanvasCategory(cardMenu.id, null); setCardMenu(null); }}>移除分类</MenuItem>
          )}
          <MenuItem onClick={() => { setDraft(cardMenu.name); setRenamingId(cardMenu.id); setCardMenu(null); }}>重命名</MenuItem>
          <MenuItem
            danger
            onClick={() => {
              setCardMenu(null);
              askConfirm({
                title: '删除画布',
                message: `删除画布「${cardMenu.name}」？此操作不可撤销。`,
                onConfirm: () => deleteCanvas(cardMenu.id),
              });
            }}
          >删除</MenuItem>
        </div>
      )}

      {/* Category context menu */}
      {catMenu && (
        <div style={{
          position: 'fixed', left: catMenu.x, top: catMenu.y, zIndex: 2000, minWidth: 150,
          background: 'var(--dropdown-bg)', border: '1px solid var(--glass-border)',
          borderRadius: '8px', padding: 4, boxShadow: 'var(--glass-shadow)', fontSize: fs(12, gfs),
        }} onClick={(e) => e.stopPropagation()}>
          <MenuItem onClick={() => {
            const name = prompt('重命名分类', catMenu.name);
            if (name && name.trim()) renameCategory(catMenu.id, name.trim());
            setCatMenu(null);
          }}>重命名</MenuItem>
          <MenuItem danger onClick={() => {
            setCatMenu(null);
            askConfirm({
              title: '删除分类',
              message: `删除分类「${catMenu.name}」？画布不会删除，会变为未分类。`,
              onConfirm: () => deleteCategory(catMenu.id),
            });
          }}>删除</MenuItem>
        </div>
      )}
    </div>
  );
};

export default CanvasHome;
