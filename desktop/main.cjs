'use strict';

const { app, BrowserWindow, Menu, session, protocol, ipcMain, desktopCapturer, dialog, clipboard, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UI_ORIGIN = 'friend-screen://desktop';
const LAUNCHER_URL = `${UI_ORIGIN}/launcher.html`;
const PICKER_URL = `${UI_ORIGIN}/picker.html`;
const UPDATES_URL = `${UI_ORIGIN}/updates.html`;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const UI_FILES = new Map([
  ['/launcher.html', ['launcher.html', 'text/html; charset=utf-8']],
  ['/launcher.js', ['launcher.js', 'text/javascript; charset=utf-8']],
  ['/picker.html', ['picker.html', 'text/html; charset=utf-8']],
  ['/picker.js', ['picker.js', 'text/javascript; charset=utf-8']],
  ['/desktop.css', ['desktop.css', 'text/css; charset=utf-8']],
  ['/diagnostics.html', ['diagnostics.html', 'text/html; charset=utf-8']],
  ['/diagnostics.js', ['diagnostics.js', 'text/javascript; charset=utf-8']],
  ['/diagnostics.css', ['diagnostics.css', 'text/css; charset=utf-8']],
  ['/updates.html', ['updates.html', 'text/html; charset=utf-8']],
  ['/updates.css', ['updates.css', 'text/css; charset=utf-8']],
  ['/updates-renderer.js', ['updates-renderer.js', 'text/javascript; charset=utf-8']],
]);

protocol.registerSchemesAsPrivileged([{ scheme: 'friend-screen', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('同屏小屋');
// ICE candidates are filtered to the verified overlay address before signaling.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
require('./media-runtime.cjs').configureScreenVideo(app);
if (process.env.FRIEND_SCREEN_USER_DATA) app.setPath('userData', path.resolve(process.env.FRIEND_SCREEN_USER_DATA));

let mainWindow = null;
let clientSession = null;
let localService = null;
let activeOrigin = null;
let activeMode = null;
let transition = false;
let quitting = false;
let launchNotice = '';
let capturePending = null;
let navigationEpoch = 0;
let micPromptOpen = false;
let coordinator = null;
let diagnostics = null;
let updates = null;
let updateWindow = null;
let nativeEngine = null;
let nativeStarting = null, nativeGeneration = 0;
let nativeShareId = null;
let nativeShareStarts = 0;
async function stopNativeEngine(){
  nativeGeneration++;
  const engine=nativeEngine;
  nativeEngine=null;
  await engine?.close();
  if (!nativeEngine) nativeShareId = null;
}
async function getNativeEngine(event){
  if(!isCurrentContent(event.sender,event.senderFrame?.url)||event.senderFrame!==mainWindow.webContents.mainFrame||activeMode!=='overlay'||!coordinator?.gateway||!coordinator.address)throw new Error('原生媒体只允许已批准私网页面使用');
  if(nativeEngine)return nativeEngine;
  if(!nativeStarting)nativeStarting=(async()=>{
    const generation=nativeGeneration;
    const {PiikClient}=await import(pathToFileURL(path.join(__dirname,'..','network','piik-client.mjs')).href);
    if(generation!==nativeGeneration)throw new Error('页面已经离开，已取消原生媒体启动');
    nativeEngine=new PiikClient({directory:app.isPackaged?path.join(process.resourcesPath,'piik'):path.join(__dirname,'..','vendor','piik'),dataDir:path.join(app.getPath('userData'),'native-media'),site:activeOrigin,address:coordinator.address});
    const engine=nativeEngine;
    engine.on('event',message=>{
      if(engine!==nativeEngine)return;
      if (message.type === 'engine-disconnected' ||
          (message.type === 'share-ended' && message.shareId === nativeShareId)) nativeShareId = null;
      diagnostics?.native(message);
      if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('friend-screen:native-event',message);
    });
    return engine;
  })().finally(()=>{nativeStarting=null;});
  return nativeStarting;
}
const legacyTest = !app.isPackaged && process.env.FRIEND_SCREEN_LEGACY_TEST === '1';
let logQueue = Promise.resolve();
function log(event) {
  // Deliberately allow only fixed event names, never tokens, invitation or payloads.
  if (!/^[a-z-]{1,48}$/.test(event)) return;
  logQueue=logQueue.catch(()=>{}).then(async()=>{
    const dir=app.getPath('logs');await fs.mkdir(dir,{recursive:true});
    const target=path.join(dir,'app.log');
    const size=await fs.stat(target).then(s=>s.size).catch(()=>0);
    if(size>2*1024*1024) {await fs.rm(target+'.previous',{force:true});await fs.rename(target,target+'.previous');}
    await fs.appendFile(target,new Date().toISOString()+' '+event+'\n');
  });
}
async function enterOverlay() {
  if(!coordinator?.gateway) throw new Error('私有网络尚未就绪');
  activeOrigin=`http://127.0.0.1:${coordinator.gateway.address().port}`;activeMode='overlay';
  await mainWindow.loadURL(activeOrigin+'/');mainWindow.setTitle('同屏小屋 · 私有网络');log('room-page-opened');
}
async function deviceExit() {
  const admin=coordinator.view().administrator;
  const result=await dialog.showMessageBox(mainWindow,{type:'warning',title:'退出当前设备',message:admin?'这是小屋管理员设备':'退出并移除本机身份？',detail:admin?'退出会删除本机的管理员签名身份和邀请码，现有小屋将无法继续审批新成员。若只是离开房间，请取消。之后需创建新的小屋并重新邀请所有人。':'退出后离开私网，清除本机身份；下次加入需要管理员重新核对并批准。',buttons:['取消','退出当前设备'],defaultId:0,cancelId:0,noLink:true});
  if(result.response!==1)return;
  await coordinator.logout();await showLauncher('已退出当前设备。');log('device-exited');
}

function normalizeServerOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入完整的 HTTPS 服务器地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('服务器地址格式不正确，例如 https://share.example.com。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('只接受 HTTPS 服务器根地址，不包含账号、密码、路径、参数或房间号。');
  }
  return url.origin;
}

function urlOrigin(value) {
  try { return new URL(value).origin; } catch { return null; }
}

function isCurrentContent(contents, requestingUrl) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents &&
    activeOrigin && urlOrigin(contents.getURL()) === activeOrigin && urlOrigin(requestingUrl) === activeOrigin);
}

function trustedUiEvent(event, window, url) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== url) {
    throw new Error('此操作仅可从客户端自己的页面发起。');
  }
}

