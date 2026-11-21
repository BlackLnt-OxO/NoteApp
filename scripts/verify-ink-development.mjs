import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {createServer as createHTTPServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'noteapp-ink-dev-regression-'));
fs.symlinkSync(path.resolve('src'),path.join(directory,'src'),'junction');
fs.symlinkSync(path.resolve('node_modules'),path.join(directory,'node_modules'),'junction');
fs.mkdirSync(path.join(directory,'scripts'));
for(const file of ['ink-regression-dev.html','ink-regression-dev.tsx'])fs.copyFileSync(path.join('scripts',file),path.join(directory,'scripts',file));
const vite=await createServer({root:directory,configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false,
  fs:{allow:[directory,path.resolve('src'),path.resolve('node_modules')]}}});
const http=createHTTPServer(vite.middlewares);
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const port=http.address().port;
const output=path.resolve(process.argv[2]??'docs/ink-development-regression.json');
const profile=path.join(directory,'profile');fs.mkdirSync(profile);
const helper=path.join(directory,'helper');fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper,'package.json'),JSON.stringify({name:'ink-dev-regression',main:'main.js'}));
const args=[`http://127.0.0.1:${port}/scripts/ink-regression-dev.html`,output,profile,'development-regression'];
fs.writeFileSync(path.join(helper,'main.js'),fs.readFileSync('scripts/ink-benchmark-electron.js','utf8').replace('process.argv.slice(2)',JSON.stringify(args)));
console.log(JSON.stringify({port,isolated:port!==5173}));
try {
  if(port===5173)throw new Error('Test cannot use the development port');
  const child=spawn(path.resolve('node_modules/electron/dist/electron.exe'),['--no-sandbox',helper],{stdio:'pipe',windowsHide:true});
  child.stderr.on('data',data=>process.stderr.write(data));
  const code=await new Promise(resolve=>child.on('exit',resolve));
  const result=JSON.parse(fs.readFileSync(output));console.log(JSON.stringify(result.result));
  if(code!==0||!result.result.development||result.result.backend!=='worker'||!result.result.inkPixelsBeforeInput||!result.result.objectsUnchanged)throw new Error('Development regression verification failed');
}finally {await new Promise(resolve=>http.close(resolve));await vite.close();}
