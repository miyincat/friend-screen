import {_electron as electron} from '@playwright/test';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {privateFixture} from './private-native-fixture.mjs';

const fixture=await privateFixture(process.cwd());
const soak=process.env.FRIEND_NATIVE_SOAK==='1',duration=soak?600:20;
const output=path.resolve(soak?'artifacts/private-native-soak-0.3.10':'artifacts/private-native-0.3.10');
await mkdir(output,{recursive:true});
const result={date:new Date().toISOString(),environment:'One Windows PC, four isolated Electron clients. Real native UDP bound to existing ZeroTier IPv4, native previews on the same local private address. Explicitly mocked enrollment. Synthetic video/audio. Not cross-network or physical microphone verification.',checks:[],errors:[],samples:[]};
if(soak)result.environment=result.environment.replace('four isolated','seven isolated');
const clients=[];
const pass=name=>{result.checks.push(name);console.log('PASS',name);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function instruments(){
  window.__speakers=[];window.__pcs=[];window.__rawTracks=[];window.__nativeEvents=[];window.__trees=[];
  const C=AudioContext;
  window.AudioContext=class extends C{
    createGain(){const g=super.createGain(),connect=g.connect.bind(g);g.connect=(node,...rest)=>{
      if(node===this.destination){const a=this.createAnalyser();a.fftSize=2048;connect(a);window.__speakers.push({gain:g,rms(){const v=new Float32Array(a.fftSize);a.getFloatTimeDomainData(v);return Math.sqrt(v.reduce((s,x)=>s+x*x,0)/v.length);}});}
      return connect(node,...rest);
    };return g;}
  };
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
    const c=new C(),o=c.createOscillator(),g=c.createGain(),d=c.createMediaStreamDestination();o.frequency.value=733;g.gain.value=0.05;o.connect(g);g.connect(d);o.start();await c.resume();
    const t=d.stream.getAudioTracks()[0],stop=t.stop.bind(t);t.stop=()=>{stop();o.stop();c.close();};window.__rawTracks.push(t);return d.stream;
  }});
  const PC=RTCPeerConnection;window.RTCPeerConnection=class extends PC{constructor(...a){super(...a);window.__pcs.push(this);}};
  const WS=WebSocket;window.WebSocket=class extends WS{constructor(...a){super(...a);this.addEventListener('message',e=>{try{const m=JSON.parse(e.data);if(m.type==='media-tree'){window.__trees.push(m);if(window.__trees.length>12)window.__trees.shift();}}catch{}});}};
  window.privateHouse.onNative(e=>{if(['edge-state','edge-quality','share-ended'].includes(e.type)){window.__nativeEvents.push(e);if(window.__nativeEvents.length>100)window.__nativeEvents.shift();}});
}
async function launch(label){
  const data=await mkdtemp(path.join(output,label+'-'));
  const app=await electron.launch({args:['test/private-media-shell.cjs'],cwd:process.cwd(),env:{...process.env,FRIEND_TEST_ORIGIN:await fixture.gateway(label),FRIEND_TEST_ADDRESS:fixture.address,FRIEND_TEST_DATA:data},timeout:30000});
  const client={app,data,label};clients.push(client);client.page=await app.firstWindow();const p=client.page;p.setDefaultTimeout(30000);p.on('pageerror',e=>result.errors.push(label+': '+e.message));
  await p.waitForFunction(()=>window.privateHouse&&window.friendProfile?.value.name);
  await p.addInitScript(instruments);await p.reload();await p.waitForFunction(()=>document.querySelector('#create-name')?.value);
  await p.locator('#profile-details summary').click();await p.locator('#profile-name').fill(label);await p.locator('#profile-form button').click();await p.waitForFunction(label=>window.friendProfile.value.name===label,label);await p.locator('#profile-details summary').click();return client;
}
async function create(c){await c.page.locator('#create-tab').click();await c.page.locator('#create-btn').click();await c.page.locator('#room-view').waitFor({state:'visible'});return c.page.locator('#room-code').innerText();}
async function join(c,room){await c.page.locator('#join-tab').click();await c.page.locator('#join-room').fill(room);await c.page.locator('#join-btn').click();await c.page.locator('#room-view').waitFor({state:'visible'});}
async function slider(p,selector,value){await p.locator(selector).evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));},value);await pause(400);}
async function rms(p){return p.evaluate(async()=>{await new Promise(r=>setTimeout(r,250));let v=0;for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,70));v+=Math.max(0,...window.__speakers.map(s=>s.rms()));}return v/8;});}
async function pattern(c){await c.app.evaluate(async({BrowserWindow})=>{
  const w=new BrowserWindow({width:1920,height:1080,useContentSize:true,frame:false,title:'FriendScreen AV Regression',show:true,webPreferences:{backgroundThrottling:false,sandbox:true}});globalThis.__fixture=w;
  await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><title>FriendScreen AV Regression</title><style>body{margin:0;background:#132a22;overflow:hidden}</style><canvas id="c" width="1920" height="1080"></canvas><script>const x=c.getContext("2d");function f(t){x.fillStyle="#132a22";x.fillRect(0,0,1920,1080);for(let i=0;i<35;i++){x.fillStyle=`hsl(${i*10},70%,60%)`;x.fillRect((t/3+i*80)%2000-80,100+i*24,150,18)}x.fillStyle="white";x.font="60px sans-serif";x.fillText("Native video + source audio",100,120);x.fillText(Math.floor(t),100,220);requestAnimationFrame(f)}requestAnimationFrame(f);window.audio=new AudioContext();const o=audio.createOscillator(),g=audio.createGain();o.frequency.value=440;g.gain.value=0.02;o.connect(g);g.connect(audio.destination);o.start();document.onclick=()=>audio.resume()</script>'));
});const f=(await c.app.windows()).find(p=>p!==c.page&&p.url().startsWith('data:'));await f.click('canvas');await f.waitForFunction(()=>audio.state==='running');}
async function share(c){await c.page.bringToFront();await c.page.locator('#share-btn').click();await c.page.locator('#native-source-dialog').waitFor({state:'visible'});await c.page.locator('.source-card').filter({hasText:'FriendScreen AV Regression'}).first().click();await c.page.locator('#native-audio').check();await c.page.locator('#native-source-dialog button[value="share"]').click();}
async function video(c){await c.page.waitForFunction(()=>{const v=document.querySelector('#stage-video');return !v.hidden&&v.videoWidth>1000&&v.currentTime>1;},{},{timeout:50000});}
async function sourceAudio(c){return c.page.evaluate(async()=>{
  const stream=document.querySelector('#stage-video').srcObject;if(!stream?.getAudioTracks().length)return 0;
  const ctx=new AudioContext();await ctx.resume();const source=ctx.createMediaStreamSource(stream),a=ctx.createAnalyser();a.fftSize=2048;source.connect(a);let max=0;
  for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,100));const v=new Float32Array(a.fftSize);a.getFloatTimeDomainData(v);max=Math.max(max,Math.sqrt(v.reduce((s,x)=>s+x*x,0)/v.length));}
  source.disconnect();await ctx.close();return max;
});}
try{
  const host=await launch('测试房主'),one=await launch('转发朋友'),two=await launch('直连朋友'),three=await launch('下游朋友');
  const extras=[];if(soak)for(let i=4;i<7;i++)extras.push(await launch('负载朋友'+i));
  // Profile persists across page reload without account/password.
  await host.page.reload();await host.page.waitForFunction(()=>document.querySelector('#create-name')?.value==='测试房主');pass('昵称持久保存，无账号登录');
  const invite=await create(host);for(const c of [one,two,three,...extras])await join(c,invite);pass((4+extras.length)+' 个独立客户端同房');
  for(const c of [one,two,three,...extras]){await c.page.waitForFunction(()=>document.querySelector('#mic-btn').getAttribute('aria-pressed')==='true');await c.page.locator('#mic-btn').click();}
  await host.page.waitForFunction(()=>document.querySelector('#mic-btn').getAttribute('aria-pressed')==='true');await one.page.waitForFunction(()=>window.__speakers.some(s=>s.rms()>0.008));
  const full=await rms(one.page);await slider(host.page,'#mic-volume',0);assert.ok(await rms(one.page)<0.001);
  await slider(host.page,'#mic-volume',100);const own100=await rms(one.page);await slider(host.page,'#mic-volume',200);const own200=await rms(one.page);assert.ok(own200>own100*1.5);
  await slider(host.page,'#mic-volume',100);const control=one.page.locator('.member').filter({hasText:'测试房主'});const range=control.locator('.volume-slider');
  await range.evaluate(e=>{e.value=0;e.dispatchEvent(new Event('input'));});await pause(500);assert.ok(await rms(one.page)<0.001);assert.ok(await rms(two.page)>0.008);
  await range.evaluate(e=>{e.value=100;e.dispatchEvent(new Event('input'));});await pause(500);const local100=await rms(one.page);
  await range.evaluate(e=>{e.value=200;e.dispatchEvent(new Event('input'));});await pause(500);const local200=await rms(one.page);assert.ok(local200>local100*1.5);
  await control.locator('.friend-mute').click();assert.ok(await rms(one.page)<0.001);assert.ok(await rms(two.page)>0.008);await control.locator('.friend-mute').click();
  await host.page.locator('#mic-btn').click();await pause(500);assert.ok(await rms(one.page)<0.001);assert.ok(await host.page.evaluate(()=>window.__rawTracks.every(t=>t.readyState==='ended')));
  result.microphoneRms={full,own100,own200,local100,local200};pass('合成麦克风、自己 0/100/200%、单独音量及静音真实生效；仅影响本机；闭麦释放音轨');
  for(const c of [one,two,three,...extras])await c.page.locator('#sound-btn').click();
  await pattern(host);await share(host);for(const c of [host,one,two,three,...extras])await video(c);
  await host.page.waitForFunction(()=>document.querySelector('#connection-diagnostics').textContent.includes('单路编码上限 3.0 Mbps'));
  pass('默认 8 Mbps 上传预算分给两路下游，每路编码上限 3 Mbps');
  const tree=await host.page.evaluate(()=>window.__trees.at(-1));assert.equal(tree.edges.length,3+extras.length);assert.ok(tree.edges.some(e=>tree.edges.some(p=>p.to===e.from)));pass('真实原生二层转发：分享者 → 第一位朋友 → 第三位朋友');
  result.sourceAudioRms=await sourceAudio(three);assert.ok(result.sourceAudioRms>0.0002);pass('合成进程声音经原生采集、转发与接收，音频波形非零');
  const executable=path.resolve('vendor/piik/piik-app.exe').replaceAll("'","''");
  const command=`$ids=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq '${executable}'} | ForEach-Object {$_.ProcessId}); @(Get-NetUDPEndpoint | Where-Object {$ids -contains $_.OwningProcess} | Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress`;
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000});
  result.nativeSockets=JSON.parse(stdout.trim());assert.ok(result.nativeSockets.length>=4);assert.ok(result.nativeSockets.every(s=>s.LocalAddress===fixture.address));pass('实际原生 UDP 套接字只绑定 ZeroTier IPv4，无通配或物理网卡监听');
  for(let i=0;i<duration;i++){if(i&&i%60===0)console.log('SOAK',i,'/',duration);result.samples.push(await three.page.evaluate(()=>({quality:document.querySelector('#metric-quality').textContent,rate:document.querySelector('#metric-bitrate').textContent,frames:document.querySelector('#stage-video').getVideoPlaybackQuality().totalVideoFrames})));await pause(1000);}
  assert.ok(result.samples.at(-1).frames-result.samples[0].frames>duration*35);pass((4+extras.length)+' 客户端原生视频持续 '+duration+' 秒；记录下游真实帧数与速率');
  await three.page.screenshot({path:path.join(output,'01-relayed-view.png')});
  await one.page.locator('#leave-btn').click();await video(three);await pause(2000);const before=await three.page.locator('#stage-video').evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames);await pause(3000);assert.ok(await three.page.locator('#stage-video').evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames)>before+50);pass('转发成员退出后下游重排，并继续解码画面');
  if(!soak){
    await host.page.evaluate(()=>window.__budgetPreview=document.querySelector('#stage-video').srcObject);
    await two.page.locator('#leave-btn').click();await host.page.waitForFunction(()=>document.querySelector('#connection-diagnostics').textContent.includes('单路编码上限 6.0 Mbps'));
    await video(three);await join(two,invite);await video(two);
    await host.page.waitForFunction(()=>document.querySelector('#connection-diagnostics').textContent.includes('单路编码上限 3.0 Mbps'));
    assert.ok(await host.page.evaluate(()=>window.__budgetPreview===document.querySelector('#stage-video').srcObject));
    pass('实际下游 2→1→2 时单路预算 3→6→3 Mbps，保持共享和本机播放流');
  }
  await host.page.locator('#share-btn').click();await three.page.waitForFunction(()=>document.querySelector('#stage-video').hidden);
  await pattern(two);await share(two);await video(host);await video(three);pass('普通成员接替共享，无需重新成为房主');
  await two.page.locator('#share-btn').click();await host.page.locator('#leave-btn').click();await three.page.locator('#setup-view').waitFor({state:'visible'});pass('房主离开结束房间');
  const second=await create(two);await join(host,second);pass('原观看者可独立创建新房间，原房主可加入');
  await two.page.locator('#leave-btn').click();await host.page.locator('#setup-view').waitFor({state:'visible'});
  assert.deepEqual(result.errors,[]);result.passed=true;
}catch(error){result.passed=false;result.errors.push(error.stack);process.exitCode=1;console.error(error.stack);
  for(const c of clients)try{result[c.label]=await c.page.evaluate(()=>({status:document.querySelector('#status-message').textContent,diagnostics:document.querySelector('#connection-diagnostics').textContent,events:window.__nativeEvents,trees:window.__trees,pcs:window.__pcs.map(p=>({state:p.connectionState,ice:p.iceConnectionState}))}));await c.page.screenshot({path:path.join(output,'failure-'+c.label+'.png')});}catch{}
}finally{for(const c of clients.reverse())await c.app.close().catch(()=>{});await fixture.close();await writeFile(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks,errors:result.errors,output}));}
