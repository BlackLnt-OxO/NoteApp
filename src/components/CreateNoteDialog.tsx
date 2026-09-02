import React, { useState, useRef } from 'react';
import { useNoteStore } from '../store';
import { DEFAULT_COLORS } from '../types';
import ColorPicker from './ColorPicker';
import { fs, fsn } from '../utils';

interface CreateNoteDialogProps { onClose: () => void; }

const CreateNoteDialog: React.FC<CreateNoteDialogProps> = ({ onClose }) => {
  const { addNote, tags, settings, updateSettings, saveData } = useNoteStore();
  const gfs = settings.fontSize;
  const [content, setContent] = useState('');
  const [selectedColor, setSelectedColor] = useState(settings.defaultNoteColor);
  const [selectedTag, setSelectedTag] = useState('general');
  const [images, setImages] = useState<{ id: string; dataUrl: string; fileName?: string }[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Color picker state
  const [showPicker, setShowPicker] = useState(false);
  const [pickerColor, setPickerColor] = useState('#ffffff');
  const [editingColor, setEditingColor] = useState<string | null>(null);
  const [hoverSwatch, setHoverSwatch] = useState<string | null>(null);
  const [hoverDelete, setHoverDelete] = useState<string | null>(null);
  const [hoverEdit, setHoverEdit] = useState<string | null>(null);
  const customColors = settings.customNoteColors || [];

  const handleCreate = () => {
    const colsPerRow = 3;
    const count = useNoteStore.getState().notes.length;
    addNote({
      content, color: selectedColor, tag: selectedTag, images,
      gridX: 0, gridY: 0,
    });
    onClose();
  };

  const handlePickImage = async () => {
    if (window.electronAPI) {
      const r = await window.electronAPI.pickImage();
      if (r?.dataUrl) setImages(p => [...p, { id: 'img_' + Date.now(), dataUrl: r.dataUrl, fileName: r.filePath?.split(/[\\/]/).pop() || 'image.png' }]);
    } else fileInputRef.current?.click();
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    Array.from(e.target.files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => setImages(p => [...p, { id: 'img_' + Date.now(), dataUrl: ev.target?.result as string, fileName: file.name }]);
      reader.readAsDataURL(file);
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDraggingOver(false);
    if (!e.dataTransfer.files) return;
    Array.from(e.dataTransfer.files).forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => setImages(p => [...p, { id: 'img_' + Date.now(), dataUrl: ev.target?.result as string, fileName: file.name }]);
        reader.readAsDataURL(file);
      }
    });
  };

  const dw = fsn(460, gfs);

  return (
    <div className="dialog-overlay"
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdTarget = e.target === e.currentTarget ? '1' : '0'; }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdTarget === '1') onClose();
      }}>
      <div className="dialog animate-scale-in" onClick={(e) => e.stopPropagation()} style={{ minWidth: dw }}>
        <h3 style={{ fontSize: fs(18, gfs), marginBottom: fs(18, gfs) }}>新建便笺</h3>

        <div style={{ marginBottom: fs(14, gfs) }}>
          <label style={lbl(gfs)}>内容</label>
          <textarea className="glass-input" value={content} onChange={(e) => setContent(e.target.value)}
            placeholder="输入便笺内容..." autoFocus
            style={{ minHeight: fsn(90, gfs), resize: 'vertical', fontFamily: 'inherit', fontSize: fs(13, gfs), transition: 'none' }} />
        </div>

        <div style={{ marginBottom: fs(14, gfs) }}>
          <label style={lbl(gfs)}>标签分类</label>
          <div style={{ display: 'flex', gap: fs(5, gfs), flexWrap: 'wrap' }}>
            {tags.filter(t => t.id !== 'all').map((tag) => (
              <button key={tag.id} onClick={() => setSelectedTag(tag.id)} style={{
                padding: `${fs(5, gfs)} ${fs(12, gfs)}`, borderRadius: fs(18, gfs),
                border: selectedTag === tag.id ? `2px solid ${tag.color}` : '1px solid var(--glass-border)',
                background: selectedTag === tag.id ? `${tag.color}33` : 'var(--glass-bg-light)',
                color: 'var(--text-primary)', cursor: 'pointer', fontSize: fs(12, gfs), fontFamily: 'inherit',
                transition: 'all var(--transition)', display: 'flex', alignItems: 'center', gap: fs(5, gfs),
              }}>
                <span style={{ width: fs(7, gfs), height: fs(7, gfs), borderRadius: '50%', background: tag.color }} />
                {tag.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: fs(14, gfs) }}>
          <label style={lbl(gfs)}>颜色</label>
          <div style={{ display: 'flex', gap: fs(5, gfs), flexWrap: 'wrap', alignItems: 'center' }}>
            {DEFAULT_COLORS.map((c) => (
              <div key={c} className={`color-swatch ${selectedColor === c ? 'selected' : ''}`}
                style={{ background: c, width: fsn(28, gfs), height: fsn(28, gfs) }} onClick={() => setSelectedColor(c)} />
            ))}
            {customColors.map((c) => (
              <div key={c} style={{ position: 'relative', display: 'inline-block' }}
                onMouseEnter={() => setHoverSwatch(c)} onMouseLeave={() => { setHoverSwatch(null); setHoverDelete(null); setHoverEdit(null); }}>
                <div className={`color-swatch ${selectedColor === c ? 'selected' : ''}`}
                  style={{ background: c, width: fsn(28, gfs), height: fsn(28, gfs) }} onClick={() => setSelectedColor(c)} />
                {/* Pencil — bottom-left */}
                <button onClick={(e) => {
                  e.stopPropagation();
                  setEditingColor(c); setPickerColor(c); setShowPicker(true);
                }} onMouseEnter={() => setHoverEdit(c)} onMouseLeave={() => setHoverEdit(null)} style={{
                  position: 'absolute', bottom: '-5px', left: '-5px',
                  width: fsn(14, gfs), height: fsn(14, gfs), borderRadius: '50%',
                  border: 'none', color: '#fff', fontSize: fs(7, gfs),
                  cursor: hoverSwatch === c ? 'pointer' : 'default',
                  display: 'flex', transition: 'opacity 0.15s',
                  opacity: hoverSwatch === c ? 1 : 0,
                  background: hoverEdit === c ? '#2196F3' : 'rgba(120,120,120,0.7)',
                  alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}>✎</button>
                {/* Delete X — top-right */}
                <button onClick={(e) => {
                  e.stopPropagation();
                  const newCustom = customColors.filter(x => x !== c);
                  updateSettings({ customNoteColors: newCustom });
                  saveData();
                  if (selectedColor === c) setSelectedColor(DEFAULT_COLORS[0]);
                }} onMouseEnter={() => setHoverDelete(c)} onMouseLeave={() => setHoverDelete(null)} style={{
                  position: 'absolute', top: '-5px', right: '-5px',
                  width: fsn(14, gfs), height: fsn(14, gfs), borderRadius: '50%',
                  border: 'none', color: '#fff', fontSize: fs(7, gfs),
                  cursor: hoverSwatch === c ? 'pointer' : 'default',
                  display: 'flex', transition: 'opacity 0.15s',
                  opacity: hoverSwatch === c ? 1 : 0,
                  background: hoverDelete === c ? 'var(--danger)' : 'rgba(120,120,120,0.7)',
                  alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}>x</button>
              </div>
            ))}
            {/* + button */}
            <button className="glass-btn" onClick={() => { setEditingColor(null); setPickerColor('#ffffff'); setShowPicker(true); }} style={{
              width: fsn(28, gfs), height: fsn(28, gfs), borderRadius: '50%',
              padding: 0, fontSize: fs(18, gfs), display: 'flex', lineHeight: 1,
              alignItems: 'center', justifyContent: 'center',
              background: 'var(--glass-bg-light)',
              color: 'var(--text-muted)', border: '1px dashed var(--glass-border)',
            }}>+</button>
          </div>
          {/* Color picker overlay */}
          {showPicker && (
            <div className="dialog-overlay" style={{ zIndex: 10003 }}
              onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdTarget = e.target === e.currentTarget ? '1' : '0'; }}
              onMouseUp={(e) => {
                if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdTarget === '1') {
                  if (editingColor) {
                    const replaced = customColors.map(x => x === editingColor ? pickerColor : x);
                    updateSettings({ customNoteColors: replaced });
                    if (settings.defaultNoteColor === editingColor) updateSettings({ defaultNoteColor: pickerColor });
                  } else {
                    if (!customColors.includes(pickerColor)) {
                      updateSettings({ customNoteColors: [...customColors, pickerColor] });
                    }
                  }
                  saveData();
                  setShowPicker(false);
                }
              }}>
              <ColorPicker
                color={editingColor || '#ffffff'}
                onChange={setPickerColor}
                gfs={gfs}
              />
            </div>
          )}
        </div>

        <div style={{ marginBottom: fs(14, gfs) }}>
          <label style={lbl(gfs)}>图片</label>
          <div onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }} onDragLeave={() => setIsDraggingOver(false)}
            onDrop={handleDrop} onClick={handlePickImage} style={{
              border: `2px dashed ${isDraggingOver ? 'var(--accent)' : 'var(--glass-border)'}`,
              borderRadius: 'var(--radius-md)', padding: fs(18, gfs), textAlign: 'center', cursor: 'pointer',
              background: isDraggingOver ? 'rgba(107,92,231,0.08)' : 'var(--glass-bg-light)',
              marginBottom: fs(8, gfs), fontSize: fs(13, gfs), color: 'var(--text-secondary)',
            }}>
            点击选择图片或拖拽图片到此处
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileInput} />
          {images.length > 0 && (
            <div style={{ display: 'flex', gap: fs(6, gfs), flexWrap: 'wrap' }}>
              {images.map((img) => (
                <div key={img.id} style={{ position: 'relative', width: fsn(72, gfs), height: fsn(72, gfs), borderRadius: fs(6, gfs), overflow: 'hidden' }}>
                  <img src={img.dataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <button onClick={() => setImages(p => p.filter(i => i.id !== img.id))} style={{
                    position: 'absolute', top: '2px', right: '2px', width: fsn(18, gfs), height: fsn(18, gfs),
                    borderRadius: '50%', background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff',
                    fontSize: fs(10, gfs), cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>x</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button className="glass-btn" onClick={onClose} style={{ fontSize: fs(13, gfs), padding: `${fs(8, gfs)} ${fs(16, gfs)}` }}>取消</button>
          <button onClick={handleCreate} className="btn-accent" style={{
            padding: `${fs(9, gfs)} ${fs(22, gfs)}`,
            borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: fs(13, gfs),
            fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>创建便笺</button>
        </div>
      </div>
    </div>
  );
};

const lbl = (g: number): React.CSSProperties => ({
  display: 'block', fontSize: fs(12, g), color: 'var(--text-secondary)', marginBottom: fs(5, g), fontWeight: 500,
});

export default CreateNoteDialog;
