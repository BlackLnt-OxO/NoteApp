const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const floatingManager = require('./floatingManager');
const diagnostic = require('./diagnostic');

let mainWindow = null;
let screenshotWindows = [];
let isDev = false;

try {
  isDev = !app.isPackaged;
} catch (e) {
  isDev = false;
}

// ---- User-configurable data directory --------------------------------------
// A pointer file (next to the default userData, never inside it) records the
// current data directory and any replaced one awaiting deletion at quit.
const DATA_DIR_CONFIG_FILE = () => path.join(app.getPath('appData'), 'sticky-notes-config.json');
const DEFAULT_USER_DATA = path.join(app.getPath('appData'), 'sticky-notes');

function getDataDirConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(DATA_DIR_CONFIG_FILE(), 'utf-8'));
    return { dir: cfg.dir ?? null, prevDir: cfg.prevDir ?? null };
  } catch {
    return { dir: null, prevDir: null };
  }
}

function saveDataDirConfig(cfg) {
  try {
    fs.writeFileSync(DATA_DIR_CONFIG_FILE(), JSON.stringify({ dir: cfg.dir ?? null, prevDir: cfg.prevDir ?? null }, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save data dir config:', e);
  }
}

let relaunching = false;
function relaunch() {
  relaunching = true;
  // Under a portable build, process.execPath can point at the unpacked temp
  // copy; relaunching it loads the app from the wrong location (raw HTML/CSS
  // shown instead of the UI). electron-builder sets PORTABLE_EXECUTABLE_FILE to
  // the original exe — launch that with a clean argv + cwd, matching a manual
  // double-click.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  // Dev: process.execPath is bare electron.exe — launching it with no args shows
  // the default Electron window. Pass the app path (the project dir w/
  // package.json main) so it loads THIS app. Portable: launch the original exe.
  const args = process.env.PORTABLE_EXECUTABLE_FILE ? [] : [app.getAppPath()];
  try {
    spawn(exe, args, { cwd: app.getAppPath() || path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.error('Failed to relaunch app:', e);
  }
  app.exit(0);
}

// Apply a configured data directory before ready — every getPath('userData')
// below is lazy (handler / whenReady), so this takes effect for the session.
(function initDataDir() {
  const cfg = getDataDirConfig();
  if (cfg.dir && fs.existsSync(cfg.dir)) {
    app.setPath('userData', cfg.dir);
  }
})();

async function migrateDataDir(oldDir, newDir) {
  // Flush Chromium storage (localStorage/IndexedDB) before copying.
  try {
    const { session } = require('electron');
    await session.defaultSession.flushStorageData();
  } catch { /* ignore */ }
  if (newDir.startsWith(oldDir + path.sep)) {
    throw new Error('新目录不能位于旧数据目录内部');
  }
  if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
  fs.cpSync(oldDir, newDir, { recursive: true });
}

// Only a real quit (not a relaunch) deletes the replaced data directory, so the
// user keeps a fallback window (可回退) until they actually close the app.
app.on('quit', () => {
  if (relaunching) { relaunching = false; return; }
  const cfg = getDataDirConfig();
  if (cfg.prevDir && fs.existsSync(cfg.prevDir)) {
    try {
      fs.rmSync(cfg.prevDir, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to remove old data dir:', e);
    }
    saveDataDirConfig({ ...cfg, prevDir: null });
  }
});

function loadWindowBounds(key) {
  const userDataPath = app.getPath('userData');
  const filePath = path.join(userDataPath, 'window-bounds.json');
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data[key] || null;
    } catch(e) { return null; }
  }
  return null;
}

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const saved = loadWindowBounds('main');

  mainWindow = new BrowserWindow({
    x: saved?.x,
    y: saved?.y,
    width: saved?.width || Math.min(1400, width),
    height: saved?.height || Math.min(900, height),
    minWidth: 900,
    minHeight: 600,
    frame: true,
    transparent: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: false,
  });

  if (saved?.isMaximized) {
    mainWindow.once('ready-to-show', () => mainWindow.maximize());
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // TEMP(eraser-perf): auto-open DevTools shortly after the window is visible
    // so the user can copy the [eraser:canvas|pdf] timing lines from a wipe.
    // Remove after the numbers have been captured.
    setTimeout(() => {
      if (isDev && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }, 800);
  });

  // Save bounds on move/resize
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
      const b = mainWindow.getBounds();
      b.isMaximized = false;
      saveWindowBounds('main', b);
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', () => saveWindowBounds('main', { ...mainWindow.getBounds(), isMaximized: true }));
  mainWindow.on('unmaximize', saveBounds);

  // Forward fullscreen state to the renderer (button + ESC handling).
  mainWindow.on('enter-full-screen', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('fullscreen-changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('fullscreen-changed', false);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Portable first-run / transient load races can fail the main frame once;
  // retry it so the window doesn't sit on a blank or raw-source page.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = aborted
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }, 600);
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.setBackgroundColor('#00000000');
  });

  // TEMP(eraser-perf): F12 fallback to toggle DevTools if the auto-open above
  // didn't show. Remove together with the auto-open after data is captured.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || input.key === 'f12')) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools();
    }
  });
}

function saveWindowBounds(key, bounds) {
  const userDataPath = app.getPath('userData');
  const filePath = path.join(userDataPath, 'window-bounds.json');
  let data = {};
  if (fs.existsSync(filePath)) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch(e) {}
  }
  data[key] = bounds;
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

// Call Python script with JSON input, return parsed output (legacy — prefer daemon)
function callPython(scriptName, input) {
  try {
    // Copy script from asar to temp (Python can't read asar)
    const tmpDir = path.join(app.getPath('temp'), 'sticky-notes-py');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const srcPath = path.join(__dirname, scriptName);
    const dstPath = path.join(tmpDir, scriptName);
    fs.copyFileSync(srcPath, dstPath);
    const result = require('child_process').execSync(
      `python "${dstPath}"`, { input: JSON.stringify(input), encoding: 'utf-8', timeout: 120000, maxBuffer: 50 * 1024 * 1024 }
    );
    return JSON.parse(result.trim());
  } catch(e) { console.error(`Python ${scriptName} error:`, e.message); return null; }
}

// ── Capture Daemon (persistent Python process for mss GDI capture + stitch) ──
let capDaemon = null;
let capDaemonBuffer = '';
let capDaemonPending = [];  // queue of resolve callbacks

// Resolve the frozen capture engine (cap-engine.exe) → absolute path, or null.
// Packaged: shipped via electron-builder extraResources → resources/engine/cap-engine.exe.
// Dev: engine only when explicitly opted in (NOTEAPP_USE_ENGINE=1) — dev normally runs the
// Python source so you always test the latest capture_daemon.py (never a stale engine).
function resolveCapEnginePath() {
  if (!isDev) {
    const p = path.join(process.resourcesPath, 'engine', 'cap-engine.exe');
    if (fs.existsSync(p)) return p;
    return null;
  }
  if (process.env.NOTEAPP_USE_ENGINE === '1') {
    const p = path.join(__dirname, '..', 'engine', 'dist', 'cap-engine', 'cap-engine.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function spawnCapDaemon() {
  const engineExe = resolveCapEnginePath();

  if (engineExe) {
    // Frozen engine (bundles Python + cv2 + mss) — no system Python required.
    capDaemon = require('child_process').spawn(engineExe, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // no console flash for the console-subsystem exe
    });
  } else {
    // Legacy path: run capture_daemon.py with a system Python. Dev default; also the
    // fallback for a packaged build shipped without an engine. Needs Python installed.
    const daemonSrc = path.join(__dirname, 'longshot', 'capture_daemon.py');
    const mssSrc = path.join(__dirname, 'mss');
    const tmpDir = path.join(app.getPath('temp'), 'sticky-notes-py');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const daemonDst = path.join(tmpDir, 'capture_daemon.py');
    const mssDst = path.join(tmpDir, 'mss');
    fs.copyFileSync(daemonSrc, daemonDst);
    // Copy bundled mss library so Python can import it (cannot read from asar)
    try { fs.cpSync(mssSrc, mssDst, { recursive: true }); } catch(e) {
      // If mss is already there from a previous run, that's fine
      if (e.code !== 'ERR_FS_CP_EEXIST') console.error('[cap-daemon] mss copy warning:', e.message);
    }
    capDaemon = require('child_process').spawn('python', [daemonDst], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  capDaemonBuffer = '';
  capDaemonPending = [];

  // Prevent EPIPE crashes when writing to daemon stdin after it exits
  capDaemon.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') console.error('[cap-daemon] stdin error:', err.message);
  });

  capDaemon.on('error', (err) => {
    console.error('[cap-daemon] spawn error:', err.message);
  });

  capDaemon.stdout.on('data', (chunk) => {
    capDaemonBuffer += chunk.toString();
    const lines = capDaemonBuffer.split('\n');
    capDaemonBuffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (capDaemonPending.length > 0) {
          capDaemonPending.shift()(msg);
        }
      } catch(e) { console.error('[cap-daemon] parse error:', e.message); }
    }
  });

  capDaemon.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error('[cap-daemon stderr]', text);
  });

  capDaemon.on('close', (code) => {
    console.log('[cap-daemon] exited with code', code);
    // Drain pending promises with error so callers know daemon died
    while (capDaemonPending.length > 0) {
      capDaemonPending.shift()(null);
    }
    capDaemon = null;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killCapDaemon();
      reject(new Error('daemon start timeout'));
    }, 15000);
    capDaemonPending.push((msg) => {
      clearTimeout(timeout);
      if (msg && msg.ready) resolve();
      else reject(new Error('daemon failed to become ready'));
    });
  });
}

