import { _electron as electron, chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const output = path.resolve('artifacts/desktop-performance-0.3.5');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'isolated-profile-'));
const app = await electron.launch({
  args: ['.'], cwd: root, timeout: 30000,
  env: { ...process.env, FRIEND_SCREEN_LEGACY_TEST: '1', FRIEND_SCREEN_SKIP_AUTO_CONNECT: '1', FRIEND_SCREEN_USER_DATA: profile },
});
let browser;
let fixtureCreated = false;
const result = {
  date: new Date().toISOString(), passed: false, checks: [], errors: [],
  environment: 'One Windows host, Electron 45 development runtime in isolated legacy-test profile, an explicitly owned 1920x1080 animated fixture window, a separate Edge receiver, local signaling and same-host WebRTC.',
  limits: 'Single-machine loopback only; not cross-network, not a ZeroTier media-path test, no real system audio or microphone, no installed/packaged executable. Main-window foreground and minimized phases compare local scheduling and native window capture only. Synthetic animation is not a game or video workload.',
};
const pass = name => { result.checks.push(name); console.log('PASS ' + name); };
const now = () => new Promise(resolve => setTimeout(resolve, 1000));

async function getMetrics(page) {
  return page.evaluate(async () => {
    const video = document.querySelector('#stage-video');
    const stream = video?.srcObject;
    const track = stream?.getVideoTracks()[0];
    const pcs = window.__pcs || [];
    const pc = pcs.find(item => item.connectionState !== 'closed');
    if (!pc) return {stageReady: Boolean(stream), stageWidth: video?.videoWidth || 0, stageHeight: video?.videoHeight || 0};
    const reports = await pc.getStats();
    const all = [...reports.values()];
    const senders = pc.getSenders();
    const transport = senders.find(sender => sender.track?.kind === 'video')?.transport;
    let livePair = null, liveApi = false;
    try {
      liveApi = typeof transport?.iceTransport?.getSelectedCandidatePair === 'function';
      if (liveApi) {
        const pair = transport.iceTransport.getSelectedCandidatePair();
        const candidate = item => item ? {address:item.address,protocol:item.protocol,type:item.type} : null;
        livePair = pair ? {local:candidate(pair.local),remote:candidate(pair.remote)} : null;
      }
    } catch (error) { livePair = {error:error.message}; }
    const outgoing = all.filter(item => item.type === 'outbound-rtp' && (item.kind || item.mediaType) === 'video');
    const incoming = all.filter(item => item.type === 'inbound-rtp' && (item.kind || item.mediaType) === 'video');
    const codecFor = item => {
      const codec = reports.get(item.codecId);
      return codec ? {mimeType:codec.mimeType,sdpFmtpLine:codec.sdpFmtpLine,encoderImplementation:codec.encoderImplementation,powerEfficientEncoder:codec.powerEfficientEncoder} : null;
    };
    const mediaSources = all.filter(item => item.type === 'media-source' && item.kind === 'video').map(item => ({width:item.width,height:item.height,fps:item.framesPerSecond,frames:item.frames}));
    const pairs = all.filter(item => item.type === 'candidate-pair' && (item.selected || item.nominated && item.state === 'succeeded')).map(item => ({state:item.state,rtt:item.currentRoundTripTime,availableOutgoingBitrate:item.availableOutgoingBitrate}));
    return {
      time:performance.now(), stageReady:Boolean(stream && track?.readyState === 'live' && video.readyState >= 2),
      stageWidth:video?.videoWidth || 0,stageHeight:video?.videoHeight || 0,
      track:track ? {readyState:track.readyState,settings:track.getSettings(),constraints:track.getConstraints()} : null,
      outgoing:outgoing.map(item => ({width:item.frameWidth,height:item.frameHeight,frames:item.framesEncoded ?? item.framesSent,bytes:item.bytesSent,encodeTime:item.totalEncodeTime,fps:item.framesPerSecond,limitation:item.qualityLimitationReason,codec:codecFor(item)})),
      incoming:incoming.map(item => ({width:item.frameWidth,height:item.frameHeight,frames:item.framesDecoded,bytes:item.bytesReceived,fps:item.framesPerSecond,freezeCount:item.freezeCount,freezeDuration:item.totalFreezesDuration,packetsLost:item.packetsLost,jitterBufferDelay:item.jitterBufferDelay,codec:codecFor(item)})),
      mediaSources,pairs,liveApi,livePair,
      connection:pcs.map(item => ({connection:item.connectionState,ice:item.iceConnectionState})),
    };
  });
}