function settingsPath() { return path.join(app.getPath('userData'), 'connection.json'); }

async function loadSavedOrigin() {
  try {
    const info = await fs.stat(settingsPath());
    if (info.size > 4096) return '';
    const saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    return normalizeServerOrigin(saved.origin);
  } catch { return ''; }
}

async function saveOrigin(origin, mode = 'server') {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const target = settingsPath();
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ origin, mode }, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}

function webPreferences() {
  return {
    additionalArguments: legacyTest ? [] : ['--friend-native-private'],
    session: clientSession,
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  };
}

function guardWindow(window, isPicker = false) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  const allowed = (url) => isPicker ? url === PICKER_URL :
    (url === LAUNCHER_URL || Boolean(activeOrigin && urlOrigin(url) === activeOrigin));
  contents.on('will-navigate', (event) => { if (!allowed(event.url)) event.preventDefault(); });
  contents.on('will-redirect', (event) => { if (!allowed(event.url)) event.preventDefault(); });
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !allowed(event.url)) event.preventDefault();
  });
  if (!isPicker) {
    contents.on('did-start-navigation', (event) => {
      if (!event.isMainFrame || event.isInPlace) return;
      navigationEpoch += 1;
      diagnostics?.navigation();
      cancelCapture();
      stopNativeEngine().catch(()=>{});
    });
  }
}

function cancelCapture() {
  capturePending?.finish(null);
}

async function stopLocalService() {
  const service = localService;
  localService = null;
  if (service) await service.close();
}

async function showLauncher(message = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  activeOrigin = null;
  activeMode = null;
  updateLocalAddressMenu();
  cancelCapture();
  launchNotice = message;
  await mainWindow.loadURL(LAUNCHER_URL);
  mainWindow.setTitle('同屏小屋 · 连接设置');
  await stopLocalService();
  await clientSession.cookies.flushStore();
}