function sendDaemon(msg) {
  return new Promise((resolve, reject) => {
    if (!capDaemon || capDaemon.killed) { reject(new Error('daemon not running')); return; }
    capDaemonPending.push(resolve);
    try {
      capDaemon.stdin.write(JSON.stringify(msg) + '\n');
    } catch(e) {
      // Remove the pending resolver on write error
      const idx = capDaemonPending.indexOf(resolve);
      if (idx >= 0) capDaemonPending.splice(idx, 1);
      reject(e);
    }
  });
}

function killCapDaemon() {
  if (capDaemon && !capDaemon.killed) {
    try { capDaemon.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n'); } catch(e) {}
    setTimeout(() => {
      if (capDaemon && !capDaemon.killed) { try { capDaemon.kill(); } catch(e) {} }
      capDaemon = null;
      capDaemonBuffer = '';
      capDaemonPending = [];
    }, 2000);
  } else {
    capDaemon = null;
    capDaemonBuffer = '';
    capDaemonPending = [];
  }
}

// Screenshot via Windows native Win+Shift+S
const SCREENSHOT_DIR = path.join(require('os').homedir(), 'Pictures', 'Screenshots');

async function captureWithNativeSnipping() {
  let oldFiles = [];
  try { if (fs.existsSync(SCREENSHOT_DIR)) oldFiles = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png')); } catch(e) {}
  const oldImg = clipboard.readImage();
  const oldHash = oldImg.getSize().width > 0 ? oldImg.toDataURL().slice(-100) : '';
  try { require('child_process').execSync('explorer ms-screenclip:', { timeout: 3000 }); } catch(e) {}
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const img = clipboard.readImage();
    const sz = img.getSize();
    if (sz.width > 0 && sz.height > 0) {
      const dataUrl = img.toDataURL();
      if (dataUrl.slice(-100) !== oldHash) {
        try {
          const newFiles = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
          for (const f of newFiles) { if (!oldFiles.includes(f)) fs.unlinkSync(path.join(SCREENSHOT_DIR, f)); }
        } catch(e) {}
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('screenshot:completed', { dataUrl, width: sz.width, height: sz.height });
        }
        return true;
      }
    }
  }
  return false;
}

