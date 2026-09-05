import React, { useState, useRef, useEffect } from 'react';
import { useNoteStore } from '../store';
import { fs, fsn } from '../utils';
import { DEFAULT_COLORS } from '../types';
import ColorPicker from './ColorPicker';
import { askConfirm } from './ConfirmDialog';

interface SettingsDialogProps { onClose: () => void; }

const ShortcutInput: React.FC<{ value: string; onSet: (v: string) => void; gfs: number }> = ({ value, onSet, gfs }) => {
  const [capture, setCapture] = useState(false);
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: fs(4, gfs), position: 'relative' }}>
      <button className="glass-btn" onClick={() => setCapture(!capture)}
        style={{ fontSize: fs(11, gfs), padding: `${fs(3, gfs)} ${fs(8, gfs)}`, fontFamily: 'monospace', minWidth: fsn(90, gfs), textAlign: 'center',
          background: capture ? 'var(--accent)' : 'var(--glass-bg-light)', color: capture ? '#fff' : 'var(--text-primary)' }}>
        {capture ? '...' : value}
      </button>
      {capture && (
        <input autoFocus style={{ position: 'absolute', opacity: 0, width: '100%', height: '100%', left: 0, top: 0 }}
          onKeyDown={(e) => {
            e.preventDefault();
            const parts: string[] = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Meta');
            const k = e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta' ? '' : e.key.toUpperCase();
            if (k) parts.push(k);
            if (parts.length >= 2) { onSet(parts.join('+')); setCapture(false); }
          }}
          onBlur={() => setCapture(false)}
        />
      )}
    </div>
  );
};

