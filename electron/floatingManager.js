const { BrowserWindow, screen, app } = require('electron');
const path = require('path');
const fs = require('fs');

const floatingWindows = new Map();

function createFloatingNote(noteData, isDev) {
  const noteId = noteData.id || `float-${Date.now()}`;

  if (floatingWindows.has(noteId)) {
    const existing = floatingWindows.get(noteId);
    if (!existing.isDestroyed()) existing.close();
    floatingWindows.delete(noteId);
  }

  // Save/load float state
  const userDataPath = app.getPath('userData');
  const floatDir = path.join(userDataPath, 'floating-notes');
  if (!fs.existsSync(floatDir)) fs.mkdirSync(floatDir, { recursive: true });
  const floatStateFile = path.join(floatDir, `${noteId}.json`);
  if (!fs.existsSync(floatStateFile)) {
    fs.writeFileSync(floatStateFile, JSON.stringify({
      content: noteData.content || '',
      color: noteData.color || '#2d2d44',
      fontSize: noteData.fontSize || 14,
      images: noteData.images || [],
      settingsBgOpacity: noteData.settingsBgOpacity || 0.3,
    }), 'utf-8');
  } else {
    try {
      const saved = JSON.parse(fs.readFileSync(floatStateFile, 'utf-8'));
      saved.content = noteData.content;
      saved.color = noteData.color;
      saved.fontSize = noteData.fontSize;
      fs.writeFileSync(floatStateFile, JSON.stringify(saved), 'utf-8');
    } catch(e) {}
  }

  const savedState = JSON.parse(fs.readFileSync(floatStateFile, 'utf-8'));

  // Center on current screen (where main window is), fallback to primary
  let defX, defY;
  try {
    const allWins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    const targetWin = allWins.length > 0 ? allWins[0] : null;
    if (targetWin) {
      const bounds = targetWin.getBounds();
      const disp = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      const { width: sw, height: sh } = disp.workArea;
      defX = Math.round(sw / 2 - 160);
      defY = Math.round(sh / 2 - 140);
    }
  } catch(e) { console.error('Float center calc error:', e); }
  if (defX == null) {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    defX = Math.round(sw / 2 - 160);
    defY = Math.round(sh / 2 - 140);
  }

  // Use saved position if it's still on a visible display
  let sx = savedState.x, sy = savedState.y;
  if (sx != null && sy != null) {
    const allDisplays = screen.getAllDisplays();
    let onScreen = false;
    for (const d of allDisplays) {
      const { x: dx, y: dy, width: dw, height: dh } = d.workArea;
      if (sx + 100 > dx && sy + 100 > dy && sx < dx + dw && sy < dy + dh) {
        onScreen = true; break;
      }
    }
    if (!onScreen) { sx = undefined; sy = undefined; }
  }

  const floatWin = new BrowserWindow({
    width: savedState.width || 260,
    height: savedState.height || 220,
    x: sx != null ? sx : (noteData.x || defX),
    y: sy != null ? sy : (noteData.y || defY),
    minWidth: 160,
    minHeight: 120,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  floatWin.setAlwaysOnTop(true, 'floating');
  floatWin.setVisibleOnAllWorkspaces(true);

  // Generate lightweight HTML
  const html = generateFloatHTML(noteId, savedState, noteData);
  const tempFile = path.join(floatDir, `${noteId}.html`);
  fs.writeFileSync(tempFile, html, 'utf-8');
  floatWin.loadFile(tempFile);

  // Persist position & size (225ms debounce, normalized for cross-DPI consistency)
  let saveBoundsTimer;
  const saveBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (floatWin.isDestroyed()) return;
      try {
        const bounds = floatWin.getBounds();
        const disp = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
        const sf = (disp && disp.scaleFactor) || 1;
        const data = JSON.parse(fs.readFileSync(floatStateFile, 'utf-8'));
        data.x = Math.round(bounds.x);
        data.y = Math.round(bounds.y);
        data.width = Math.round(bounds.width / sf);
        data.height = Math.round(bounds.height / sf);
        fs.writeFileSync(floatStateFile, JSON.stringify(data), 'utf-8');
      } catch(e) {}
    }, 225);
  };
  floatWin.on('move', saveBounds);
  floatWin.on('resize', saveBounds);

  floatWin.on('closed', () => {
    clearTimeout(saveBoundsTimer);
    floatingWindows.delete(noteId);
    try { fs.unlinkSync(tempFile); } catch(e) {}
  });

  floatingWindows.set(noteId, floatWin);
  return noteId;
}

