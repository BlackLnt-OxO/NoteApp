const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path');
const [url,output,profile,mode]=process.argv.slice(2);
app.setPath('userData',profile);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
if(mode.startsWith('software')) app.disableHardwareAcceleration();
if(mode.includes('memory')) app.commandLine.appendSwitch('force-device-scale-factor','1.5');
let gpu=null; app.on('gpu-info-update',()=>{gpu=app.getGPUFeatureStatus()});
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:mode.includes('memory')?1400:1000,height:mode.includes('memory')?900:720,useContentSize:true,show:true,title:'画布性能验证（隔离数据）',webPreferences:{backgroundThrottling:false}});
  const errors=[]; win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)errors.push(message)});
  await win.loadURL(url);
  const deadline=Date.now()+360000;
  const memory=[],gpuMemory=[];let polling=false,gpuSampling=false,phase='opening';
  const sampleGPU=()=>{
    if(!mode.includes('memory')||gpuSampling)return;
    gpuSampling=true;const ids=app.getAppMetrics().map(p=>p.pid),at=Date.now(),samplePhase=phase;
    require('child_process').execFile('powershell.exe',['-NoProfile','-Command',"(Get-Counter -Counter '\\GPU Process Memory(*)\\Dedicated Usage','\\GPU Process Memory(*)\\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples | Select-Object InstanceName,Path,CookedValue | ConvertTo-Json -Compress"],
      {windowsHide:true,timeout:10000},(_error,stdout)=>{
        try{const rows=JSON.parse(stdout),samples=(Array.isArray(rows)?rows:[rows]).filter(row=>ids.some(id=>row.InstanceName.startsWith(`pid_${id}_`))&&row.CookedValue>=0);
          gpuMemory.push({at,phase:samplePhase,dedicatedBytes:samples.filter(row=>row.Path.endsWith('dedicated usage')).reduce((n,row)=>n+row.CookedValue,0),
            sharedBytes:samples.filter(row=>row.Path.endsWith('shared usage')).reduce((n,row)=>n+row.CookedValue,0),samples:samples.length});
        }catch{gpuMemory.push({at,phase:samplePhase,error:'GPU process counters unavailable'});}gpuSampling=false;
      });
  };
  const gpuTimer=mode.includes('memory')?setInterval(sampleGPU,2000):null;sampleGPU();
  const timer=setInterval(async()=>{
    if(polling)return;polling=true;
    const metrics=app.getAppMetrics();
    const state=await win.webContents.executeJavaScript('({phase:window.benchmarkPhase,result:window.benchmarkResult})');
    phase=state.phase??phase;
    memory.push({at:Date.now(),phase,visible:win.isVisible(),minimized:win.isMinimized(),processes:metrics.map(process=>({type:process.type,pid:process.pid,memory:process.memory}))});
    const result=state.result;
    if(result||Date.now()>deadline){
      clearInterval(timer);
      if(gpuTimer)clearInterval(gpuTimer);
      fs.mkdirSync(path.dirname(output),{recursive:true});
      fs.writeFileSync(output,JSON.stringify({mode,gpu,electron:process.versions.electron,memory,gpuMemory,result:result??{error:'timeout'},errors},null,2));
      app.exit(result?.error?1:0);
    }
    polling=false;
  },250);
});
