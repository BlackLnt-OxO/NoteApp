const { BrowserWindow, dialog, ipcMain, app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const imageTypes = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]);
const documentTypes = ['pdf', 'doc', 'docx', 'md', 'txt', ...imageTypes.keys()];
const typeOf = file => path.extname(file).slice(1).toLowerCase();
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function checkedPath(file, types = documentTypes) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !types.includes(typeOf(file))) {
    throw new Error('请选择支持的本地文件。');
  }
  return file;
}

async function readSource(file) {
  checkedPath(file);
  const handle = await fs.open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('请选择本地文件。');
    return await handle.readFile();
  } finally { await handle.close(); }
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}

async function renderMarkdown(text, source) {
  const md = require('markdown-it')({ html: false });
  const root = path.dirname(source);
  const tokens = md.parse(text, {});
  const images = tokens.flatMap(token => token.children ?? []).filter(token => token.type === 'image');
  for (const token of images) {
    try {
      const name = decodeURIComponent(token.attrGet('src') ?? '');
      if (!name || path.isAbsolute(name) || /^[a-z][a-z0-9+.-]*:/i.test(name)) throw new Error();
      const candidate = path.resolve(root, name);
      const relative = path.relative(root, candidate);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
        || !imageTypes.has(typeOf(candidate))) throw new Error();
      let segmentPath = root;
      for (const segment of relative.split(path.sep)) {
        segmentPath = path.join(segmentPath, segment);
        if ((await fs.lstat(segmentPath)).isSymbolicLink()) throw new Error();
      }
      const data = await readSource(candidate);
      token.attrSet('src', 'data:' + imageTypes.get(typeOf(candidate)) + ';base64,' + data.toString('base64'));
    } catch {
      token.type = 'text';
      token.content = token.content ? '[' + token.content + ']' : '[图片不可用]';
    }
  }
  return md.renderer.render(tokens, md.options, {});
}

function html(body, styles = '') {
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>' +
    '@page{size:A4;margin:18mm}body{font:12pt/1.6 "Microsoft YaHei",sans-serif;color:#111;overflow-wrap:anywhere}' +
    'img{max-width:100%;max-height:250mm;object-fit:contain}pre{white-space:pre-wrap;background:#f4f4f4;padding:.65em}' +
    'h1,h2,h3{break-after:avoid}table{border-collapse:collapse;max-width:100%}thead{display:table-header-group}td,th{border:1px solid #aaa;padding:.25em .5em}' +
    styles + '</style>' + body;
}