async function enterLocal() {
  const { createApp, readConfig } = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href);
  const service = createApp(readConfig({ HOST: '127.0.0.1', PORT: '0', ACCOUNT_DATA_DIR: path.join(app.getPath('userData'), 'local-accounts') }));
  localService = service;
  const port = await service.listen();
  activeOrigin = `http://127.0.0.1:${port}`;
  activeMode = 'local';
  await mainWindow.loadURL(`${activeOrigin}/`);
  mainWindow.setTitle('同屏小屋 · 本机试用');
  await saveOrigin('', 'local');
  updateLocalAddressMenu();
}

async function enterServer(origin) {
  activeOrigin = origin;
  activeMode = 'server';
  updateLocalAddressMenu();
  await mainWindow.loadURL(`${origin}/`);
  await saveOrigin(origin);
  mainWindow.setTitle(`同屏小屋 · ${new URL(origin).host}`);
}

async function connect(event, mode, value) {
  trustedUiEvent(event, mainWindow, LAUNCHER_URL);
  if (transition) return { ok: false, message: '正在连接，请稍候。' };
  const origin = mode === 'server' ? normalizeServerOrigin(value) : null;
  transition = true;
  try {
    cancelCapture();
    await stopLocalService();
    if (mode === 'local') await enterLocal();
    else await enterServer(origin);
    return { ok: true };
  } catch (error) {
    const message = mode === 'server'
      ? '无法连接这个 HTTPS 服务器。请检查域名、证书与服务是否就绪；客户端不会忽略证书错误。'
      : '本机服务启动失败，请关闭客户端后重试。';
    await showLauncher(message).catch(() => {});
    return { ok: false, message };
  } finally { transition = false; }
}

function validCaptureRequest(request, epoch) {
  return Boolean(epoch === navigationEpoch && request.userGesture && request.videoRequested &&
    mainWindow && !mainWindow.isDestroyed() && request.frame &&
    request.frame === mainWindow.webContents.mainFrame &&
    isCurrentContent(mainWindow.webContents, request.securityOrigin));
}

async function chooseCaptureSource(request, callback) {
  const epoch = navigationEpoch;
  if (capturePending || !validCaptureRequest(request, epoch)) { callback(null); return; }
  const pending = { window: null, sources: new Map(), done: false, audioAllowed: process.platform === 'win32' && request.audioRequested, epoch };
  pending.finish = (selection) => {
    if (pending.done) return;
    pending.done = true;
    if (capturePending === pending) capturePending = null;
    const picker = pending.window;
    const valid = selection && validCaptureRequest(request, epoch);
    let streams = null;
    if (valid) {
      const source = pending.sources.get(selection.id);
      if (source) {
        streams = { video: source };
        if (selection.audio === true && pending.audioAllowed) streams.audio = 'loopback';
      }
    }
    try { callback(streams); } catch { /* The requesting frame may have closed. */ }
    pending.sources.clear();
    if (picker && !picker.isDestroyed()) setImmediate(() => { if (!picker.isDestroyed()) picker.close(); });
  };
  capturePending = pending;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 210 }, fetchWindowIcons: false });
    if (pending.done || !validCaptureRequest(request, epoch)) { pending.finish(null); return; }
    for (const source of sources.slice(0, 128)) pending.sources.set(source.id, source);
    const picker = new BrowserWindow({
      title: '选择共享内容 · 同屏小屋', parent: mainWindow, modal: true,
      width: 900, height: 700, minWidth: 650, minHeight: 520,
      show: false, backgroundColor: '#10161d', autoHideMenuBar: true,
      icon: path.join(__dirname, 'icon.ico'), webPreferences: webPreferences(),
    });
    pending.window = picker;
    picker.removeMenu();
    guardWindow(picker, true);
    picker.on('closed', () => pending.finish(null));
    picker.webContents.on('render-process-gone', () => pending.finish(null));
    picker.once('ready-to-show', () => { if (!picker.isDestroyed()) picker.show(); });
    await picker.loadURL(PICKER_URL);
  } catch { pending.finish(null); }
}

