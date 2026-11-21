import React from 'react';
import { createRoot } from 'react-dom/client';
import InfiniteInkCanvas from '../src/components/InfiniteInkCanvas/InfiniteInkCanvas';
import { useCanvasStore } from '../src/components/InfiniteInkCanvas/useCanvasStore';
import { readInkFrame } from '../src/components/InkFrameStats';
import { readInkDiagnostics } from '../src/components/InkDiagnostics';
import { InkRenderBackend } from '../src/components/InfiniteInkCanvas/InkRenderBackend';
import DiagnosticPanel from '../src/components/DiagnosticPanel';
import { useNoteStore } from '../src/store';
import type { Stroke, ImageObject } from '../src/components/InfiniteInkCanvas/types';
const old: Stroke = { id:'old', type:'stroke', color:'#1267cb', size:9, opacity:.7, smoothing:.35,
  compositeOperation:'source-over', createdAt:0, points:[{x:100,y:100,pressure:.7,t:0},{x:200,y:120,pressure:.7,t:4}] };
const image: ImageObject = { id:'image',type:'image',x:300,y:100,width:40,height:40,createdAt:0,
  dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9cAAAAASUVORK5CYII=' };
useNoteStore.setState({ uiScale: 1 });
useCanvasStore.setState({ objects:[old,image], loaded:true, currentCanvasId:null, history:[], redoStack:[], camera:{x:0,y:0,zoom:1}, activeTool:'pen' });
createRoot(document.getElementById('root')!).render(<React.StrictMode><InfiniteInkCanvas /></React.StrictMode>);
const pause = () => new Promise(resolve => requestAnimationFrame(resolve));
(async () => {
  try {
    const start=performance.now();
    while (!readInkFrame().visibleTiles) { if(performance.now()-start>10000) throw new Error('StrictMode cold ink never appeared'); await pause(); }
    const layer=document.querySelector<HTMLCanvasElement>('[data-ink-layer="committed"]')!;
    const alpha=layer.getContext('2d')!.getImageData(0,0,layer.width,layer.height).data;
    const inkPixels=alpha.reduce((count,value,i)=>count+(i%4===3&&value>0?1:0),0);
    if(!inkPixels)throw new Error('Committed layer is empty before input');
    const canvas=document.querySelector('canvas')!;canvas.setPointerCapture=()=>{};canvas.releasePointerCapture=()=>{};
    const send=(target:EventTarget,type:string,x:number,y:number,buttons:number)=>target.dispatchEvent(new PointerEvent(type,
      {pointerId:42,pointerType:'mouse',button:1,buttons,clientX:x,clientY:y,bubbles:true}));
    send(canvas,'pointerdown',100,100,4);send(canvas,'pointermove',120,110,4);
    await pause();
    const during={...useCanvasStore.getState().camera};
    send(window,'pointerup',120,110,0);send(canvas,'pointermove',140,120,0);
    const after={...useCanvasStore.getState().camera};
    if(during.x!==20||during.y!==10||after.x!==20||after.y!==10)throw new Error('Middle release left camera dragging');
    // Let the initial quality upgrade finish before comparing retained pixels.
    const settleStart=performance.now();
    do { await pause(); if(performance.now()-settleStart>10000)throw new Error('Wheel-pan fixture did not settle'); }
    while(performance.now()-settleStart<500||readInkFrame().queuedTiles);
    const wheel=(x:number,y:number,ctrlKey=false)=>canvas.dispatchEvent(new WheelEvent('wheel',
      {deltaX:ctrlKey?6:0,deltaY:ctrlKey?9:100,ctrlKey,clientX:x,clientY:y,bubbles:true,cancelable:true}));
    const snapshot=async()=>({camera:{...useCanvasStore.getState().camera},transform:layer.style.transform,
      pixels:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        layer.getContext('2d')!.getImageData(0,0,layer.width,layer.height).data))).join(',')});
    wheel(100,100);send(canvas,'pointerdown',100,100,4);wheel(100,100);
    await pause();const beforeFirstMove=await snapshot();
    send(canvas,'pointermove',100,100,4);await pause();const afterFirstMove=await snapshot();
    if(JSON.stringify(beforeFirstMove)!==JSON.stringify(afterFirstMove))throw new Error('Wheel-to-middle pan changed the stationary viewport');
    send(canvas,'pointermove',120,110,4);wheel(120,110,true);
    const scrolled={...useCanvasStore.getState().camera};
    send(canvas,'pointermove',120,110,4);await pause();
    if(JSON.stringify(scrolled)!==JSON.stringify(useCanvasStore.getState().camera))throw new Error('Ctrl-wheel left a stale pan origin');
    send(canvas,'pointermove',130,125,4);await pause();
    const continued={...useCanvasStore.getState().camera};
    if(Math.abs(continued.x-scrolled.x-10)>1e-6||Math.abs(continued.y-scrolled.y-15)>1e-6)throw new Error('Wheel-pan lost relative pointer movement');
    send(window,'pointerup',130,125,0);
    const objectsUnchanged=useCanvasStore.getState().objects.length===2;
    const settle=async()=>{const start=performance.now();do{await pause();if(performance.now()-start>15000)throw new Error('Diagnostic handoff timed out');}
      while(performance.now()-start<600||readInkFrame().queuedTiles);};
    useCanvasStore.setState({camera:{x:0,y:0,zoom:1},activeTool:'pen',brushSettings:{...useCanvasStore.getState().brushSettings,
      color:'#13e96b',size:8,opacity:1,smoothing:0,edgeFeather:false}});
    const pen=(type:string,x:number,y:number)=>canvas.dispatchEvent(new PointerEvent(type,{pointerId:43,pointerType:'pen',
      button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y,pressure:.7,bubbles:true}));
    const green=(x:number,y:number)=>[canvas,layer].some(c=>{const r=c.getBoundingClientRect();
      const p=c.getContext('2d')!.getImageData(Math.round((x-r.left)*c.width/r.width),Math.round((y-r.top)*c.height/r.height),1,1).data;
      return p[3]>20&&p[1]>150&&p[0]<90&&p[2]>50&&p[2]<160;});
    const backendPrototype=InkRenderBackend.prototype as any,post=backendPrototype.post;
    // Let new-version viewport jobs overtake the delayed vectors, as in the incident.
    backendPrototype.post=function(message:any){
      if((message.type==='changes'&&(message.added.length||message.removed.length))||message.type==='order')
        setTimeout(()=>post.call(this,message),60);
      else post.call(this,message);
    };
    try{
      pen('pointerdown',100,100);
      for(let i=1;i<=40;i++){pen('pointermove',100+i*19,100);if(i%4===0)await pause();}
      pen('pointerup',860,100);await settle();
      if(!green(200,100)||!green(700,100))throw new Error('Diagnostic cross-tile stroke missing');
      const drawn=useCanvasStore.getState().objects.slice(-1)[0];
      pen('pointerdown',100,250);pen('pointermove',140,250);pen('pointerup',140,250);await settle();
      if(!green(125,250)||!green(200,100)||!green(700,100))throw new Error('Newest stroke disappeared after handoff');
      useCanvasStore.setState({activeTool:'select',selectedIds:[drawn.id]});await pause();
      pen('pointerdown',480,100);pen('pointermove',580,200);await pause();pen('pointerup',580,200);await settle();
      if(green(200,100)||green(700,100)||!green(300,200)||!green(800,200)||!green(125,250))
        throw new Error('Diagnostic drag left ghosts or lost ink');
    }finally{backendPrototype.post=post;}
    const panelNode=document.createElement('div');document.body.appendChild(panelNode);const panel=createRoot(panelNode);
    panel.render(<DiagnosticPanel visible onClose={()=>{}}/>);await pause();await pause();
    let exported:Blob|undefined,filename='';
    const createURL=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
    try{
      URL.createObjectURL=blob=>{exported=blob as Blob;return createURL(blob);};
      HTMLAnchorElement.prototype.click=function(){filename=this.download;};
      const button=Array.from(panelNode.querySelectorAll('button')).find(b=>b.textContent==='一键导出现场');
      if(!button)throw new Error('Diagnostic export button missing');button.click();
    }finally{URL.createObjectURL=createURL;HTMLAnchorElement.prototype.click=click;panel.unmount();panelNode.remove();}
    if(!exported||!filename.endsWith('.json'))throw new Error('Diagnostic JSON download missing');
    const report=JSON.parse(await exported.text()),text=JSON.stringify(report);
    if(report.events.length>512||report.capacity!==512||/"points"|"dataUrl"|data:image/.test(text))throw new Error('Diagnostic export leaked content or exceeded its limit');
    const records=report.events.filter((e:any)=>e.type==='stroke-commit'||e.type==='drag-start'||e.type==='drag-end');
    if(!records.some((e:any)=>e.type==='stroke-commit'&&e.data.expectedKeys.includes('1:0'))||
      !records.some((e:any)=>e.type==='drag-start')||!records.some((e:any)=>e.type==='drag-end'&&e.data.dx===100))
      throw new Error('Diagnostic commit/drag evidence missing');
    const types=[...new Set(report.events.map((e:any)=>e.type))];
    for(const type of ['worker-result','tile-ready','publish','display-invalidate','display-paint','handoff-complete'])
      if(!types.includes(type))throw new Error('Diagnostic render chain missing '+type);
    (window as any).benchmarkResult={strictMode:true,development:import.meta.env.DEV,backend:readInkFrame().backend,inkPixelsBeforeInput:inkPixels,
      visibleTilesBeforeInput:readInkFrame().visibleTiles,images:document.querySelectorAll('img').length,during,after,
      wheelPan:{beforeFirstMove,afterFirstMove,scrolled,continued},
      objectsUnchanged,diagnostics:{eventCount:report.events.length,sources:report.sources.length,types,filename,metadataOnly:true,deferredSourceMs:60}};
  }catch(error){(window as any).benchmarkResult={error:String(error)};}
})();
