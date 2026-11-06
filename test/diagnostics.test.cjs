const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {unzipSync,strFromU8}=require('fflate');
const {DiagnosticsRecorder,sanitizeSample,sanitizeEvent,sanitizeNativeSample,tag}=require('../desktop/diagnostics-recorder.cjs');
async function fixture(options={}){const desktop=await fs.mkdtemp(path.join(os.tmpdir(),'house-diagnostics-'));return{desktop,recorder:new DiagnosticsRecorder({desktop,version:'0.3.7',...options})};}
const payload={roomId:'FSR1-secret-room-code',selfId:'device-raw-identity',joined:true,role:'sharing',microphone:true,microphoneVolume:100,listening:true,target:{width:1920,height:1080,fps:60,bitrate:12000000},priority:'fixed',password:'secret-password',avatar:'secret-avatar',sdp:'secret-sdp',ip:'10.22.33.44',player:{width:1920,height:1080,currentTime:10,src:'secret-media-url'},peers:[{id:'friend-raw-identity',name:'secret-name',nodeId:'abcdef0123',state:'connected',pathReason:'overlay-udp',sameAddressAsLocal:true,privateVerified:true,localVolume:0,rtp:[{kind:'audio',direction:'inbound-rtp',packetsLost:3,bytesReceived:1000,codec:'audio/opus',address:'10.22.33.44'}]}],media:{own:true,codec:'h264',actual:{width:1920,height:1080,framesPerSecond:59.9},bitrate:8,capture:{kind:'window',title:'secret-title',sourceId:'secret-source'},paths:[{connectionId:'edge-raw-id',state:'connected',address:'10.22.33.44'}]}};
test('统计字段白名单与跨设备摘要，不保存敏感输入',()=>{
  const serialized=JSON.stringify(sanitizeSample(payload));
  for(const secret of ['secret-password','secret-name','secret-avatar','secret-sdp','secret-title','secret-media-url','10.22.33.44','device-raw-identity','edge-raw-id'])assert.ok(!serialized.includes(secret),secret);
  assert.equal(sanitizeSample(payload).selfTag,tag(payload.selfId,'device'));assert.equal(sanitizeSample(payload).peers[0].sameAddressAsLocal,true);assert.equal(sanitizeSample(payload).peers[0].pathReason,'overlay-udp');
  assert.equal(sanitizeSample({...payload,media:{actual:{framesPerSecond:NaN}}}).media.actual.framesPerSecond,null);
  assert.equal(sanitizeEvent({type:'native-share-ended',failureStage:'secret-key',hresult:'0x80004005',sdp:'secret'}).failureStage,null);
  assert.equal(sanitizeEvent({type:'arbitrary-user-message'}),null);
});
test('开关、逐条落盘、标记与 ZIP 内容完整；关闭后停止写入',async()=>{
  const {desktop,recorder:r}=await fixture();assert.deepEqual(await fs.readdir(desktop),[]);
  await r.start({deviceId:payload.selfId,environment:{platform:'win32',arch:'x64',release:'10.0.26200',username:'secret-user'}});
  r.recordSample(payload,{phase:'connected',network:{available:true,peers:[{nodeId:'abcdef0123',direct:true,latency:12,ip:'10.22.33.44'}]},resources:{nativeCpuPercent:12,nativeMemoryMiB:100}},0);
  r.recordEvent({type:'mark',mark:'stutter',text:'secret-password'});
  await r.queue;assert.equal((await fs.readFile(path.join(r.last.folder,'samples.jsonl'),'utf8')).trim().split('\n').length,1);
  const state=await r.stop();assert.equal(state.active,false);assert.ok(state.zip.startsWith(desktop));
  const files=unzipSync(await fs.readFile(state.zip));assert.ok(files['summary.json']);assert.ok(files['samples.jsonl']);assert.ok(files['events.jsonl']);assert.ok(files['概览.txt']);
  const all=Object.values(files).map(strFromU8).join('\n');for(const secret of ['secret-password','secret-user','secret-title','secret-name','10.22.33.44','FSR1-secret-room-code'])assert.ok(!all.includes(secret));
  const summary=JSON.parse(strFromU8(files['summary.json']));assert.equal(summary.samples,1);assert.equal(summary.eventCounts.mark,1);assert.equal(summary.fps.median,59.9);
  r.recordSample(payload,{},0);r.recordEvent({type:'mark',mark:'other'});await r.queue;assert.equal(r.samples,1);assert.equal(r.events,3);
  await r.stop();assert.equal(r.events,3);
});
test('关闭与开始并发时仍完成停止，不留下隐藏记录',async()=>{
  const {recorder:r}=await fixture();const start=r.start();const stop=r.stop('window-closed');await Promise.all([start,stop]);assert.equal(r.active,false);assert.ok(r.status().zip);
});
test('单次容量上限自动停止，导出原有数据且不递归',async()=>{
  const {recorder:r}=await fixture({maxBytes:1200});await r.start();
  for(let i=0;i<20;i++)r.recordSample(payload,{},0);
  await new Promise(resolve=>setTimeout(resolve,100));if(r.stopping)await r.stopping;
  assert.equal(r.active,false);assert.ok(r.bytes<=1200);assert.ok(r.status().zip);
  const z=unzipSync(await fs.readFile(r.last.zip));assert.equal(JSON.parse(strFromU8(z['summary.json'])).stopReason,'limit');
});
test('异常退出后可以打包已落盘的上次记录，不自动恢复录制',async()=>{
  const {desktop,recorder:r}=await fixture();await r.start();r.recordSample(payload,{},0);await r.queue;
  const next=new DiagnosticsRecorder({desktop,version:'0.3.7'});const state=await next.exportLast();assert.equal(next.active,false);assert.ok(state.zip);
  const z=unzipSync(await fs.readFile(state.zip));assert.ok(z['samples.jsonl']);assert.ok(!z['summary.json']);
});
test('桌面不可写明确报错，拒绝上次记录的路径越界',async()=>{
  const {desktop}=await fixture();const bad=path.join(desktop,'not-a-folder');await fs.writeFile(bad,'test');
  const r=new DiagnosticsRecorder({desktop:bad,version:'0.3.7'});const status=await r.start();assert.equal(status.active,false);assert.match(status.error,/无法创建/);
  const safe=new DiagnosticsRecorder({desktop,version:'0.3.7'});await fs.mkdir(safe.base);await fs.writeFile(path.join(safe.base,'latest.json'),JSON.stringify({name:'../../secret'}));assert.equal((await safe.exportLast()).zip,null);
});

