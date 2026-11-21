import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Serve built fixtures on an OS-assigned port, never the user's Vite port. */
export async function startInkTestServer(directory) {
  const root = path.resolve(directory);
  const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8', '.json':'application/json', '.wasm':'application/wasm', '.png':'image/png' };
  const server = createServer((request, response) => {
    let file;
    try { file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)); }
    catch { response.writeHead(400); response.end(); return; }
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      response.writeHead(404); response.end(); return;
    }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type':mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control':'no-store' });
      const stream = fs.createReadStream(file);
      stream.on('error', () => response.destroy()); stream.pipe(response);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  if (port === 5173) { await new Promise(resolve => server.close(resolve)); throw new Error('验收端口不能使用 5173'); }
  return { port, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