function installPermissions() {
  clientSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!details.isMainFrame || !isCurrentContent(contents, requestingOrigin || details.requestingUrl)) return false;
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') return true;
    // Chromium uses this audio check to enumerate non-default ICE interfaces.
    // This grants enumeration only to our current main frame; actual microphone
    // capture still goes through setPermissionRequestHandler and its user prompt.
    if (permission === 'media' && details.mediaType === 'audio') return true;
    // Camera, screen and other permissions remain denied by default.
    return false;
  });
  clientSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (!details.isMainFrame || !isCurrentContent(contents, details.requestingUrl)) { callback(false); return; }
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') { callback(true); return; }
    if (permission === 'display-capture') {
      // Electron 45 requests this permission BEFORE invoking setDisplayMediaRequestHandler.
      // Only the selected server's main frame may proceed to that user-controlled picker.
      callback(Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video'));
      return;
    }
    if (permission !== 'media' || !Array.isArray(details.mediaTypes) || details.mediaTypes.length !== 1 ||
        details.mediaTypes[0] !== 'audio' || micPromptOpen) { callback(false); return; }
    const epoch = navigationEpoch;
    const origin = activeOrigin;
    micPromptOpen = true;
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: '允许使用麦克风？', message: '将你的声音分享给房间里的朋友',
        detail: `请求来自：${origin}\n\n只有点击“允许”后才会采集麦克风。你可以随时在房间里关闭麦克风，或离开房间停止采集。`,
        buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0, noLink: true,
      });
      callback(result.response === 1 && epoch === navigationEpoch && isCurrentContent(contents, origin));
    } catch { callback(false); }
    finally { micPromptOpen = false; }
  });
  clientSession.setDisplayMediaRequestHandler((request, callback) => { void chooseCaptureSource(request, callback); }, { useSystemPicker: false });
  clientSession.on('will-download', (event) => event.preventDefault());
}

async function openUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.show();
    updateWindow.focus();
  } else {
    const window = new BrowserWindow({
      parent: mainWindow, title: '同屏小屋 · 客户端更新',
      width: 510, height: 485, minWidth: 360, minHeight: 355,
      backgroundColor: '#10161e', show: false, webPreferences: webPreferences(),
    });
    updateWindow = window;
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-redirect']) {
      window.webContents.on(name, event => { if (event.url !== UPDATES_URL) event.preventDefault(); });
    }
    window.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame || event.url !== UPDATES_URL) event.preventDefault();
    });
    window.on('closed', () => { if (updateWindow === window) updateWindow = null; });
    await window.loadURL(UPDATES_URL);
    if (window.isDestroyed()) return;
    window.show();
  }
  if (['idle', 'current', 'error'].includes(updates.state.phase)) void updates.check();
}