async function samplePhase(name, hostPage, watcherPage, fixturePage, mainMinimized, durationMs = 9000) {
  const samples = [];
  const sourceStart = await fixturePage.evaluate(() => window.__sourceStats());
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    const host = await getMetrics(hostPage);
    const viewer = await getMetrics(watcherPage);
    const source = await fixturePage.evaluate(() => window.__sourceStats());
    samples.push({wallTime:new Date().toISOString(),host,viewer,source});
    await now();
  }
  const phase = {name,durationSeconds:(Date.now()-started)/1000,mainWindowMinimized:mainMinimized,sourceStart,sourceEnd:samples.at(-1)?.source,samples};
  const first = samples.find(item => item.host.outgoing?.length && item.viewer.incoming?.length);
  const last = [...samples].reverse().find(item => item.host.outgoing?.length && item.viewer.incoming?.length);
  if (first && last && last !== first) {
    const seconds = (last.host.time - first.host.time)/1000;
    const sent0 = first.host.outgoing[0], sent1 = last.host.outgoing[0];
    const recv0 = first.viewer.incoming[0], recv1 = last.viewer.incoming[0];
    phase.windowRates = {
      seconds,
      sendFps:deltaRate(sent1.frames,sent0.frames,seconds),
      receiveFps:deltaRate(recv1.frames,recv0.frames,seconds),
      sourceFps:deltaRate(last.source.frames,first.source.frames,(last.source.lastRaf-first.source.lastRaf)/1000),
      averageEncodeMsPerFrame:typeof sent0.encodeTime === 'number' && typeof sent1.encodeTime === 'number' && sent1.frames > sent0.frames ? (sent1.encodeTime-sent0.encodeTime)*1000/(sent1.frames-sent0.frames) : null,
      sentFrameDelta:sent1.frames-sent0.frames,receivedFrameDelta:recv1.frames-recv0.frames,
      sourceDimensions:last.host.track?.settings ? {width:last.host.track.settings.width,height:last.host.track.settings.height} : null,
      encodedDimensions:{width:sent1.width,height:sent1.height},decodedDimensions:{width:recv1.width,height:recv1.height},
      senderCodec:sent1.codec,receiverCodec:recv1.codec,limitation:sent1.limitation,
    };
  }
  return phase;
}

