'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Native media IPC is only exposed to loopback pages. The main process also
// verifies the exact active gateway origin, main frame and enrollment state.
if(process.isMainFrame && process.argv.includes('--friend-native-private') && location.protocol==='http:' && location.hostname==='127.0.0.1'){
  contextBridge.exposeInMainWorld('privateHouse',Object.freeze({
    native:(type,payload)=>ipcRenderer.invoke('friend-screen:native-media',type,payload),
    health:()=>ipcRenderer.invoke('friend-screen:native-health'),
    openUpdates:()=>ipcRenderer.invoke('friend-screen:update-open'),
    openDiagnostics:()=>ipcRenderer.invoke('friend-screen:diagnostics-open'),
    diagnosticsState:()=>ipcRenderer.invoke('friend-screen:diagnostics-status'),
    diagnosticsSample:value=>ipcRenderer.send('friend-screen:diagnostics-sample',value),
    diagnosticsEvent:value=>ipcRenderer.send('friend-screen:diagnostics-event',value),
    onDiagnosticsState:listener=>{const fn=(_event,message)=>listener(message);ipcRenderer.on('friend-screen:diagnostics-state',fn);return()=>ipcRenderer.removeListener('friend-screen:diagnostics-state',fn);},
    onNative:listener=>{const fn=(_event,message)=>listener(message);ipcRenderer.on('friend-screen:native-event',fn);return()=>ipcRenderer.removeListener('friend-screen:native-event',fn);},
  }));
}
if (process.isMainFrame && location.protocol === 'friend-screen:' && location.hostname === 'desktop') {
  if (location.pathname === '/launcher.html') {
    contextBridge.exposeInMainWorld('desktopLauncher', Object.freeze({
      getSettings: () => ipcRenderer.invoke('friend-screen:settings'),
      startLocal: () => ipcRenderer.invoke('friend-screen:local'),
      connect: (origin) => ipcRenderer.invoke('friend-screen:connect', origin),
      setup:value=>ipcRenderer.invoke('friend-screen:overlay-setup',value),
      authorize:()=>ipcRenderer.invoke('friend-screen:overlay-authorize'),
      retry:()=>ipcRenderer.invoke('friend-screen:overlay-retry'),
      enter:()=>ipcRenderer.invoke('friend-screen:overlay-enter'),
      admin:value=>ipcRenderer.invoke('friend-screen:overlay-admin',value),
      logout:()=>ipcRenderer.invoke('friend-screen:overlay-logout'),
      openUpdates:()=>ipcRenderer.invoke('friend-screen:update-open'),
    }));
  } else if (location.pathname === '/updates.html') {
    contextBridge.exposeInMainWorld('desktopUpdates', Object.freeze({
      action: (name, value) => ipcRenderer.invoke('friend-screen:update-action', name, value),
      onState: listener => {
        const receive = (_event, state) => listener(state);
        ipcRenderer.on('friend-screen:update-state', receive);
        return () => ipcRenderer.removeListener('friend-screen:update-state', receive);
      },
    }));
  } else if(location.pathname==='/diagnostics.html'){
    contextBridge.exposeInMainWorld('desktopDiagnostics',Object.freeze({
      action:(operation,value)=>ipcRenderer.invoke('friend-screen:diagnostics-panel',operation,value),
      onState:listener=>{const fn=(_event,message)=>listener(message);ipcRenderer.on('friend-screen:diagnostics-state',fn);return()=>ipcRenderer.removeListener('friend-screen:diagnostics-state',fn);},
    }));
  } else if (location.pathname === '/picker.html') {
    contextBridge.exposeInMainWorld('desktopPicker', Object.freeze({
      getSources: () => ipcRenderer.invoke('friend-screen:sources'),
      select: (id, audio) => ipcRenderer.invoke('friend-screen:select-source', { id, audio }),
      cancel: () => ipcRenderer.invoke('friend-screen:cancel-source'),
    }));
  }
}
