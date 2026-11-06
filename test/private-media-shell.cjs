'use strict';
// Test-only desktop host. Never packaged. It uses the production preload and
// native adapter; the parent test explicitly mocks room enrollment.
const {app,BrowserWindow,ipcMain,session,protocol,shell}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {FRIEND_TEST_ORIGIN:origin,FRIEND_TEST_ADDRESS:address,FRIEND_TEST_DATA:data}=process.env;
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)||!address||!data)throw Error('Invalid private media fixture');
app.setPath('userData',data);
app.setVersion(JSON.parse(fs.readFileSync(path.resolve('package.json'),'utf8')).version);
fs.mkdirSync(path.join(data,'test-desktop'),{recursive:true});app.setPath('desktop',path.join(data,'test-desktop'));
protocol.registerSchemesAsPrivileged([{scheme:'friend-screen',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.commandLine.appendSwitch('disable-features','WebRtcHideLocalIpsWithMdns');
if(process.env.FRIEND_TEST_LEGACY_H264_BUFFER!=='1')require('../desktop/media-runtime.cjs').configureScreenVideo(app);
let engine,window,closing=false,diagnostics;
app.whenReady().then(async()=>{
  const {PiikClient}=await import(pathToFileURL(path.resolve('network/piik-client.mjs')).href);
  engine=new PiikClient({directory:path.resolve('vendor/piik'),dataDir:path.join(data,'native'),site:origin,address});
  const trusted=event=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||new URL(event.senderFrame.url).origin!==origin)throw Error('Untrusted test IPC');};
  ipcMain.handle('friend-screen:native-health',async e=>{trusted(e);try{await engine.start();return{ok:true,value:engine.health};}catch(error){return{ok:false,error:error.message};}});
  ipcMain.handle('friend-screen:native-media',async(e,type,payload)=>{
    trusted(e);
    try {
      const value=await engine.command(type,payload);
      if(type==='list-sources') {
        value.houseWindowId=String(window.getNativeWindowHandle().readUInt32LE(0));
        const prefix=process.env.FRIEND_TEST_WINDOW_PREFIX;
        if (prefix) value.sources=value.sources.filter(source=>source.kind==='window' && source.title.startsWith(prefix));
      }
      return{ok:true,value};
    } catch(error){return{ok:false,error:error.message};}
  });
  engine.on('event',m=>{diagnostics?.native(m);window?.webContents.send('friend-screen:native-event',m);});
  session.defaultSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
  window=new BrowserWindow({width:1400,height:940,show:true,webPreferences:{preload:path.resolve('desktop/preload.cjs'),additionalArguments:['--friend-native-private'],sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  session.defaultSession.protocol.handle('friend-screen',async req=>{const name=new URL(req.url).pathname.slice(1);if(!['diagnostics.html','diagnostics.js','diagnostics.css','desktop.css'].includes(name))return new Response('',{status:404});return new Response(fs.readFileSync(path.resolve('desktop',name)),{headers:{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript'}});});
  const {DiagnosticsController}=require('../desktop/diagnostics.cjs');
  diagnostics=new DiagnosticsController({app,BrowserWindow,ipcMain,shell,session:session.defaultSession,preload:path.resolve('desktop/preload.cjs'),mainWindow:()=>window,authorize:trusted,getContext:()=>({phase:'connected',nativePid:engine?.child?.exitCode===null?engine.child.pid:null,networkPaths:async()=>({available:false,peers:[]})}),bridgePath:path.resolve('native/bin/OverlayBridge.exe')});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  await window.loadURL(origin);
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',e=>{if(closing)return;e.preventDefault();closing=true;Promise.allSettled([diagnostics?.shutdown(),engine?.close()]).finally(()=>app.exit());});