function generateFloatHTML(noteId, state, noteData) {
  const color = state.color || '#2d2d44';
  const content = (state.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fontSize = state.fontSize || 14;
  const images = state.images || [];
  let imgsHTML = '';
  if (images.length) {
    imgsHTML = images.map((img, i) => {
      const h = img._previewH || 100;
      const x = img._imgX != null ? img._imgX : 10;
      const y = img._imgY != null ? img._imgY : 10 + i * (h + 8);
      return `<div class="fi" data-idx="${i}" style="left:${x}px;top:${y}px">
        <img src="${img.dataUrl}" style="height:${h}px" draggable="false" />
        <button class="fidel">x</button>
        <div class="firesizetl"></div>
        <div class="firesize"></div>
      </div>`;
    }).join('');
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@property --sb-alpha { syntax: '<number>'; inherits: true; initial-value: 0; }
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;height:100vh;background:transparent;overflow:hidden;user-select:none}
.root{height:100vh;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;position:relative}
.glass-bg{position:absolute;inset:0;border-radius:16px;background:${color}66;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.2);box-shadow:0 8px 32px rgba(0,0,0,0.3);pointer-events:none;z-index:0}
.root.transparent .glass-bg{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;border-color:transparent;box-shadow:none}
.drag-strip{height:14px;min-height:14px;flex-shrink:0;z-index:2;cursor:grab;-webkit-app-region:drag;transition:background 0.3s}
.drag-strip:hover{background:rgba(255,255,255,0.06)}
.scroll-area{flex:1;overflow-y:auto;overflow-x:hidden;position:relative;z-index:1;--sb-alpha:0;transition:--sb-alpha 0.45s ease;-webkit-app-region:no-drag;border-radius:0 0 16px 16px}
.scroll-area:hover{--sb-alpha:0.2}
.scroll-area::-webkit-scrollbar{width:5px}
.scroll-area::-webkit-scrollbar-track{background:transparent}
.scroll-area::-webkit-scrollbar-thumb{background:rgb(255 255 255 / var(--sb-alpha));border-radius:2px}
.content{padding:14px;min-height:100%;color:rgba(255,255,255,0.95);font-size:${fontSize}px;line-height:1.5;outline:none;white-space:pre-wrap;word-break:break-word}
.content[contenteditable="true"]{user-select:text;-webkit-user-select:text}
.content[contenteditable="false"]{user-select:none;pointer-events:none}
.fi{position:absolute;z-index:5;line-height:0;-webkit-app-region:no-drag}
.fi img{border-radius:5px;display:block;cursor:grab}
.fidel{position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.6);border:none;color:#fff;font-size:10px;cursor:pointer;opacity:0;transition:opacity 0.15s;display:flex;align-items:center;justify-content:center}
.fi:hover .fidel{opacity:1}
.firesizetl{position:absolute;top:0;left:0;width:14px;height:14px;cursor:nwse-resize;opacity:0;transition:opacity 0.15s;background:linear-gradient(135deg,rgba(255,255,255,0.4) 50%,transparent 50%)}
.firesize{position:absolute;bottom:1px;right:1px;width:14px;height:14px;cursor:nwse-resize;opacity:0;transition:opacity 0.15s;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,0.4) 50%)}
.fi:hover .firesize{opacity:1}
</style></head><body>
<div class="root" id="root">
<div class="glass-bg"></div>
<div class="drag-strip"></div>
<div class="scroll-area">
<div class="content" id="content" contenteditable="true">${content}</div>
${imgsHTML}
</div>
</div>
<script>
let penetrate = false;
let transparent = false;
const root = document.getElementById('root');
const scrollArea = document.querySelector('.scroll-area');
const content = document.getElementById('content');
let imgData = ${JSON.stringify(images)};

