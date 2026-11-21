import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer as createHTTPServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const output = path.resolve(process.argv[2] ?? 'docs/ink-shapes-validation.json');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noteapp-shapes-'));
const profile = path.join(directory, 'profile'); fs.mkdirSync(profile);
const vite = await createServer({ root: process.cwd(), configFile: false, plugins: [react()], server: {
  middlewareMode: true, hmr: false, watch: null, fs: { allow: [process.cwd()] },
} });
const http = createHTTPServer(vite.middlewares);
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const port = http.address().port;
const helper = path.join(directory, 'helper'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'ink-shape-smoke', main: 'main.cjs' }));
const args = { url: `http://127.0.0.1:${port}/scripts/ink-shapes-smoke.html`, output, profile };
fs.writeFileSync(path.join(helper, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const settings=${JSON.stringify(args)};
app.setPath('userData',settings.profile);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1000,height:720,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false,offscreen:true}});
  win.webContents.setFrameRate(60);
  const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)errors.push(message)});
  await win.loadURL(settings.url);
  const deadline=Date.now()+90000, captures=new Set();let busy=false;
  const timer=setInterval(async()=>{
    if(busy)return;busy=true;
    try{
      const state=await win.webContents.executeJavaScript('({capture:window.shapeCapture,result:window.benchmarkResult})');
      if(state.capture&&!captures.has(state.capture)){
        captures.add(state.capture);const image=await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(settings.output),{recursive:true});
        fs.writeFileSync(path.join(path.dirname(settings.output),'ink-shapes-'+state.capture+'.png'),image.toPNG());
        await win.webContents.executeJavaScript('window.shapeCaptureDone='+JSON.stringify(state.capture));
      }
      if(state.result||Date.now()>deadline){
        clearInterval(timer);fs.mkdirSync(path.dirname(settings.output),{recursive:true});
        const report={result:state.result??{error:'timeout'},errors,gpu:app.getGPUFeatureStatus(),isolatedProfile:true,electron:process.versions.electron};
        fs.writeFileSync(settings.output,JSON.stringify(report,null,2));app.exit(report.result.error?1:0);
      }
    }catch(error){clearInterval(timer);fs.writeFileSync(settings.output,JSON.stringify({error:String(error),errors}));app.exit(1);}
    busy=false;
  },200);
});
`);
try {
  const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), ['--no-sandbox', helper], { stdio: 'pipe', windowsHide: true });
  child.stderr.on('data', data => process.stderr.write(data));
  const code = await new Promise(resolve => child.on('exit', resolve));
  const result = JSON.parse(fs.readFileSync(output, 'utf8')); console.log(JSON.stringify(result));
  if (code !== 0 || !result.result?.ok) process.exitCode = 1;
} finally { await new Promise(resolve => http.close(resolve)); await vite.close(); }
