/**
 * LibraryHome — the PDF home screen: a library of imported PDFs.
 *
 * - Category chips (全部 / folders) to filter, "+" to create a folder.
 * - Card grid of PDFs (name, page count, last opened), sorted by last opened.
 * - Right-click a card: 打开 / 添加到分类 / 移除分类 / 删除.
 * - Right-click a category chip: 重命名 / 删除.
 * - Opening uses the stored absolute path; if the file was moved/deleted the
 *   UI shows a re-select dialog and updates the stored path.
 */

import React, { useState, useEffect } from 'react';
import { usePdfStore } from './PdfStore';
import { usePdfLibrary, type PdfCategory, type PdfLibraryItem } from './PdfLibrary';
import { pickPdfFile } from './PdfPicker';
import FlowGrid from '../FlowGrid';

// ---- helpers ------------------------------------------------------------------

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

function formatBytes(b: number): string {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return `${b} B`;
}

const PdfCardIcon: React.FC = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M8 13h8M8 17h5" opacity="0.7" />
  </svg>
);

// ---- Context menu -------------------------------------------------------------

interface MenuState { x: number; y: number; }

const LibraryHome: React.FC = () => {
  const items = usePdfLibrary((s) => s.items);
  const categories = usePdfLibrary((s) => s.categories);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null); // null = all
  const [cardMenu, setCardMenu] = useState<(MenuState & { item: PdfLibraryItem }) | null>(null);
  const [categoryMenu, setCategoryMenu] = useState<(MenuState & { category: PdfCategory }) | null>(null);
  const [addToCategoryOpen, setAddToCategoryOpen] = useState(false);
  const [missingItem, setMissingItem] = useState<PdfLibraryItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [renamingCat, setRenamingCat] = useState<PdfCategory | null>(null);
  const [renameVal, setRenameVal] = useState('');

  useEffect(() => {
    usePdfLibrary.getState().loadState();
    const close = () => { setCardMenu(null); setCategoryMenu(null); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const filtered = selectedCategory
    ? items.filter((i) => i.categoryId === selectedCategory)
    : items;
  // Cards keep the user's drag-to-reorder sequence (no auto-sort by recency).
  const sorted = filtered;

  // ---- import ---------------------------------------------------------------

  const doImport = async () => {
    setImporting(true);
    try {
      const picked = await pickPdfFile();
      if (picked) {
        await usePdfStore.getState().loadPdfFromBuffer(picked.buffer, picked.name);
        const numPages = usePdfStore.getState().numPages;
        usePdfLibrary.getState().addItem({
          name: picked.name,
          path: picked.path,
          categoryId: selectedCategory,
          pageCount: numPages,
          sizeBytes: picked.buffer.byteLength,
        });
      }
    } finally {
      setImporting(false);
    }
  };

  // ---- open (with missing-file re-select) ------------------------------------

  const doOpen = async (item: PdfLibraryItem) => {
    const api = window.electronAPI;
    if (api?.pdfFileExists) {
      const exists = await api.pdfFileExists(item.path);
      if (exists) {
        const res = await api.readPdfFile(item.path);
        if (res?.ok) {
          await usePdfStore.getState().loadPdfFromBuffer(res.data, item.name, {
            itemId: item.id,
            lastPage: item.lastPage,
            camera: item.camera,
            showDotGrid: item.showDotGrid,
            sidebarOpen: item.sidebarOpen,
          });
          await usePdfStore.getState().loadAnnotations(item.id);
          usePdfLibrary.getState().touchLastOpened(item.id);
          return;
        }
      }
      setMissingItem(item);
      return;
    }
    // No IPC (browser) — just try the picker
    const picked = await pickPdfFile();
    if (picked) await usePdfStore.getState().loadPdfFromBuffer(picked.buffer, picked.name);
  };

  const doReselect = async () => {
    const item = missingItem;
    setMissingItem(null);
    if (!item) return;
    const picked = await pickPdfFile();
    if (!picked) return;
    usePdfLibrary.getState().updateItemPath(item.id, picked.path);
    await usePdfStore.getState().loadPdfFromBuffer(picked.buffer, picked.name, {
      itemId: item.id,
      lastPage: item.lastPage,
      camera: item.camera,
      showDotGrid: item.showDotGrid,
      sidebarOpen: item.sidebarOpen,
    });
    await usePdfStore.getState().loadAnnotations(item.id);
    usePdfLibrary.getState().touchLastOpened(item.id);
  };

  // ---- category helpers -------------------------------------------------------

  const createCategory = () => {
    const name = newCatName.trim();
    if (name) usePdfLibrary.getState().addCategory(name);
    setCreatingCategory(false);
    setNewCatName('');
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: '14px', cursor: 'pointer', fontSize: '12px',
    fontFamily: 'inherit', border: active ? 'none' : '1px solid var(--glass-border)',
    background: active ? 'var(--accent)' : 'var(--glass-bg-light)',
    color: active ? '#fff' : 'var(--text-secondary)',
    transition: 'all var(--transition)',
  });

  return (
    <div style={{
      position: 'absolute', inset: 0, overflowY: 'auto', padding: '28px 32px',
      background: 'var(--page-bg)', color: 'var(--text-primary)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: '18px', fontWeight: 600 }}>PDF 批注库</span>
        <button
          onClick={doImport} disabled={importing}
          style={{
            marginLeft: 'auto', padding: '8px 18px', borderRadius: '8px',
            background: 'var(--accent)', border: 'none', color: '#fff', cursor: 'pointer',
            fontSize: '13px', fontWeight: 600, fontFamily: 'inherit',
          }}
        >
          {importing ? '正在导入…' : '导入 PDF'}
        </button>
      </div>

      {/* Category chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
        <button style={chipStyle(selectedCategory === null)} onClick={() => setSelectedCategory(null)}>
          全部 <span style={{ opacity: 0.7 }}>({items.length})</span>
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            style={chipStyle(selectedCategory === c.id)}
            onClick={() => setSelectedCategory(c.id === selectedCategory ? null : c.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setRenamingCat(null);
              setCategoryMenu({ x: e.clientX, y: e.clientY, category: c });
            }}
          >
            {c.name} <span style={{ opacity: 0.7 }}>({items.filter((i) => i.categoryId === c.id).length})</span>
          </button>
        ))}

        {creatingCategory ? (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              autoFocus value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createCategory(); if (e.key === 'Escape') setCreatingCategory(false); }}
              placeholder="分类名称"
              style={{ padding: '5px 10px', borderRadius: '6px', border: '1px solid var(--glass-border)', background: 'var(--glass-bg-light)', color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'inherit', outline: 'none', width: 120 }}
            />
            <button onClick={createCategory} style={{ padding: '5px 10px', borderRadius: '6px', border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit' }}>添加</button>
          </div>
        ) : (
          <button onClick={() => setCreatingCategory(true)} title="新建分类"
            style={{
              width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', fontSize: '14px',
              border: '1px dashed var(--glass-border)', background: 'transparent', color: 'var(--text-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
            }}>
            +
          </button>
        )}
      </div>

      {/* Empty state */}
      {sorted.length === 0 && (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          {items.length === 0 ? '还没有导入过 PDF，点击右上角「导入 PDF」开始。' : '这个分类下还没有 PDF。'}
        </div>
      )}

      {/* Card grid (drag-to-reorder) */}
      {sorted.length > 0 && (
        <FlowGrid
          items={sorted}
          itemWidth={220}
          itemHeight={110}
          gap={14}
          getId={(i) => i.id}
          onReorder={(from, to) => usePdfLibrary.getState().reorderItems(from, to)}
          onCardClick={(item) => doOpen(item)}
          renderCard={(item, _idx, hovered) => (
            <div
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCardMenu({ x: e.clientX, y: e.clientY, item });
              }}
              style={{
                width: '100%', height: '100%', boxSizing: 'border-box',
                padding: '16px', borderRadius: '12px', cursor: 'pointer',
                background: hovered ? 'var(--glass-bg-hover)' : 'var(--glass-bg-light)',
                border: hovered ? '1px solid var(--glass-border-active)' : '1px solid var(--glass-border)',
                transition: 'all var(--transition)',
                display: 'flex', flexDirection: 'column', gap: 10,
                position: 'relative', userSelect: 'none',
              }}
            >
              {hovered && (
                <button
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`从库中删除「${item.name}」？批注和磁盘上的 PDF 文件不会被删除。`)) {
                      usePdfLibrary.getState().removeItem(item.id);
                      window.electronAPI?.deletePdfAnnotation(item.id);
                    }
                  }}
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer',
                    background: 'rgba(231,76,60,0.8)', color: '#fff', fontSize: '12px', lineHeight: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  ×
                </button>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ color: 'var(--accent)' }}><PdfCardIcon /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>{item.pageCount} 页 · {formatBytes(item.sizeBytes)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                <span>{item.categoryId ? (categories.find((c) => c.id === item.categoryId)?.name ?? '') : ''}</span>
                <span>{relativeTime(item.lastOpened)}</span>
              </div>
            </div>
          )}
        />
      )}

      {/* ---- Card context menu ---- */}
      {cardMenu && (
        <div
          style={{
            position: 'fixed', left: cardMenu.x, top: cardMenu.y, zIndex: 2000, minWidth: 160,
            background: 'var(--dropdown-bg, rgba(30,30,50,0.98))', border: '1px solid var(--glass-border)',
            borderRadius: '8px', padding: 4, boxShadow: 'var(--glass-shadow)', fontSize: '12px',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem onClick={() => { doOpen(cardMenu.item); setCardMenu(null); }}>打开</MenuItem>
          <MenuItem onClick={() => setAddToCategoryOpen((v) => !v)}>添加到分类 ▸</MenuItem>
          {addToCategoryOpen && (
            <div style={{ padding: '2px 0 4px', margin: '0 4px', borderTop: '1px solid var(--glass-border)' }}>
              {categories.map((c) => (
                <MenuItem
                  key={c.id}
                  onClick={() => {
                    usePdfLibrary.getState().setItemCategory(cardMenu.item.id, c.id);
                    setCardMenu(null);
                  }}
                >
                  {c.name}
                </MenuItem>
              ))}
              <MenuItem
                onClick={() => {
                  const name = prompt('新分类名称');
                  if (name && name.trim()) {
                    const id = usePdfLibrary.getState().addCategory(name.trim());
                    usePdfLibrary.getState().setItemCategory(cardMenu.item.id, id);
                  }
                  setCardMenu(null);
                }}
              >
                + 新建分类…
              </MenuItem>
            </div>
          )}
          {cardMenu.item.categoryId && (
            <MenuItem
              onClick={() => {
                usePdfLibrary.getState().setItemCategory(cardMenu.item.id, null);
                setCardMenu(null);
              }}
            >
              移除分类
            </MenuItem>
          )}
          <MenuItem
            danger
            onClick={() => {
              if (confirm(`从库中删除「${cardMenu.item.name}」？批注和磁盘上的 PDF 文件不会被删除。`)) {
                usePdfLibrary.getState().removeItem(cardMenu.item.id);
                window.electronAPI?.deletePdfAnnotation(cardMenu.item.id);
              }
              setCardMenu(null);
            }}
          >
            删除
          </MenuItem>
        </div>
      )}

      {/* ---- Category context menu ---- */}
      {categoryMenu && (
        <div
          style={{
            position: 'fixed', left: categoryMenu.x, top: categoryMenu.y, zIndex: 2000, minWidth: 150,
            background: 'var(--dropdown-bg, rgba(30,30,50,0.98))', border: '1px solid var(--glass-border)',
            borderRadius: '8px', padding: 4, boxShadow: 'var(--glass-shadow)', fontSize: '12px',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            onClick={() => {
              setRenameVal(categoryMenu.category.name);
              setRenamingCat(categoryMenu.category);
              setCategoryMenu(null);
            }}
          >
            重命名
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              if (confirm(`删除分类「${categoryMenu.category.name}」？其下的 PDF 不会被删除。`)) {
                usePdfLibrary.getState().deleteCategory(categoryMenu.category.id);
                if (selectedCategory === categoryMenu.category.id) setSelectedCategory(null);
              }
              setCategoryMenu(null);
            }}
          >
            删除分类
          </MenuItem>
        </div>
      )}

      {/* ---- Rename inline ---- */}
      {renamingCat && (
        <div style={{
          position: 'fixed', left: 200, top: 160, zIndex: 2000,
          display: 'flex', gap: 4, padding: 8,
          background: 'var(--dropdown-bg, rgba(30,30,50,0.98))', border: '1px solid var(--glass-border)', borderRadius: '8px',
        }}>
          <input
            autoFocus value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { if (renameVal.trim()) usePdfLibrary.getState().renameCategory(renamingCat.id, renameVal.trim()); setRenamingCat(null); }
              if (e.key === 'Escape') setRenamingCat(null);
            }}
            style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--glass-border)', background: 'var(--glass-bg-light)', color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'inherit', outline: 'none', width: 130 }}
          />
          <button onClick={() => { if (renameVal.trim()) usePdfLibrary.getState().renameCategory(renamingCat.id, renameVal.trim()); setRenamingCat(null); }}
            style={{ padding: '5px 10px', borderRadius: '6px', border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit' }}>
            确定
          </button>
        </div>
      )}

      {/* ---- Missing file dialog ---- */}
      {missingItem && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 3000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.5)',
        }}>
          <div style={{
            padding: '22px 24px', borderRadius: '12px', maxWidth: 380,
            background: 'var(--glass-bg)', backdropFilter: 'blur(16px)', border: '1px solid var(--glass-border)',
            boxShadow: 'var(--glass-shadow)', color: 'var(--text-primary)', fontSize: '13px', lineHeight: 1.7,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: '14px' }}>找不到 PDF 文件</div>
            <div style={{ color: 'var(--text-secondary)' }}>
              文件可能已被移动或删除：<br />
              <span style={{ fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all' }}>{missingItem.name}</span>
            </div>
            <div style={{ marginTop: '18px', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setMissingItem(null)}
                style={{ padding: '7px 14px', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', border: '1px solid var(--glass-border)', background: 'var(--glass-bg-light)', color: 'var(--text-secondary)' }}>
                取消
              </button>
              <button onClick={doReselect}
                style={{ padding: '7px 14px', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', border: 'none', background: 'var(--accent)', color: '#fff' }}>
                重新选择文件
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
        borderRadius: '6px', border: 'none', background: 'transparent',
        color: danger ? '#ff8a8a' : 'var(--text-secondary)', cursor: 'pointer',
        fontSize: '12px', fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-bg-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export default LibraryHome;
