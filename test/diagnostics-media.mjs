import {_electron as electron} from '@playwright/test';
import {mkdir,mkdtemp,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {privateFixture} from './private-native-fixture.mjs';
const root=process.cwd(),stutterCase=process.env.FRIEND_STUTTER_CASE;
if(stutterCase&&!['before','after','before-loss','after-loss','fixed-loss','before-1080','fixed-1080','after-1080'].includes(stutterCase))throw Error('Invalid controlled comparison');
const out=path.join(root,stutterCase?'artifacts/stutter-0.3.9/'+stutterCase:'artifacts/diagnostics-0.3.9');
await mkdir(out,{recursive:true});const fixture=await privateFixture(root,{impairedMedia:Boolean(stutterCase&&(stutterCase.endsWith('-loss')||['before-1080','fixed-1080'].includes(stutterCase)))}),clients=[];
const result={date:new Date().toISOString(),checks:[],errors:[],limits:'Two isolated Electron clients on one Windows PC with existing ZeroTier IPv4; mocked enrollment; owned synthetic window and synthesized microphone. Not cross-network validation.'};
const pass=value=>{result.checks.push(value);console.log('PASS',value);};
async function launch(label){
  const data=await mkdtemp(path.join(out,label+'-'));
  const app=await electron.launch({args:['test/private-media-shell.cjs'],cwd:root,env:{...process.env,FRIEND_TEST_ORIGIN:await fixture.gateway(label),FRIEND_TEST_ADDRESS:fixture.address,FRIEND_TEST_DATA:data},timeout:30000});
  const c={app,data};clients.push(c);c.page=await app.firstWindow();c.page.setDefaultTimeout(30000);
  c.page.on('pageerror',e=>result.errors.push(e.message));
  await c.page.waitForFunction(()=>window.privateHouse&&window.friendProfile?.value.name);
  await c.page.addInitScript(()=>Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{const a=new AudioContext(),o=a.createOscillator(),g=a.createGain(),d=a.createMediaStreamDestination();g.gain.value=.01;o.connect(g);g.connect(d);o.start();await a.resume();const t=d.stream.getAudioTracks()[0],stop=t.stop.bind(t);t.stop=()=>{stop();o.stop();a.close();};return d.stream;}}));
  await c.page.reload();await c.page.waitForFunction(()=>window.friendProfile?.value.name);return c;
}
async function open(c){const wait=c.app.waitForEvent('window');await c.page.locator('#diagnostic-window').click();c.panel=await wait;c.panel.setDefaultTimeout(30000);await c.panel.locator('#record-toggle').waitFor();return c.panel;}
async function contents(c){const names=(await readdir(path.join(c.data,'test-desktop'))).filter(n=>n.endsWith('.zip'));assert.ok(names.length);const file=path.join(c.data,'test-desktop',names.sort().at(-1));return{file,files:unzipSync(await readFile(file))};}
try{
  const host=await launch('host'),viewer=await launch('viewer');
  await open(host);await host.panel.waitForTimeout(1000);assert.deepEqual(await readdir(path.join(host.data,'test-desktop')),[]);pass('默认不记录；打开窗口不会创建桌面日志');
  await host.panel.locator('#record-toggle').click();await host.panel.waitForFunction(()=>document.querySelector('#record-toggle').getAttribute('aria-pressed')==='true');
  await host.page.locator('#create-btn').click();await host.page.locator('#room-view').waitFor({state:'visible'});const room=await host.page.locator('#room-code').innerText();
  await viewer.page.locator('#join-tab').click();await viewer.page.locator('#join-room').fill(room);await viewer.page.locator('#join-btn').click();await viewer.page.locator('#room-view').waitFor({state:'visible'});
  await open(viewer);await viewer.panel.locator('#record-toggle').click();
  await host.app.evaluate(async({BrowserWindow})=>{const w=new BrowserWindow({width:1920,height:1080,useContentSize:true,frame:false,title:'Diagnostic Motion Fixture',webPreferences:{sandbox:true,backgroundThrottling:false}});globalThis.fixture=w;await w.loadURL('data:text/html,'+encodeURIComponent('<title>Diagnostic Motion Fixture</title><style>body{margin:0;background:#12382c}</style><canvas id="c" width="1920" height="1080"></canvas><script>const x=c.getContext("2d");function f(t){x.fillStyle="#12382c";x.fillRect(0,0,1920,1080);x.fillStyle="#72dda9";x.fillRect(t/4%1700,200,190,400);x.fillStyle="white";x.font="70px sans-serif";x.fillText("Private diagnostics test",100,150);requestAnimationFrame(f)}requestAnimationFrame(f);const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();g.gain.value=.01;o.connect(g);g.connect(a.destination);o.start();document.onclick=()=>a.resume()</script>'));});
  const patternWindow=(await host.app.windows()).find(p=>p.url().startsWith('data:'));await patternWindow.click('canvas');
  if(stutterCase){
    await host.page.locator('#share-settings-btn').click();
    await host.page.locator('#native-bitrate').press('End');
    await host.page.getByRole('button', {name:'关闭分享设置'}).click();
    await patternWindow.evaluate(blockPattern=>{
      const tile=document.createElement('canvas');tile.width=1920;tile.height=1080;
      const tx=tile.getContext('2d'),data=tx.createImageData(1920,1080);let seed=12345;
      for(let i=0;i<data.data.length;i+=4){seed=blockPattern?(Math.imul(Math.floor((i/4)%1920/16)+1,2654435761)^Math.imul(Math.floor(i/4/1920/16)+1,2246822519))>>>0:(Math.imul(seed,1664525)+1013904223)>>>0;data.data[i]=seed&255;data.data[i+1]=(seed>>>8)&255;data.data[i+2]=(seed>>>16)&255;data.data[i+3]=255;}tx.putImageData(data,0,0);
      const canvas=document.querySelector('canvas'),context=canvas.getContext('2d');
      function animate(t){const offset=Math.floor(t/10)%1920;context.drawImage(tile,-offset,0);context.drawImage(tile,1920-offset,0);requestAnimationFrame(animate);}requestAnimationFrame(animate);
    },stutterCase.endsWith('-1080'));
  }
  await host.page.bringToFront();await host.page.locator('#share-btn').click();await host.page.locator('#native-source-dialog').waitFor({state:'visible'});await host.page.locator('.source-card').filter({hasText:'Diagnostic Motion Fixture'}).click();await host.page.locator('#native-audio').check();await host.page.locator('#native-source-dialog button[value="share"]').click();
  await viewer.page.waitForFunction(()=>document.querySelector('#stage-video').videoWidth>1000);
  await viewer.panel.waitForFunction(()=>document.querySelector('#video').textContent.includes('1920'),{},{timeout:15000});await viewer.panel.waitForTimeout(stutterCase?60000:12000);
  await viewer.panel.locator('#mark-kind').selectOption('video-stutter-audio-ok');await viewer.panel.locator('#mark').click();await viewer.panel.screenshot({path:path.join(out,'live-window.png'),fullPage:true});
  assert.match(await viewer.panel.locator('#events').innerText(),/画面卡顿/);assert.match(await viewer.page.locator('#diagnostic-window').innerText(),/记录中/);pass('实际原生视频、语音、资源统计与问题标记实时显示');
  const live=await viewer.panel.evaluate(()=>window.desktopDiagnostics.action('state'));
  assert.ok(live.native.some(n=>n.diagnostics?.direction==='inbound'&&n.diagnostics?.scope==='network'));
  assert.ok(live.native.some(n=>n.diagnostics?.scope==='local-playback'&&n.diagnostics?.sourceEdgeTag));
  assert.ok(live.native.some(n=>n.diagnostics?.ingress?.screenAudioPackets>0));
  assert.ok(live.snapshot.media.localPlayback.some(t=>t.kind==='video'&&t.framesReceived>0&&t.keyFramesDecoded>0));
  result.nativeEvidence=live.native;result.playbackEvidence=live.snapshot.media.localPlayback;
  pass('原生对外入口、本机播放、共享声音及完整帧/关键帧实际进入监视窗口');
  await host.panel.locator('#record-toggle').click();await host.panel.waitForFunction(()=>document.querySelector('#record-info').textContent.includes('.zip'));
  const h=await contents(host),hostText=Object.values(h.files).map(strFromU8).join('\n');assert.ok(!hostText.includes(room));assert.ok(!hostText.includes(fixture.address));assert.ok(!hostText.includes('Diagnostic Motion Fixture'));
  const hs=strFromU8(h.files['samples.jsonl']).trim().split('\n').map(JSON.parse);
  assert.ok(hs.some(s=>s.renderer?.media?.actual?.width>1000));assert.ok(hs.some(s=>s.host.resources.nativeProcesses>=1));assert.ok(hs.some(s=>s.renderer?.peers?.length===1));assert.ok(hs.some(s=>s.renderer?.peers?.some(p=>p.sameAddressAsLocal===true)));pass('手动停止自动生成可解压 ZIP，包含真实媒体统计且无房号/IP/窗口标题');
  assert.ok(hs.some(s=>s.native?.some(n=>n.diagnostics?.scope==='network'&&n.diagnostics?.direction==='outbound'&&n.diagnostics?.queue?.sentPackets>0&&Number.isFinite(n.diagnostics?.rtcpRttMs))));
  const rowsBefore=hs.length;await host.page.waitForTimeout(3500);assert.equal(strFromU8((await contents(host)).files['samples.jsonl']).trim().split('\n').length,rowsBefore);pass('关闭记录开关后停止写入');
  const panelClosed=viewer.panel.waitForEvent('close');await viewer.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/diagnostics.html')).close());await panelClosed;await viewer.page.waitForFunction(()=>!document.querySelector('#diagnostic-window').textContent.includes('记录中'),{},{timeout:15000});const v=await contents(viewer);
  assert.equal(JSON.parse(strFromU8(v.files['summary.json'])).stopReason,'window-closed');assert.ok(strFromU8(v.files['events.jsonl']).includes('stutter'));
  const vs=strFromU8(v.files['samples.jsonl']).trim().split('\n').map(JSON.parse);const hostRoom=hs.find(s=>s.renderer?.roomTag)?.renderer.roomTag;assert.ok(vs.some(s=>s.renderer?.roomTag===hostRoom));pass('关闭诊断窗口自动保存，双方房间摘要可关联');
  const incoming=vs.flatMap(s=>s.native||[]).find(n=>n.diagnostics?.scope==='network'&&n.diagnostics?.direction==='inbound'&&n.diagnostics?.ingress?.readPackets>0);
  assert.ok(incoming);assert.ok(hs.some(s=>s.native?.some(n=>n.edgeTag===incoming.edgeTag&&n.diagnostics?.direction==='outbound')));
  const ve=strFromU8(v.files['events.jsonl']).trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.ok(ve.some(e=>e.type==='native-receiver-diagnostics'&&e.diagnostics?.ingress?.screenAudioPackets>0));
  const allText=Object.values(v.files).map(strFromU8).join(String.fromCharCode(10));assert.ok(!allText.includes(fixture.address));assert.ok(!allText.includes(room));
  pass('双方同一视频边摘要匹配；网络 RTT/队列与原生入口、共享声音独立写入 ZIP');
  await host.panel.locator('#record-toggle').click();await host.panel.waitForTimeout(3300);await host.app.close();host.closed=true;
  const q=await contents(host);assert.equal(JSON.parse(strFromU8(q.files['summary.json'])).stopReason,'application-quit');pass('退出程序自动完成诊断导出');
  result.exampleSummary=JSON.parse(strFromU8(v.files['summary.json']));result.hostZip=h.file;result.viewerZip=v.file;result.comparison=stutterCase||null;result.passed=true;
  assert.deepEqual(result.errors,[]);
}catch(e){result.passed=false;result.errors.push(e.stack);process.exitCode=1;console.error(e.stack);for(const c of clients)try{result.uiStatus=await c.page.locator('#status-message').innerText();}catch{}}
finally{for(const c of clients.reverse())if(!c.closed)await c.app.close().catch(()=>{});result.h264Buffer=process.env.FRIEND_TEST_LEGACY_H264_BUFFER==='1'?'legacy':'h26x';result.impairedLink=fixture.mediaEvidence();result.errors.push(...fixture.errors);if(fixture.errors.length){result.passed=false;process.exitCode=1;}await fixture.close();await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks,errors:result.errors,out}));}
