/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

/** Exercise the real main-process barrier without launching or touching a user profile. */
function mainProcess() {
  const listeners = new Map<string, Function>(), handlers = new Map<string, Function>();
  const app = { on: (name: string, fn: Function) => listeners.set(name, fn), whenReady: () => new Promise(() => {}),
    isPackaged: true, getPath: () => 'D:\\isolated-profile', setPath: vi.fn(), quit: vi.fn(), exit: vi.fn(), getGPUFeatureStatus: () => ({ '2d_canvas': 'enabled' }) };
  const ipcMain = { on: (name: string, fn: Function) => handlers.set(name, fn), handle: (name: string, fn: Function) => handlers.set(name, fn) };
  const files = { existsSync: () => false, readFileSync: () => { throw new Error('missing'); }, mkdirSync: vi.fn(), cpSync: vi.fn() };
  const dialog = { showErrorBox: vi.fn() }, flushStorageData = vi.fn().mockResolvedValue(undefined);
  const electron = { app, ipcMain, dialog, session: { defaultSession: { flushStorageData } } };
  const source = readFileSync(resolve('electron/main.js'), 'utf8');
  const context = { module: { exports: {} as any }, __dirname: resolve('electron'), process: { platform: 'win32', env: {}, execPath: 'electron.exe' },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer,
    require: (name: string) => name === 'electron' ? electron : name === 'path' ? path : name === 'fs' ? files :
      name === 'os' ? { homedir: () => 'D:\\isolated-home' } : name === 'child_process' ? { spawn: vi.fn() } : {} };
  vm.runInNewContext(source + '\nmodule.exports={requestRendererFlush,finishExit,migrateDataDir,setWindow:value=>mainWindow=value};', context);
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() }, close: vi.fn() };
  context.module.exports.setWindow(win);
  const ack = (error?: string, sender = win.webContents) => handlers.get('app:flushed-storage')!({ sender }, { id: win.webContents.send.mock.calls.find(call => call[0] === 'app:flush-storage')![1], error });
  return { ...context.module.exports, win, ack, app, files, dialog, flushStorageData };
}
describe('Electron acknowledged storage barriers', () => {
  it('shares the in-flight barrier and only accepts acknowledgement from its own window', async () => {
    const p = mainProcess(), first = p.requestRendererFlush();
    expect(p.requestRendererFlush()).toBe(first); expect(p.win.webContents.send).toHaveBeenCalledTimes(1);
    p.ack(undefined, {}); let done = false; first.then(() => done = true); await Promise.resolve(); expect(done).toBe(false);
    p.ack(); await first; expect(done).toBe(true);
  });
  it('keeps the app open and resumes editing on a save failure', async () => {
    const p = mainProcess(), finishing = p.finishExit(true); p.ack('disk full'); await finishing;
    expect(p.app.quit).not.toHaveBeenCalled(); expect(p.win.close).not.toHaveBeenCalled();
    expect(p.win.webContents.send).toHaveBeenCalledWith('app:storage-resume'); expect(p.dialog.showErrorBox).toHaveBeenCalled();
  });
  it('quits only after the renderer confirms the final transaction', async () => {
    const p = mainProcess(), finishing = p.finishExit(true); expect(p.app.quit).not.toHaveBeenCalled();
    p.ack(); await finishing; expect(p.app.quit).toHaveBeenCalledTimes(1);
  });
  it('copies a data directory only after renderer and Chromium storage are flushed', async () => {
    const p = mainProcess(), copying = p.migrateDataDir('D:\\old', 'D:\\new'); expect(p.files.cpSync).not.toHaveBeenCalled();
    p.ack(); await copying;
    expect(p.flushStorageData).toHaveBeenCalled(); expect(p.files.cpSync).toHaveBeenCalledWith('D:\\old', 'D:\\new', { recursive: true });
  });
  it('rejects nested destinations and Chromium flush failures without copying', async () => {
    const p = mainProcess();
    await expect(p.migrateDataDir('D:\\old', 'd:\\old\\child')).rejects.toThrow('内部');
    expect(p.win.webContents.send).not.toHaveBeenCalled();
    p.flushStorageData.mockRejectedValueOnce(new Error('storage flush failed'));
    const copying = p.migrateDataDir('D:\\old', 'D:\\new'); p.ack();
    await expect(copying).rejects.toThrow('storage flush failed'); expect(p.files.cpSync).not.toHaveBeenCalled();
  });
});