function installIpc() {
  ipcMain.handle('friend-screen:update-open', async event => {
    if (event.senderFrame?.url === LAUNCHER_URL) trustedUiEvent(event, mainWindow, LAUNCHER_URL);
    else if (activeMode !== 'overlay' || !isCurrentContent(event.sender, event.senderFrame?.url) ||
        event.senderFrame !== mainWindow?.webContents.mainFrame) {
      throw new Error('更新只能从客户端设置打开。');
    }
    await openUpdateWindow();
  });
  ipcMain.handle('friend-screen:update-action', (event, action, value) => {
    trustedUiEvent(event, updateWindow, UPDATES_URL);
    return updates.action(action, value);
  });
  ipcMain.handle('friend-screen:native-health',async(event)=>{try{const engine=await getNativeEngine(event);await engine.start();return{ok:true,value:engine.health};}catch(error){return{ok:false,error:error.message};}});
  ipcMain.handle('friend-screen:native-media',async(event,type,payload)=>{
    const starting = type === 'start-share';
    if (starting && updates?.installing) return { ok: false, error: '客户端正在重启更新。' };
    if (starting) nativeShareStarts++;
    try {
    const engine=await getNativeEngine(event);
    if(payload?.iceServers?.length)throw new Error('私网媒体不允许公网 STUN 或 TURN');
    const value=await engine.command(type,payload);
    if (engine === nativeEngine) {
      if (starting) nativeShareId = payload.shareId;
      else if (type === 'stop-share' && payload?.shareId === nativeShareId) nativeShareId = null;
    }
    if(['start-share','stop-share','update-share'].includes(type))diagnostics?.event({type:'native-'+type,shareId:payload?.shareId});
    if(type==='list-sources')value.houseWindowId=String(mainWindow.getNativeWindowHandle().readUInt32LE(0));
    return{ok:true,value};
    } catch(error) {
      log('native-media-request-failed');
      diagnostics?.event({type:'native-command-failed',operation:type});
      return{ok:false,error:error.message};
    } finally { if (starting) nativeShareStarts--; }
  });
  ipcMain.handle('friend-screen:settings', async (event) => {
    trustedUiEvent(event, mainWindow, LAUNCHER_URL);
    return { ...(legacyTest ? {origin:await loadSavedOrigin(),legacy:true} : coordinator.view()), version: app.getVersion(), notice: launchNotice };
  });
  if(legacyTest) {
    ipcMain.handle('friend-screen:local', (event) => connect(event, 'local'));
    ipcMain.handle('friend-screen:connect', (event, origin) => connect(event, 'server', origin));
  }
  const actions={
    setup:value=>coordinator.setup(value),authorize:()=>coordinator.authorize(),
    retry:async()=>{await coordinator.poll();return coordinator.view();},
    enter:()=>enterOverlay(),admin:value=>coordinator.adminAction(value),logout:()=>deviceExit(),
  };
  for(const [name,action] of Object.entries(actions))ipcMain.handle('friend-screen:overlay-'+name,async(event,value)=>{
    trustedUiEvent(event,mainWindow,LAUNCHER_URL);
    try{return {ok:true,value:await action(value)};}catch(error){log('overlay-action-failed');return {ok:false,message:error.message || '操作失败，请重试'};}
  });
  ipcMain.handle('friend-screen:sources', (event) => {
    const pending = capturePending;
    trustedUiEvent(event, pending?.window, PICKER_URL);
    if (!pending || pending.done) throw new Error('共享选择请求已结束。');
    return {
      audioAllowed: pending.audioAllowed,
      sources: [...pending.sources.values()].map((source) => ({
        id: source.id, name: source.name, kind: source.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
      })),
    };
  });
  ipcMain.handle('friend-screen:select-source', (event, selection) => {
    const pending = capturePending;
    trustedUiEvent(event, pending?.window, PICKER_URL);
    if (!selection || typeof selection.id !== 'string' || selection.id.length > 256 ||
        typeof selection.audio !== 'boolean' || !pending.sources.has(selection.id)) {
      throw new Error('请选择列表中存在的屏幕或窗口。');
    }
    pending.finish({ id: selection.id, audio: selection.audio });
    return { ok: true };
  });
  ipcMain.handle('friend-screen:cancel-source', (event) => {
    const pending = capturePending;
    trustedUiEvent(event, pending?.window, PICKER_URL);
    pending.finish(null);
    return { ok: true };
  });
}

