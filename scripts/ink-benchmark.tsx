import React from 'react';
import { runBackendChecks } from './ink-benchmark-checks';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import InfiniteInkCanvas from '../src/components/InfiniteInkCanvas/InfiniteInkCanvas';
import { useCanvasStore } from '../src/components/InfiniteInkCanvas/useCanvasStore';
import { readInkFrame, resetInkFrame, readFrameWindows } from '../src/components/InkFrameStats';
import type { Stroke, CanvasObject } from '../src/components/InfiniteInkCanvas/types';
import PdfCanvas from '../src/components/PdfAnnotation/PdfCanvas';
import { usePdfStore } from '../src/components/PdfAnnotation/PdfStore';
import { loadPdfDocument } from '../src/components/PdfAnnotation/PdfLoader';
import { InkRenderBackend } from '../src/components/InfiniteInkCanvas/InkRenderBackend';
import { InkDisplayLayers } from '../src/components/InkDisplayLayers';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const percentile = (values: number[], p = .95) => values.slice().sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)] ?? 0;
function fixture(count: number, points = 72): Stroke[] {
  return Array.from({ length: count }, (_, j) => ({ id: `bench-${j}`, type: 'stroke', color: '#1267cb', size: 4,
    opacity: .6, smoothing: .35, renderVersion: 2, style: 'marker', compositeOperation: 'source-over', createdAt: 0,
    points: Array.from({ length: points }, (_, i) => ({ x: 40+(j%40)*60+i*.6, y: 40+(Math.floor(j/40)%88)*20+Math.sin(i*.17)*8, pressure: .3+(i%13)*.04, t:i*4 })) }));
}
async function waitCoverage(timeout = 120000, required = 4) {
  const start = performance.now(); let first = 0;
  while (performance.now()-start < timeout) {
    await frame(); const stats = readInkFrame();
    if (!first && stats.visibleTiles > 0) first = performance.now()-start;
    // 1000x720 viewport spans 2x2 tiles; generated fixture covers all four.
    if (stats.visibleTiles >= required) return { first, complete: performance.now()-start, stats: { ...stats } };
  }
  return { first, complete: null, stats: { ...readInkFrame() } };
}
async function longRasters() {
  const results = [];
  for (const version of [undefined, 2] as const) for (const style of ['marker', 'fountain', 'pencil'] as const) {
    const stroke = { ...fixture(1, 16384)[0], id: `long-${style}-${version}`, style, renderVersion: version };
    resetInkFrame();
    useCanvasStore.setState({ objects: [stroke], history: [], redoStack: [], camera: { x: 0, y: 0, zoom: 1 }, loaded: true, currentCanvasId: null, renderEpoch: 0 });
    const root = createRoot(document.getElementById('root')!);
    const started = performance.now(); flushSync(() => root.render(<InfiniteInkCanvas />));
    const raster = await waitCoverage(120000, 2);
    results.push({ style, version: version ?? 'legacy', points: 16384, first: raster.first, complete: performance.now()-started, stats: raster.stats });
    root.unmount(); await pause(100);
  }
  return results;
}
async function fastPan(canvas: HTMLCanvasElement) {
  canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {};
  const handler: number[] = [], intervals: number[] = [];
  const visibility = new Set<string>();
  let cameraUpdates = 0, historicalDraws = 0, backgroundPaints = 0;
  const unsubscribe = useCanvasStore.subscribe((state, previous) => { if (state.camera !== previous.camera) cameraUpdates++; });
  const historical = document.querySelector<HTMLCanvasElement>('[data-ink-layer="committed"]')?.getContext('2d');
  const background = document.querySelector<HTMLCanvasElement>('[data-ink-layer="background"]')?.getContext('2d');
  const draw = historical?.drawImage, fill = background?.fillRect;
  if (historical && draw) historical.drawImage = function (...args: any[]) { historicalDraws++; return (draw as any).apply(this, args); };
  if (background && fill) background.fillRect = function (...args: any[]) { backgroundPaints++; return (fill as any).apply(this, args); };
  const send = (type: string, x: number, y: number) => {
    const started = performance.now();
    canvas.dispatchEvent(new PointerEvent(type, { pointerId: 74, pointerType: 'mouse', button: 1,
      buttons: type === 'pointerup' ? 0 : 4, clientX: x, clientY: y, bubbles: true }));
    handler.push(performance.now() - started);
  };
  resetInkFrame(); let previous = await frame(); send('pointerdown', 500, 350);
  try {
    for (let f = 0; f < 120; f++) {
      const now = await frame();
      visibility.add(document.visibilityState);
      if(now - previous > 250)throw new Error(`Fast-pan timing invalid: ${now-previous}ms, visibility=${document.visibilityState}`);
      intervals.push(now - previous); previous = now;
      for (let i = 0; i < 4; i++) {
        const sample = f * 4 + i;
        send('pointermove', 500 + 650 * Math.sin(sample / 65), 350 + 160 * Math.sin(sample / 43));
      }
    }
    send('pointerup', 500 + 650 * Math.sin(479 / 65), 350 + 160 * Math.sin(479 / 43));
    await frame();
    return { samples: 480, visibility:[...visibility], handlerP95: percentile(handler), frameP95: percentile(intervals), cameraUpdates,
      historicalDraws: historical ? historicalDraws : null, backgroundPaints: background ? backgroundPaints : null,
      inkBytes: readInkFrame().totalInkBytes, displayBytes: Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas')).reduce((n, c) => n + c.width * c.height * 4, 0),
      windows: readFrameWindows(), camera: { ...useCanvasStore.getState().camera } };
  } finally {
    unsubscribe(); if (historical && draw) historical.drawImage = draw; if (background && fill) background.fillRect = fill;
  }
}
async function run(count: number) {
  const objects = fixture(count);
  resetInkFrame();
  useCanvasStore.setState({ objects, camera: { x: 0, y: 0, zoom: 1 }, loaded: true, currentCanvasId: null, renderEpoch: 0 });
  const root = createRoot(document.getElementById('root')!);
  const start = performance.now(); flushSync(() => root.render(<InfiniteInkCanvas />));
  const mountMs = performance.now() - start;
  const opened = await waitCoverage(); opened.first += mountMs; opened.complete = opened.complete === null ? null : performance.now()-start;
  await pause(800);
  const canvas = document.querySelector('canvas')!;
  // Synthetic PointerEvents cannot acquire native pointer capture. Input handlers remain real.
  canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {};
  const input: number[] = [], live: number[] = [], intervals: number[] = [];
  const send = (type: string, x: number, y: number, pressure = .7) => {
    const event = new PointerEvent(type, { pointerId: 42, pointerType: 'pen', clientX: x, clientY: y, pressure,
      buttons: type === 'pointerup' ? 0 : 1, bubbles: true });
    // Give every compared version identical samples. Empty coalesced arrays are
    // covered separately; old main drops them and would invalidate the timing comparison.
    Object.defineProperty(event, 'getCoalescedEvents', { value: () => [event] });
    const before = performance.now(); canvas.dispatchEvent(event); input.push(performance.now()-before);
  };
  resetInkFrame(); let previous = await frame(); send('pointerdown',100,150);
  for (let f=0;f<180;f++) {
    const now = await frame();
    intervals.push(now-previous); previous=now;
    for (let i=0;i<4;i++) send('pointermove',100+((f*4+i)%700),150+Math.sin((f*4+i)*.05)*25);
    live.push(readInkFrame().liveMs ?? readInkFrame().drawMs);
  }
  const penUpStart=performance.now(); send('pointerup',820,150,0); const penUpMs=performance.now()-penUpStart;
  await pause(200); resetInkFrame();
  useCanvasStore.getState().setCamera({ x: -1024, y: 0 });
  const pan = await waitCoverage();
  const windows = readFrameWindows();
  const fastPanResult = await fastPan(canvas);
  const data = { count, points:count*72, opened, pan, inputP95:percentile(input), liveP95:percentile(live), frameP95:percentile(intervals), penUpMs,
    fastPan: fastPanResult,
    windows, strokePoints:useCanvasStore.getState().objects.at(-1)?.type === 'stroke' ? (useCanvasStore.getState().objects.at(-1) as Stroke).points.length : 0,
    zoom: null as null | { handlerP95: number; frameP95: number; zoom: number } };
  const zoomInput: number[] = [], zoomFrames: number[] = []; previous = await frame();
  for (let i=0; i<60; i++) {
    const now = await frame();
    zoomFrames.push(now-previous); previous=now;
    const started = performance.now();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY:-3, clientX:500, clientY:350, bubbles:true, cancelable:true }));
    zoomInput.push(performance.now()-started);
  }
  data.zoom = { handlerP95:percentile(zoomInput), frameP95:percentile(zoomFrames), zoom:useCanvasStore.getState().camera.zoom };
  root.unmount(); await pause(100); return data;
}
async function lodCases() {
  // Same minimal PDF/xref fixture as PdfLoader.test, rendered by real pdf.js.
  const parts = ['%PDF-1.4\n'], offsets = [0];
  for (const object of [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 1200] >>\nendobj\n',
  ]) { offsets.push(parts.join('').length); parts.push(object); }
  const xref = parts.join('').length;
  parts.push('xref\n0 4\n0000000000 65535 f \n' + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join(''));
  parts.push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const { doc, firstPage } = await loadPdfDocument(new TextEncoder().encode(parts.join('')).buffer);
  if (firstPage.width !== 900 || firstPage.height !== 1200) throw new Error('LOD PDF fixture invalid');
  const backend = InkRenderBackend.prototype as any;
  const receive = backend.receive, requestViewport = backend.requestViewport, paint = InkDisplayLayers.prototype.paint;
  let visibleQueued = 0;
  backend.requestViewport = function (...args: any[]) {
    const result = requestViewport.apply(this, args);
    visibleQueued = this.jobs.filter((job: any) => job.priority < 20000).length + this.transitions.size;
    return result;
  };
  let receiveTimes: number[] = [], paintTimes: number[] = [], arrivals = 0, peakInkBytes = 0;
  backend.receive = function (reply: any) {
    const start = performance.now(); try { return receive.call(this, reply); }
    finally { if (reply.type === 'tile') { receiveTimes.push(performance.now() - start); arrivals++; } }
  };
  InkDisplayLayers.prototype.paint = function (p) {
    const start = performance.now(); try { return paint.call(this, p); }
    finally { paintTimes.push(performance.now() - start); }
  };
  const results = [];
  let root: ReturnType<typeof createRoot> | null = null;
  const sample = async (minimumMs = 350, previousFrame = performance.now()) => {
    const started = performance.now(), intervals: number[] = [];
    let previous = previousFrame, idle = 0, reportedAt = started;
    for (;;) {
      const now = await frame(); intervals.push(now - previous); previous = now;
      if (document.visibilityState !== 'visible' || now - started > 120000) throw new Error('LOD benchmark hidden or timed out: ' + JSON.stringify({phase:(window as any).benchmarkPhase,stats:readInkFrame(),results}));
      const stats = readInkFrame(); peakInkBytes = Math.max(peakInkBytes, stats.totalInkBytes);
      if (now - reportedAt > 10000) { console.info(JSON.stringify({phase:(window as any).benchmarkPhase,stats})); reportedAt = now; }
      // Optional offscreen prefetch is not part of visible sharpness completion.
      idle = visibleQueued === 0 && stats.visibleTiles > 0 ? idle + 1 : 0;
      if (now - started >= minimumMs && idle >= 4) break;
    }
    return { frameP95: percentile(intervals), worstFrame: Math.max(...intervals), over50: intervals.filter(n => n > 50).length,
      frames: intervals.length, sharpMs: performance.now() - started, arrivals,
      receiveP95: percentile(receiveTimes), receiveMax: Math.max(0, ...receiveTimes),
      paintP95: percentile(paintTimes), paintMax: Math.max(0, ...paintTimes), peakInkBytes, stats: { ...readInkFrame() } };
  };
  const reset = () => { resetInkFrame(); receiveTimes = []; paintTimes = []; arrivals = peakInkBytes = 0; };
  try {
    for (const surface of ['canvas', 'pdf'] as const) for (const count of [3500, 10000]) {
      (window as any).benchmarkPhase = `${surface}-${count}-open`; console.info((window as any).benchmarkPhase);
      const strokes = fixture(count).map(s => ({ ...s, featherSize: .6 }));
      const camera = { x: 0, y: 0, zoom: .75 };
      if (surface === 'canvas') useCanvasStore.setState({ objects: strokes, history: [], redoStack: [], camera, loaded: true, currentCanvasId: null, renderEpoch: 0 });
      else usePdfStore.setState({ pdfDoc: doc, numPages: 1, currentPage: 1, pageSizes: { 1: firstPage }, items: { 1: strokes },
        history: {}, redoStack: {}, camera, pendingResumeCamera: camera, currentItemId: null, anchorPages: [], renderEpoch: 0 });
      reset(); root = createRoot(document.getElementById('root')!);
      flushSync(() => root!.render(surface === 'canvas' ? <InfiniteInkCanvas /> : <PdfCanvas />));
      const opened = await sample();
      const transitions = [];
      for (const zoom of [.5, 1.4, .5, 1.4]) {
        (window as any).benchmarkPhase = `${surface}-${count}-zoom-${zoom}`; console.info((window as any).benchmarkPhase);
        reset();
        // A real wheel gesture crosses the boundary; measure after its last event.
        const canvas = document.querySelector('canvas')!;
        const state = () => surface === 'canvas' ? useCanvasStore.getState() : usePdfStore.getState();
        let stoppedAt = performance.now();
        for (let i = 0; i < 12; i++) {
          stoppedAt = await frame();
          const deltaY = (1 - Math.pow(zoom / state().camera.zoom, 1 / (12 - i))) / .001;
          canvas.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
        }
        if (Math.abs(state().camera.zoom - zoom) > .01) throw new Error('LOD wheel fixture missed target');
        transitions.push({ zoom, ...await sample(350, stoppedAt) });
      }
      results.push({ surface, count, dpr: devicePixelRatio, opened, transitions });
      root.unmount(); root = null; await pause(100);
    }
  } finally {
    root?.unmount(); backend.receive = receive; backend.requestViewport = requestViewport; InkDisplayLayers.prototype.paint = paint;
    usePdfStore.setState({ pdfDoc: null, items: {} }); await doc.destroy();
  }
  return results;
}
async function memoryCase() {
  const phase = (name: string) => { (window as any).benchmarkPhase = name; };
  const snapshot = () => ({ ...readInkFrame(), displayBytes: Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas')).reduce((n,c)=>n+c.width*c.height*4,0),
    heapBytes: (performance as any).memory?.usedJSHeapSize ?? null });
  useCanvasStore.setState({ objects: [], currentCanvasId: null, loaded: true, history: [], redoStack: [], camera: { x: 0, y: 0, zoom: .75 } });
  const root = createRoot(document.getElementById('root')!); flushSync(()=>root.render(<InfiniteInkCanvas />));
  phase('empty'); await pause(3500); const empty = snapshot();
  let documentFixture = new URLSearchParams(location.search).has('document') ? await (await fetch('/document-fixture.json')).json() : null;
  let strokes: CanvasObject[] = documentFixture?.objects ?? fixture(3500).map((s,j)=>({...s,renderVersion:undefined,size:7,featherSize:.5,
    points:s.points.map((p,i)=>({...p,x:40+(j%40)*60+150*Math.sin(i*.073+j*.01),y:40+(Math.floor(j/40)%88)*20+90*Math.cos(i*.081)})) }));
  const count = strokes.filter(s=>s.type==='stroke').length, points = strokes.reduce((n,s)=>n+(s.type==='stroke'?s.points.length:0),0), images = strokes.filter(s=>s.type==='image').length;
  phase('loading'); resetInkFrame(); const started = performance.now(); useCanvasStore.setState({ objects: strokes, camera:documentFixture?.camera??{x:0,y:0,zoom:.75}, renderEpoch: useCanvasStore.getState().renderEpoch + 1 });
  const settle = async () => {
    const start = performance.now(); await pause(500);
    while(readInkFrame().queuedTiles || !readInkFrame().visibleTiles) {
      if(performance.now()-start>120000)throw new Error('Memory fixture did not finish loading: '+JSON.stringify(snapshot())); await frame();
    }
    await pause(500);
  };
  await settle(); const loadMs=performance.now()-started; phase('loaded'); await pause(5000); const loaded=snapshot();
  const fast = await fastPan(document.querySelector('canvas')!); await settle();
  const positions=[];
  for(let i=0;i<6;i++) {
    phase('pan-'+i); useCanvasStore.getState().setCamera({x:-300*(i%3),y:-300*Math.floor(i/3)}); await settle(); positions.push(snapshot());
  }
  phase('after-pan'); await pause(5000); const afterPan=snapshot();
  root.unmount(); useCanvasStore.setState({objects:[],history:[],redoStack:[]}); strokes=[];documentFixture=null; resetInkFrame(); phase('closed'); await pause(5000);
  return { count,points,images,fixture:new URLSearchParams(location.search).has('document')?'document-copy':'generated',dpr:devicePixelRatio,loadMs,empty,loaded,fastPan:fast,positions,afterPan,closed:snapshot() };
}
(async () => {
  try {
    if(new URLSearchParams(location.search).has('lod')) { (window as any).benchmarkResult={lod:await lodCases(),pixels:await runBackendChecks()}; return; }
    if(new URLSearchParams(location.search).has('memory')) { (window as any).benchmarkResult={memory:await memoryCase()}; return; }
    const cases = [await run(3500), await run(10000)];
    const longStroke = await longRasters();
    const pixels = await runBackendChecks();
    let initialSaveMs = null, incrementSaveMs = null;
    if (new URLSearchParams(location.search).has('storage')) {
    const saveStart=performance.now();
    const storage = await import(/* @vite-ignore */ ['/src/components/InfiniteInkCanvas', 'CanvasRepository.ts'].join('/'));
    const objects=fixture(3500); await storage.canvasRepository.save('benchmark',objects,{x:0,y:0,zoom:1},true);
    initialSaveMs=performance.now()-saveStart;
    const start=performance.now(); await storage.canvasRepository.save('benchmark',[...objects,fixture(1,16384)[0] as Stroke].map((o,i)=>i===objects.length?{...o,id:'long'}:o),{x:0,y:0,zoom:1},true);
    incrementSaveMs=performance.now()-start; await storage.canvasRepository.close();
    }
    (window as any).benchmarkResult={timingSchema:'ink-benchmark-2-mount-inclusive', cases, longStroke, pixels, initialSaveMs, incrementSaveMs};
  } catch(error) { (window as any).benchmarkResult={error:String(error),stack:(error as Error).stack}; }
})();