async function withRenderer(run) {
  const work = await fs.mkdtemp(path.join(app.getPath('temp'), 'noteapp-file-'));
  let win;
  let timer;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    const file = path.join(work, 'render.html');
    const load = async contents => {
      await fs.writeFile(file, contents, 'utf8');
      await win.loadFile(file);
    };
    return await Promise.race([
      run(win.webContents, load),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('文件排版超时。')), 120000); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (win && !win.isDestroyed()) win.destroy();
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function paginateText(source, bytes, kind) {
  const text = decodeText(bytes);
  const escaped = value => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  const body = kind === 'md' ? await renderMarkdown(text, source) : '<div style="white-space:pre-wrap">' + escaped(text) + '</div>';
  return withRenderer(async (contents, load) => {
    await load(html(body));
    await contents.executeJavaScript('Promise.all([document.fonts.ready.then(() => null), ...Array.from(document.images, img => img.decode().catch(() => null))]).then(() => null)');
    return contents.printToPDF({ preferCSSPageSize: true, printBackground: true });
  });
}

async function paginateImages(paths, read) {
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.create();
  await withRenderer(async (contents, load) => {
    for (const file of paths) {
      const mime = imageTypes.get(typeOf(file));
      const bytes = await read(file);
      await load(html('<img src="data:' + mime + ';base64,' + bytes.toString('base64') + '">'));
      const normalized = await contents.executeJavaScript('(' + (async (outputMime) => {
        const image = document.images[0];
        await image.decode();
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL(outputMime, 0.96);
      }).toString() + ')(' + JSON.stringify(mime === 'image/jpeg' ? mime : 'image/png') + ')')
        .catch(() => { throw new Error('无法解码图片：' + path.basename(file)); });
      const image = mime === 'image/jpeg' ? await pdf.embedJpg(normalized) : await pdf.embedPng(normalized);
      const scale = 841.89 / Math.max(image.width, image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }
  });
  return Buffer.from(await pdf.save());
}

const wordScript = [
  '$ErrorActionPreference = "Stop"',
  '$word = $null; $doc = $null; $discard = 0',
  'try {',
  '  $word = New-Object -ComObject Word.Application',
  '  $word.Visible = $false; $word.DisplayAlerts = 0',
  '  $security = $word.AutomationSecurity; $links = $word.Options.UpdateLinksAtOpen; $printLinks = $word.Options.UpdateLinksAtPrint',
  '  $word.AutomationSecurity = 3; $word.Options.UpdateLinksAtOpen = $false; $word.Options.UpdateLinksAtPrint = $false',
  '  $doc = $word.Documents.Open($env:NOTEAPP_WORD_SOURCE, $false, $true, $false)',
  '  $doc.ExportAsFixedFormat($env:NOTEAPP_WORD_OUTPUT, 17)',
  '} finally {',
  '  if ($doc) { try { $doc.Close([ref]$discard) } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }',
  '  if ($word) {',
  '    try { $word.Options.UpdateLinksAtOpen = $links; $word.Options.UpdateLinksAtPrint = $printLinks; $word.AutomationSecurity = $security } catch {}',
  '    try { $word.Quit([ref]$discard) } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)',
  '  }',
  '}',
].join('\r\n');

async function paginateWord(file) {
  const work = await fs.mkdtemp(path.join(app.getPath('temp'), 'noteapp-word-'));
  try {
    const output = path.join(work, 'converted.pdf');
    try {
      await promisify(execFile)('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(wordScript, 'utf16le').toString('base64'),
      ], { windowsHide: true, timeout: 90000, env: { ...process.env, NOTEAPP_WORD_SOURCE: file, NOTEAPP_WORD_OUTPUT: output } });
      return await fs.readFile(output);
    } catch {
      throw new Error('Word 转换失败。请确认桌面版 Microsoft Word 可用，且文档可以直接打开。');
    }
  } finally { await fs.rm(work, { recursive: true, force: true }).catch(() => {}); }
}

async function prepareDocument(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('请选择要打开的文件。');
  const paths = files.map(file => checkedPath(file));
  if (paths.length > 1 && !paths.every(file => imageTypes.has(typeOf(file)))) {
    throw new Error('请选择一份文档，或多选图片组成图片序列。');
  }
  const digest = createHash('sha256');
  let sizeBytes = 0;
  const read = async file => {
    let bytes;
    try { bytes = await readSource(file); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw Object.assign(new Error('找不到源文件：' + path.basename(file)), { code: 'OFFLINE' });
      throw error;
    }
    const kind = typeOf(file);
    digest.update(kind + ':' + createHash('sha256').update(bytes).digest('hex') + '\n');
    sizeBytes += bytes.length;
    return bytes;
  };
  const file = paths[0];
  const kind = typeOf(file);
  let pdf;
  if (imageTypes.has(kind)) pdf = await paginateImages(paths, read);
  else {
    const bytes = await read(file);
    if (kind === 'pdf') pdf = bytes;
    else if (kind === 'doc' || kind === 'docx') {
      pdf = await paginateWord(file);
      if (!(await readSource(file)).equals(bytes)) throw new Error('转换期间源文件已更新，请重试。');
    } else pdf = await paginateText(file, bytes, kind);
  }
  return {
    paths, kind: paths.length > 1 ? 'sequence' : kind, sizeBytes,
    name: paths.length > 1 ? path.basename(file, path.extname(file)) + ' 等 ' + paths.length + ' 张' : path.basename(file),
    digest: digest.digest('hex'), data: arrayBuffer(pdf),
  };
}

function setupFileLibrary(getWindow) {
  ipcMain.handle('file-library:pick', async (_event, options = {}) => {
    const types = options.imagesOnly ? [...imageTypes.keys()] : documentTypes;
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: options.single ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: [{ name: options.imagesOnly ? '图片' : '支持的文件', extensions: types }],
    });
    return result.canceled ? [] : result.filePaths.map(file => checkedPath(file, types));
  });
  ipcMain.handle('file-library:status', async (_event, files) => {
    return Promise.all(files.map(async file => {
      try {
        await fs.access(checkedPath(file), require('node:fs').constants.R_OK);
        return (await fs.stat(file)).isFile();
      } catch { return false; }
    }));
  });
  ipcMain.handle('file-library:image', async (_event, file) => {
    const data = await readSource(checkedPath(file, [...imageTypes.keys()]));
    return { mime: imageTypes.get(typeOf(file)), data: arrayBuffer(data) };
  });
  ipcMain.handle('file-library:prepare', async (_event, paths) => {
    try { return { ok: true, file: await prepareDocument(paths) }; }
    catch (error) { return { ok: false, error: error.message || '无法打开文件。', offline: error.code === 'OFFLINE' }; }
  });
}

module.exports = { setupFileLibrary };