const nativeEvent={type:'native-receiver-diagnostics',connectionId:'private-edge-secret',shareId:'private-share-secret',ageMs:5,diagnostics:{schema:1,sampleTimestampMs:123456,direction:'inbound',scope:'network',state:'connected',sourceConnectionId:'upstream-secret',iceRttMs:28,rtcpRttMs:null,rtp:{packets:100,packetsLost:2,packetsOutOfOrder:3,nackRequests:9,address:'10.22.33.44'},ingress:{readPackets:102,rtxPackets:4,screenAudioPackets:50,lastVideoPacketAgeMs:1,token:'secret-token'},queue:null,sdp:'secret-sdp'}};
test('原生视频计数进入事件和采样 ZIP，分清共享声音、缺失值与隐私',async()=>{
  const clean=sanitizeNativeSample(nativeEvent);
  assert.equal(clean.diagnostics.rtp.packetsLost,2);assert.equal(clean.diagnostics.ingress.screenAudioPackets,50);assert.equal(clean.diagnostics.queue,null);assert.equal(clean.diagnostics.rtcpRttMs,null);
  assert.equal(clean.diagnostics.sourceEdgeTag,tag('upstream-secret','edge'));
  assert.equal(sanitizeNativeSample({...nativeEvent,diagnostics:{schema:99}}).diagnostics,null);
  const {recorder:r}=await fixture();await r.start();r.recordSample(payload,{},0,[nativeEvent]);r.recordEvent(nativeEvent);r.recordEvent({type:'mark',mark:'video-stutter-audio-ok'});const state=await r.stop();
  const files=unzipSync(await fs.readFile(state.zip)),sample=JSON.parse(strFromU8(files['samples.jsonl']).trim());
  assert.equal(sample.native[0].edgeTag,tag('private-edge-secret','edge'));assert.equal(sample.native[0].diagnostics.ingress.rtxPackets,4);
  assert.equal(JSON.parse(strFromU8(files['session.json'])).schema,'friendscreen-diagnostics-v2');
  const all=Object.values(files).map(strFromU8).join('');for(const secret of ['private-edge-secret','private-share-secret','upstream-secret','secret-token','secret-sdp','10.22.33.44'])assert.ok(!all.includes(secret),secret);
  assert.ok(all.includes('video-stutter-audio-ok'));
});

test('原生统计只在观察时保留，关闭链路和引擎退出清理旧样本',()=>{
  const {DiagnosticsController}=require('../desktop/diagnostics.cjs');
  const c=Object.create(DiagnosticsController.prototype);c.nativeStats=new Map();let active=false;c.collecting=()=>active;c.event=()=>{};
  const event={...nativeEvent,type:'receiver-diagnostics'};
  c.native(event);assert.equal(c.nativeStats.size,0);active=true;c.native(event);assert.equal(c.nativeRecords().length,1);
  c.native({type:'edge-state',connectionId:event.connectionId,state:'closed'});assert.equal(c.nativeRecords().length,0);
  c.native(event);c.nativeStats.get(event.connectionId).receivedAt-=11000;assert.equal(c.nativeRecords().length,0);
  c.native(event);c.native({type:'share-ended',shareId:event.shareId});assert.equal(c.nativeRecords().length,0);
  c.native(event);active=false;c.native({type:'engine-disconnected'});assert.equal(c.nativeRecords().length,0);
});

test('浏览器完整帧、关键帧、重传和共享音频统计保留独立流标识',async()=>{
  const {diagnosticRtp}=await import('../public/diagnostic-telemetry.js');
  const raw=diagnosticRtp(new Map([['v',{id:'video-secret',type:'inbound-rtp',kind:'video',timestamp:123,framesReceived:12,framesDecoded:8,keyFramesDecoded:2,retransmittedPacketsReceived:4,totalAssemblyTime:.05}],['a',{id:'audio-secret',type:'inbound-rtp',kind:'audio',packetsReceived:100,concealedSamples:2}]]));
  const s=sanitizeSample({media:{playback:raw}}).media.localPlayback;
  assert.equal(s[0].framesReceived,12);assert.equal(s[0].framesDecoded,8);assert.equal(s[0].retransmittedPacketsReceived,4);assert.equal(s[1].packetsReceived,100);assert.equal(s[1].framesReceived,null);assert.notEqual(s[0].streamTag,s[1].streamTag);
});