// Listen for global penetrate changes from main process
window.electronAPI.onFloatPenetrateChanged((enabled) => {
  penetrate = enabled;
  content.contentEditable = enabled ? 'false' : 'true';
});
// Listen for transparency toggle
window.electronAPI.onFloatTransparentChanged((enabled) => {
  transparent = enabled;
  if (enabled) root.classList.add('transparent');
  else root.classList.remove('transparent');
});
// Sync text edits
content.addEventListener('input', () => {
  window.electronAPI.updateFloatContent('${noteId}', content.innerText);
});
// Image drag
document.querySelectorAll('.fi').forEach((wrap, idx) => {
  const img = wrap.querySelector('img');
  const del = wrap.querySelector('.fidel');
  const res = wrap.querySelector('.firesize');
  const restl = wrap.querySelector('.firesizetl');
  del.onclick = (e) => { e.stopPropagation(); imgData.splice(idx,1); saveState(); wrap.remove(); };
  // Top-left resize (anchor bottom-right)
  restl.onpointerdown = (e) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY, startH = imgData[idx]._previewH || 100;
    const startImgX = imgData[idx]._imgX != null ? imgData[idx]._imgX : 10;
    const startImgY = imgData[idx]._imgY != null ? imgData[idx]._imgY : 10;
    const ratio = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : 1;
    const startW = ratio * startH;
    document.body.style.cursor = 'nwse-resize';
    const mm = (ev) => {
      const d = Math.max(startX - ev.clientX, startY - ev.clientY);
      const nh = Math.max(30, startH + d);
      const nw = ratio * nh;
      imgData[idx]._previewH = nh; img.style.height = nh + 'px';
      imgData[idx]._imgX = startImgX + startW - nw; wrap.style.left = (startImgX + startW - nw) + 'px';
      imgData[idx]._imgY = startImgY + startH - nh; wrap.style.top = (startImgY + startH - nh) + 'px';
    };
    const mu = () => { document.body.style.cursor=''; window.removeEventListener('pointermove',mm); window.removeEventListener('pointerup',mu); saveState(); };
    window.addEventListener('pointermove', mm); window.addEventListener('pointerup', mu);
  };
  // Bottom-right resize
  res.onpointerdown = (e) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY, startH = imgData[idx]._previewH || 100;
    document.body.style.cursor = 'nwse-resize';
    const mm = (ev) => {
      const d = Math.max(ev.clientX - startX, ev.clientY - startY);
      const nh = Math.max(30, startH + d);
      imgData[idx]._previewH = nh; img.style.height = nh + 'px';
    };
    const mu = () => { document.body.style.cursor=''; window.removeEventListener('pointermove',mm); window.removeEventListener('pointerup',mu); saveState(); };
    window.addEventListener('pointermove', mm); window.addEventListener('pointerup', mu);
  };
  // Drag
  img.onpointerdown = (e) => {
    if (penetrate) return;
    e.preventDefault(); e.stopPropagation();
    const ih = imgData[idx]._previewH || 100;
    const ghostH = ih * 0.92;
    const rect = img.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    const sr = ghostH / ih;
    const ghost = document.createElement('img');
    ghost.src = img.src;
    ghost.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;opacity:0.8;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
    ghost.style.height = ghostH+'px'; ghost.style.width = 'auto';
    ghost.style.left = (e.clientX - offX*sr)+'px'; ghost.style.top = (e.clientY - offY*sr)+'px';
    document.body.appendChild(ghost);
    let moved = false;
    const mm = (ev) => {
      moved = true;
      ghost.style.left = (ev.clientX - offX*sr)+'px'; ghost.style.top = (ev.clientY - offY*sr)+'px';
    };
    const mu = (ev) => {
      ghost.remove();
      window.removeEventListener('pointermove',mm); window.removeEventListener('pointerup',mu);
      if (!moved) return;
      const srect = scrollArea.getBoundingClientRect();
      imgData[idx]._imgX = ev.clientX - srect.left - offX;
      imgData[idx]._imgY = ev.clientY - srect.top - offY;
      wrap.style.left = imgData[idx]._imgX + 'px';
      wrap.style.top = imgData[idx]._imgY + 'px';
      saveState();
    };
    window.addEventListener('pointermove', mm); window.addEventListener('pointerup', mu);
  };
});

