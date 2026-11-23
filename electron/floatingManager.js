const { BrowserWindow, screen, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { BUTTON, closeVisibility } = require('./floatingCloseVisibility');

const floatingWindows = new Map();
const closeGlyph = '<svg aria-hidden="true" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"><path d="m4 4 8 8m0-8-8 8"/></svg>';
const inlineData = value => JSON.stringify(value).replace(/</g, '\\u003c');
const closeOpacities = new WeakMap();
let transparent = false;
let penetrate = false;
let cursorTimer;

function canSample(win) {
  return !win.isDestroyed() && win.isVisible() && !win.isMinimized()
    && !win.webContents.isLoadingMainFrame();
}

function sampleCloseButtons() {
  const visible = transparent && !penetrate ? Array.from(floatingWindows.values()).filter(canSample) : [];
  if (!visible.length) {
    clearInterval(cursorTimer);
    cursorTimer = undefined;
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  for (const win of visible) {
    const opacity = Math.round(closeVisibility(cursor, win.getContentBounds()) * 100) / 100;
    if (closeOpacities.get(win) === opacity) continue;
    closeOpacities.set(win, opacity);
    win.webContents.send('float:closeVisibility', opacity);
  }
  cursorTimer ??= setInterval(sampleCloseButtons, 1000 / 30);
}

function applyInteraction(win) {
  if (win.isDestroyed()) return;
  if (penetrate) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
  if (win.webContents.isLoadingMainFrame()) return;
  win.webContents.send('float:penetrateChanged', penetrate);
  win.webContents.send('float:transparentChanged', transparent);
  closeOpacities.delete(win);
}

function togglePenetrate() {
  penetrate = !penetrate;
  for (const win of floatingWindows.values()) applyInteraction(win);
  sampleCloseButtons();
}

function toggleTransparency() {
  transparent = !transparent;
  for (const win of floatingWindows.values()) applyInteraction(win);
  sampleCloseButtons();
}

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
      attachments: noteData.attachments || [],
      settingsBgOpacity: noteData.settingsBgOpacity || 0.3,
    }), 'utf-8');
  } else {
    try {
      const saved = JSON.parse(fs.readFileSync(floatStateFile, 'utf-8'));
      saved.content = noteData.content;
      saved.color = noteData.color;
      saved.fontSize = noteData.fontSize;
      mergeMedia(saved, noteData);
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
  if (penetrate) floatWin.setIgnoreMouseEvents(true, { forward: true });
  floatWin.webContents.on('did-stop-loading', () => {
    applyInteraction(floatWin);
    sampleCloseButtons();
  });
  for (const event of ['show', 'hide', 'minimize', 'restore']) {
    floatWin.on(event, sampleCloseButtons);
  }

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
    sampleCloseButtons();
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
        <button class="fidel" aria-label="移除图片" title="移除图片">${closeGlyph}</button>
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
.float-window-close{position:absolute;z-index:3;top:${BUTTON.top}px;right:${BUTTON.right}px;width:${BUTTON.size}px;height:${BUTTON.size}px;display:grid;place-items:center;
  padding:0;border:1px solid transparent;border-radius:5px;background:rgba(0,0,0,.24);color:#ddd;cursor:pointer;-webkit-app-region:no-drag}
.float-window-close:hover:not(:disabled){background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.24);color:#fff}
.root.transparent .float-window-close{opacity:var(--close-visibility,0);transition:opacity 60ms linear}
.root.transparent .float-window-close:hover:not(:disabled){opacity:1}
.float-window-close:disabled{display:none}
@media (prefers-reduced-motion:reduce){.root.transparent .float-window-close{transition:none}}
.scroll-area{flex:1;overflow-y:auto;overflow-x:hidden;position:relative;z-index:1;--sb-alpha:0;transition:--sb-alpha 0.45s ease;-webkit-app-region:no-drag;border-radius:0 0 16px 16px}
.scroll-area:hover{--sb-alpha:0.2}
.scroll-area::-webkit-scrollbar{width:5px}
.scroll-area::-webkit-scrollbar-track{background:transparent}
.scroll-area::-webkit-scrollbar-thumb{background:rgb(255 255 255 / var(--sb-alpha));border-radius:2px}
.content{padding:14px;min-height:100%;color:rgba(255,255,255,0.95);font-size:${fontSize}px;line-height:1.5;outline:none;white-space:pre-wrap;word-break:break-word}
.content[contenteditable="true"]{user-select:text;-webkit-user-select:text}
.content[contenteditable="false"]{user-select:none;pointer-events:none}
.root.drop-ready{outline:2px dashed #9182ff;outline-offset:-3px}
.float-attachments{position:relative;z-index:1;max-height:35%;overflow:auto;padding:3px 10px 8px;-webkit-app-region:no-drag}
.float-attachments:empty{display:none}
.float-attachment{display:flex;align-items:center;gap:3px;padding:2px;margin-bottom:3px;border-radius:5px;background:rgba(255,255,255,.10)}
.float-attachment button{color:#fff;border:0;background:transparent;cursor:pointer;font:inherit}
.float-attachment button:first-child{flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;text-align:left}
.float-attachment button:last-child{display:grid;place-items:center;width:22px;height:22px;border-radius:5px}
.float-attachment button:last-child:hover,.fi .fidel:hover{background:rgba(232,90,111,.28);color:#ffd1de}
.fi{position:absolute;z-index:5;line-height:0;-webkit-app-region:no-drag}
.fi img{border-radius:5px;display:block;cursor:grab}
.fidel{position:absolute;top:2px;right:2px;width:22px;height:22px;border-radius:6px;background:rgba(0,0,0,.55);border:none;color:#fff;cursor:pointer;opacity:0;transition:opacity .15s,background-color .15s;display:grid;place-items:center}
.fi:is(:hover,:focus-within) .fidel{opacity:1}
.firesizetl{position:absolute;top:0;left:0;width:14px;height:14px;cursor:nwse-resize;opacity:0;transition:opacity 0.15s;background:linear-gradient(135deg,rgba(255,255,255,0.4) 50%,transparent 50%)}
.firesize{position:absolute;bottom:1px;right:1px;width:14px;height:14px;cursor:nwse-resize;opacity:0;transition:opacity 0.15s;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,0.4) 50%)}
.fi:hover .firesize{opacity:1}
</style></head><body>
<div class="root${transparent ? ' transparent' : ''}" id="root">
<div class="glass-bg"></div>
<div class="drag-strip"></div>
<button class="float-window-close" aria-label="关闭磁贴" title="关闭磁贴"${penetrate ? ' disabled' : ''}>${closeGlyph}</button>
<div class="scroll-area">
<div class="content" id="content" contenteditable="${!penetrate}">${content}</div>
${imgsHTML}
</div>
<div class="float-attachments"></div>
</div>
<script>
let penetrate = ${penetrate};
const root = document.getElementById('root');
const scrollArea = document.querySelector('.scroll-area');
const content = document.getElementById('content');
let imgData = ${inlineData(images)};
const closeGlyph = ${inlineData(closeGlyph)};
const noteId = ${inlineData(noteId)};
const attachments = document.querySelector('.float-attachments');
const closeButton = document.querySelector('.float-window-close');
closeButton.onclick = () => { if (!penetrate) window.electronAPI.closeFloatingNote(noteId); };
window.electronAPI.onFloatCloseVisibility(opacity => closeButton.style.setProperty('--close-visibility', String(opacity)));

function renderAttachments(items) {
  attachments.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'float-attachment';
    const open = document.createElement('button');
    open.textContent = item.path.split(/[\\\\/]/).pop();
    open.title = item.path;
    open.onclick = () => window.electronAPI.openFloatingAttachment(noteId, item.id);
    const remove = document.createElement('button');
    remove.innerHTML = closeGlyph;
    remove.setAttribute('aria-label', '移除附件');
    remove.onclick = () => window.electronAPI.removeFloatingMedia(noteId, item.id, 'attachment');
    row.append(open, remove);
    attachments.appendChild(row);
  }
}
renderAttachments(${inlineData(state.attachments || [])});

root.addEventListener('dragover', event => {
  if (penetrate || !Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  root.classList.add('drop-ready');
});
root.addEventListener('dragleave', event => {
  if (!event.relatedTarget || !root.contains(event.relatedTarget)) root.classList.remove('drop-ready');
});
root.addEventListener('drop', event => {
  if (!Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  root.classList.remove('drop-ready');
  if (penetrate) return;
  const paths = Array.from(event.dataTransfer.files, file => {
    try { return window.electronAPI.getDroppedFilePath(file); } catch { return ''; }
  });
  void window.electronAPI.dropOnFloatingNote(noteId, paths);
});
window.electronAPI.onFloatingMedia(({ images, attachments }) => {
  const focusImage = document.activeElement?.closest('.fi');
  for (const item of scrollArea.querySelectorAll('.fi')) item.remove();
  imgData = images;
  images.forEach((item, index) => {
    const wrap = document.createElement('div');
    const image = document.createElement('img');
    const height = item._previewH || 100;
    wrap.className = 'fi';
    wrap.style.left = (item._imgX ?? 10) + 'px';
    wrap.style.top = (item._imgY ?? (10 + index * (height + 8))) + 'px';
    image.src = item.dataUrl;
    image.style.height = height + 'px';
    image.draggable = false;
    wrap.appendChild(image);
    wrap.insertAdjacentHTML('beforeend', '<button class="fidel" aria-label="移除图片" title="移除图片">' + closeGlyph +
      '</button><div class="firesizetl"></div><div class="firesize"></div>');
    scrollArea.appendChild(wrap);
    bindImage(wrap, index);
  });
  renderAttachments(attachments);
  if (focusImage) content.focus({preventScroll:true});
});

// Listen for global penetrate changes from main process
window.electronAPI.onFloatPenetrateChanged((enabled) => {
  penetrate = enabled;
  closeButton.disabled = enabled;
  if (enabled) closeButton.style.removeProperty('--close-visibility');
  content.contentEditable = enabled ? 'false' : 'true';
});
// Listen for transparency toggle
window.electronAPI.onFloatTransparentChanged((enabled) => {
  if (!enabled) closeButton.style.removeProperty('--close-visibility');
  root.classList.toggle('transparent', enabled);
});
// Sync text edits
content.addEventListener('input', () => {
  window.electronAPI.updateFloatContent('${noteId}', content.innerText);
});
// Image drag
document.querySelectorAll('.fi').forEach(bindImage);
function bindImage(wrap, idx) {
  const img = wrap.querySelector('img');
  const del = wrap.querySelector('.fidel');
  const res = wrap.querySelector('.firesize');
  const restl = wrap.querySelector('.firesizetl');
  del.onclick = (e) => { e.stopPropagation(); void window.electronAPI.removeFloatingMedia(noteId, imgData[idx].id, 'image'); };
  // Top-left resize (anchor bottom-right)
  restl.onpointerdown = (e) => {
    if (e.button !== 0) return;
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
    followImagePointer(e, mm, saveState, () => {
      imgData[idx]._previewH = startH; img.style.height = startH+'px';
      imgData[idx]._imgX = startImgX; wrap.style.left = startImgX+'px';
      imgData[idx]._imgY = startImgY; wrap.style.top = startImgY+'px';
    });
  };
  // Bottom-right resize
  res.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY, startH = imgData[idx]._previewH || 100;
    document.body.style.cursor = 'nwse-resize';
    const mm = (ev) => {
      const d = Math.max(ev.clientX - startX, ev.clientY - startY);
      const nh = Math.max(30, startH + d);
      imgData[idx]._previewH = nh; img.style.height = nh + 'px';
    };
    followImagePointer(e, mm, saveState, () => { imgData[idx]._previewH = startH; img.style.height = startH+'px'; });
  };
  // Drag
  img.onpointerdown = (e) => {
    if (penetrate || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const ih = imgData[idx]._previewH || 100;
    const ghostH = ih * 0.92;
    const rect = img.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    const sr = ghostH / ih;
    const ghost = document.createElement('img');
    ghost.src = img.src;
    ghost.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;opacity:0.8;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.4);will-change:transform;';
    ghost.style.height = ghostH+'px'; ghost.style.width = 'auto';
    ghost.style.left = (e.clientX - offX*sr)+'px'; ghost.style.top = (e.clientY - offY*sr)+'px';
    document.body.appendChild(ghost);
    followImagePointer(e, (ev) => {
      ghost.style.transform = 'translate3d('+(ev.clientX-e.clientX)+'px,'+(ev.clientY-e.clientY)+'px,0)';
    }, (ev) => {
      ghost.remove();
      const srect = scrollArea.getBoundingClientRect();
      imgData[idx]._imgX = ev.clientX - srect.left - offX;
      imgData[idx]._imgY = ev.clientY - srect.top - offY;
      wrap.style.left = imgData[idx]._imgX + 'px';
      wrap.style.top = imgData[idx]._imgY + 'px';
      saveState();
    }, () => ghost.remove());
  };
}

function followImagePointer(start, paint, commit, reset) {
  const handle = start.currentTarget;
  const pointer = start.pointerId;
  let latest;
  let frame;
  handle.setPointerCapture(pointer);
  const clear = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', abort);
    handle.removeEventListener('lostpointercapture', cancel);
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    document.body.style.cursor = '';
  };
  const abort = () => { clear(); reset(); };
  const cancel = event => { if (event.pointerId === pointer) abort(); };
  const move = event => {
    if (event.pointerId !== pointer) return;
    latest = event;
    if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; paint(latest); });
  };
  const finish = event => {
    if (event.pointerId !== pointer) return;
    clear();
    if (!latest && event.clientX === start.clientX && event.clientY === start.clientY) { reset(); return; }
    paint(event);
    commit(event);
  };
  window.addEventListener('pointermove', move, { capture: true, passive: true });
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', abort);
  handle.addEventListener('lostpointercapture', cancel);
}

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

function mergeMedia(saved, data) {
  if (Array.isArray(data.images)) {
    const current = new Map((saved.images || []).map(image => [image.id, image]));
    saved.images = data.images.map(image => {
      const old = current.get(image.id);
      return old ? { ...image, _imgX: old._imgX ?? image._imgX, _imgY: old._imgY ?? image._imgY, _previewH: old._previewH ?? image._previewH } : image;
    });
  }
  if (Array.isArray(data.attachments)) saved.attachments = data.attachments;
}

function syncFloatingMedia(noteId, media) {
  const win = getWindow(noteId);
  if (!win) return;
  const file = path.join(app.getPath('userData'), 'floating-notes', `${noteId}.json`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  mergeMedia(saved, media);
  fs.writeFileSync(file, JSON.stringify(saved), 'utf-8');
  win.webContents.send('floating:media', { images: saved.images || [], attachments: saved.attachments || [] });
}

function updateFloatingNote(noteId, noteData) {
  // Update saved state with new content/color/font/images from main note
  const userDataPath = app.getPath('userData');
  const floatDir = path.join(userDataPath, 'floating-notes');
  const floatStateFile = path.join(floatDir, `${noteId}.json`);
  try {
    if (fs.existsSync(floatStateFile)) {
      const saved = JSON.parse(fs.readFileSync(floatStateFile, 'utf-8'));
      if (noteData.content !== undefined) saved.content = noteData.content;
      if (noteData.color !== undefined) saved.color = noteData.color;
      if (noteData.fontSize !== undefined) saved.fontSize = noteData.fontSize;
      if (noteData.images !== undefined) saved.images = noteData.images;
      if (noteData.attachments !== undefined) saved.attachments = noteData.attachments;
      if (noteData.settingsBgOpacity !== undefined) saved.settingsBgOpacity = noteData.settingsBgOpacity;
      fs.writeFileSync(floatStateFile, JSON.stringify(saved), 'utf-8');
      // Regenerate + reload the float window so content/images stay in sync
      // with the main note (previously only the color/font synced).
      const html = generateFloatHTML(noteId, saved, noteData);
      const tempFile = path.join(floatDir, `${noteId}.html`);
      fs.writeFileSync(tempFile, html, 'utf-8');
      const floatWin = floatingWindows.get(noteId);
      if (floatWin && !floatWin.isDestroyed()) {
        floatWin.loadFile(tempFile);
      }
    }
  } catch(e) {}
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
  <button class="float-close" onclick="window.electronAPI.closeFloatingNote('${noteDataId}')" aria-label="关闭">${closeGlyph}</button>
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

module.exports = { createFloatingNote, closeFloatingNote, updateFloatingNote, syncFloatingMedia, closeAll, updateAllFontSize,
  getWindow, floatingWindows, togglePenetrate, toggleTransparency };
