'use strict';
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {DiagnosticsRecorder,sanitizeSample,sanitizeHost,sanitizeNativeSample}=require('./diagnostics-recorder.cjs');
const execute=promisify(execFile);
const URL='friend-screen://desktop/diagnostics.html';
class DiagnosticsController{
  constructor({app,BrowserWindow,ipcMain,shell,session,preload,mainWindow,authorize,getContext,bridgePath}){
    Object.assign(this,{app,BrowserWindow,ipcMain,shell,session,preload,mainWindow,authorize,getContext,bridgePath});
    this.window=null;this.latest=null;this.receivedAt=0;this.host=null;this.recent=[];this.cpu=new Map();this.generation=0;
    this.nativeStats=new Map();
    this.recorder=new DiagnosticsRecorder({desktop:app.getPath('desktop'),version:app.getVersion(),onChange:()=>this.publish()});
    this.install();this.timer=setInterval(()=>this.tick(),3000);this.timer.unref();
  }
  collecting(){return this.recorder.active||Boolean(this.window&&!this.window.isDestroyed());}
  nativeRecords(){const now=Date.now();for(const [key,row] of this.nativeStats)if(now-row.receivedAt>10000)this.nativeStats.delete(key);return[...this.nativeStats.values()].map(row=>({...row.event,ageMs:now-row.receivedAt}));}
  state(){return{...this.recorder.status(),collecting:this.collecting(),snapshot:this.latest?sanitizeSample(this.latest):null,host:this.host?sanitizeHost(this.host):null,ageMs:this.receivedAt?Date.now()-this.receivedAt:null,native:this.nativeRecords().map(sanitizeNativeSample),recent:this.recent.slice(-40)};}
  publish(){
    const state=this.state();
    if(this.window&&!this.window.isDestroyed())this.window.webContents.send('friend-screen:diagnostics-state',state);
    const main=this.mainWindow();if(main&&!main.isDestroyed())main.webContents.send('friend-screen:diagnostics-state',{active:state.active,collecting:state.collecting});
  }
  panel(event){if(!this.window||event.sender!==this.window.webContents||event.senderFrame!==this.window.webContents.mainFrame||event.senderFrame.url!==URL)throw Error('诊断操作来源无效');}
  install(){
    this.ipcMain.handle('friend-screen:diagnostics-open',event=>{this.authorize(event);this.open();return this.state();});
    this.ipcMain.handle('friend-screen:diagnostics-status',event=>{this.authorize(event);return{active:this.recorder.active,collecting:this.collecting()};});
    this.ipcMain.on('friend-screen:diagnostics-sample',(event,data)=>{try{this.authorize(event);if(!this.collecting()||Date.now()-this.receivedAt<800||JSON.stringify(data).length>120000)return;this.latest=data;this.receivedAt=Date.now();}catch{}});
    this.ipcMain.on('friend-screen:diagnostics-event',(event,data)=>{try{this.authorize(event);if(JSON.stringify(data).length<=4096)this.event(data);}catch{}});
    this.ipcMain.handle('friend-screen:diagnostics-panel',async(event,operation,value)=>{
      this.panel(event);
      if(operation==='state')return this.state();
      if(operation==='start'){await this.recorder.start({deviceId:this.getContext().deviceId,environment:{platform:process.platform,arch:process.arch,release:os.release(),logicalProcessors:os.cpus().length,memoryGiB:os.totalmem()/1024**3}});await this.tick();}
      else if(operation==='stop')await this.recorder.stop('user');
      else if(operation==='mark'){this.event({type:'mark',mark:value});this.publish();}
      else if(operation==='export-last')await this.recorder.exportLast();
      else if(operation==='show-file'){const s=this.recorder.status();if(s.zip)this.shell.showItemInFolder(s.zip);else if(s.folder)await this.shell.openPath(s.folder);}
      else throw Error('诊断操作无效');
      return this.state();
    });
  }
  open(){
    if(this.window&&!this.window.isDestroyed()){this.window.show();this.window.focus();return;}
    const window=new this.BrowserWindow({width:1040,height:820,minWidth:800,minHeight:650,title:'同屏小屋 · 诊断记录',backgroundColor:'#0e1117',autoHideMenuBar:true,webPreferences:{session:this.session,preload:this.preload,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    this.window=window;
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',e=>{if(e.url!==URL)e.preventDefault();});
    window.webContents.on('will-attach-webview',e=>e.preventDefault());
    window.webContents.on('did-finish-load',()=>{this.publish();this.tick();});
    window.on('close',event=>{if(this.recorder.active||this.recorder.busy){event.preventDefault();if(this.closingWindow)return;this.closingWindow=true;this.recorder.stop('window-closed').finally(()=>{this.window=null;window.destroy();this.closingWindow=false;this.publish();});}});
    window.on('closed',()=>{if(this.window===window)this.window=null;this.publish();});
    window.loadURL(URL);this.publish();
  }
  event(value){
    const {sanitizeEvent}=require('./diagnostics-recorder.cjs');const clean=sanitizeEvent(value);if(!clean)return;
    if(this.collecting()&&!['native-edge-quality','native-receiver-diagnostics'].includes(clean.type)){this.recent.push({utc:new Date().toISOString(),...clean});if(this.recent.length>80)this.recent.shift();}
    this.recorder.recordEvent(value);
  }
  native(event){
    if(event.type==='engine-disconnected')this.nativeStats.clear();
    if(event.type==='share-ended')for(const [key,row] of this.nativeStats)if(row.event.shareId===event.shareId)this.nativeStats.delete(key);
    if(event.type==='edge-state'&&event.state==='closed')this.nativeStats.delete(event.connectionId);
    if(!this.collecting())return;
    if(['edge-quality','receiver-diagnostics'].includes(event.type)&&event.diagnostics?.schema===1){
      if(this.nativeStats.size>=16&&!this.nativeStats.has(event.connectionId))this.nativeStats.delete(this.nativeStats.keys().next().value);
      this.nativeStats.set(event.connectionId,{event,receivedAt:Date.now()});
    }
    this.event({...event,type:'native-'+event.type,failureStage:event.failure?.stage,hresult:event.failure?.hresult||event.failure?.HRESULT,exitCode:event.failure?.exitCode});
  }
  async resources(nativePid){
    const cpus=os.cpus(),cores=cpus.length,now=Date.now(),metrics=this.app.getAppMetrics();let electronCpu=0,seen=false;
    const system=cpus.reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0}),oldSystem=this.systemCpu;this.systemCpu=system;
    const systemCpuPercent=oldSystem&&system.total>oldSystem.total?100*(1-(system.idle-oldSystem.idle)/(system.total-oldSystem.total)):null;
    for(const m of metrics){const key='electron:'+m.pid+':'+m.creationTime,total=m.cpu?.cumulativeCPUUsage,old=this.cpu.get(key);if(Number.isFinite(total)){if(old&&now>old.time&&total>=old.cpu){electronCpu+=(total-old.cpu)/((now-old.time)/1000)/cores*100;seen=true;}this.cpu.set(key,{time:now,cpu:total});}}
    const result={systemCpuPercent,systemFreeMemoryMiB:os.freemem()/1024**2,electronCpuPercent:seen?electronCpu:null,electronMemoryMiB:metrics.reduce((s,m)=>s+(m.memory?.workingSetSize||0),0)/1024,nativeCpuPercent:null,nativeMemoryMiB:null,nativeProcesses:nativePid?null:0,logicalProcessors:cores};
    if(Number.isInteger(nativePid)&&nativePid>0&&this.bridgePath){
      try{
        const {stdout}=await execute(this.bridgePath,['metrics',String(nativePid)],{windowsHide:true,timeout:2500,maxBuffer:16384});
        const data=JSON.parse(stdout.trim());let total=0,has=false;
        if(data.ok&&Array.isArray(data.result)){for(const p of data.result){const key='native:'+p.pid+':'+p.startedAtMs,old=this.cpu.get(key);if(old&&now>old.time&&p.cpuSeconds>=old.cpu){total+=(p.cpuSeconds-old.cpu)/((now-old.time)/1000)/cores*100;has=true;}this.cpu.set(key,{time:now,cpu:p.cpuSeconds});}result.nativeCpuPercent=has?total:null;result.nativeMemoryMiB=data.result.reduce((s,p)=>s+p.workingSetBytes,0)/1024**2;result.nativeProcesses=data.result.length;}
      }catch{}
    }
    if(this.cpu.size>128)this.cpu.clear();
    return result;
  }
  async tick(){
    if(this.ticking||!this.collecting())return;
    this.ticking=true;
    try{
      const context=this.getContext();
      const [resources,network]=await Promise.all([this.resources(context.nativePid),context.networkPaths?.().catch(()=>({available:false,peers:[]}))]);
      this.host={phase:context.phase,nativeRunning:Boolean(context.nativePid),resources,network:network||{available:false,peers:[]}};
      const age=this.receivedAt?Date.now()-this.receivedAt:null;
      this.recorder.recordSample(age!==null&&age<7500?this.latest:null,this.host,age,this.nativeRecords());
      this.publish();
    }catch{}finally{this.ticking=false;}
  }
  navigation(){this.latest=null;this.receivedAt=0;this.nativeStats.clear();this.event({type:'page-navigation'});}
  async shutdown(){clearInterval(this.timer);await this.recorder.stop('application-quit');}
}
module.exports={DiagnosticsController};
