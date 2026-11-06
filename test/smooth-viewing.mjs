import {_electron as electron} from '@playwright/test';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {privateFixture} from './private-native-fixture.mjs';

const root=process.cwd(),out=path.join(root,'artifacts/smooth-viewing-0.3.10');
await mkdir(out,{recursive:true});
const fixture=await privateFixture(root,{impairedMedia:true}),clients=[];
const result={date:new Date().toISOString(),checks:[],errors:[],phases:[],limits:'One Windows PC; two isolated Electron clients; mocked enrollment, real native H.264 and shared audio, synthetic window/microphone. Controlled encrypted UDP loss/reordering is not campus-network validation. Receiver buffer targets are not end-to-end delay measurements.'};
const pass=s=>{result.checks.push(s);console.log('PASS',s);};
async function launch(label){
  const data=await mkdtemp(path.join(out,label+'-'));
  const app=await electron.launch({args:['test/private-media-shell.cjs'],cwd:root,env:{...process.env,FRIEND_TEST_ORIGIN:await fixture.gateway(label),FRIEND_TEST_ADDRESS:fixture.address,FRIEND_TEST_DATA:data},timeout:30000});
  const c={app};clients.push(c);c.page=await app.firstWindow();c.page.setDefaultTimeout(30000);c.page.on('pageerror',e=>result.errors.push(e.message));
  await c.page.waitForFunction(()=>window.friendProfile?.value.name);
  await c.page.addInitScript(()=>{
    window.__pcs=[];const PC=RTCPeerConnection;window.RTCPeerConnection=class extends PC{constructor(...args){super(...args);window.__pcs.push(this);}};
    const C=AudioContext;Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{const a=new C(),o=a.createOscillator(),g=a.createGain(),d=a.createMediaStreamDestination();g.gain.value=.01;o.connect(g);g.connect(d);o.start();await a.resume();const t=d.stream.getAudioTracks()[0],stop=t.stop.bind(t);t.stop=()=>{stop();o.stop();a.close();};return d.stream;}});
  });
  await c.page.reload();await c.page.waitForFunction(()=>window.friendProfile?.value.name);return c;
}
async function read(c){return c.page.evaluate(async()=>{
  const v=document.querySelector('#stage-video'),track=v.srcObject?.getVideoTracks()[0],pc=window.__pcs.find(p=>p.connectionState==='connected'&&p.getReceivers().some(r=>r.track===track));
  const reports=pc?await pc.getStats():new Map(),stats=[...reports.values()].filter(r=>r.type==='inbound-rtp').map(r=>({kind:r.kind,timestamp:r.timestamp,framesDecoded:r.framesDecoded,frameWidth:r.frameWidth,frameHeight:r.frameHeight,bytesReceived:r.bytesReceived,freezeCount:r.freezeCount,totalFreezesDuration:r.totalFreezesDuration,jitterBufferDelay:r.jitterBufferDelay,jitterBufferTargetDelay:r.jitterBufferTargetDelay,jitterBufferEmittedCount:r.jitterBufferEmittedCount}));
  return {time:performance.now(),width:v.videoWidth,height:v.videoHeight,stats,targets:pc?.getReceivers().map(r=>({kind:r.track.kind,target:r.jitterBufferTarget})),voiceTargets:window.__pcs.filter(p=>p.connectionState==='connected'&&p!==pc).flatMap(p=>p.getReceivers().filter(r=>r.track?.kind==='audio').map(r=>r.jitterBufferTarget)),diagnostics:document.querySelector('#connection-diagnostics').textContent};
});}
async function setPlayback(page, mode) {
  await page.locator('#share-settings-btn').click();
  await page.locator('#playback-mode').selectOption(mode);
  await page.getByRole('button', {name:'关闭分享设置'}).click();
}
try{
  const host=await launch('host'),viewer=await launch('viewer');
  await host.page.locator('#create-btn').click();await host.page.locator('#room-view').waitFor({state:'visible'});
  const room=await host.page.locator('#room-code').innerText();await viewer.page.locator('#join-tab').click();await viewer.page.locator('#join-room').fill(room);await viewer.page.locator('#join-btn').click();await viewer.page.locator('#room-view').waitFor({state:'visible'});
  await viewer.page.waitForFunction(()=>document.querySelector('#mic-btn').getAttribute('aria-pressed')==='true');
  await viewer.page.locator('#mic-btn').click();
  await viewer.page.waitForFunction(()=>window.__pcs.some(p=>p.connectionState==='connected'&&p.getReceivers().some(r=>r.track?.kind==='audio')));
  await host.app.evaluate(async({BrowserWindow})=>{
    const w=new BrowserWindow({width:1920,height:1080,useContentSize:true,frame:false,title:'Smooth Viewing Fixture',webPreferences:{sandbox:true,backgroundThrottling:false}});globalThis.smoothFixture=w;
    await w.loadURL('data:text/html,'+encodeURIComponent('<title>Smooth Viewing Fixture</title><style>body{margin:0;overflow:hidden}</style><canvas id="c" width="1920" height="1080"></canvas><script>const x=c.getContext("2d");function f(t){x.fillStyle="#153b30";x.fillRect(0,0,1920,1080);for(let i=0;i<28;i++){x.fillStyle=`hsl(${i*12},70%,60%)`;x.fillRect((t/3+i*83)%2000-80,200+i*26,160,18)}x.fillStyle="white";x.font="50px sans-serif";x.fillText("6 Mbps private room / "+Math.floor(t),100,100);requestAnimationFrame(f)}requestAnimationFrame(f);const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();g.gain.value=.01;o.connect(g);g.connect(a.destination);o.start();document.onclick=()=>a.resume()</script>'));
  });
  const pattern=(await host.app.windows()).find(p=>p.url().startsWith('data:'));await pattern.click('canvas');
  await host.page.bringToFront();await host.page.locator('#share-btn').click();await host.page.locator('#native-source-dialog').waitFor({state:'visible'});await host.page.locator('.source-card').filter({hasText:'Smooth Viewing Fixture'}).click();await host.page.locator('#native-audio').check();await host.page.locator('#native-source-dialog button[value="share"]').click();
  await viewer.page.waitForFunction(()=>document.querySelector('#stage-video').videoWidth>1800,{},{timeout:50000});
  await viewer.page.evaluate(()=>{window.__originalVideo=document.querySelector('#stage-video');window.__originalStream=window.__originalVideo.srcObject;});
  for(const mode of ['realtime','smooth','realtime']){
    await setPlayback(viewer.page,mode);await viewer.page.waitForTimeout(5000);
    const start=await read(viewer);await viewer.page.waitForTimeout(12000);const end=await read(viewer);
    const a=start.stats.find(r=>r.kind==='video'),b=end.stats.find(r=>r.kind==='video'),seconds=(b.timestamp-a.timestamp)/1000;
    const phase={mode,start,end,fps:(b.framesDecoded-a.framesDecoded)/seconds,mbps:(b.bytesReceived-a.bytesReceived)*8/seconds/1e6,averageBufferMs:(b.jitterBufferDelay-a.jitterBufferDelay)/(b.jitterBufferEmittedCount-a.jitterBufferEmittedCount)*1000,averageTargetMs:(b.jitterBufferTargetDelay-a.jitterBufferTargetDelay)/(b.jitterBufferEmittedCount-a.jitterBufferEmittedCount)*1000};
    result.phases.push(phase);assert.ok(end.width>=1900);assert.ok(end.height>=1070);assert.ok(phase.fps>40,JSON.stringify(phase));
    assert.ok(end.targets.some(r=>r.kind==='audio'));assert.ok(end.targets.every(r=>r.target===(mode==='smooth'?600:null)));
    assert.ok(end.voiceTargets.length>0);assert.ok(end.voiceTargets.every(t=>t===null));
    assert.ok(await viewer.page.evaluate(()=>window.__originalVideo===document.querySelector('#stage-video')&&window.__originalStream===window.__originalVideo.srcObject));
    pass(mode+': full-size native video keeps decoding; shared audio uses same buffer target, voice stays automatic, playback stream preserved');
  }
  const smooth=result.phases[1],realtime=result.phases[0];assert.ok(smooth.averageTargetMs>realtime.averageTargetMs+250);assert.ok((await read(host)).targets.every(r=>r.target===null));
  pass('receiver statistics confirm added buffering; source preview stays automatic');
  await setPlayback(viewer.page,'smooth');await viewer.page.screenshot({path:path.join(out,'smooth-view.png'),fullPage:true});
  assert.deepEqual(result.errors,[]);result.passed=true;
}catch(e){result.passed=false;result.errors.push(e.stack);process.exitCode=1;console.error(e.stack);for(const c of clients)try{result.failure=await read(c);}catch{}}
finally{for(const c of clients.reverse())await c.app.close().catch(()=>{});result.impairedLink=fixture.mediaEvidence();result.errors.push(...fixture.errors);if(fixture.errors.length){result.passed=false;process.exitCode=1;}await fixture.close();await writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:result.checks,errors:result.errors,out}));}
