import { InkRenderBackend } from '../src/components/InfiniteInkCanvas/InkRenderBackend';
import { getInkStrokeIndex } from '../src/components/PdfAnnotation/InkStrokeIndex';
import { stampCachedStroke, tileScaleOf, releaseDocumentInkCaches } from '../src/components/PdfAnnotation/InkRasterCache';
import { disposeTiles } from '../src/components/InfiniteInkCanvas/InkTiles';
import type { Stroke } from '../src/components/InfiniteInkCanvas/types';
const camera = { x: 0, y: 0, zoom: 1 };
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
async function settle(backend: InkRenderBackend) {
  const start = performance.now();
  while (backend.requestViewport(camera, 1023.99, 256, 1, true)) {
    if (performance.now() - start > 15000) throw new Error('Pixel check backend timeout');
    await frame();
  }
}
function pixels(tiles: Map<string, HTMLCanvasElement>) {
  const canvas = document.createElement('canvas'); canvas.width = 3072; canvas.height = 768;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  for (const [key, tile] of tiles) {
    const [x,y] = key.split(':').map(Number);
    ctx.drawImage(tile, x*1536, y*1536, 1536,1536);
  }
  const data = ctx.getImageData(0,0,3072,768).data; canvas.width=0; return data;
}
export async function runBackendChecks() {
  const results = [];
  for (const version of [undefined,2] as const) for (const style of ['marker','fountain','pencil'] as const) {
    const stroke: Stroke = { id:`pixel-${style}-${version}`,type:'stroke', style, renderVersion:version,color:'#123abc',opacity:.5,size:9,
      smoothing:.35,featherSize:.6,pressureOpacity:true,inkSpeed:.5,createdAt:0,compositeOperation:'source-over',
      points:Array.from({length:96},(_,i)=>({x:460+i*1.5,y:80+Math.sin(i*.2)*20,pressure:.25+(i%13)*.05,t:i*4})) };
    const overlap = {...stroke,id:stroke.id+'-overlap',points:stroke.points.map(point=>({...point,y:point.y+3}))};
    const eraser: Stroke = {...stroke,id:stroke.id+'-erase',renderVersion:undefined,style:'marker',opacity:1,size:5,compositeOperation:'destination-out',
      points:[{x:500,y:50,pressure:.5,t:0},{x:525,y:130,pressure:.5,t:4}]};
    const source = [stroke,overlap,eraser], tiles=new Map<string,HTMLCanvasElement>();
    for(const item of source)getInkStrokeIndex(tiles).add(item);
    const backend = new InkRenderBackend({tiles:()=>tiles,publish:()=>{},protectedKeys:()=>new Set(),fixedScale:3});
    backend.sync(source);await settle(backend);
    const expected = new Map<string,HTMLCanvasElement>();
    for(const item of source)stampCachedStroke(expected,item,512,3);
    const actual=pixels(tiles), wanted=pixels(expected);
    let worstAlpha=0,worstPremultiplied=0,bad=0;
    for(let i=0;i<actual.length;i+=4){
      const alpha=Math.abs(actual[i+3]-wanted[i+3]); worstAlpha=Math.max(worstAlpha,alpha);
      let color=0;for(let c=0;c<3;c++)color=Math.max(color,Math.abs(actual[i+c]*actual[i+3]/255-wanted[i+c]*wanted[i+3]/255));
      worstPremultiplied=Math.max(worstPremultiplied,color); if(alpha>3||color>3)bad++;
    }
    // A removed handoff must disappear immediately and never return via a stale bitmap.
    const pending={...stroke,id:stroke.id+'-pending'};getInkStrokeIndex(tiles).add(pending);backend.retain(pending,[...source,pending]);
    const live=document.createElement('canvas');live.width=1024;live.height=256;
    backend.drawPending(live.getContext('2d')!);
    const appeared=live.getContext('2d')!.getImageData(0,0,1024,256).data.some((value,i)=>i%4===3&&value>0);
    const handoffScales: number[] = []; const started = performance.now();
    while (backend.requestViewport(camera, 1023.99, 256, 1, false)) {
      handoffScales.push(tileScaleOf(tiles.get('0:0')!));
      if (performance.now() - started > 15000) throw new Error('Pen-up handoff timeout');
      await frame();
    }
    handoffScales.push(tileScaleOf(tiles.get('0:0')!));
    live.getContext('2d')!.clearRect(0,0,1024,256);backend.drawPending(live.getContext('2d')!);
    const handedOff=!live.getContext('2d')!.getImageData(0,0,1024,256).data.some((value,i)=>i%4===3&&value>0);
    // Also cancel a second pending stroke while its Worker result is still in flight.
    const canceled = { ...pending, id: pending.id + '-canceled' };
    getInkStrokeIndex(tiles).add(canceled); backend.retain(canceled,[...source,pending,canceled]);
    backend.requestViewport(camera, 1023.99, 256, 1, false);
    backend.suppress([pending.id,canceled.id]);getInkStrokeIndex(tiles).remove(new Set([pending.id,canceled.id]));backend.sync(source);
    live.getContext('2d')!.clearRect(0,0,1024,256);backend.drawPending(live.getContext('2d')!);
    const removed=!live.getContext('2d')!.getImageData(0,0,1024,256).data.some((value,i)=>i%4===3&&value>0);
    await settle(backend);
    results.push({style,version:version??'legacy',badPixels:bad,worstAlpha,worstPremultiplied,appeared,removed,handedOff,
      minimumHandoffScale:Math.min(...handoffScales),finalScale:tileScaleOf(tiles.get('0:0')!)});
    backend.dispose();disposeTiles(tiles);disposeTiles(expected);live.width=0;releaseDocumentInkCaches();
  }
  if(results.some(result=>result.badPixels||!result.appeared||!result.removed||!result.handedOff||result.minimumHandoffScale<3))throw new Error('Worker pixel/handoff failure: '+JSON.stringify(results));
  return results;
}
