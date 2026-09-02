import React, { useState } from 'react';
import { useNoteStore } from '../store';
import { DEFAULT_COLORS } from '../types';
import { askConfirm } from './ConfirmDialog';

interface SidebarProps {
  onCreateNote: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ onCreateNote }) => {
  const { notes, tags, activeTag, setActiveTag, addTag, deleteTag, updateTag, settings, viewMode, setViewMode } = useNoteStore();
  const fs = settings.fontSize;
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [hoverTag, setHoverTag] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [showAddTag, setShowAddTag] = useState(false);
  const [tagColorIndex, setTagColorIndex] = useState(0);

  const filteredCounts: Record<string, number> = {};
  tags.forEach((tag) => {
    filteredCounts[tag.id] = tag.id === 'all'
      ? notes.length
      : notes.filter((n) => n.tag === tag.id).length;
  });

  const handleAddTag = () => {
    if (!newTagName.trim()) return;
    const tagColor = DEFAULT_COLORS[tagColorIndex % DEFAULT_COLORS.length];
    addTag({
      id: 'tag_' + Date.now(),
      name: newTagName.trim(),
      color: tagColor,
    });
    setNewTagName('');
    setShowAddTag(false);
    setTagColorIndex((i) => i + 1);
  };

  const handleStartEdit = (tagId: string, currentName: string) => {
    setEditingTag(tagId);
    setNewTagName(currentName);
  };

  const handleSaveEdit = (tagId: string) => {
    if (newTagName.trim()) {
      updateTag(tagId, { name: newTagName.trim() });
    }
    setEditingTag(null);
    setNewTagName('');
  };

  return (
    <div style={{
      width: '220px',
      flexShrink: 0,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '12px',
      gap: '4px',
      position: 'relative',
      zIndex: 1,
      overflow: 'hidden',
      background: 'var(--sidebar-bg, var(--glass-bg))',
    }}>
      {/* Create note button */}
      <button
        onClick={onCreateNote}
        className="btn-accent"
        style={{
          width: '100%',
          padding: '11px',
          borderRadius: 'var(--radius-md)',
          fontSize: fs + 'px',
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          fontFamily: 'inherit',
          marginBottom: '8px',
          letterSpacing: '0.3px',
        }}
      >
        + 新建便笺
      </button>

      {/* View mode toggle */}
      <div style={{ display: 'flex', gap: '3px', marginBottom: '8px' }}>
        {([
          { id: 'notes' as const, label: '便笺' },
          { id: 'inkcanvas' as const, label: '画布' },
          { id: 'pdf' as const, label: 'PDF' },
        ]).map((m) => (
          <button
            key={m.id}
            onClick={() => setViewMode(m.id)}
            className={viewMode === m.id ? 'hover-ring-dark' : 'hover-ring-light'}
            style={{
              flex: 1,
              padding: '5px 6px',
              background: viewMode === m.id ? 'var(--accent)' : 'var(--glass-bg-light)',
              border: viewMode === m.id ? 'none' : '1px solid var(--glass-border)',
              borderRadius: '6px',
              color: viewMode === m.id ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: Math.max(9, fs - 3) + 'px',
              fontFamily: 'inherit',
              fontWeight: viewMode === m.id ? 600 : 400,
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Tag list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}>
        <div style={{
          fontSize: Math.max(9, fs - 4) + 'px',
          color: 'var(--text-muted)',
          padding: '6px 8px 4px',
          textTransform: 'uppercase',
          letterSpacing: '1.5px',
          fontWeight: 600,
        }}>
          标签分类
        </div>

        {tags.map((tag) => {
          const isActive = activeTag === tag.id;
          const isHover = hoverTag === tag.id;
          return (
          <div
            key={tag.id}
            onClick={() => setActiveTag(tag.id)}
            onMouseEnter={() => setHoverTag(tag.id)}
            onMouseLeave={() => setHoverTag(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (tag.id !== 'all') {
                askConfirm({
                  title: '删除标签',
                  message: `删除标签「${tag.name}」？便笺不会被删除。`,
                  onConfirm: () => deleteTag(tag.id),
                });
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '7px 12px',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              transition: 'all var(--transition)',
              background: isActive
                ? 'rgba(107,92,231,0.18)'
                : isHover
                  ? 'var(--glass-bg-hover)'
                  : 'transparent',
              border: isActive
                ? '1px solid var(--accent)'
                : isHover
                  ? '1px solid var(--glass-border-active)'
                  : '1px solid transparent',
              position: 'relative',
            }}
          >
            <div style={{
              width: '9px',
              height: '9px',
              borderRadius: '50%',
              background: tag.color,
              flexShrink: 0,
            }} />

            {editingTag === tag.id ? (
              <input
                className="glass-input"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onBlur={() => handleSaveEdit(tag.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveEdit(tag.id);
                  if (e.key === 'Escape') setEditingTag(null);
                }}
                autoFocus
                style={{
                  flex: 1,
                  padding: '2px 6px',
                  fontSize: Math.max(10, fs - 2) + 'px',
                  height: '22px',
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span style={{
                  flex: 1,
                  fontSize: fs + 'px',
                  color: isActive
                    ? 'var(--accent)'
                    : isHover
                      ? 'var(--text-primary)'
                      : 'var(--text-secondary)',
                  fontWeight: isActive ? 600 : 400,
                }}>
                  {tag.name}
                </span>
                <span style={{
                  fontSize: Math.max(9, fs - 4) + 'px',
                  color: 'var(--text-muted)',
                  background: 'var(--glass-bg-light)',
                  padding: '1px 0',
                  minWidth: '20px',
                  textAlign: 'center',
                  borderRadius: '8px',
                  fontWeight: 500,
                  flexShrink: 0,
                }}>
                  {filteredCounts[tag.id] || 0}
                </span>
                {tag.id !== 'all' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(tag.id, tag.name);
                    }}
                    title="重命名"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontSize: Math.max(9, fs - 3) + 'px',
                      padding: '0 2px',
                      opacity: 0,
                      transition: 'opacity 0.15s',
                      fontFamily: 'inherit',
                    }}
                    className="edit-tag-btn"
                  >
                    ...
                  </button>
                )}
              </>
            )}
          </div>
          );
        })}

        {/* Add tag */}
        {showAddTag ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '4px 12px',
          }}>
            <input
              className="glass-input"
              placeholder="标签名称..."
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTag();
                if (e.key === 'Escape') setShowAddTag(false);
              }}
              autoFocus
              style={{ padding: '6px 10px', fontSize: Math.max(10, fs - 2) + 'px' }}
            />
            <div style={{ display: 'flex', gap: '3px' }}>
              {DEFAULT_COLORS.slice(0, 8).map((color, i) => (
                <div
                  key={color}
                  className={`color-swatch ${tagColorIndex % DEFAULT_COLORS.length === i ? 'selected' : ''}`}
                  style={{
                    background: color,
                    width: '18px',
                    height: '18px',
                  }}
                  onClick={() => setTagColorIndex(i)}
                />
              ))}
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className="glass-btn" onClick={handleAddTag} style={{ flex: 1, padding: '4px 8px', fontSize: Math.max(9, fs - 3) + 'px' }}>
                添加
              </button>
              <button className="glass-btn" onClick={() => setShowAddTag(false)} style={{ padding: '4px 8px', fontSize: Math.max(9, fs - 3) + 'px' }}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddTag(true)}
            className="hover-ring-light"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '7px 12px',
              background: 'none',
              border: '1px dashed var(--glass-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: Math.max(10, fs - 2) + 'px',
              fontFamily: 'inherit',
            }}
          >
            + 添加标签
          </button>
        )}
      </div>

      {/* Screenshot buttons — pinned to the bottom of the sidebar */}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '5px' }}>
        <button
          onClick={() => {
            window.electronAPI?.startScreenshot();
          }}
          className="hover-ring-light"
          style={{
            width: '100%',
            padding: '9px',
            background: 'var(--glass-bg-light)',
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-secondary)',
            fontSize: Math.max(10, fs - 2) + 'px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '5px',
            fontFamily: 'inherit',
          }}
        >
          截图
        </button>

        <button
          onClick={() => {
            window.electronAPI?.startLongScreenshot();
          }}
          className="hover-ring-light"
          style={{
            width: '100%',
            padding: '9px',
            background: 'var(--glass-bg-light)',
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-secondary)',
            fontSize: Math.max(10, fs - 2) + 'px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '5px',
            fontFamily: 'inherit',
          }}
        >
          长截图
        </button>
      </div>
    </div>
  );
};

// Inject hover style for edit button
const style = document.createElement('style');
style.textContent = `
  .edit-tag-btn { opacity: 0; }
  div:hover > .edit-tag-btn { opacity: 1 !important; }
`;
if (!document.querySelector('style[data-sidebar]')) {
  style.setAttribute('data-sidebar', 'true');
  document.head.appendChild(style);
}

export default Sidebar;
