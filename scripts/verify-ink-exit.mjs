import { build } from 'vite';
import { startInkTestServer } from './ink-test-server.mjs';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-ink-exit-'));
const output = path.resolve(process.argv[2] ?? 'docs/ink-exit-smoke.json');
fs.symlinkSync(path.resolve('src'), path.join(temporary, 'src'), 'junction');
fs.symlinkSync(path.resolve('node_modules'), path.join(temporary, 'node_modules'), 'junction');
fs.mkdirSync(path.join(temporary, 'scripts'));
for (const file of ['ink-exit-smoke.html', 'ink-exit-smoke.tsx']) fs.copyFileSync(path.join('scripts', file), path.join(temporary, 'scripts', file));
await build({ root: temporary, configFile: false, plugins: [react()], resolve: { alias: { '@': path.resolve('src') } },
  build: { outDir: path.join(temporary, 'output'), rollupOptions: { input: path.join(temporary, 'scripts/ink-exit-smoke.html') } } });
const server = await startInkTestServer(path.join(temporary, 'output'));
const port = server.port;
const appData = path.join(temporary, 'appData'), profile = path.join(temporary, 'profile');
fs.mkdirSync(appData); fs.mkdirSync(profile);
fs.writeFileSync(path.join(appData, 'sticky-notes-config.json'), JSON.stringify({ dir: profile, prevDir: null }));
const results = [];
try {
  for (const phase of ['create', 'reopen']) {
    const helper = path.join(temporary, phase); fs.mkdirSync(helper);
    fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'ink-exit-smoke', main: 'main.js' }));
    const resultFile = path.join(helper, 'result.json');
    fs.writeFileSync(path.join(helper, 'main.js'), `
const { app, BrowserWindow, ipcMain, globalShortcut, dialog } = require('electron');
const fs = require('fs');
app.setPath('appData', ${JSON.stringify(appData)}); app.setPath('userData', ${JSON.stringify(profile)});
// Only the isolated harness suppresses display and unrelated global shortcuts.
BrowserWindow.prototype.show = function() {};
const loadURL = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function() { return loadURL.call(this, ${JSON.stringify(`http://127.0.0.1:${port}/scripts/ink-exit-smoke.html?phase=${phase}`)}); };
globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {};
let ready, ack, failure;
const save = () => fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ phase: ${JSON.stringify(phase)}, ready, ack, failure }));
dialog.showErrorBox = (_title, message) => { failure = message; save(); app.exit(1); };
ipcMain.on('app:flushed-storage', (_event, result) => { ack = result; });
app.on('browser-window-created', (_event, win) => {
  win.webContents.openDevTools = () => {};
  const started = Date.now(); let polling = false;
  const timer = setInterval(async () => {
    if (polling || win.isDestroyed()) return; polling = true;
    try { ready = await win.webContents.executeJavaScript('window.exitSmokeReady'); } catch {}
    if (ready) { clearInterval(timer); if (ready.error) { failure = ready.error; save(); app.exit(1); } else win.close(); }
    else if (Date.now()-started > 45000) { failure = 'renderer timeout'; clearInterval(timer); save(); app.exit(1); }
    polling = false;
  }, 100);
});
app.on('quit', save);
require(${JSON.stringify(path.resolve('electron/main.js'))});
`);
    const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), ['--no-sandbox', helper],
      { stdio: 'pipe', windowsHide: true });
    child.stderr.on('data', data => process.stderr.write(data));
    const code = await new Promise(resolve => child.on('exit', resolve));
    const result = JSON.parse(fs.readFileSync(resultFile)); results.push({ code, ...result });
    if (code !== 0 || !result.ack || result.ack.error || result.failure) throw new Error(`Exit verification failed: ${JSON.stringify(result)}`);
  }
} finally { await server.close(); fs.writeFileSync(output, JSON.stringify({ profile, results }, null, 2)); }
console.log(JSON.stringify({ output, results }));
