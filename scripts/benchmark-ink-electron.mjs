import {build} from 'vite';
import {startInkTestServer} from './ink-test-server.mjs';
import react from '@vitejs/plugin-react';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const root=path.resolve(process.argv[2]??'.'),mode=process.argv[3]??'hardware';
const output=path.resolve(process.argv[4]??path.join(os.tmpdir(),`noteapp-ink-${Date.now()}.json`));
const documentFixture=process.argv[5];
const buildRoot=fs.mkdtempSync(path.join(os.tmpdir(),'noteapp-ink-build-'));
fs.symlinkSync(path.join(root,'src'),path.join(buildRoot,'src'),'junction');
fs.symlinkSync(path.resolve('node_modules'),path.join(buildRoot,'node_modules'),'junction');
fs.mkdirSync(path.join(buildRoot,'scripts'));
fs.copyFileSync(path.resolve('scripts/ink-benchmark.html'),path.join(buildRoot,'scripts/ink-benchmark.html'));
const hasStorage=fs.existsSync(path.join(root,'src/components/InfiniteInkCanvas/CanvasRepository.ts'));
let renderer=fs.readFileSync(path.resolve('scripts/ink-benchmark.tsx'),'utf8').replace(
  "await import(/* @vite-ignore */ ['/src/components/InfiniteInkCanvas', 'CanvasRepository.ts'].join('/'))",
  hasStorage ? "await import('../src/components/InfiniteInkCanvas/CanvasRepository')" : "({canvasRepository:{async save(){},async close(){}}})");
if(!hasStorage)renderer=renderer.replace("import { runBackendChecks } from './ink-benchmark-checks';",'').replace('const pixels = await runBackendChecks();','const pixels = null;');
if(!hasStorage)renderer=renderer.replace(/^import .* from '.*(?:PdfCanvas|PdfStore|PdfLoader|InkRenderBackend|InkDisplayLayers)';\r?\n/gm,'')
  .replace(/^    if\(new URLSearchParams\(location.search\).has\('lod'\)\).*\r?\n/m,'');
fs.copyFileSync(path.resolve('scripts/ink-benchmark-checks.ts'),path.join(buildRoot,'scripts/ink-benchmark-checks.ts'));
fs.writeFileSync(path.join(buildRoot,'scripts/ink-benchmark.tsx'),renderer);
await build({root:buildRoot,configFile:false,plugins:[react()],resolve:{alias:{'@':path.join(root,'src')}},build:{outDir:path.join(buildRoot,'output'),rollupOptions:{input:path.join(buildRoot,'scripts/ink-benchmark.html')}}});
if(documentFixture)fs.copyFileSync(path.resolve(documentFixture),path.join(buildRoot,'output','document-fixture.json'));
const server=await startInkTestServer(path.join(buildRoot,'output'));
const port=server.port;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'noteapp-ink-profile-'));
const electron=path.resolve('node_modules/electron/dist/electron.exe');
const helper=fs.mkdtempSync(path.join(os.tmpdir(),'noteapp-ink-harness-'));
fs.writeFileSync(path.join(helper,'package.json'),JSON.stringify({name:'noteapp-ink-benchmark',main:'main.js'}));

const query=mode.includes('lod')?'?lod=1':mode.includes('memory')?'?memory=1'+(documentFixture?'&document=1':''):fs.existsSync(path.join(root,'src/components/InfiniteInkCanvas/CanvasRepository.ts'))?'?storage=1':'';
const url=`http://127.0.0.1:${port}/scripts/ink-benchmark.html${query}`;
const source=fs.readFileSync(path.resolve('scripts/ink-benchmark-electron.js'),'utf8').replace('process.argv.slice(2)',JSON.stringify([url,output,profile,mode]));
fs.writeFileSync(path.join(helper,'main.js'),source);
const processHandle=spawn(electron,['--no-sandbox',helper],{stdio:'pipe',windowsHide:false,env:{...process.env,ELECTRON_ENABLE_LOGGING:'1'}});
processHandle.stdout.on('data',data=>process.stdout.write(data));
processHandle.stderr.on('data',data=>process.stderr.write(data));
const code=await new Promise(resolve=>processHandle.on('exit',resolve));
await server.close(); console.log(JSON.stringify({code,output,profile}));process.exitCode=code??1;
