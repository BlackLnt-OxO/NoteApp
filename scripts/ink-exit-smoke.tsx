import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { useNoteStore } from '../src/store';
import { useCanvasStore } from '../src/components/InfiniteInkCanvas/useCanvasStore';
import { useCanvasLibrary } from '../src/components/InfiniteInkCanvas/useCanvasLibrary';
import { canvasRepository } from '../src/components/InfiniteInkCanvas/CanvasRepository';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    createRoot(document.getElementById('root')!).render(<App />);
    await pause(500);
    useNoteStore.setState({ viewMode: 'inkcanvas' }); await pause(50);
    const phase = new URLSearchParams(location.search).get('phase');
    if (phase === 'reopen') {
      const id = localStorage.getItem('ink-exit-smoke-id')!;
      const data = await canvasRepository.load(id);
      const stroke = data.objects[0];
      if (data.objects.length !== 1 || stroke?.type !== 'stroke' || stroke.points.length !== 4
        || stroke.points.map(point => point.x).join(',') !== '100,110,120,130') throw new Error(`立即退出后笔迹或最后采样丢失: ${JSON.stringify(data.objects)}`);
      (window as any).exitSmokeReady = { phase, id, points: stroke.points, reopened: true }; return;
    }
    useCanvasLibrary.getState().loadLibrary();
    const id = useCanvasLibrary.getState().addCanvas(); localStorage.setItem('ink-exit-smoke-id', id);
    await useCanvasStore.getState().switchCanvas(id); useCanvasLibrary.getState().setCurrentCanvasId(id);
    await pause(50); useCanvasStore.getState().setCamera({ x: 0, y: 0, zoom: 1 }); await pause(50);
    const canvas = document.querySelector('canvas')!, rect = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {};
    for (const x of [100, 110, 120, 130]) {
      const event = new PointerEvent(x === 100 ? 'pointerdown' : 'pointermove', { pointerId: 42, pointerType: 'pen',
        clientX: rect.left+x, clientY: rect.top+100, pressure: .7, buttons: 1, bubbles: true });
      Object.defineProperty(event, 'getCoalescedEvents', { value: () => [event] }); canvas.dispatchEvent(event);
    }
    (window as any).exitSmokeReady = { phase, id, pendingGesture: true };
  } catch (error) { (window as any).exitSmokeReady = { error: String(error) }; }
})();
