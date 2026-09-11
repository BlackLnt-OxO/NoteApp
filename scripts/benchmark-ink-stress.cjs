/** Stress cases matching uninterrupted retracing and genuinely overlapping ink.
 * Usage: node scripts/benchmark-ink-stress.cjs <20260911-before-directory>
 * Set INK_BENCH_SOFTWARE=1 for a software-canvas comparison. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { build } = require('esbuild');

async function longStroke(count, style = 'marker') {
  const point = i => ({ x: 40 + (i % 80 <= 40 ? i % 80 : 80 - i % 80) * 12, y: 140,
    pressure: 0.5, t: i * (1000 / 240) });
  const base = { id: 'long', type: 'stroke', style, size: 8, color: '#1267cb', opacity: 0.5,
    smoothing: 0.05, compositeOperation: 'source-over', createdAt: 0, edgeFeather: true };
  const results = {};
  for (const mode of ['before', 'after']) {
    const stroke = { ...base, renderVersion: mode === 'after' ? 2 : undefined,
      points: Array.from({ length: count }, (_, i) => point(i)) };
    const ink = mode === 'after' ? new After.StreamingInkStroke(stroke) : null;
    if (ink) ink.update(); // prefix built outside per-input-frame measurement
    const c = document.createElement('canvas'); c.width = 720; c.height = 300;
    const ctx = c.getContext('2d');
    const samples = [];
    for (let frame = 0; frame < 6; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      for (let j = 0; j < 4; j++) stroke.points.push(point(stroke.points.length));
      ctx.clearRect(0, 0, 720, 300);
      const start = performance.now();
      if (ink) ink.draw(ctx); else BeforeBrush.drawAnnotatedStroke(ctx, stroke);
      ctx.getImageData(200, 140, 1, 1); // include queued raster work
      const ms = performance.now() - start;
      samples.push(ms);
      if (ms > 1000) break; // bound pathological old-path runtime; no extrapolation
    }
    samples.sort((a, b) => a - b);
    results[mode] = { medianMs: samples[Math.floor(samples.length / 2)], worstMs: samples[samples.length - 1], samples,
      newSamplesProcessed: ink?.stats.lastUpdatePoints, rasterTilesUpdated: ink?.stats.refreshedTiles };
    ink?.dispose();
  }
  return { kind: 'continuous-retrace', style, prefixPoints: count, newPointsPerFrame: 4, edgeFeather: true, ...results };
}

async function progressiveStroke(style = 'marker') {
  const stroke = { id: 'progressive', type: 'stroke', style, renderVersion: 2, size: 8,
    color: '#1267cb', opacity: 0.5, smoothing: 0.05, compositeOperation: 'source-over',
    createdAt: 0, edgeFeather: true, points: [] };
  const ink = new After.StreamingInkStroke(stroke);
  const c = document.createElement('canvas'); c.width = 720; c.height = 300;
  document.body.appendChild(c);
  const ctx = c.getContext('2d'), windows = [];
  let samples = [], intervals = [], previous = 0;
  const slowFrames = [];
  for (let frame = 0; frame < 1024; frame++) {
    const timestamp = await new Promise(resolve => requestAnimationFrame(resolve));
    if (previous) intervals.push(timestamp - previous);
    previous = timestamp;
    for (let j = 0; j < 4; j++) {
      const i = stroke.points.length;
      stroke.points.push({ x: 40 + (i % 80 <= 40 ? i % 80 : 80 - i % 80) * 12,
        y: 140, pressure: 0.5, t: i * (1000 / 240) });
    }
    const start = performance.now();
    ctx.clearRect(0, 0, 720, 300); ink.draw(ctx);
    const drawn = performance.now();
    ctx.getImageData(200, 140, 1, 1);
    const finished = performance.now();
    samples.push(finished - start);
    if (finished - start > 16.67) slowFrames.push({ frame, points: stroke.points.length,
      drawCommandsMs: drawn - start, readbackMs: finished - drawn, totalMs: finished - start });
    if ((frame + 1) % 256 === 0) {
      samples.sort((a, b) => a - b); intervals.sort((a, b) => a - b);
      windows.push({ endingPoints: stroke.points.length, frames: samples.length,
        medianMs: samples[128], p95Ms: samples[243], worstMs: samples[255],
        frameIntervalP95Ms: intervals[Math.floor(intervals.length * 0.95)],
        framesOver16ms: samples.filter(ms => ms > 16.67).length });
      samples = []; intervals = [];
    }
  }
  ink.dispose(); c.remove();
  return { kind: 'progressive-live-retrace', style, newPointsPerFrame: 4, totalPoints: 4096, windows, slowFrames };
}

async function denseErase(count) {
  After.clearInkRasterCache();
  const strokes = Array.from({ length: count }, (_, i) => ({
    id: `dense${i}`, type: 'stroke', size: 6, color: '#1267cb', opacity: 0.4,
    smoothing: 0.05, compositeOperation: 'source-over', createdAt: 0, edgeFeather: true,
    // All strokes intersect the removed stroke; a bbox-only optimization cannot skip them.
    points: Array.from({ length: 12 }, (_, j) => ({ x: 100 + j * 3 + (i % 3) * 0.25,
      y: 120 + Math.sin(j) * 2 + (i % 5) * 0.2, pressure: 0.5, t: j * 4 })),
  }));
  const initial = new Map();
  for (const s of strokes) After.stampCachedStroke(initial, s, 512, 3);
  const index = After.getInkStrokeIndex(initial), removed = strokes[Math.floor(count / 2)], skip = new Set([removed.id]);
  const original = initial.get('0:0');
  const results = {};
  for (const mode of ['before', 'after']) {
    const c = document.createElement('canvas'); c.width = c.height = 1536;
    const ctx = c.getContext('2d'), tiles = new Map([['0:0', c]]), ribbons = new Map();
    const samples = [];
    const cacheBefore = After.inkRasterCacheStats();
    for (let frame = 0; frame < 3; frame++) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1536, 1536); ctx.drawImage(original, 0, 0);
      ctx.getImageData(0, 0, 1, 1);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const start = performance.now();
      const engine = mode === 'before' ? BeforeErase : After;
      engine.eraseStrokeRegions(tiles, index.grid, skip, [removed], 512, 3, index.bounds, ribbons);
      ctx.getImageData(330, 360, 1, 1);
      const ms = performance.now() - start; samples.push(ms);
      if (ms > 2000) break;
    }
    samples.sort((a, b) => a - b);
    const cacheAfter = After.inkRasterCacheStats();
    results[mode] = { medianMs: samples[Math.floor(samples.length / 2)], worstMs: samples[samples.length - 1], samples,
      cacheHits: cacheAfter.hits - cacheBefore.hits, cacheMisses: cacheAfter.misses - cacheBefore.misses };
  }
  return { kind: 'overlapping-stroke-erase', strokes: count, edgeFeather: true, ...results };
}

async function eraserCacheScenario(kind) {
  After.clearInkRasterCache();
  const count = kind === 'budget-thrash' ? 12 : kind === 'long-legacy' ? 2 : 128;
  const strokes = Array.from({ length: count }, (_, i) => ({
    id: kind + i, type: 'stroke', size: 8, color: '#1267cb', opacity: 0.5,
    renderVersion: kind === 'budget-thrash' || kind === 'cold-v2' ? 2 : undefined,
    smoothing: 0.05, compositeOperation: 'source-over', createdAt: 0, edgeFeather: true,
    points: Array.from({ length: kind === 'long-legacy' ? 2048 : 12 }, (_, j) => ({
      x: kind === 'budget-thrash' ? 30 + j * 39 : kind === 'long-legacy'
        ? 40 + (j % 80 <= 40 ? j % 80 : 80 - j % 80) * 11 : 100 + j * 3,
      y: kind === 'budget-thrash' ? 30 + j * 39 + (i % 3) : 120 + Math.sin(j) * 2 + (i % 5) * 0.2,
      pressure: 0.5, t: j * 4,
    })),
  }));
  const initial = new Map();
  for (const stroke of strokes) After.stampCachedStroke(initial, stroke, 512, 3);
  const index = After.getInkStrokeIndex(initial), removed = strokes[count - 1], skip = new Set([removed.id]);
  const c = document.createElement('canvas'); c.width = c.height = 1536;
  const ctx = c.getContext('2d'), tiles = new Map([['0:0', c]]), samples = [];
  const conditions = kind === 'budget-thrash' ? ['normal-1', 'normal-2', 'normal-3'] : ['warm-1', 'warm-2', 'forced-cold', 'rewarmed'];
  for (const condition of conditions) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1536, 1536); ctx.drawImage(initial.get('0:0'), 0, 0);
    ctx.getImageData(0, 0, 1, 1);
    if (condition === 'forced-cold') After.clearInkRasterCache();
    const before = After.inkRasterCacheStats();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const begin = performance.now();
    After.eraseStrokeRegions(tiles, index.grid, skip, [removed], 512, 3, index.bounds);
    const commands = performance.now();
    ctx.getImageData(330, 360, 1, 1);
    const end = performance.now(), after = After.inkRasterCacheStats();
    samples.push({ condition, commandMs: commands - begin, synchronizedMs: end - begin,
      cacheHits: after.hits - before.hits, cacheMisses: after.misses - before.misses,
      entriesBefore: before.entries, entriesAfter: after.entries,
      cacheMiBBefore: before.bytes / 1048576, cacheMiBAfter: after.bytes / 1048576 });
  }
  return { kind, strokes: count, pointsPerStroke: strokes[0].points.length, samples };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const eraserCache = process.env.INK_STRESS_CASES === 'eraser-cache';
  const baseline = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'noteapp-ink-before-20260911'));
  const sourceDir = path.join(root, 'src/components/PdfAnnotation');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-ink-stress-'));
  const software = process.env.INK_BENCH_SOFTWARE === '1';
  const bundle = async (name, source) => build({ stdin: { contents: source, loader: 'ts', resolveDir: sourceDir },
    bundle: true, format: 'iife', globalName: name, outfile: path.join(temp, `${name}.js`), define: { 'import.meta.env.DEV': 'false' } });
  const beforeBrush = fs.readFileSync(path.join(eraserCache ? sourceDir : baseline, 'PdfBrushRenderers.ts'), 'utf8');
  const beforeErase = fs.readFileSync(path.join(eraserCache ? sourceDir : baseline, 'InkTileErase.ts'), 'utf8');
  await bundle('BeforeBrush', beforeBrush);
  await bundle('BeforeErase', beforeErase);
  await bundle('After', "export * from './StreamingInkStroke'; export * from './InkRasterCache'; export * from './InkTileErase'; export * from './InkStrokeIndex';");
  fs.writeFileSync(path.join(temp, 'index.html'), `<!doctype html><meta charset="utf-8"><script>
    const originalContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, options) {
      return originalContext.call(this, type, type === '2d' && ${software} ? {...options, willReadFrequently: true} : options);
    };</script><script src="BeforeBrush.js"></script><script src="BeforeErase.js"></script><script src="After.js"></script>
    <script>${longStroke.toString()}\n${denseErase.toString()}\n${progressiveStroke.toString()}\n${eraserCacheScenario.toString()}</script>`);
  const candidates = [process.env.INK_BENCH_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  const executable = candidates.find(p => p && fs.existsSync(p));
  if (!executable) throw Error('Set INK_BENCH_BROWSER to a Chromium executable');
  const profile = path.join(temp, 'profile');
  const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await new Promise(r => setTimeout(r, 50));
    if (!fs.existsSync(portFile)) throw Error('Browser debug port unavailable');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const pending = new Map(); let id = 0;
    socket.onmessage = e => { const m = JSON.parse(e.data), handler = pending.get(m.id); if (handler) { pending.delete(m.id); handler(m); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id, timeout = setTimeout(() => { pending.delete(key); reject(Error(`CDP timeout: ${method}`)); }, 60000);
      pending.set(key, m => { clearTimeout(timeout); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
    const version = await send('Browser.getVersion');
    await send('Page.navigate', { url: pathToFileURL(path.join(temp, 'index.html')).href });
    for (let i = 0; i < 100; i++) {
      const ready = await send('Runtime.evaluate', { expression: 'typeof longStroke === "function"' });
      if (ready.result.value) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const report = { date: new Date().toISOString(), browser: version.product, cpu: os.cpus()[0].model,
      canvas: software ? 'willReadFrequently=true (software)' : 'application defaults (CPU live masks, accelerated main canvas when available)',
      method: eraserCache ? 'Current eraser only: warm, intentionally cleared, and naturally thrashing raster cache. commandMs measures synchronous JS/native calls; synchronizedMs also forces 1px readback. Initial page stamping is outside measurements. This is not actual pointer-to-display latency.' : 'Uninterrupted retrace with growing prefix and four added points per frame; truly overlapping legacy strokes with feather enabled. Times include synchronous 1px readback, not full pointer-to-display latency. Prefix preparation and document load are outside input-frame timings.',
      baselineBrushSha256: eraserCache ? undefined : createHash('sha256').update(beforeBrush).digest('hex'), baselineEraseSha256: eraserCache ? undefined : createHash('sha256').update(beforeErase).digest('hex'),
      currentSourceSha256: Object.fromEntries(['InkTileErase.ts', 'InkRasterCache.ts', 'InkStrokeIndex.ts', 'StreamingInkStroke.ts', 'StreamingPencilGrain.ts'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(sourceDir, name))).digest('hex')])), cases: [] };
    const pencil = process.env.INK_STRESS_CASES === 'pencil';
    const progressive = process.env.INK_STRESS_CASES === 'progressive';
    for (const expression of eraserCache ? ["eraserCacheScenario('cold-legacy')", "eraserCacheScenario('cold-v2')", "eraserCacheScenario('budget-thrash')", "eraserCacheScenario('long-legacy')"] : pencil ? ["longStroke(512, 'pencil')", "longStroke(4096, 'pencil')", "progressiveStroke('pencil')"] : progressive ? ['progressiveStroke()'] : ['longStroke(512)', 'longStroke(4096)', 'longStroke(16384)', 'denseErase(128)', 'denseErase(512)']) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      report.cases.push(result.result.value); console.log(JSON.stringify(result.result.value));
      fs.writeFileSync(path.join(root, `docs/ink-${eraserCache ? 'eraser-cache' : pencil ? 'pencil' : progressive ? 'progressive' : 'stress'}-${software ? 'software' : 'default'}.json`), JSON.stringify(report, null, 2) + '\n');
    }
  } finally {
    if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); socket.close(); }
    else browser.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