function updateLocalAddressMenu() {
  const item = Menu.getApplicationMenu()?.getMenuItemById('copy-local-address');
  if (item) item.enabled = activeMode === 'local' && Boolean(activeOrigin);
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '小屋', submenu: [
      { id: 'connection-settings', label: '设备与小屋设置', accelerator: 'CmdOrCtrl+Shift+H', click: () => {
        if (transition) return;
        transition = true;
        showLauncher('已返回连接设置，原房间的屏幕与麦克风已停止。').catch(() => {}).finally(() => { transition = false; });
      } },
      { label: '打开日志目录', click: () => {shell.openPath(app.getPath('logs'));} },
      { id:'diagnostics-window',label:'诊断记录窗口',accelerator:'CmdOrCtrl+Shift+D',click:()=>diagnostics?.open() },
      { id: 'copy-local-address', label: '复制本机服务地址', enabled: false, click: () => {
        if (activeMode === 'local' && activeOrigin) clipboard.writeText(`${activeOrigin}/`);
      } },
      { type: 'separator' }, { label: '退出', role: 'quit' },
    ] },
    { label: '编辑', submenu: [ { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' } ] },
    { label: '显示', submenu: [ { label: '重新加载', role: 'reload' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' } ] },
  ]));
}

async function initialize() {
  app.setAppLogsPath();log('application-started');
  const { Updates } = require('./updates.cjs');
  updates = new Updates({
    app,
    resources: process.resourcesPath,
    publish: state => {
      if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send('friend-screen:update-state', state);
    },
    canRestart: () => !nativeShareId && !nativeShareStarts && !capturePending && !quitting,
  });
  await updates.load();
  clientSession = session.fromPartition('persist:friend-screen-client', { cache: false });
  clientSession.protocol.handle('friend-screen', async (request) => {
    const url = new URL(request.url);
    const entry = UI_FILES.get(url.pathname);
    if (request.method !== 'GET' || url.hostname !== 'desktop' || url.port || url.username || url.password || !entry) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.readFile(path.join(__dirname, entry[0]));
      return new Response(data, { headers: {
        'Content-Type': entry[1], 'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      } });
    } catch { return new Response('Page unavailable', { status: 500 }); }
  });
  installPermissions();
  const {DiagnosticsController}=require('./diagnostics.cjs');
  diagnostics=new DiagnosticsController({app,BrowserWindow,ipcMain,shell,session:clientSession,preload:path.join(__dirname,'preload.cjs'),mainWindow:()=>mainWindow,
    authorize:event=>{if(!isCurrentContent(event.sender,event.senderFrame?.url)||event.senderFrame!==mainWindow?.webContents.mainFrame)throw new Error('诊断数据来源无效');},
    getContext:()=>({deviceId:coordinator?.state?.device?.deviceId,phase:coordinator?.status?.phase,nativePid:nativeEngine?.child?.exitCode===null?nativeEngine.child.pid:null,networkPaths:coordinator?()=>coordinator.networkPaths():null}),
    bridgePath:app.isPackaged?path.join(process.resourcesPath,'native','OverlayBridge.exe'):path.join(__dirname,'..','native','bin','OverlayBridge.exe'),
  });
  installIpc();
  mainWindow = new BrowserWindow({
    title: '同屏小屋 · 连接设置', width: 1280, height: 880, minWidth: 820, minHeight: 620,
    backgroundColor: '#0e1117', show: false, icon: path.join(__dirname, 'icon.ico'),
    // Sharing and private-path checks must keep running when a game covers or
    // minimizes the client. Capture still requires the explicit source picker.
    webPreferences: { ...webPreferences(), backgroundThrottling: false },
  });
  guardWindow(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; cancelCapture();app.quit(); });
  mainWindow.webContents.on('render-process-gone', () => { diagnostics?.event({type:'renderer-gone',state:'failed'});cancelCapture();stopNativeEngine().catch(()=>{}); });
  mainWindow.once('ready-to-show', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  installMenu();
  if(!legacyTest) {
    const {Coordinator}=await import(pathToFileURL(path.join(__dirname,'..','network','coordinator.mjs')).href);
    coordinator=new Coordinator({dataDir:app.getPath('userData'),root:path.join(__dirname,'..'),
      bridgePath:app.isPackaged?path.join(process.resourcesPath,'native','OverlayBridge.exe'):path.join(__dirname,'..','native','bin','OverlayBridge.exe'),secureStorage:safeStorage,
      onReady:()=>{if(!quitting)enterOverlay().catch(()=>showLauncher('进入小屋失败，请重试。'));},
      onDisconnected:exit=>{stopNativeEngine().catch(()=>{});if(exit)deviceExit().catch(()=>showLauncher('退出失败，请重试。'));else if(!quitting)showLauncher('私网连接中断，屏幕和麦克风已停止。');},
    });
    await coordinator.load();await showLauncher();
    if(!process.env.FRIEND_SCREEN_SKIP_AUTO_CONNECT)await coordinator.poll();
    return;
  }
  let saved;
  try { saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8')); } catch { /* First launch. */ }
  await showLauncher();
  if (!process.env.FRIEND_SCREEN_SKIP_AUTO_CONNECT && saved?.mode) {
    try {
      if (saved.mode === 'local') await enterLocal();
      else if (saved.mode === 'server') await enterServer(normalizeServerOrigin(saved.origin));
    } catch { await showLauncher('自动连接失败，请检查服务器地址后重试。'); }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.on('certificate-error', (event, contents, url, error, certificate, callback) => { event.preventDefault(); callback(false); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    cancelCapture();
    Promise.allSettled([diagnostics?.shutdown(),stopNativeEngine(),stopLocalService(),coordinator?.close(),clientSession?.cookies.flushStore(),logQueue]).finally(() => app.quit());
  });
  app.whenReady().then(initialize).catch((error) => {
    log('initialization-failed');
    dialog.showErrorBox('同屏小屋无法启动', '客户端初始化失败。请确认应用文件完整后重试。');
    app.quit();
  });
}
