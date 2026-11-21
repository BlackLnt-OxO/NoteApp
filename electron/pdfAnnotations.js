const { ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function setupPdfAnnotations(getDir) {
  function sidecar(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(getDir(), safe + '.json');
  }

  ipcMain.handle('pdf-annotation:save', (_event, id, data) => {
    let temporary;
    try {
      const filePath = sidecar(id);
      temporary = filePath + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(data), 'utf8');
      fs.renameSync(temporary, filePath);
      return { ok: true, filePath };
    } catch (error) {
      return { ok: false, error: String(error) };
    } finally {
      if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch { /* Best effort. */ } }
    }
  });
  ipcMain.handle('pdf-annotation:load', (_event, id) => {
    try { return JSON.parse(fs.readFileSync(sidecar(id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
  ipcMain.handle('pdf-annotation:delete', (_event, id) => {
    try {
      fs.rmSync(sidecar(id), { force: true });
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error) }; }
  });
}

module.exports = { setupPdfAnnotations };
