/** Isolated headless Chromium benchmark. Optional arg: pre-change InkTiles.ts.
 * Uses a temporary browser profile; never opens the application's user data. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { build } = require('esbuild');

async function runBenchmark(count, edgeFeather) {
  const strokes = Array.from({ length: count }, (_, i) => ({
    id: `s${i}`, type: 'stroke', color: '#1267cb', size: 3, opacity: 0.65,
    smoothing: 0.05, createdAt: 0, compositeOperation: 'source-over', edgeFeather,
    points: Array.from({ length: 12 }, (_, j) => ({
      x: 10 + (i % 20) * 24 + j * 2,
      y: 12 + Math.floor(i / 20) * 24 + Math.sin(j * 0.8) * 5,
      pressure: 0.25 + j * 0.05, t: j * 8,
    })),
  }));
  const grid = new Map([['0:0', strokes]]), bounds = new Map();
  for (const s of strokes) bounds.set(s.id, {
    minX: Math.min(...s.points.map(p => p.x)) - s.size / 2,
    minY: Math.min(...s.points.map(p => p.y)) - s.size / 2,
    maxX: Math.max(...s.points.map(p => p.x)) + s.size / 2,
    maxY: Math.max(...s.points.map(p => p.y)) + s.size / 2,
  });
  const removed = strokes[Math.floor(count / 2) + 10], skip = new Set([removed.id]);
  const original = InkAfter.rebuildTiles(strokes).get('0:0');
  const results = {};
  for (const [label, engine] of [['before', globalThis.InkBefore], ['after', InkAfter]]) {
    if (!engine) continue;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1536;
    const ctx = canvas.getContext('2d');
    const tiles = new Map([['0:0', canvas]]), ribbons = new Map();
    const samples = [];
    let coldMs = 0;
    for (let i = -2; i < (edgeFeather ? 3 : 12); i++) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 1536, 1536);
      ctx.drawImage(original, 0, 0);
      ctx.getImageData(0, 0, 1, 1); // flush scene restoration outside timing
      await new Promise(resolve => requestAnimationFrame(resolve));
      const start = performance.now();
      engine.removeStrokesFromTiles(tiles, grid, skip, [removed], bounds, ribbons);
      ctx.getImageData(750, 750, 1, 1); // include pending raster work
      const elapsed = performance.now() - start;
      if (i === -2) coldMs = elapsed;
      if (i >= 0) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    results[label] = {
      coldMs, medianMs: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
      preparedStrokes: ribbons.size, samples,
    };
    const expected = InkAfter.rebuildTiles(strokes.filter(s => s !== removed)).get('0:0');
    const a = ctx.getImageData(0, 0, 1536, 1536).data;
    const b = expected.getContext('2d').getImageData(0, 0, 1536, 1536).data;
    let changedChannels = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changedChannels++;
    results[label].pixelDifferences = changedChannels;
    if (changedChannels) throw Error(`${label}: ${changedChannels} pixel channels differ`);
  }
  return { strokes: count, edgeFeather, ...results };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const before = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-ink-bench-'));
  const sourceDir = path.join(root, 'src/components/InfiniteInkCanvas');
  const bundle = async (name, source) => {
    await build({ stdin: { contents: source, loader: 'ts', resolveDir: sourceDir },
      bundle: true, format: 'iife', globalName: name, outfile: path.join(temp, `${name}.js`),
      define: { 'import.meta.env.DEV': 'false' } });
  };
  if (before) await bundle('InkBefore', fs.readFileSync(before, 'utf8'));
  await bundle('InkAfter', fs.readFileSync(path.join(sourceDir, 'InkTiles.ts'), 'utf8'));
  fs.writeFileSync(path.join(temp, 'index.html'), `<!doctype html><meta charset="utf-8">
    <script>
    // Keep all compared canvases on the same raster backend. Repeated reads
    // otherwise cause Chromium to migrate only some canvases from GPU to CPU.
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, options) {
      return getContext.call(this, type, type === '2d' ? {...options, willReadFrequently: true} : options);
    };
    </script>
    ${before ? '<script src="InkBefore.js"></script>' : ''}
    <script src="InkAfter.js"></script><script>${runBenchmark.toString()}</script>`);
  const candidates = [process.env.INK_BENCH_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  const browserPath = candidates.find(p => p && fs.existsSync(p));
  if (!browserPath) throw Error('Set INK_BENCH_BROWSER to a Chromium browser executable');
  const profile = path.join(temp, 'profile');
  const browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  let socket;
  let send;
  try {
    const activePort = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(activePort); i++) await new Promise(r => setTimeout(r, 50));
    if (!fs.existsSync(activePort)) throw Error('Browser did not expose its local debug port');
    const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const pending = new Map();
    let id = 0;
    socket.onmessage = e => {
      const message = JSON.parse(e.data), handler = pending.get(message.id);
      if (handler) { pending.delete(message.id); handler(message); }
    };
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timeout = setTimeout(() => { pending.delete(key); reject(Error(`CDP timeout: ${method}`)); }, 60000);
      pending.set(key, message => { clearTimeout(timeout); message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result); });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
    const version = await send('Browser.getVersion');
    await send('Page.navigate', { url: pathToFileURL(path.join(temp, 'index.html')).href });
    for (let i = 0; i < 100; i++) {
      const ready = await send('Runtime.evaluate', { expression: 'typeof runBenchmark === "function"' });
      if (ready.result.value) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const report = {
      date: new Date().toISOString(), browser: version.product, cpu: os.cpus()[0].model,
      method: 'Headless Chromium with willReadFrequently=true (CPU raster for stable pixel comparison), 512-world-unit tile at 3x, 12 warm samples without feather / 3 with feather, plus cold first repair; synchronous 1px readback included; not end-to-end stylus latency.',
      beforeSha256: before ? createHash('sha256').update(fs.readFileSync(before)).digest('hex') : null,
      cases: [],
    };
    for (const feather of [false, true]) {
      const result = await send('Runtime.evaluate', { expression: `runBenchmark(${feather ? 40 : 400}, ${feather})`, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      report.cases.push(result.result.value);
      console.log(JSON.stringify(result.result.value));
      fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs/ink-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
    }
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/ink-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (send && socket.readyState === WebSocket.OPEN) {
      // Close only the isolated browser spawned above.
      socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
      socket.close();
    } else browser.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