function saveState() {
  window.electronAPI.saveFloatState('${noteId}', { images: imgData });
}
</script></body></html>`;
}

function closeFloatingNote(noteId) {
  const floatWin = floatingWindows.get(noteId);
  if (floatWin && !floatWin.isDestroyed()) floatWin.close();
  floatingWindows.delete(noteId);
  return true;
}

function updateFloatingNote(noteId, noteData) {
  // Update saved state with new content/color/font from main note
  const userDataPath = app.getPath('userData');
  const floatDir = path.join(userDataPath, 'floating-notes');
  const floatStateFile = path.join(floatDir, `${noteId}.json`);
  try {
    if (fs.existsSync(floatStateFile)) {
      const saved = JSON.parse(fs.readFileSync(floatStateFile, 'utf-8'));
      saved.content = noteData.content;
      saved.color = noteData.color;
      saved.fontSize = noteData.fontSize;
      if (noteData.settingsBgOpacity !== undefined) saved.settingsBgOpacity = noteData.settingsBgOpacity;
      fs.writeFileSync(floatStateFile, JSON.stringify(saved), 'utf-8');
    }
  } catch(e) {}
  // Notify floating window to reload
  const floatWin = floatingWindows.get(noteId);
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send('float:settingsUpdated', noteData);
  }
  return true;
}

function closeAll() {
  for (const [noteId, floatWin] of floatingWindows) {
    if (floatWin && !floatWin.isDestroyed()) floatWin.close();
  }
  floatingWindows.clear();
}

function generateFloatingNoteHTML(noteData) {
  const color = noteData.color || '#2d2d44';
  const rawContent = noteData.content || '';
  const escapedContent = rawContent
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const images = noteData.images || [];
  const fontSize = noteData.fontSize || 14;
  const noteDataId = noteData.id || '';

  let imagesHTML = '';
  if (images.length > 0) {
    imagesHTML = images.map(img => {
      const src = typeof img === 'string' ? img : (img.dataUrl || img.src || '');
      return `<img src="${src}" style="max-width:100%;border-radius:8px;margin-top:6px;" />`;
    }).join('');
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    height: 100vh; background: transparent; overflow: hidden; user-select: none;
  }
  .float-note {
    height: 100%; border-radius: 16px;
    background: ${color}66;
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,0.2);
    display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    position: relative;
    -webkit-app-region: drag;
  }
  .float-close {
    position: absolute; top: 6px; right: 8px; z-index: 10;
    width: 20px; height: 20px; border: none; border-radius: 50%; cursor: pointer;
    font-size: 10px; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.35); color: rgba(255,255,255,0.6);
    opacity: 0; transition: opacity 0.2s; font-family: inherit;
    -webkit-app-region: no-drag;
  }
  .float-note:hover .float-close { opacity: 1; }
  .float-close:hover { background: rgba(255,80,80,0.7); color: #fff; opacity: 1; }
  .float-content {
    flex: 1; padding: 14px; overflow-y: auto;
    color: rgba(255,255,255,0.95); font-size: ${fontSize}px;
    line-height: 1.5; outline: none; white-space: pre-wrap; word-break: break-word;
  }
  .float-content[contenteditable="true"] {
    -webkit-user-select: text; user-select: text;
  }
  .float-images { padding: 0 0 14px 14px; }
  .float-images img { max-width: 100%; height: auto; border-radius: 8px; margin-top: 4px; display: block; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
 </style>
</head>
<body>
<div class="float-note">
  <button class="float-close" onclick="window.electronAPI.closeFloatingNote('${noteDataId}')" title="关闭">x</button>
  <div class="float-content" contenteditable="true">${escapedContent}</div>
  ${imagesHTML ? `<div class="float-images">${imagesHTML}</div>` : ''}
</div>
</body>
</html>`;
}

function updateAllFontSize(fontSize) {
  // Re-generate each floating note's HTML with new font size
  for (const [noteId, floatWin] of floatingWindows) {
    if (floatWin && !floatWin.isDestroyed()) {
      // Rebuild the HTML with updated font size by calling updateFloatingNote
      // We need the original noteData which we don't store separately
      // Just use executeJavaScript as a lightweight update
      const code = `document.querySelector('.float-content').style.fontSize='${fontSize}px'`;
      floatWin.webContents.executeJavaScript(code).catch(() => {});
    }
  }
}

function getWindow(noteId) {
  return floatingWindows.get(noteId);
}

module.exports = { createFloatingNote, closeFloatingNote, updateFloatingNote, closeAll, updateAllFontSize, getWindow, floatingWindows };