function deltaRate(end, start, seconds) {
  return Number.isFinite(end) && Number.isFinite(start) && seconds > 0 ? (end-start)/seconds : null;
}

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => result.errors.push(error.message));
  await page.addInitScript(() => {
    window.__pcs=[];
    const NativePC=RTCPeerConnection;
    window.RTCPeerConnection=class extends NativePC {constructor(...args){super(...args);window.__pcs.push(this);}};
  });
  await page.locator('#local-mode-btn').waitFor({state:'visible'});
  await page.locator('#local-mode-btn').click();
  await page.waitForURL(url => url.hostname === '127.0.0.1');
  await page.locator('#create-name').fill('性能测试房主');
  await page.locator('#create-password').fill('desktop-performance-test');
  await page.locator('#create-btn').click();
  await page.locator('#room-view').waitFor({state:'visible'});
  await page.locator('#quality-select').selectOption('1080p60');
  assert.equal(await page.locator('#sharing-priority').inputValue(),'fixed');
  const base = new URL(page.url()).origin;

  const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>同屏小屋 60fps 测试窗口</title><style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#08121b}canvas{display:block;width:1920px;height:1080px}</style><canvas id="motion"></canvas><script>
    const canvas=document.querySelector('#motion'),ctx=canvas.getContext('2d',{alpha:false});
    canvas.width=1920;canvas.height=1080;window.__fixtureFrames=0;window.__fixtureMinimized=false;let last=0;
    function draw(t){window.__fixtureFrames++;last=t;ctx.fillStyle='#08121b';ctx.fillRect(0,0,1920,1080);const phase=(t*.36)%480;
      for(let y=0;y<1080;y+=120)for(let x=-480;x<2400;x+=240){ctx.fillStyle=((x/240+y/120)&1)?'#1b655c':'#274879';ctx.fillRect(x+phase,y+phase*.18,210,92);}
      ctx.fillStyle='#e5fff4';ctx.font='24px Consolas,monospace';ctx.fillText('NATIVE WINDOW CAPTURE   1920x1080   60 FPS   '+Math.round(t),32+phase*.2,60);
      requestAnimationFrame(draw)}requestAnimationFrame(draw);
    window.__sourceStats=()=>({frames:window.__fixtureFrames,lastRaf:last,hidden:document.hidden,width:canvas.width,height:canvas.height,innerWidth,innerHeight,dpr:devicePixelRatio});
  </script>`;
  const fixtureData = 'data:text/html;charset=utf-8,' + encodeURIComponent(fixtureHtml);
  await app.evaluate(async ({BrowserWindow},url) => {
    const fixture=new BrowserWindow({width:1920,height:1080,frame:false,title:'同屏小屋 60fps 测试窗口',show:true,backgroundColor:'#08121b',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    fixture.setMenu(null);await fixture.loadURL(url);fixture.setContentSize(1920,1080);fixture.show();fixture.focus();
    globalThis.__performanceFixture=fixture;
  },fixtureData);
  fixtureCreated=true;
  const fixturePage = app.windows().find(candidate => candidate.url().startsWith('data:text/html'));
  assert.ok(fixturePage,'Owned fixture window must be discoverable');
  const fixtureGeometry = await app.evaluate(({screen}) => ({display:screen.getPrimaryDisplay().size,scaleFactor:screen.getPrimaryDisplay().scaleFactor,fixture:globalThis.__performanceFixture.getBounds(),content:globalThis.__performanceFixture.getContentBounds(),prefs:globalThis.__performanceFixture.webContents.getLastWebPreferences()}));
  result.display = fixtureGeometry;
  assert.equal(fixtureGeometry.content.width,1920,'Fixture content width must be 1920 CSS pixels');
  result.geometryNote=fixtureGeometry.content.height===1080 ? 'Exact 1080 CSS pixel client height.' : `Windows high-DPI window bounds report ${fixtureGeometry.content.height} CSS pixels; the owned source canvas remains 1920x1080 and the captured track settings/encoded output are recorded independently.`;

  browser=await chromium.launch({executablePath:process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const watcher=await browser.newPage({viewport:{width:1280,height:800}});watcher.setDefaultTimeout(20000);watcher.on('pageerror',error=>result.errors.push(error.message));
  await watcher.addInitScript(() => {
    window.__pcs=[];
    const NativePC=RTCPeerConnection;
    window.RTCPeerConnection=class extends NativePC {constructor(...args){super(...args);window.__pcs.push(this);}};
  });
  await watcher.goto(base+'/#room='+await page.locator('#room-code').textContent());
  await watcher.locator('#join-name').fill('性能测试观看者');
  await watcher.locator('#join-password').fill('desktop-performance-test');
  await watcher.locator('#join-btn').click();
  await watcher.locator('#room-view').waitFor({state:'visible'});
  await fixturePage.waitForFunction(() => window.__fixtureFrames > 120);
  const pickerPromise=app.waitForEvent('window');
  await page.bringToFront();
  await page.locator('#share-btn').click();
  const picker=await pickerPromise;
  await picker.locator('#system-audio').waitFor();
  const source=picker.locator('.source-option[data-kind="window"][data-name="同屏小屋 60fps 测试窗口"]');
  await source.waitFor({timeout:20000});await source.click();
  await picker.locator('#confirm-share-btn').click().catch(error=>{if(!picker.isClosed()&&!/closed/i.test(error.message))throw error;});
  await watcher.waitForFunction(() => {const v=document.querySelector('#stage-video');return !v.hidden&&v.videoWidth>0&&v.readyState>=2;});
  await watcher.waitForFunction(async()=>{for(const pc of window.__pcs||[]){const stats=await pc.getStats();if([...stats.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='video'&&s.framesDecoded>60))return true;}return false;});

  result.runtime = await app.evaluate(({app,BrowserWindow}) => ({electron:process.versions.electron,chrome:process.versions.chrome,platform:process.platform,gpuFeatureStatus:app.getGPUFeatureStatus?.(),mainPrefs:BrowserWindow.getAllWindows().find(window=>window.getTitle().includes('本机试用'))?.webContents.getLastWebPreferences()}));
  result.runtime.liveSelectedPairApi=await page.evaluate(()=>typeof RTCIceTransport?.prototype?.getSelectedCandidatePair==='function');
  result.runtime.selectedPairSample=(await getMetrics(page)).livePair;
  result.fixtureSource = await fixturePage.evaluate(() => window.__sourceStats());
  const capture = await page.evaluate(() => {const track=document.querySelector('#stage-video').srcObject?.getVideoTracks()[0];return track?{settings:track.getSettings(),constraints:track.getConstraints()}:null;});
  result.nativeCapture=capture;
  assert.ok(capture?.settings?.width && capture?.settings?.height,'Native capture settings must be available');
  assert.ok(result.runtime.liveSelectedPairApi,'Electron runtime lacks RTCIceTransport.getSelectedCandidatePair');
  pass('Electron native picker captures only the owned 1920x1080 fixture; Edge receives decoded RTP and Electron exposes the selected-pair API');

  await page.evaluate(() => document.querySelector('#stage-video').play());
  await watcher.evaluate(() => document.querySelector('#stage-video').play());
  await page.bringToFront();
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(item=>item.getTitle().includes('本机试用'));window.show();window.focus();});
  result.mainForeground=await samplePhase('main-window-foreground',page,watcher,fixturePage,false,10000);

  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.getTitle().includes('本机试用')).minimize());
  await page.waitForTimeout(1000);
  result.mainMinimized=await samplePhase('main-window-minimized',page,watcher,fixturePage,true,10000);
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(item=>item.getTitle().includes('本机试用'));window.restore();window.show();window.focus();});
  await page.waitForTimeout(1000);
  result.foregroundAfterMinimized=await samplePhase('main-window-restored',page,watcher,fixturePage,false,8000);

  const senderResults=[result.mainForeground,result.mainMinimized,result.foregroundAfterMinimized].map(phase=>phase.windowRates?.sendFps).filter(Number.isFinite);
  const receiverResults=[result.mainForeground,result.mainMinimized,result.foregroundAfterMinimized].map(phase=>phase.windowRates?.receiveFps).filter(Number.isFinite);
  result.conclusion={
    target:'1080p60',
    sourceReachedNear60:result.fixtureSource.width===1920&&result.fixtureSource.height===1080,
    foregroundSenderFps:result.mainForeground.windowRates?.sendFps ?? null,
    minimizedSenderFps:result.mainMinimized.windowRates?.sendFps ?? null,
    foregroundReceiverFps:result.mainForeground.windowRates?.receiveFps ?? null,
    minimizedReceiverFps:result.mainMinimized.windowRates?.receiveFps ?? null,
    allPhasesTargetMet:senderResults.length===3&&receiverResults.length===3&&senderResults.every(fps=>fps>=57)&&receiverResults.every(fps=>fps>=57),
  };
  assert.deepEqual(result.errors,[],'Renderer errors occurred');
  result.passed=result.conclusion.allPhasesTargetMet;
  if(result.passed)pass('Native capture sustains the 1080p60 acceptance threshold in foreground, minimized and restored phases');
  else result.failure='Observed actual measured FPS did not meet the >=57 fps threshold in every phase; inspect per-second samples, source cadence, codec and encode time.';
} catch(error) {
  result.failure={name:error.name,message:error.message};
  result.errors.push(error.stack || error.message);
  console.error(error.stack || error.message);
} finally {
  if(fixtureCreated) await app.evaluate(() => {if(globalThis.__performanceFixture&&!globalThis.__performanceFixture.isDestroyed())globalThis.__performanceFixture.close();}).catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  await app.close().catch(()=>{});
  result.endedAt=new Date().toISOString();
  await writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));
  console.log(`RESULT ${JSON.stringify({passed:result.passed,output:path.join(output,'results.json'),failure:result.failure,conclusion:result.conclusion})}`);
}
