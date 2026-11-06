// Seven isolated browser profiles on ONE computer. Synthetic media, NOT cross-network acceptance.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {cpus} from 'node:os';
import {createApp,readConfig} from '../server.mjs';
const config=readConfig({PORT:'0',ACCOUNT_DATA_DIR:':memory:'});config.maxParticipants=8;
const server=createApp(config),base='http://127.0.0.1:'+await server.listen();
const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--mute-audio','--autoplay-policy=no-user-gesture-required']});
const output='artifacts/overlay-tests';await mkdir(output,{recursive:true});
const pages=[],errors=[],samples=[],cdp=await browser.newBrowserCDPSession();
function fixture(){
  window.__pcs=[];const PC=RTCPeerConnection;window.RTCPeerConnection=class extends PC{constructor(...args){super(...args);window.__pcs.push(this);}};
  const audio=()=>{const c=new AudioContext(),o=c.createOscillator(),g=c.createGain(),d=c.createMediaStreamDestination();g.gain.value=.01;o.connect(g);g.connect(d);o.start();c.resume();const t=d.stream.getAudioTracks()[0],stop=t.stop.bind(t);t.stop=()=>{o.stop();c.close();stop();};return t;};
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>new MediaStream([audio()])});
  Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{value:async()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');let n=0;const draw=()=>{x.fillStyle='#18372d';x.fillRect(0,0,1280,720);x.fillStyle='#9ee8c0';x.fillRect((n++*11)%1000,100,200,180);x.font='36px sans-serif';x.fillText('7 clients / synthetic 720p '+n,60,500);};draw();const timer=setInterval(draw,34),s=c.captureStream(30),t=s.getVideoTracks()[0],stop=t.stop.bind(t);t.stop=()=>{clearInterval(timer);stop();};s.addTrack(audio());return s;}});
}
try{
  let room;
  for(let i=0;i<7;i++){
    const context=await browser.newContext({viewport:{width:1280,height:960}});await context.addInitScript(fixture);const p=await context.newPage();p.setDefaultTimeout(25000);p.on('pageerror',e=>errors.push(e.message));p.on('crash',()=>errors.push('page crash'));pages.push(p);
    await p.goto(base+(room?'/#room='+room:'/'));const mode=i?'join':'create';await p.locator('#'+mode+'-name').fill('测试成员'+i);await p.locator('#'+mode+'-password').fill('mesh-soak-only');if(!i)await p.locator('#quality-select').selectOption('720p30');await p.locator('#'+mode+'-btn').click();await p.locator('#room-view').waitFor({state:'visible'});if(!i)room=await p.locator('#room-code').textContent();await p.locator('#mic-btn').click();await p.locator('#sound-btn').click();
  }
  await pages[0].locator('#share-btn').click();for(const p of pages.slice(1))await p.waitForFunction(()=>document.querySelector('#stage-video').videoWidth>0);
  for(const p of pages)await p.waitForFunction(()=>window.__pcs.filter(pc=>pc.connectionState==='connected').length===6);
  const started=Date.now();let lastTime=started,lastCpu=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((s,p)=>s+p.cpuTime,0);
  for(let i=0;i<60;i++){
    await new Promise(resolve=>setTimeout(resolve,10000));
    const now=Date.now(),cpu=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((s,p)=>s+p.cpuTime,0),clients=[];
    for(const p of pages)clients.push(await p.evaluate(async()=>{let bytes=0,decoded=0;for(const pc of window.__pcs){for(const s of (await pc.getStats()).values()){if(s.type==='outbound-rtp')bytes+=s.bytesSent||0;if(s.type==='inbound-rtp'&&s.kind==='video')decoded+=s.framesDecoded||0;}}return {connected:window.__pcs.filter(pc=>pc.connectionState==='connected').length,bytesSent:bytes,framesDecoded:decoded,videoWidth:document.querySelector('#stage-video').videoWidth};}));
    assert.ok(clients.every(c=>c.connected===6));assert.ok(clients.slice(1).every(c=>c.videoWidth>0));assert.deepEqual(errors,[]);
    samples.push({seconds:(now-started)/1000,cpuOneCorePercent:100*(cpu-lastCpu)/((now-lastTime)/1000),logicalCpus:cpus().length,clients});lastTime=now;lastCpu=cpu;
    if((i+1)%6===0)console.log('PASS local seven-client minute '+((i+1)/6));
  }
  await pages[1].screenshot({path:output+'/seven-client-loopback.png'});
  await writeFile(output+'/seven-client-loopback.json',JSON.stringify({passed:true,date:new Date().toISOString(),browser:browser.version(),durationSeconds:(Date.now()-started)/1000,environment:'One Windows computer, seven isolated Edge contexts, synthetic 720p30 canvas and oscillator audio, loopback WebRTC mesh; not ZeroTier or seven physical computers.',errors,samples},null,2));
}catch(e){await writeFile(output+'/seven-client-loopback-failure.json',JSON.stringify({passed:false,error:e.message,errors,samples},null,2));throw e;}
finally{await browser.close();await server.close();}