// IPC Handlers
function setupIPC() {
  // Window controls - close the window that sent the request
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    }
    return false;
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:isMaximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() || false;
  });
  ipcMain.handle('window:toggleFullScreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });
  ipcMain.handle('window:isFullScreen', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() || false;
  });

  // ---- Data directory ------------------------------------------------------

  ipcMain.handle('app:getDataDirectory', () => ({
    path: app.getPath('userData'),
    isConfigured: fs.existsSync(DATA_DIR_CONFIG_FILE()),
    prevDir: getDataDirConfig().prevDir,
  }));

  ipcMain.handle('app:pickDataDirectory', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择数据存储位置',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('app:setDataDirectory', async (event, dir) => {
    const oldDir = app.getPath('userData');
    const cfg = getDataDirConfig();

    // First-run "使用默认位置" (null): choosing the DEFAULT does NOT migrate or
    // relaunch — it only marks the app configured and continues.
    if (dir === null) {
      saveDataDirConfig({ dir: null, prevDir: cfg.prevDir ?? oldDir });
      return { changed: false };
    }

    // '' or a real path = changing the location (incl. Settings' "恢复默认位置"),
    // which migrates and relaunches once.
    const newDir = dir ? path.resolve(String(dir)) : DEFAULT_USER_DATA;

    if (newDir === oldDir) {
      // Same location — just mark configured so the first-run prompt doesn't reappear.
      saveDataDirConfig({ dir: cfg.dir ?? null, prevDir: cfg.prevDir });
      return { changed: false };
    }

    if (fs.existsSync(oldDir)) {
      try {
        await migrateDataDir(oldDir, newDir);
      } catch (e) {
        console.error('Data dir migration failed:', e);
        return { changed: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    saveDataDirConfig({ dir: newDir, prevDir: oldDir });

    if (isDev) {
      // Dev: keep the concurrently-launched Vite server alive. Relaunching the
      // Electron process (spawn/exit) drops the renderer for the moment it hits
      // localhost:5173, which can come back as a black window. Instead point
      // userData at the new dir immediately and just reload the renderer.
      app.setPath('userData', newDir);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    } else {
      relaunch();
    }
    return { changed: true };
  });

  // Floating note state (separate from main note)
  ipcMain.handle('float:loadState', (event, noteId) => {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'floating-notes', `${noteId}.json`);
    if (fs.existsSync(filePath)) {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch(e) {}
    }
    return null;
  });

  ipcMain.handle('float:saveState', (event, noteId, state) => {
    const userDataPath = app.getPath('userData');
    const dir = path.join(userDataPath, 'floating-notes');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${noteId}.json`);
    let existing = {};
    if (fs.existsSync(filePath)) {
      try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch(e) {}
    }
    const merged = { ...existing, ...state };
    fs.writeFileSync(filePath, JSON.stringify(merged), 'utf-8');
    return true;
  });

  ipcMain.handle('float:resetState', (event, noteId) => {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'floating-notes', `${noteId}.json`);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch(e) {}
    }
    return true;
  });

  ipcMain.handle('float:updateContent', (event, noteId, content) => {
    // Update content in both float state and main note
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'floating-notes', `${noteId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        saved.content = content;
        fs.writeFileSync(filePath, JSON.stringify(saved), 'utf-8');
      } catch(e) {}
    }
    // Also update main store
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('float:contentUpdated', { noteId, content });
    }
    return true;
  });

  // Floating note management
  ipcMain.handle('floating:create', (event, noteData) => {
    return floatingManager.createFloatingNote(noteData, isDev);
  });

  ipcMain.handle('floating:close', (event, noteId) => {
    // Notify main window to update isFloating state
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating:closed', noteId);
    }
    return floatingManager.closeFloatingNote(noteId);
  });

  ipcMain.handle('floating:update', (event, noteId, noteData) => {
    return floatingManager.updateFloatingNote(noteId, noteData);
  });

  ipcMain.handle('floating:updateAllFontSize', (event, fontSize) => {
    floatingManager.updateAllFontSize(fontSize);
    return true;
  });

  ipcMain.handle('floating:closeAll', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating:allClosed');
    }
    return floatingManager.closeAll();
  });

  // Eyedropper: fullscreen overlay, pick pixel color
  ipcMain.handle('eyedropper:start', async () => {
    return new Promise(async (resolve) => {
      const displays = screen.getAllDisplays();
      const capWins = [];
      let resolved = false;

      for (const d of displays) {
        const ow = new BrowserWindow({
          x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
          transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
          webPreferences: { contextIsolation: false, nodeIntegration: true },
        });
        ow.setAlwaysOnTop(true, 'screen-saver');
        ow.setIgnoreMouseEvents(false);

        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: d.size.width, height: d.size.height },
        });
        const source = sources.find(s => s.display_id === String(d.id)) || sources[0];
        const imgDataUrl = source ? source.thumbnail.toDataURL() : '';

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0}body{cursor:crosshair;overflow:hidden;width:100vw;height:100vh}
#c{position:fixed;inset:0}
#lp{position:fixed;pointer-events:none;width:120px;height:24px;background:rgba(0,0,0,0.75);color:#fff;font:12px monospace;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.3);border-radius:4px;z-index:100;white-space:nowrap}
</style></head><body>
<canvas id="c"></canvas><div id="lp"></div>
<script>
const {ipcRenderer}=require('electron');
const cvs=document.getElementById('c'),ctx=cvs.getContext('2d'),lp=document.getElementById('lp');
cvs.width=${d.size.width};cvs.height=${d.size.height};
const img=new Image();img.src='${imgDataUrl}';
img.onload=function(){ctx.drawImage(img,0,0);};
document.addEventListener('mousemove',function(e){
  lp.style.left=(e.clientX+14)+'px';lp.style.top=(e.clientY+14)+'px';
  const px=ctx.getImageData(e.clientX,e.clientY,1,1).data;
  const hex='#'+[px[0],px[1],px[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
  lp.style.borderColor=hex;
  lp.innerHTML='<span style="display:inline-block;width:14px;height:14px;background:'+hex+';border:1px solid rgba(255,255,255,0.4);border-radius:2px;margin-right:4px"></span>'+hex.toUpperCase();
});
document.addEventListener('click',function(e){
  const px=ctx.getImageData(e.clientX,e.clientY,1,1).data;
  const hex='#'+[px[0],px[1],px[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
  ipcRenderer.send('eyedropper:picked',hex);
});
document.addEventListener('keydown',function(e){if(e.key==='Escape')ipcRenderer.send('eyedropper:picked',null);});
</script></body></html>`;

        const tmpDir = path.join(app.getPath('temp'), 'sticky-notes-screenshot');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const f = path.join(tmpDir, `eyedrop-${d.id}.html`);
        fs.writeFileSync(f, html, 'utf-8');
        ow.loadFile(f);
        capWins.push(ow);
      }

      const close = () => { capWins.forEach(w => { if (!w.isDestroyed()) w.close(); }); };

      ipcMain.once('eyedropper:picked', (event, color) => {
        if (!resolved) { resolved = true; close(); resolve(color); }
      });
    });
  });

  ipcMain.handle('screenshot:start', () => captureWithNativeSnipping());

  // Long screenshot floating toolbar actions
  ipcMain.on('screenshot:long-finish', () => {
    longCaptureActive = false;
    stopAutoCapture();
    hideLongCaptureUI();
    finishLongCaptureFromFrames(longCaptureFrames, longCaptureRegion);
  });
  ipcMain.on('screenshot:long-cancel', () => {
    longCaptureActive = false; longCaptureFrames = [];
    stopAutoCapture();
    killCapDaemon();
    hideLongCaptureUI();
    closeScreenshotWindows();
  });

  // Long screenshot: integrated overlay + auto-capture + preview
  ipcMain.handle('screenshot:startLongScreenshot', async () => {
    try {
      return createScreenshotOverlay('long');
    } catch(e) { console.error('Long screenshot error:', e); return false; }
  });

  ipcMain.handle('screenshot:cancel', () => {
    closeScreenshotWindows();
    return true;
  });

  ipcMain.handle('screenshot:capture', async (event, { x, y, width, height, screenId }) => {
    return captureScreenRegion(x, y, width, height, screenId);
  });

  ipcMain.handle('screenshot:startLongCapture', async (event, { x, y, width, height, screenId }) => {
    return startLongCapture(x, y, width, height, screenId);
  });

  ipcMain.handle('screenshot:captureScrollFrame', async (event, { x, y, width, height, screenId }) => {
    return captureScrollFrame(x, y, width, height, screenId);
  });

  ipcMain.handle('screenshot:cancelLongCapture', async () => {
    longCaptureActive = false;
    if (longCaptureTimer) { clearInterval(longCaptureTimer); longCaptureTimer = null; }
    if (longCaptureToolbar && !longCaptureToolbar.isDestroyed()) longCaptureToolbar.close();
    closeScreenshotWindows();
    return true;
  });

  ipcMain.handle('screenshot:finishLongCapture', async (event, { frames }) => {
    return finishLongCapture(frames);
  });

  // ── Diagnostic IPC handlers ──
  ipcMain.handle('screenshot:diag-set-config', async (event, config) => {
    diagnostic.setConfig(config);
    return diagnostic.getConfig();
  });
  ipcMain.handle('screenshot:diag-get-config', async () => {
    return diagnostic.getConfig();
  });
  ipcMain.handle('screenshot:diag-get-stats', async () => {
    if (diagCaptureLoop) return diagCaptureLoop.getState();
    return { active: false };
  });
  ipcMain.handle('screenshot:diag-get-log-path', async () => {
    return diagLogPath || diagnostic.getLogFilePath();
  });
  ipcMain.handle('screenshot:diag-get-modes', async () => {
    return diagnostic.DIAGNOSTIC_MODES;
  });

  // File operations
  ipcMain.handle('file:saveImage', async (event, { dataUrl, fileName }) => {
    const userDataPath = app.getPath('userData');
    const imagesDir = path.join(userDataPath, 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }
    const filePath = path.join(imagesDir, fileName);
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filePath, base64Data, 'base64');
    return filePath;
  });

  // "另存为…" — write an image data-URL to a user-chosen disk location.
  ipcMain.handle('file:saveImageAs', async (event, { dataUrl, defaultFileName }) => {
    const { dialog } = require('electron');
    try {
      const mimeMatch = /^data:image\/(\w+);base64,/.exec(String(dataUrl || ''));
      const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'png';
      const validExt = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(mime) ? mime : 'png';
      // Strip any extension the caller attached so the mime-derived one is used.
      const base = String(defaultFileName || '').trim().replace(/\.[^.\\/]+$/, '') || 'note-image';
      const defaultPath = path.join(app.getPath('downloads'), `${base}.${validExt}`);
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath,
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      let filePath = result.filePath;
      if (!/\.[^\\/]+$/.test(filePath)) filePath += `.${validExt}`;
      const base64Data = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(filePath, base64Data, 'base64');
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('file:pickImage', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }],
    });
    if (result.canceled) return null;
    const filePath = result.filePaths[0];
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const dataUrl = `data:image/${mime};base64,${data.toString('base64')}`;
    return { dataUrl, filePath };
  });

  ipcMain.handle('file:pickBackground', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }],
    });
    if (result.canceled) return null;
    const filePath = result.filePaths[0];
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const dataUrl = `data:image/${mime};base64,${data.toString('base64')}`;
    return { dataUrl, filePath };
  });

  // ---- PDF file access (library) -----------------------------------------

  ipcMain.handle('pdf:pickFile', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    try {
      const data = fs.readFileSync(filePath);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return { filePath, sizeBytes: data.length, data: buffer };
    } catch (e) {
      return { filePath, error: String(e) };
    }
  });

  ipcMain.handle('pdf:readFile', (event, filePath) => {
    try {
      const data = fs.readFileSync(filePath);
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return { ok: true, sizeBytes: data.length, data: buffer };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('pdf:fileExists', (event, filePath) => {
    try { return fs.existsSync(filePath); } catch { return false; }
  });

  // ---- PDF annotation persistence (one folder for all such files) -----------

  function getPdfDataDir() {
    // Dev: project dir (visible next to the app). Packaged: userData (writable).
    let base;
    try {
      base = app.isPackaged ? app.getPath('userData') : app.getAppPath();
    } catch {
      base = app.getPath('userData');
    }
    const dir = path.join(base, 'pdf-annotations');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  ipcMain.handle('pdf-annotation:save', (event, itemId, data) => {
    try {
      const safe = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(getPdfDataDir(), `${safe}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('pdf-annotation:load', (event, itemId) => {
    try {
      const safe = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(getPdfDataDir(), `${safe}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('pdf-annotation:delete', (event, itemId) => {
    try {
      const safe = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(getPdfDataDir(), `${safe}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('app:getPath', (event, name) => {
    return app.getPath(name);
  });

  // Cross-window drag support
  ipcMain.handle('app:getCursorScreenPoint', () => {
    return screen.getCursorScreenPoint();
  });

  // Window bounds memory
  ipcMain.handle('window:saveBounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const key = 'main';
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'window-bounds.json');
    let data = {};
    if (fs.existsSync(filePath)) {
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch(e) {}
    }
    data[key] = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, isMaximized: bounds.isMaximized };
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  });

  ipcMain.handle('window:getBounds', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const key = 'main';
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'window-bounds.json');
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return data[key] || null;
      } catch(e) { return null; }
    }
    return null;
  });

  // Default background image
  ipcMain.handle('app:getDefaultBackground', async () => {
    // Check for default background image in app directory
    const possiblePaths = [
      path.join(__dirname, '..', 'LS_Camera.1184.png'),
      path.join(__dirname, '..', '..', 'LS_Camera.1184.png'),
      path.join(app.getAppPath(), 'LS_Camera.1184.png'),
    ];

    for (const bgPath of possiblePaths) {
      if (fs.existsSync(bgPath)) {
        try {
          const data = fs.readFileSync(bgPath);
          const dataUrl = `data:image/png;base64,${data.toString('base64')}`;
          return dataUrl;
        } catch (e) {
          // continue
        }
      }
    }
    return null;
  });

  // Sync data loading (for initial render, no flash)
  ipcMain.on('store:loadSync', (event) => {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'notes-data.json');
    let data = null;
    if (fs.existsSync(filePath)) {
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch(e) {}
    }
    event.returnValue = data;
  });

  // Data persistence
  ipcMain.handle('store:save', async (event, data) => {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'notes-data.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  });

  ipcMain.handle('store:load', async () => {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, 'notes-data.json');
    if (fs.existsSync(filePath)) {
      try {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
      } catch (e) {
        return null;
      }
    }
    return null;
  });
}

let longCaptureActive = false;
let longCaptureFrames = [];
let longCaptureRegion = null;
let longCaptureCumulative = null; // incremental stitch result
let longCapturePrevFrame = null;  // previous frame for overlap detection

// ── Diagnostic state ──
let diagCaptureLoop = null;       // diagnostic capture loop instance
let diagPreviewWindow = null;     // preview window for low-res incremental preview
let diagEventLoopMonitor = null;  // event loop lag monitor
let diagLogPath = null;           // current diagnostic log file path
let diagTilesDir = null;          // temp directory for tile files


// Cache display bounds at app start (overwritten, not appended)
function cacheDisplayBounds() {
  try {
    const displays = screen.getAllDisplays().map(d => ({ id: d.id, x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height }));
    const f = path.join(app.getPath('userData'), 'display-cache.json');
    fs.writeFileSync(f, JSON.stringify(displays), 'utf-8');
  } catch(e) {}
}

function loadDisplayCache() {
  try {
    const f = path.join(app.getPath('userData'), 'display-cache.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch(e) {}
  return null;
}

let screenshotOverlays = [];

function createScreenshotOverlay(mode = 'normal') {
  closeScreenshotWindows();

  const isLongMode = mode === 'long';
  const displays = screen.getAllDisplays();

  // Create one overlay per display (no resize flicker - each is already correct size)
  for (const d of displays) {
    const { x, y, width, height } = d.bounds;
    const sf = d.scaleFactor || 1;

    const ow = new BrowserWindow({
      x, y, width, height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    ow.setAlwaysOnTop(true, 'screen-saver');
    ow.setVisibleOnAllWorkspaces(true);

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:100vw;height:100vh;cursor:crosshair;user-select:none;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
#dim{position:fixed;inset:0;background:rgba(0,0,0,0.3)}
#sel{position:fixed;outline:2px dashed #fff;box-shadow:0 0 0 9999px rgba(0,0,0,0.4);display:none;pointer-events:none}
#tb{position:fixed;background:rgba(30,30,30,0.92);backdrop-filter:blur(10px);border-radius:12px;padding:6px;display:none;gap:4px;z-index:10}
#sz{color:#aaa;font-size:12px;padding:8px;white-space:nowrap}
.b{border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;color:#fff;white-space:nowrap;background:rgba(255,255,255,0.1)}
.b:hover{background:rgba(255,255,255,0.25)}
.bp{background:rgba(0,120,255,0.8)}.bp:hover{background:rgba(0,120,255,1)}
</style></head><body>
<div id="dim"></div><div id="sel"></div>
<div id="tb"><span id="sz"></span>
<button class="b bp" id="cb">截图</button>
<button class="b" id="lb">长截图</button>
<button class="b" id="xb">取消</button>
</div>
<script>
var startSX,startSY,selSX,selSY,selSW,selSH; // screen coords for capture
var startX,startY,selX,selY,selW,selH; // CSS coords for display
var drawing=false,capturing=false,isLong=${isLongMode};
dim.addEventListener('mousedown',function(e){
  drawing=true;
  startSX=e.screenX;startSY=e.screenY;
  startX=e.offsetX;startY=e.offsetY;
  dim.style.display='none';sel.style.display='block';tb.style.display='none';
});
window.addEventListener('mousemove',function(e){
  if(!drawing)return;
  selSX=Math.min(startSX,e.screenX);selSY=Math.min(startSY,e.screenY);
  selSW=Math.abs(e.screenX-startSX);selSH=Math.abs(e.screenY-startSY);
  var cx=e.offsetX,cy=e.offsetY;
  selX=Math.min(startX,cx);selY=Math.min(startY,cy);
  selW=Math.abs(cx-startX);selH=Math.abs(cy-startY);
  sel.style.left=(selX-2)+'px';sel.style.top=(selY-2)+'px';
  sel.style.width=(selW+4)+'px';sel.style.height=(selH+4)+'px';
});
window.addEventListener('mouseup',function(){
  if(!drawing)return;drawing=false;
  if(selW<10||selH<10){sel.style.display='none';dim.style.display='block';return}
  tb.style.display='flex';tb.style.left=selX+'px';tb.style.top=(selY+selH+8)+'px';
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){window.__capture={action:'cancel'}}});
if(isLong){cb.textContent='开始';lb.style.display='none';}
lb.onclick=function(){capturing=true;sel.style.outlineColor='#0f8';cb.textContent='✓ 保存';lb.style.display='none';xb.textContent='✕ 取消';document.body.style.cursor='default';window.__capture={action:'long-start',x:Math.round(selSX),y:Math.round(selSY),w:Math.round(selSW),h:Math.round(selSH)}};
cb.onclick=function(){if(capturing||isLong){window.__capture={action:capturing?'long-finish':'long-start',x:Math.round(selSX),y:Math.round(selSY),w:Math.round(selSW),h:Math.round(selSH)}}else{window.__capture={action:'capture',x:Math.round(selSX),y:Math.round(selSY),w:Math.round(selSW),h:Math.round(selSH)}}};
xb.onclick=function(){if(capturing||isLong){capturing=false;window.__capture={action:'cancel'}}else window.close()};
</script></body></html>`;

    const tempDir = path.join(app.getPath('temp'), 'sticky-notes-screenshot');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const f = path.join(tempDir, `overlay-${d.id}.html`);
    fs.writeFileSync(f, html, 'utf-8');
    ow.loadFile(f);

    ow.on('closed', () => {
      screenshotOverlays = screenshotOverlays.filter(w => w !== ow);
    });
    screenshotOverlays.push(ow);
  }

  // Poll all overlays for capture actions
  const pollAll = () => {
    let allClosed = true;
    for (const w of screenshotOverlays) {
      if (w && !w.isDestroyed()) { allClosed = false; break; }
    }
    if (allClosed) { longCaptureActive = false; stopAutoCapture(); return; }

    for (const w of screenshotOverlays) {
      if (!w || w.isDestroyed()) continue;
      w.webContents.executeJavaScript('window.__capture').then(data => {
        if (data) {
          w.webContents.executeJavaScript('window.__capture=undefined').catch(()=>{});
          const { action, x: sx, y: sy, w: sw, h: sh } = data;
          if (action === 'cancel') {
            longCaptureActive = false; longCaptureFrames = [];
            stopAutoCapture();
            hideLongCaptureUI();
            closeScreenshotWindows();
          } else if (action === 'capture') {
            captureScreenRegion(sx, sy, sw, sh, null).then(result => {
              if (result && result.dataUrl && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('screenshot:completed', result);
                try { clipboard.writeImage(nativeImage.createFromDataURL(result.dataUrl)); } catch(e) {}
              }
              closeScreenshotWindows();
            });
          } else if (action === 'long-start') {
            longCaptureActive = true; longCaptureFrames = [];
            // Convert overlay logical coords to physical for mss
            const phys = logicalToPhysical(sx, sy, sw, sh);
            longCaptureRegion = { x: phys.x, y: phys.y, w: phys.w, h: phys.h };
            console.log('[longshot] region logical:', { x: sx, y: sy, w: sw, h: sh },
              '→ physical:', phys);
            // Transform overlay: remove dim/border, switch toolbar to capture mode
            for (const ow of screenshotOverlays) {
              if (ow && !ow.isDestroyed()) {
                ow.setIgnoreMouseEvents(true, { forward: true });
                ow.webContents.executeJavaScript(`
                  var dim=document.getElementById('dim');
                  var sel=document.getElementById('sel');
                  var tb=document.getElementById('tb');
                  if(dim) dim.style.display='none';
                  if(sel){ sel.style.outline='none'; sel.style.boxShadow='0 0 0 9999px rgba(0,0,0,0.35)'; }
                  if(tb) tb.style.display='none';
                `).catch(()=>{});
              }
            }
            // Show floating toolbar at same position where overlay toolbar was
            showLongCaptureUI(sx, sy, sw, sh);
            startAutoCapture();
          } else if (action === 'long-finish') {
            longCaptureActive = false;
            hideLongCaptureUI();
            longCaptureActive = false;
            for (const ow of screenshotOverlays) { if (ow&&!ow.isDestroyed()) ow.setIgnoreMouseEvents(false); }
            finishLongCaptureFromFrames(longCaptureFrames, longCaptureRegion);
          }
        }
      }).catch(()=>{});
    }
    setTimeout(pollAll, 150);
  };
  setTimeout(pollAll, 300);
  return true;
}

function getOverlayHTML() {
  return `<!DOCTYPE html>
<html>
  <head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 100vw; height: 100vh;
      cursor: crosshair;
      user-select: none;
      overflow: hidden;
      background: transparent;
    }
    #dim-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.4);
      z-index: 1;
    }
    #selection {
      position: fixed;
      border: 2px dashed #fff;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.4);
      display: none;
      pointer-events: none;
      z-index: 2;
    }
    #toolbar {
      position: fixed;
      background: rgba(30,30,30,0.9);
      backdrop-filter: blur(10px);
      border-radius: 12px;
      padding: 6px;
      display: none;
      gap: 4px;
      z-index: 1000;
    }
    .btn {
      background: rgba(255,255,255,0.1);
      border: none;
      color: #fff;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
      transition: background 0.2s;
    }
    .btn:hover { background: rgba(255,255,255,0.25); }
    .btn.primary { background: rgba(0,120,255,0.8); }
    .btn.primary:hover { background: rgba(0,120,255,1); }
    #size-info {
      color: #aaa;
      font-size: 12px;
      padding: 8px;
    }
  </style>
  </head>
  <body>
  <div id="dim-overlay"></div>
  <div id="selection"></div>
  <div id="toolbar">
    <span id="size-info"></span>
    <button class="btn" onclick="cancelScreenshot()">取消 (Esc)</button>
    <button class="btn primary" id="capture-btn" onclick="captureScreenshot()">截图</button>
    <button class="btn" id="long-capture-btn" onclick="startLongCapture()">长截图</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    let startX, startY, selX, selY, selW, selH;
    let isDrawing = false;
    const DX = ${x}, DY = ${y};
    const dimOverlay = document.getElementById('dim-overlay');
    const selection = document.getElementById('selection');
    const toolbar = document.getElementById('toolbar');
    const sizeInfo = document.getElementById('size-info');
    const captureBtn = document.getElementById('capture-btn');
    const longCaptureBtn = document.getElementById('long-capture-btn');

    dimOverlay.addEventListener('mousedown', (e) => {
      isDrawing = true;
      startX = e.screenX;
      startY = e.screenY;
      dimOverlay.style.display = 'none';
      selection.style.display = 'block';
      toolbar.style.display = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDrawing) return;

      const currentX = e.screenX;
      const currentY = e.screenY;

      selX = Math.min(startX, currentX);
      selY = Math.min(startY, currentY);
      selW = Math.abs(currentX - startX);
      selH = Math.abs(currentY - startY);

      selection.style.left = (selX - DX) + 'px';
      selection.style.top = (selY - DY) + 'px';
      selection.style.width = selW + 'px';
      selection.style.height = selH + 'px';
    });

    window.addEventListener('mouseup', (e) => {
      if (!isDrawing) return;
      isDrawing = false;

      if (selW < 10 || selH < 10) {
        selection.style.display = 'none';
        dimOverlay.style.display = 'block';
        return;
      }

      // Show toolbar below selection
      const toolbarX = selX - DX;
      const toolbarY = selY - DY + selH + 8;

      toolbar.style.left = toolbarX + 'px';
      toolbar.style.top = toolbarY + 'px';
      toolbar.style.display = 'flex';

      sizeInfo.textContent = Math.round(selW) + ' × ' + Math.round(selH);

      captureBtn.onclick = () => captureScreenshot();
      longCaptureBtn.onclick = () => startLongCapture();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        cancelScreenshot();
      }
    });

    function cancelScreenshot() {
      ipcRenderer.invoke('screenshot:cancel').then(() => {
        window.close();
      });
    }

    function captureScreenshot() {
      // Hide selection & toolbar so they don't appear in the capture
      selection.style.display = 'none';
      toolbar.style.display = 'none';
      setTimeout(() => {
        ipcRenderer.invoke('screenshot:capture', {
        x: Math.round(selX),
        y: Math.round(selY),
        width: Math.round(selW),
        height: Math.round(selH),
        screenId: null
        }).then((result) => {
          if (result && result.dataUrl) {
            ipcRenderer.send('screenshot:result', result);
          }
          window.close();
        });
      }, 50);
    }

    function startLongCapture() {
      ipcRenderer.invoke('screenshot:startLongCapture', {
        x: Math.round(selX),
        y: Math.round(selY),
        width: Math.round(selW),
        height: Math.round(selH),
        screenId: null
      }).then(() => {
        // Main process handles auto-capture; overlay becomes click-through
        // Show hints briefly then hide
        selection.style.borderColor = '#00ff88';
        document.body.style.cursor = 'default';
        setTimeout(() => { window.close(); }, 300);
      });
    }

    function finishLongCapture() {
      ipcRenderer.invoke('screenshot:finishLongCapture', {}).then((result) => {
        if (result && result.dataUrl) {
          ipcRenderer.send('screenshot:result', result);
        }
        window.close();
      });
    }

    window.cancelScreenshot = cancelScreenshot;
    window.captureScreenshot = captureScreenshot;
    window.startLongCapture = startLongCapture;
    window.finishLongCapture = finishLongCapture;
  </script>
  </body>
  </html>`;
}

async function finishLongCaptureFromFrames(frames, region) {
  // Diagnostic routing
  if (diagCaptureLoop && diagCaptureLoop.getState().active) return finishLongCaptureFromFramesDiag(region);

  // ── Daemon path: get cumulative result from persistent process ──
  if (capDaemon && !capDaemon.killed) {
    try {
      const result = await sendDaemon({ action: 'finish' });
      killCapDaemon();
      if (result && result.ok && result.cumPath) {
        const cumPath = result.cumPath;
        if (fs.existsSync(cumPath)) {
          const buf = fs.readFileSync(cumPath);
          const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
          const img = nativeImage.createFromDataURL(dataUrl);
          const sz = img.getSize();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('screenshot:completed', {
              dataUrl,
              width: sz.width,
              height: sz.height,
              isStitched: true,
            });
          }
          try { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); } catch(e) {}
          try { fs.unlinkSync(cumPath); } catch(e) {}
          longCaptureCumulative = null;
          longCapturePrevFrame = null;
          longCaptureFrames = [];
          longCaptureRegion = null;
          closeScreenshotWindows();
          return;
        }
      }
    } catch(e) { console.error('[longshot] daemon finish error:', e.message); }
    killCapDaemon();
  }

  // ── Legacy path: cumulative file from incrstitch.py ──
  const cumPath = path.join(app.getPath('temp'), 'sticky-notes-cumulative.png');
  if (longCaptureCumulative && fs.existsSync(cumPath)) {
    const buf = fs.readFileSync(cumPath);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    const img = nativeImage.createFromDataURL(dataUrl);
    const sz = img.getSize();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const result = { dataUrl, width: sz.width, height: sz.height, isStitched: true };
      mainWindow.webContents.send('screenshot:completed', result);
    }
    try { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); } catch(e) {}
    try { fs.unlinkSync(cumPath); } catch(e) {}
    longCaptureCumulative = null;
    longCapturePrevFrame = null;
    longCaptureFrames = [];
    longCaptureRegion = null;
    closeScreenshotWindows();
    return;
  }

  // Fallback: batch stitching (old path)
  if (!frames || frames.length === 0) {
    if (region) {
      const single = await captureScreenRegion(region.x, region.y, region.w, region.h, null);
      if (single && single.dataUrl && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('screenshot:completed', single);
        try { clipboard.writeImage(nativeImage.createFromDataURL(single.dataUrl)); } catch(e) {}
      }
    }
  } else if (frames.length === 1) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screenshot:completed', frames[0]);
      try { clipboard.writeImage(nativeImage.createFromDataURL(frames[0].dataUrl)); } catch(e) {}
    }
  } else {
    const maxFrames = 80;
    const useFrames = frames.length > maxFrames ? frames.slice(-maxFrames) : frames;
    const dataUrls = useFrames.map(f => f.dataUrl);
    const alignResult = callPython('align.py', { images: dataUrls });
    if (alignResult && alignResult.ok) {
      const offsets = alignResult.alignments.map(a => a.offset);
      const stitchResult = callPython('stitch.py', { images: dataUrls, offsets });
      if (stitchResult && stitchResult.ok && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('screenshot:completed', {
          dataUrl: stitchResult.dataUrl,
          width: stitchResult.width,
          height: stitchResult.height,
          isStitched: true,
        });
        try { clipboard.writeImage(nativeImage.createFromDataURL(stitchResult.dataUrl)); } catch(e) {}
      }
    }
  }
  longCaptureCumulative = null;
  longCapturePrevFrame = null;
  longCaptureFrames = [];
  longCaptureRegion = null;
  closeScreenshotWindows();
}

function closeScreenshotWindows() {
  killCapDaemon();
  for (const w of screenshotOverlays) {
    if (w && !w.isDestroyed()) w.close();
  }
  screenshotOverlays = [];
  longCaptureActive = false;
  longCaptureCumulative = null;
  longCapturePrevFrame = null;
  longCaptureFrames = [];
  longCaptureRegion = null;
  stopAutoCaptureDiag();
}

// Convert overlay logical (DIP) screen coordinates to physical pixels for mss.
// On mixed-DPI multi-monitor setups, e.screenX/Y returns DIP coordinates where
// each axis band inherits the DPI of the monitor that "owns" it.
function logicalToPhysical(logX, logY, logW, logH) {
  const displays = screen.getAllDisplays();
  const cx = logX + logW / 2, cy = logY + logH / 2;
  const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const sf = display.scaleFactor || 1;
  const dxLog = display.bounds.x;
  const dyLog = display.bounds.y;

  // Physical position of the display: within the primary's x/y band → no scale;
  // outside the primary's band → scale by this display's sf.
  const primary = screen.getPrimaryDisplay();
  const primaryW = primary.bounds.width;
  const primaryH = primary.bounds.height;
  const dxPhys = (dxLog >= 0 && dxLog < primaryW) ? dxLog : Math.round(dxLog * sf);
  const dyPhys = (dyLog >= 0 && dyLog < primaryH) ? dyLog : Math.round(dyLog * sf);

  return {
    x: dxPhys + Math.round((logX - dxLog) * sf),
    y: dyPhys + Math.round((logY - dyLog) * sf),
    w: Math.round(logW * sf),
    h: Math.round(logH * sf),
  };
}

async function captureScreenRegion(x, y, width, height, screenId) {
  try {
    // Use the display nearest to capture point for correct DPI handling
    const capDisplay = screen.getDisplayNearestPoint({ x, y });
    const capSF = capDisplay.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: capDisplay.size.width, height: capDisplay.size.height },
    });

    if (sources.length === 0) return null;

    // Find source matching the capture display
    const source = sources.find(s => s.display_id === String(capDisplay.id)) || sources[0];
    const fullImage = source.thumbnail;

    // fullImage covers capDisplay. Crop x,y are physical screen coords relative to display origin
    const scaleFactor = fullImage.getSize().width / capDisplay.bounds.width;
    const cropRect = {
      x: Math.round((x - capDisplay.bounds.x) * scaleFactor),
      y: Math.round((y - capDisplay.bounds.y) * scaleFactor),
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor),
    };

    const cropped = fullImage.crop(cropRect);
    const dataUrl = cropped.toDataURL();

    return { dataUrl, width: cropped.getSize().width, height: cropped.getSize().height };
  } catch (e) {
    console.error('Screenshot capture error:', e);
    return null;
  }
}

let longCaptureToolbar = null;
let longCaptureTimer = null;
let longGuideOverlay = null;
let autoCapTimer = null;
let stitchBusy = false;

// ── Diagnostic Preview Window ──

function createDiagPreviewWindow(selX, selY, selW, selH) {
  closeDiagPreview();
  const pw = diagnostic.getConfig().previewWidth;
  const previewW = pw + 16;
  const display = screen.getDisplayNearestPoint({ x: selX + selW / 2, y: selY + selH / 2 });
  const maxH = Math.min(selH, display.bounds.height - 80);
  const previewH = maxH;
  let px = selX + selW + 12, py = selY;
  if (px + previewW > display.bounds.x + display.bounds.width) px = selX - previewW - 12;
  if (px < display.bounds.x) px = display.bounds.x + 8;
  if (py + previewH > display.bounds.y + display.bounds.height) py = display.bounds.y + display.bounds.height - previewH - 8;
  if (py < display.bounds.y) py = display.bounds.y + 8;
  const previewHTML = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'body{background:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;display:flex;flex-direction:column;height:100vh}' +
    '#header{color:#aaa;font-size:10px;padding:3px 6px;flex-shrink:0;text-align:center;background:#222}' +
    '#scroll{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;align-items:center}' +
    '#preview-stack{display:flex;flex-direction:column;width:100%}' +
    '#preview-stack img{display:block;width:100%;image-rendering:auto}' +
    '#info{color:#888;font-size:9px;padding:2px 6px;flex-shrink:0;text-align:center;background:#222}' +
    '::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:2px}' +
    '</style></head><body>' +
    '<div id="header">Long Screenshot Preview</div>' +
    '<div id="scroll"><div id="preview-stack"></div></div>' +
    '<div id="info">Waiting...</div>' +
    '</body></html>';
  const tempDir = path.join(app.getPath('temp'), 'sticky-notes-screenshot');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const f = path.join(tempDir, 'diag-preview.html');
  fs.writeFileSync(f, previewHTML, 'utf-8');
  diagPreviewWindow = new BrowserWindow({
    x: px, y: py, width: previewW, height: previewH,
    transparent: false, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false, backgroundColor: '#1a1a2e',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  diagPreviewWindow.setAlwaysOnTop(true, 'screen-saver');
  diagPreviewWindow.setIgnoreMouseEvents(true);
  diagPreviewWindow.loadFile(f);
  diagPreviewWindow.on('closed', () => { diagPreviewWindow = null; });
  return diagPreviewWindow;
}

function updateDiagPreview(previewInfo) {
  if (!diagPreviewWindow || diagPreviewWindow.isDestroyed()) return;
  const { previewPath, tileCount, stitchedHeight } = previewInfo;
  const now = performance.now();
  if (!updateDiagPreview._lastUpdate) updateDiagPreview._lastUpdate = 0;
  const minInterval = 1000 / Math.max(1, diagnostic.getConfig().previewMaxFps || 4);
  if (now - updateDiagPreview._lastUpdate < minInterval) {
    if (updateDiagPreview._pendingTimer) clearTimeout(updateDiagPreview._pendingTimer);
    updateDiagPreview._pendingTimer = setTimeout(() => {
      updateDiagPreview._pendingTimer = null;
      updateDiagPreview._lastUpdate = 0;
      updateDiagPreview(previewInfo);
    }, minInterval);
    return;
  }
  updateDiagPreview._lastUpdate = now;
  const version = Date.now();
  const imgSrc = previewPath ? 'file://' + previewPath.replace(/\\/g, '/') + '?v=' + version : '';
  const script = '(function(){var s=document.getElementById("preview-stack");var i=document.getElementById("info");var sc=document.getElementById("scroll");if("' + imgSrc + '"!==""){s.innerHTML="";var m=document.createElement("img");m.src="' + imgSrc + '";m.style.display="block";m.style.width="100%";m.onerror=function(){this.style.display="none"};s.appendChild(m)}i.textContent="' + tileCount + ' tiles | ' + stitchedHeight + 'px";setTimeout(function(){sc.scrollTop=sc.scrollHeight},50)})();';
  diagPreviewWindow.webContents.executeJavaScript(script).catch(() => {});
}

function closeDiagPreview() {
  if (updateDiagPreview._pendingTimer) { clearTimeout(updateDiagPreview._pendingTimer); updateDiagPreview._pendingTimer = null; }
  updateDiagPreview._lastUpdate = 0;
  if (diagPreviewWindow && !diagPreviewWindow.isDestroyed()) diagPreviewWindow.close();
  diagPreviewWindow = null;
}

// ── Diagnostic-aware auto-capture ──

function startAutoCaptureDiag(region) {
  const config = diagnostic.getConfig();
  const mode = config.mode;
  if (!diagLogPath) diagLogPath = diagnostic.initLogger('long-capture');
  if (diagEventLoopMonitor) diagEventLoopMonitor.stop();
  diagEventLoopMonitor = diagnostic.startEventLoopMonitor('main');
  const tempDir = path.join(app.getPath('temp'), 'sticky-notes-diag');
  diagTilesDir = path.join(tempDir, 'tiles');
  if (!fs.existsSync(diagTilesDir)) fs.mkdirSync(diagTilesDir, { recursive: true });
  const cumPath = path.join(tempDir, 'sticky-notes-cumulative-diag.png');
  if (fs.existsSync(cumPath)) fs.unlinkSync(cumPath);
  const capRegion = diagnostic.resolveCaptureArea(region) || region;
  async function captureFn(r) { return await captureScreenRegion(r.x, r.y, r.w, r.h, null); }
  function stitchFn(prevDataUrl, currDataUrl, cumulativePath) {
    return callPython('incrstitch_diag.py', {
      prev: prevDataUrl, curr: currDataUrl, cumPath: cumulativePath,
      previewDir: diagnostic.getConfig().previewEnabled ? path.join(tempDir, 'preview-tiles') : null,
      previewWidth: diagnostic.getConfig().previewWidth, useFilePaths: false,
    });
  }
  function onPreviewUpdate(previewInfo) {
    if (diagPreviewWindow && !diagPreviewWindow.isDestroyed()) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('screenshot:preview-update', {
          type: 'preview-update', previewPath: previewInfo.previewPath,
          previewWidth: previewInfo.previewWidth, previewHeight: previewInfo.previewHeight,
          stitchedHeight: previewInfo.stitchedHeight, tileCount: previewInfo.tileCount,
          incremental: previewInfo.incremental, durationMs: previewInfo.durationMs,
        });
      }
      updateDiagPreview(previewInfo);
    }
  }
  function onFrameCaptured(frameInfo) {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('screenshot:capture-progress', { type: 'capture-progress', ...frameInfo });
  }
  const loop = diagnostic.createDiagnosticCaptureLoop({
    captureFn, stitchFn, onPreviewUpdate, onFrameCaptured,
    region: capRegion, tempDir,
  });
  diagCaptureLoop = loop;
  if (config.previewEnabled) {
    diagnostic.resetPreviewState();
    createDiagPreviewWindow(region.x, region.y, region.w, region.h);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('screenshot:diag-status', {
      type: 'diag-status', active: true, mode,
      captureInterval: config.captureInterval, captureArea: config.captureArea,
      previewEnabled: config.previewEnabled, logPath: diagLogPath,
    });
  }
  loop.start();
}

function stopAutoCaptureDiag() {
  if (diagCaptureLoop) { diagCaptureLoop.stop(); diagCaptureLoop = null; }
  if (diagEventLoopMonitor) {
    const stats = diagEventLoopMonitor.stop();
    diagEventLoopMonitor = null;
    if (mainWindow && !mainWindow.isDestroyed() && stats) {
      mainWindow.webContents.send('screenshot:diag-stats', {
        type: 'eventloop-stats', scope: 'main', ...stats,
      });
    }
  }
  closeDiagPreview();
  diagnostic.resetPreviewState();
  diagnostic.closeLogger();
  diagLogPath = null;
}

function finishLongCaptureFromFramesDiag(region) {
  const mode = diagnostic.getConfig().mode;
  stopAutoCaptureDiag();
  const tempDir = path.join(app.getPath('temp'), 'sticky-notes-diag');
  const cumPath = path.join(tempDir, 'sticky-notes-cumulative-diag.png');
  if (fs.existsSync(cumPath)) {
    const buf = fs.readFileSync(cumPath);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    const img = nativeImage.createFromDataURL(dataUrl);
    const sz = img.getSize();
    diagnostic.logEvent('result', 'final', {
      width: sz.width, height: sz.height, bytes: buf.length, mode,
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screenshot:completed', {
        dataUrl, width: sz.width, height: sz.height, isStitched: true,
      });
    }
    try { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); } catch(e) {}
    try { fs.unlinkSync(cumPath); } catch(e) {}
  } else if (region) {
    captureScreenRegion(region.x, region.y, region.w, region.h, null).then(result => {
      if (result && result.dataUrl && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('screenshot:completed', result);
        try { clipboard.writeImage(nativeImage.createFromDataURL(result.dataUrl)); } catch(e) {}
      }
    });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('screenshot:diag-status', {
      type: 'diag-status', active: false, mode, logPath: diagLogPath,
    });
  }
  closeScreenshotWindows();
}

function startAutoCapture() {
  // Diagnostic routing: if non-baseline mode, use diagnostic loop
  const mode = diagnostic.getConfig().mode;
  if (mode !== 'baseline' && mode !== 'baseline-with-preview' && mode !== 'baseline-no-preview') {
    if (longCaptureRegion) { startAutoCaptureDiag(longCaptureRegion); return; }
  }
  if (mode === 'baseline-with-preview' || mode === 'baseline-no-preview') {
    if (longCaptureRegion) { startAutoCaptureDiag(longCaptureRegion); return; }
  }

  // ── Primary path: mss daemon (no GPU, no execSync) ──
  if (autoCapTimer) clearInterval(autoCapTimer);
  longCaptureCumulative = null;
  longCapturePrevFrame = null;
  stitchBusy = false;
  const cumPath = path.join(app.getPath('temp'), 'sticky-notes-cumulative.png');
  if (fs.existsSync(cumPath)) fs.unlinkSync(cumPath);

  let daemonActive = true;

  spawnCapDaemon().then(() => {
    if (!capDaemon || capDaemon.killed || !longCaptureActive || !longCaptureRegion) {
      daemonActive = false; killCapDaemon(); return;
    }
    const r = longCaptureRegion;
    // Log Electron's display info for cross-reference with mss
    const electronDisplays = screen.getAllDisplays().map(d => ({
      id: d.id, x: d.bounds.x, y: d.bounds.y,
      w: d.bounds.width, h: d.bounds.height,
      sf: d.scaleFactor,
    }));
    console.log('[longshot] Electron displays:', JSON.stringify(electronDisplays));
    console.log('[longshot] capture region (from overlay):',
      { left: r.x, top: r.y, width: r.w, height: r.h });
    return sendDaemon({
      action: 'configure',
      cum_path: cumPath,
      region: { left: r.x, top: r.y, width: r.w, height: r.h },
    });
  }).then((configureResult) => {
    if (!daemonActive || !longCaptureActive) return;
    // If configure reports an error (e.g., region outside monitors), fall back to legacy
    if (!configureResult || !configureResult.ok) {
      console.error('[longshot] daemon configure failed:',
        configureResult && configureResult.error ? configureResult.error : 'unknown',
        configureResult && configureResult.monitors ? 'mss monitors:' + JSON.stringify(configureResult.monitors) : '');
      daemonActive = false;
      killCapDaemon();
      _startAutoCaptureLegacy(cumPath);
      return;
    }
    console.log('[longshot] daemon configured OK, mss region:',
      JSON.stringify(configureResult.region),
      'monitors:', JSON.stringify(configureResult.monitors));
    longCaptureCumulative = cumPath;

    function tick() {
      if (!longCaptureActive || !daemonActive) { autoCapTimer = null; return; }
      if (stitchBusy) { autoCapTimer = setTimeout(tick, 50); return; }

      stitchBusy = true;
      sendDaemon({ action: 'tick' }).then(result => {
        stitchBusy = false;
        if (!daemonActive) return;
        if (result && result.ok && !result.duplicate && result.stitch_ok) {
          longCaptureCumulative = cumPath;
        }
        autoCapTimer = setTimeout(tick, 200);
      }).catch(err => {
        stitchBusy = false;
        if (!daemonActive || !longCaptureActive) return;
        // Daemon tick failed mid-capture — stop gracefully.
        // We do NOT fall back to legacy here because the capture methods
        // (mss vs desktopCapturer) produce different pixels, which would
        // break the incremental stitch. Keep whatever was accumulated.
        console.error('[longshot] daemon tick failed, stopping capture:', err.message);
        daemonActive = false;
        killCapDaemon();
        autoCapTimer = null;
      });
    }
    autoCapTimer = setTimeout(tick, 200);
  }).catch(err => {
    console.error('[longshot] daemon spawn failed, falling back to legacy:', err.message);
    killCapDaemon();
    _startAutoCaptureLegacy(cumPath);
  });
}

// ── Legacy fallback: desktopCapturer + execSync('incrstitch.py') ──
function _startAutoCaptureLegacy(cumPath) {
  if (autoCapTimer) clearInterval(autoCapTimer);
  longCaptureCumulative = null;
  longCapturePrevFrame = null;
  stitchBusy = false;

  if (!cumPath) {
    cumPath = path.join(app.getPath('temp'), 'sticky-notes-cumulative.png');
    if (fs.existsSync(cumPath)) fs.unlinkSync(cumPath);
  }

  function tick() {
    if (!longCaptureActive || !longCaptureRegion) { autoCapTimer = null; return; }
    if (stitchBusy) { autoCapTimer = setTimeout(tick, 50); return; }
    const r = longCaptureRegion;
    stitchBusy = true;
    captureScreenRegion(r.x, r.y, r.w, r.h, null).then(result => {
      if (!result || !result.dataUrl) { stitchBusy = false; autoCapTimer = setTimeout(tick, 200); return; }
      if (longCapturePrevFrame && longCapturePrevFrame.slice(0, 50000) === result.dataUrl.slice(0, 50000)) {
        stitchBusy = false; autoCapTimer = setTimeout(tick, 200); return;
      }

      if (!longCapturePrevFrame) {
        longCapturePrevFrame = result.dataUrl;
        const firstImg = nativeImage.createFromDataURL(result.dataUrl);
        fs.writeFileSync(cumPath, firstImg.toPNG());
        stitchBusy = false;
        autoCapTimer = setTimeout(tick, 200);
        return;
      }

      try {
        const stitchResult = callPython('incrstitch.py', {
          prev: longCapturePrevFrame,
          curr: result.dataUrl,
          cum_path: cumPath,
        });
        if (stitchResult && stitchResult.ok) {
          longCapturePrevFrame = result.dataUrl;
          longCaptureCumulative = cumPath;
        }
      } catch(e) {}
      stitchBusy = false;
      autoCapTimer = setTimeout(tick, 200);
    }).catch(() => { stitchBusy = false; autoCapTimer = setTimeout(tick, 200); });
  }
  autoCapTimer = setTimeout(tick, 200);
}
function stopAutoCapture() { if (autoCapTimer) { clearTimeout(autoCapTimer); autoCapTimer = null; } }

function showLongCaptureUI(x, y, w, h) {
  // Overlays stay hidden during capture (hidden by poll loop on long-start)
  // so they don't appear in mss screen capture

  // Floating toolbar below selection, matching main app glass style
  const tbHTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;gap:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden}
.tb{background:rgba(30,30,30,0.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:5px 8px;display:flex;align-items:center;gap:6px}
.b{border:1px solid rgba(255,255,255,0.12);padding:7px 16px;border-radius:8px;cursor:pointer;font-size:13px;color:#fff;white-space:nowrap;background:rgba(255,255,255,0.08);transition:all .15s;font-family:inherit}
.b:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.22)}
.bf{background:rgba(0,180,100,0.82);border-color:rgba(0,200,120,0.3)}.bf:hover{background:rgba(0,210,130,0.9)}
.bc{background:rgba(200,60,60,0.7);border-color:rgba(230,80,80,0.3)}.bc:hover{background:rgba(230,80,80,0.85)}
.hint{color:rgba(255,255,255,0.45);font-size:10px;margin:0 4px}
</style></head><body>
<div class="tb">
<span class="hint">Enter 保存 · Esc 取消</span>
<button class="b bf" id="done">保存</button>
<button class="b bc" id="cancel">取消</button>
</div>
<script>const{ipcRenderer}=require('electron');
document.getElementById('done').onclick=function(){ipcRenderer.send('screenshot:long-finish');window.close()};
document.getElementById('cancel').onclick=function(){ipcRenderer.send('screenshot:long-cancel');window.close()};
document.addEventListener('keydown',function(e){if(e.key==='Enter'){ipcRenderer.send('screenshot:long-finish');window.close()}else if(e.key==='Escape'){ipcRenderer.send('screenshot:long-cancel');window.close()}});
</script></body></html>`;

  const tempDir = path.join(app.getPath('temp'), 'sticky-notes-screenshot');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const f = path.join(tempDir, 'long-toolbar.html');
  fs.writeFileSync(f, tbHTML, 'utf-8');

  // Position toolbar at same spot as overlay's original toolbar (8px below selection)
  // x,y,w,h and BrowserWindow coords are both in DIP (device-independent pixels)
  const tbW = 270, tbH = 48;
  const gap = 8;
  let tbx = x, tby = y + h + gap;
  // Keep on screen
  const disp = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 });
  if (tbx + tbW > disp.bounds.x + disp.bounds.width) tbx = disp.bounds.x + disp.bounds.width - tbW - 8;
  if (tby + tbH > disp.bounds.y + disp.bounds.height) tby = y - tbH - gap;

  longCaptureToolbar = new BrowserWindow({
    x: tbx, y: tby, width: tbW, height: tbH,
    transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: true,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  longCaptureToolbar.setAlwaysOnTop(true, 'screen-saver');
  longCaptureToolbar.loadFile(f);
  longCaptureToolbar.on('closed', () => { longCaptureToolbar = null; });
}

function hideLongCaptureUI() {
  if (longCaptureToolbar && !longCaptureToolbar.isDestroyed()) longCaptureToolbar.close();
  if (longGuideOverlay && !longGuideOverlay.isDestroyed()) longGuideOverlay.close();
  longCaptureToolbar = null;
  longGuideOverlay = null;
}

function createLongCaptureToolbar() {
  if (longCaptureToolbar && !longCaptureToolbar.isDestroyed()) {
    longCaptureToolbar.close();
  }
  const cp2 = screen.getCursorScreenPoint();
  const tdisp = screen.getDisplayNearestPoint(cp2);
  const sw = tdisp.workArea.width;
  const sx = tdisp.workArea.x;

  longCaptureToolbar = new BrowserWindow({
    x: sx + Math.round(sw / 2 - 105), y: tdisp.workArea.y + 60,
    width: 210, height: 44,
    transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  longCaptureToolbar.setAlwaysOnTop(true, 'screen-saver');

  const tHTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;gap:8px}
.b{border:none;padding:6px 16px;border-radius:8px;cursor:pointer;font-size:13px;color:#fff;font-family:inherit}
.fin{background:rgba(0,190,100,0.88)}.fin:hover{background:rgba(0,210,130,0.95)}
.can{background:rgba(200,60,60,0.82)}.can:hover{background:rgba(230,80,80,0.95)}
</style></head><body>
<button class="b fin" onclick="done()">完成</button>
<button class="b can" onclick="cancel()">取消</button>
<script>
const {ipcRenderer}=require('electron');
function done(){ipcRenderer.invoke('screenshot:finishLongCapture',{}).then(r=>{if(r)ipcRenderer.send('screenshot:result',r);window.close()})}
function cancel(){ipcRenderer.invoke('screenshot:cancelLongCapture');window.close()}
</script></body></html>`;

  const tempDir = path.join(app.getPath('temp'), 'sticky-notes-screenshot');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const f = path.join(tempDir, 'long-toolbar.html');
  fs.writeFileSync(f, tHTML, 'utf-8');
  longCaptureToolbar.loadFile(f);
  longCaptureToolbar.on('closed', () => { longCaptureToolbar = null; });
}

async function startLongCapture(x, y, width, height, screenId) {
  longCaptureActive = true;
  longCaptureFrames = [];
  longCaptureRegion = { x, y, width, height };

  // Hide all overlays so user can scroll content below
  for (const w of screenshotOverlays) {
    if (w && !w.isDestroyed()) {
      w.setIgnoreMouseEvents(true, { forward: true });
      w.hide();
    }
  }

  createLongCaptureToolbar();

  // Auto-capture every 500ms
  longCaptureTimer = setInterval(async () => {
    if (!longCaptureActive) return;
    const r = longCaptureRegion;
    // Capture current frame
    const result = await captureScreenRegion(r.x, r.y, r.width, r.height, null);
    if (result) {
      const last = longCaptureFrames[longCaptureFrames.length - 1];
      if (!last || last.dataUrl !== result.dataUrl) {
        longCaptureFrames.push(result);
      }
    }
  }, 600);

  return true;
}

async function captureScrollFrame(x, y, width, height, screenId) {
  if (!longCaptureActive) return null;
  const result = await captureScreenRegion(x, y, width, height, screenId);
  if (result) longCaptureFrames.push(result);
  return result;
}

async function finishLongCapture(frames) {
  longCaptureActive = false;
  if (longCaptureTimer) { clearInterval(longCaptureTimer); longCaptureTimer = null; }
  if (longCaptureToolbar && !longCaptureToolbar.isDestroyed()) longCaptureToolbar.close();
  closeScreenshotWindows();

  const allFrames = longCaptureFrames;
  if (allFrames.length === 0) {
    const region = longCaptureRegion;
    if (!region) return null;
    return await captureScreenRegion(region.x, region.y, region.width, region.height, null);
  }

  // Dedup frames
  const uniqueFrames = [allFrames[0]];
  for (let i = 1; i < allFrames.length; i++) {
    const last = uniqueFrames[uniqueFrames.length - 1];
    if (Math.abs(allFrames[i].height - last.height) > 10 ||
        allFrames[i].dataUrl !== last.dataUrl) {
      uniqueFrames.push(allFrames[i]);
    }
  }

  longCaptureFrames = [];
  longCaptureRegion = null;

  if (uniqueFrames.length === 1) {
    return uniqueFrames[0];
  }

  // Use Python OpenCV to align and stitch
  const dataUrls = uniqueFrames.map(f => f.dataUrl);
  const alignResult = callPython('align.py', { images: dataUrls });
  if (alignResult && alignResult.ok) {
    const offsets = alignResult.alignments.map(a => a.offset);
    const stitchResult = callPython('stitch.py', { images: dataUrls, offsets });
    if (stitchResult && stitchResult.ok) {
      return {
        dataUrl: stitchResult.dataUrl,
        width: stitchResult.width,
        height: stitchResult.height,
        isStitched: true,
      };
    }
  }

  // Fallback: simple vertical stack
  const maxWidth = Math.max(...uniqueFrames.map(f => f.width));
  const totalHeight = uniqueFrames.reduce((sum, f) => sum + f.height, 0);
  return {
    dataUrl: uniqueFrames[0].dataUrl, // fallback
    width: maxWidth,
    height: totalHeight,
    isStitched: false,
  };
  return {
    dataUrl: null,
    frames: uniqueFrames,
    totalWidth: maxWidth,
    totalHeight: totalHeight,
    isStitched: true,
  };
}

function calculateTotalBounds(displays) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Convert shortcut string (e.g. 'Ctrl+Shift+X') to Electron accelerator
function toAccelerator(shortcut) {
  if (!shortcut) return '';
  return shortcut
    .replace(/\bCtrl\b/g, 'CommandOrControl')
    .replace(/\bMeta\b/g, 'Super');
}

// Toggle states (persist across re-registrations)
let allPenetrate = false;
let allTransparent = false;

function getShortcutActions(settings) {
  return [
    {
      shortcut: settings?.shortcutScreenshot || 'Ctrl+Shift+X',
      action: () => { captureWithNativeSnipping(); },
    },
    {
      shortcut: settings?.shortcutLongScreenshot || 'Ctrl+Shift+Alt+X',
      action: () => { createScreenshotOverlay('long'); },
    },
    {
      shortcut: settings?.shortcutPenetrate || 'Ctrl+P',
      action: () => {
        allPenetrate = !allPenetrate;
        for (const [id, win] of floatingManager.floatingWindows) {
          if (win && !win.isDestroyed()) {
            if (allPenetrate) {
              win.setIgnoreMouseEvents(true, { forward: true });
              win.webContents.send('float:penetrateChanged', true);
            } else {
              win.setIgnoreMouseEvents(false);
              win.webContents.send('float:penetrateChanged', false);
            }
          }
        }
      },
    },
    {
      shortcut: settings?.shortcutCloseAll || 'Ctrl+Shift+W',
      action: () => {
        floatingManager.closeAll();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('floating:allClosed');
        }
      },
    },
    {
      shortcut: settings?.shortcutTransparent || 'Ctrl+Shift+T',
      action: () => {
        allTransparent = !allTransparent;
        for (const [id, win] of floatingManager.floatingWindows) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('float:transparentChanged', allTransparent);
          }
        }
      },
    },
  ];
}

let _registeredAccels = [];

function registerAllShortcuts(settings) {
  const newAccels = [];
  for (const { shortcut, action } of getShortcutActions(settings)) {
    const accel = toAccelerator(shortcut);
    if (!accel) continue;

    // Only re-register if changed or new
    if (!_registeredAccels.includes(accel)) {
      try {
        // Unregister old if it exists
        globalShortcut.unregister(accel);
        globalShortcut.register(accel, action);
      } catch(e) { console.error('Shortcut register failed:', accel, e); }
    }
    newAccels.push(accel);
  }

  // Unregister shortcuts that are no longer in settings
  for (const old of _registeredAccels) {
    if (!newAccels.includes(old)) {
      try { globalShortcut.unregister(old); } catch(e) {}
    }
  }
  _registeredAccels = newAccels;
}

// Load settings and get shortcut config
function loadShortcutSettings() {
  const userDataPath = app.getPath('userData');
  const filePath = path.join(userDataPath, 'notes-data.json');
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data.settings || {};
    }
  } catch(e) {}
  return {};
}

// IPC to re-register shortcuts when settings change
function setupShortcutIPC() {
  ipcMain.handle('shortcuts:update', async (event, settings) => {
    registerAllShortcuts(settings);
    return true;
  });
}

// App lifecycle
app.whenReady().then(() => {
  // Cache display bounds once at startup (overwrites each time, ~1KB)
  cacheDisplayBounds();
  // Also refresh on display changes
  screen.on('display-added', cacheDisplayBounds);
  screen.on('display-removed', cacheDisplayBounds);
  screen.on('display-metrics-changed', cacheDisplayBounds);

  setupIPC();
  setupShortcutIPC();
  createMainWindow();

  // Register shortcuts from saved settings
  const settings = loadShortcutSettings();
  registerAllShortcuts(settings);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  floatingManager.closeAll();
});

// Show always-on-top toast notification
ipcMain.handle('show-toast', (event, message) => {
  const cp = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cp);
  const { x: dx, width: dw } = disp.workArea;
  const toastW = 220, toastH = 44;
  const toastWin = new BrowserWindow({
    width: toastW, height: toastH,
    x: dx + dw - toastW - 16,
    y: disp.workArea.y + 48,
    transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  toastWin.setVisibleOnAllWorkspaces(true);
  const h = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh}
.toast{padding:8px 18px;border-radius:12px;background:rgba(30,30,50,0.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.9);font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.4);animation:fadeIn .2s ease-out}
@keyframes fadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
</style></head><body><div class="toast">${message}</div></body></html>`;
  const tempDir = path.join(app.getPath('temp'), 'sticky-notes-screenshot');
  const f = path.join(tempDir, 'toast.html');
  fs.writeFileSync(f, h, 'utf-8');
  toastWin.loadFile(f);
  setTimeout(() => { toastWin.close(); }, 2500);
  return true;
});

// Listen for screenshot results from overlay
ipcMain.on('screenshot:result', (event, result) => {
  if (result && result.dataUrl) {
    // Copy to clipboard
    try {
      const img = nativeImage.createFromDataURL(result.dataUrl);
      clipboard.writeImage(img);
    } catch(e) {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('screenshot:completed', result);
  }
});