const FONT_LIST = [
  { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif', name: '系统默认' },
  { family: '"Microsoft YaHei", "PingFang SC", sans-serif', name: '微软雅黑' },
  { family: '"Noto Sans SC", sans-serif', name: 'Noto Sans SC' },
  { family: '"SimSun", "宋体", serif', name: '宋体' },
  { family: '"KaiTi", "楷体", serif', name: '楷体' },
  { family: 'Georgia, "Times New Roman", serif', name: 'Georgia' },
  { family: '"Courier New", "Source Code Pro", monospace', name: '等宽字体' },
];

const SettingsDialog: React.FC<SettingsDialogProps> = ({ onClose }) => {
  const { settings, updateSettings, saveData } = useNoteStore();
  const gfs = settings.fontSize;
  const [localSettings, setLocalSettings] = useState({ ...settings });
  // Sync external settings changes (e.g. font size shortcut) into local state
  useEffect(() => { setLocalSettings(prev => ({ ...prev, ...settings })); }, [settings]);
  const [fontOpen, setFontOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerColor, setPickerColor] = useState('#ffffff');
  const [hoverSwatch, setHoverSwatch] = useState<string | null>(null);
  const bgFileRef = useRef<HTMLInputElement>(null);
  const [bgError, setBgError] = useState<string | null>(null);
  const [hoverDelete, setHoverDelete] = useState<string | null>(null);
  const [hoverEdit, setHoverEdit] = useState<string | null>(null);
  const [editingColor, setEditingColor] = useState<string | null>(null);
  const fontDropdownRef = useRef<HTMLDivElement>(null);
  const [dataDirPath, setDataDirPath] = useState('');
  const [prevDir, setPrevDir] = useState<string | null>(null);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getDataDirectory().then((info) => {
        setDataDirPath(info.path);
        setPrevDir(info.prevDir);
      });
    }
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (fontDropdownRef.current && !fontDropdownRef.current.contains(e.target as HTMLElement)) setFontOpen(false);
    };
    if (fontOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fontOpen]);

  const handleChange = (key: string, value: any) => setLocalSettings((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    updateSettings(localSettings);
    saveData();
    // Sync shortcuts to main process only when settings are saved
    if (window.electronAPI) {
      window.electronAPI.updateShortcuts(localSettings);
    }
    onClose();
  };

  // Read a background image in the renderer (FileReader + downscale), so import
  // does NOT depend on the main-process file IPC that could silently fail. The
  // result is embedded as a data URL and previewed here; persisted on 保存.
  const readBgFile = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('不是有效的图片文件'));
      img.onload = () => {
        const MAX = 1920; // keep the stored JSON small
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { const s = Math.min(MAX / w, MAX / h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d')!.drawImage(img, 0, 0, w, h);
        const isPhoto = /jpe?g|bmp/i.test(file.type);
        resolve(c.toDataURL(isPhoto ? 'image/jpeg' : 'image/png', 0.9));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });

  const handlePickBackground = () => {
    setBgError(null);
    bgFileRef.current?.click();
  };

  const handleBackgroundFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const dataUrl = await readBgFile(f);
      handleChange('backgroundImage', dataUrl);
      // Apply live (same as font size / opacity sliders); 保存 then persists it.
      updateSettings({ backgroundImage: dataUrl });
    } catch (err) {
      setBgError(err instanceof Error ? err.message : String(err));
    }
  };

  const changeDataDir = async () => {
    if (!window.electronAPI) return;
    const dir = await window.electronAPI.pickDataDirectory();
    if (!dir) return;
    askConfirm({
      title: '更改数据目录',
      message: '数据将迁移到新目录。旧数据会暂时保留，直到您退出软件；退出前可在设置中回退到旧目录。应用即将重启。',
      confirmLabel: '继续',
      danger: false,
      onConfirm: () => { window.electronAPI?.setDataDirectory(dir); },
    });
  };

  const revertDataDir = () => {
    if (!window.electronAPI || !prevDir) return;
    askConfirm({
      title: '回退数据目录',
      message: `将回退到旧目录：\n${prevDir}\n\n当前数据会迁移过去，应用即将重启。`,
      confirmLabel: '回退',
      danger: false,
      onConfirm: () => { window.electronAPI?.setDataDirectory(prevDir); },
    });
  };

  const currentFontName = FONT_LIST.find(f => f.family === localSettings.fontFamily)?.name || '系统默认';

  const dw = fsn(480, gfs);

  return (
    <div className="dialog-overlay"
      onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdTarget = e.target === e.currentTarget ? '1' : '0'; }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdTarget === '1') onClose();
      }}>
      <div className="dialog animate-scale-in" onClick={(e) => e.stopPropagation()} style={{ minWidth: dw, maxHeight: '85vh' }}>
        <h3 style={{ fontSize: fs(18, gfs), marginBottom: fs(20, gfs) }}>设置</h3>

        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>主题模式</label>
          <div style={{ display: 'flex', gap: fs(8, gfs) }}>
            {(['dark', 'light'] as const).map((t) => (
              <button key={t} onClick={() => {
                // Theme switches apply immediately (and persist) — no "保存设置"
                // needed; every other setting still waits for the save button.
                setLocalSettings(prev => ({ ...prev, theme: t }));
                updateSettings({ theme: t });
                saveData();
              }} className={localSettings.theme === t ? 'hover-ring-dark' : 'hover-ring-light'} style={{
                flex: 1, padding: `${fs(9, gfs)} ${fs(14, gfs)}`, border: '1px solid',
                borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: fs(13, gfs), fontFamily: 'inherit',
                transition: 'all var(--transition)',
                background: localSettings.theme === t ? 'var(--accent)' : 'var(--glass-bg-light)',
                color: localSettings.theme === t ? '#fff' : 'var(--text-secondary)',
                borderColor: localSettings.theme === t ? 'var(--accent)' : 'var(--glass-border)',
              }}>{t === 'dark' ? '深色' : '浅色'}</button>
            ))}
          </div>
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>数据目录</label>
          <div style={{ fontSize: fs(11, gfs), color: 'var(--text-muted)', marginBottom: fs(8, gfs), wordBreak: 'break-all' }}>{dataDirPath || '…'}</div>
          <div style={{ display: 'flex', gap: fs(6, gfs), alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="glass-btn" onClick={changeDataDir} style={{ fontSize: fs(12, gfs), padding: `${fs(6, gfs)} ${fs(12, gfs)}` }}>更改目录</button>
            {prevDir && (
              <button className="glass-btn" onClick={revertDataDir} style={{ fontSize: fs(12, gfs), padding: `${fs(6, gfs)} ${fs(12, gfs)}` }}>回退到旧目录</button>
            )}
            <button
              className="glass-btn"
              onClick={() => window.electronAPI?.setDataDirectory('')}
              style={{ fontSize: fs(12, gfs), padding: `${fs(6, gfs)} ${fs(12, gfs)}` }}
            >恢复默认位置</button>
          </div>
          <div style={{ fontSize: fs(10, gfs), color: 'var(--text-muted)', marginTop: fs(6, gfs), lineHeight: 1.6 }}>
            更改后自动重启；旧数据保留到退出，退出前可回退。「恢复默认位置」将数据目录改回系统默认。
          </div>
        </div>

        <div style={sectionStyle} ref={fontDropdownRef}>
          <label style={labelStyle(gfs)}>字体</label>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setFontOpen(!fontOpen)} className="hover-ring-light" style={{
              width: '100%', padding: `${fs(10, gfs)} ${fs(14, gfs)}`,
              background: 'var(--glass-bg-light)', backdropFilter: 'blur(10px)',
              border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)', fontSize: fs(13, gfs), fontFamily: 'inherit', cursor: 'pointer',
              textAlign: 'left', display: 'flex', justifyContent: 'space-between', transition: 'all var(--transition)',
            }}>
              <span style={{ fontFamily: localSettings.fontFamily }}>{currentFontName}</span>
              <span style={{ color: 'var(--text-muted)', transform: fontOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▾</span>
            </button>
            {fontOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10001,
                background: 'var(--dropdown-bg)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
                border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
                boxShadow: '0 12px 40px rgba(0,0,0,0.35)', overflow: 'hidden', animation: 'scaleIn 0.15s ease-out',
              }}>
                {FONT_LIST.map((f) => (
                  <button key={f.family} onClick={() => { handleChange('fontFamily', f.family); setFontOpen(false); }} className="hover-ring-light" style={{
                    width: '100%', padding: `${fs(9, gfs)} ${fs(14, gfs)}`,
                    background: localSettings.fontFamily === f.family ? 'var(--glass-bg-hover)' : 'transparent',
                    border: 'none', color: localSettings.fontFamily === f.family ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontSize: fs(13, gfs), fontFamily: f.family, cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                  }}>{f.name}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>字体大小: <strong>{localSettings.fontSize}px</strong></label>
          <input type="range" min="11" max="28" value={localSettings.fontSize}
            onChange={(e) => { const v = parseInt(e.target.value); handleChange('fontSize', v); updateSettings({ fontSize: v }); }} style={rangeStyle} />
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>背景图片</label>
          <input ref={bgFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBackgroundFile} />
          <div style={{ display: 'flex', gap: fs(6, gfs), alignItems: 'center', marginBottom: fs(6, gfs) }}>
            <button className="glass-btn" onClick={handlePickBackground} style={{ fontSize: fs(12, gfs), padding: `${fs(6, gfs)} ${fs(12, gfs)}` }}>选择图片</button>
            {localSettings.backgroundImage && (
              <>
                <button className="glass-btn" onClick={() => { handleChange('backgroundImage', null); updateSettings({ backgroundImage: null }); }} style={{ color: 'var(--danger)', fontSize: fs(12, gfs) }}>清除</button>
                <span style={{ fontSize: fs(11, gfs), color: 'var(--text-secondary)' }}>已应用（点「保存」以持久化）</span>
              </>
            )}
          </div>
          {localSettings.backgroundImage && (
            <img src={localSettings.backgroundImage} alt="背景预览"
              style={{ width: '100%', maxHeight: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--glass-border)' }} />
          )}
          {bgError && (
            <div style={{ marginTop: 6, fontSize: fs(11, gfs), color: '#ff8a8a' }}>背景图导入失败：{bgError}</div>
          )}
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>背景不透明度: <strong>{Math.round(localSettings.backgroundOpacity * 100)}%</strong></label>
          <input type="range" min="0" max="100" value={Math.round(localSettings.backgroundOpacity * 100)}
            onChange={(e) => { const v = parseInt(e.target.value) / 100; handleChange('backgroundOpacity', v); updateSettings({ backgroundOpacity: v }); }} style={rangeStyle} />
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>网格间距: <strong>{localSettings.gridSize}px</strong></label>
          <input type="range" min="10" max="60" step="5" value={localSettings.gridSize}
            onChange={(e) => handleChange('gridSize', parseInt(e.target.value))} style={rangeStyle} />
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>默认便笺颜色</label>
          <div style={{ display: 'flex', gap: fs(5, gfs), flexWrap: 'wrap', alignItems: 'center' }}>
            {DEFAULT_COLORS.map((c) => (
              <div key={c} className={`color-swatch ${localSettings.defaultNoteColor === c ? 'selected' : ''}`}
                style={{ background: c, width: fsn(26, gfs), height: fsn(26, gfs) }} onClick={() => handleChange('defaultNoteColor', c)} />
            ))}
            {(localSettings.customNoteColors || []).map((c) => (
              <div key={c} style={{ position: 'relative', display: 'inline-block' }}
                onMouseEnter={() => setHoverSwatch(c)} onMouseLeave={() => { setHoverSwatch(null); setHoverDelete(null); setHoverEdit(null); }}>
                <div className={`color-swatch ${localSettings.defaultNoteColor === c ? 'selected' : ''}`}
                  style={{ background: c, width: fsn(26, gfs), height: fsn(26, gfs) }} onClick={() => handleChange('defaultNoteColor', c)} />
                {/* Pencil — bottom-left */}
                <button onClick={(e) => {
                  e.stopPropagation();
                  setEditingColor(c);
                  setPickerColor(c);
                  setShowPicker(true);
                }} onMouseEnter={() => setHoverEdit(c)} onMouseLeave={() => setHoverEdit(null)} style={{
                  position: 'absolute', bottom: '-5px', left: '-5px',
                  width: fsn(14, gfs), height: fsn(14, gfs), borderRadius: '50%',
                  border: 'none', color: '#fff',
                  fontSize: fs(8, gfs), cursor: hoverSwatch === c ? 'pointer' : 'default',
                  display: 'flex', transition: 'opacity 0.15s',
                  opacity: hoverSwatch === c ? 1 : 0,
                  background: hoverEdit === c ? '#2196F3' : 'rgba(120,120,120,0.7)',
                  alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}>✎</button>
                {/* Delete X — top-right */}
                <button onClick={(e) => {
                  e.stopPropagation();
                  const newCustom = (localSettings.customNoteColors || []).filter(x => x !== c);
                  handleChange('customNoteColors', newCustom);
                  if (localSettings.defaultNoteColor === c) handleChange('defaultNoteColor', DEFAULT_COLORS[0]);
                }} onMouseEnter={() => setHoverDelete(c)} onMouseLeave={() => setHoverDelete(null)} style={{
                  position: 'absolute', top: '-5px', right: '-5px',
                  width: fsn(14, gfs), height: fsn(14, gfs), borderRadius: '50%',
                  border: 'none', color: '#fff',
                  fontSize: fs(8, gfs), cursor: hoverSwatch === c ? 'pointer' : 'default',
                  display: 'flex', transition: 'opacity 0.15s',
                  opacity: hoverSwatch === c ? 1 : 0,
                  background: hoverDelete === c ? 'var(--danger)' : 'rgba(120,120,120,0.7)',
                  alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}>x</button>
              </div>
            ))}
            {/* + button to open color picker */}
            <div style={{ position: 'relative' }}>
              <button className="glass-btn" onClick={() => { setEditingColor(null); setPickerColor('#ffffff'); setShowPicker(true); }} style={{
                width: fsn(26, gfs), height: fsn(26, gfs), borderRadius: '50%',
                padding: 0, fontSize: fs(18, gfs), display: 'flex', lineHeight: 1,
                alignItems: 'center', justifyContent: 'center',
                background: 'var(--glass-bg-light)',
                color: 'var(--text-muted)', border: '1px dashed var(--glass-border)',
              }}>+</button>
            </div>
          </div>

          {/* Color picker overlay */}
          {showPicker && (
            <div className="dialog-overlay" style={{ zIndex: 10002 }}
              onMouseDown={(e) => { (e.currentTarget as HTMLElement).dataset.mdTarget = e.target === e.currentTarget ? '1' : '0'; }}
              onMouseUp={(e) => {
                if (e.target === e.currentTarget && (e.currentTarget as HTMLElement).dataset.mdTarget === '1') {
                  const custom = localSettings.customNoteColors || [];
                  if (editingColor) {
                    // Editing existing color — replace old with new
                    const replaced = custom.map(x => x === editingColor ? pickerColor : x);
                    handleChange('customNoteColors', replaced);
                    if (localSettings.defaultNoteColor === editingColor) handleChange('defaultNoteColor', pickerColor);
                  } else {
                    // Adding new color
                    if (!custom.includes(pickerColor)) {
                      handleChange('customNoteColors', [...custom, pickerColor]);
                    }
                  }
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

        {/* Configurable shortcuts */}
        <div style={sectionStyle}>
          <label style={labelStyle(gfs)}>快捷键设置</label>
          <div style={{ fontSize: fs(10, gfs), color: 'var(--text-muted)', marginBottom: fs(8, gfs) }}>点击按钮后按下组合键（最多4键）</div>
          {[
            { key: 'shortcutScreenshot', label: '截图', def: 'Ctrl+Shift+X' },
            { key: 'shortcutLongScreenshot', label: '长截图', def: 'Ctrl+Shift+Alt+X' },
            { key: 'shortcutPenetrate', label: '磁贴穿透', def: 'Ctrl+P' },
            { key: 'shortcutCloseAll', label: '关闭全部磁贴', def: 'Ctrl+Shift+W' },
            { key: 'shortcutTransparent', label: '磁贴透明', def: 'Ctrl+Shift+T' },
          ].map(sc => (
            <div key={sc.key} style={{ display: 'flex', alignItems: 'center', gap: fs(8, gfs), marginBottom: fs(6, gfs) }}>
              <span style={{ fontSize: fs(12, gfs), color: 'var(--text-secondary)', minWidth: fsn(80, gfs) }}>{sc.label}</span>
              <ShortcutInput value={(localSettings as any)[sc.key] || sc.def} onSet={(v) => handleChange(sc.key, v)} gfs={gfs} />
            </div>
          ))}
        </div>

        <div className="dialog-actions">
          <button className="glass-btn" onClick={onClose} style={{ fontSize: fs(13, gfs), padding: `${fs(8, gfs)} ${fs(16, gfs)}` }}>取消</button>
          <button onClick={handleSave} className="btn-accent" style={{
            padding: `${fs(9, gfs)} ${fs(22, gfs)}`,
            borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: fs(13, gfs),
            fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>保存设置</button>
        </div>
      </div>
    </div>
  );
};

const sectionStyle: React.CSSProperties = { marginBottom: '16px' };
const labelStyle = (g: number): React.CSSProperties => ({
  display: 'block', fontSize: fs(12, g), color: 'var(--text-secondary)', marginBottom: fs(6, g), fontWeight: 500,
});
const rangeStyle: React.CSSProperties = {
  width: '100%', height: '5px', borderRadius: '3px', background: 'var(--glass-border)',
  outline: 'none', WebkitAppearance: 'none', appearance: 'none', cursor: 'pointer',
};

export default SettingsDialog;
