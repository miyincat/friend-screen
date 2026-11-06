'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomBytes}=require('node:crypto');
const {zip}=require('fflate');

const STATES=['new','connecting','connected','completed','disconnected','failed','closed','stable','have-local-offer','have-remote-offer','gathering','complete','checking','unknown'];
const TYPES=['recording-started','recording-stopped','mark','room-joined','room-closed','room-left','peer-joined','peer-left','presenter','socket-close','microphone-error','microphone-ended','signal-error','renderer-gone','renderer-error','page-navigation','native-command-failed','native-start-share','native-stop-share','native-update-share','native-edge-state','native-edge-path','native-edge-quality','native-share-ended','native-engine-disconnected'];
const RTP_FIELDS=['bytesSent','bytesReceived','packetsSent','packetsReceived','packetsLost','jitter','roundTripTime','fractionLost','audioLevel','totalAudioEnergy','concealedSamples','totalSamplesReceived','concealmentEvents','framesDecoded','framesDropped','framesEncoded','framesPerSecond','frameWidth','frameHeight','freezeCount','totalFreezesDuration','jitterBufferDelay','jitterBufferEmittedCount','totalDecodeTime','totalEncodeTime','nackCount','pliCount','firCount'];
const NUMERIC_EVENT_FIELDS=['width','height','framesPerSecond','bitrateKbps','availableOutgoingKbps','sampleTimestampMs','sampleWindowMs','intervalFramesEncoded','exitCode','closeCode'];
TYPES.push('native-receiver-diagnostics');
RTP_FIELDS.push('timestamp','framesReceived','keyFramesDecoded','packetsDiscarded','retransmittedPacketsReceived','retransmittedBytesReceived','totalAssemblyTime','framesAssembledFromMultiplePackets','totalProcessingDelay','jitterBufferTargetDelay','jitterBufferMinimumDelay','lastPacketReceivedTimestamp','pauseCount','totalPausesDuration');
const NATIVE_RTP_FIELDS=['startedAtMs','packets','bytes','headerBytes','packetsLost','packetsDuplicate','bytesDuplicate','packetsPadding','packetsOutOfOrder','markerFrames','jitterMs','jitterMaxMs','nackRequests','nackAcks','nackMisses','nackRepeated','pliRequests','firRequests','keyFramesObserved'];
const NATIVE_QUEUE_FIELDS=['sentPackets','sentRtpBytes','discardedPackets','overflowDrops','cancelledProbePackets','writeErrors','pendingPackets','pendingRtpBytes','oldestQueuedMs','maxQueueResidenceMs','totalQueueResidenceMs','dequeuedPackets'];
const NATIVE_INGRESS_FIELDS=['readPackets','readPayloadBytes','rtxPackets','rtxPayloadBytes','forwardErrors','nackMessagesSent','nackWriteErrors','pliMessagesSent','pliWriteErrors','lastVideoPacketAgeMs','screenAudioPackets','screenAudioPayloadBytes','screenAudioForwardErrors','lastScreenAudioPacketAgeMs'];
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=-1e6&&v<=1e15?v:null;
const choice=(v,allowed)=>allowed.includes(v)?v:null;
const bool=v=>typeof v==='boolean'?v:null;
const fields=(value,names)=>Object.fromEntries(names.map(key=>[key,number(value?.[key])]));
const tag=(value,prefix='id')=>typeof value==='string'&&value.length>0&&value.length<2048?prefix+'-'+createHash('sha256').update('friendscreen-diagnostics-v1:'+value).digest('hex').slice(0,12):null;
function rtp(value){
  return {...fields(value,RTP_FIELDS),streamTag:tag(value?.id,'rtp'),direction:choice(value?.direction,['inbound-rtp','outbound-rtp','remote-inbound-rtp']),kind:choice(value?.kind,['audio','video']),codec:choice(value?.codec,['audio/opus','video/H264','video/VP8','video/VP9','video/AV1'])};
}
function sanitizeNative(value){
  if(!value||value.schema!==1)return null;
  return {...fields(value,['schema','sampleTimestampMs','iceRttMs','rtcpRttMs','rtcpFeedbackAgeMs']),
    direction:choice(value.direction,['inbound','outbound']),scope:choice(value.scope,['network','local-playback']),state:choice(value.state,STATES),sourceEdgeTag:tag(value.sourceConnectionId,'edge'),
    rtp:value.rtp?fields(value.rtp,NATIVE_RTP_FIELDS):null,queue:value.queue?{...fields(value.queue,NATIVE_QUEUE_FIELDS),pacing:choice(value.queue.pacing,['network-paced','local-direct'])}:null,ingress:value.ingress?fields(value.ingress,NATIVE_INGRESS_FIELDS):null};
}
function sanitizeNativeSample(value){return{edgeTag:tag(value.connectionId,'edge'),shareTag:tag(value.shareId,'share'),ageMs:number(value.ageMs),diagnostics:sanitizeNative(value.diagnostics)};}
function sanitizeSample(value={}){
  return {
    roomTag:tag(value.roomId,'room'),selfTag:tag(value.selfId,'device'),
    joined:bool(value.joined),role:choice(value.role,['idle','sharing','viewing','waiting']),
    microphone:bool(value.microphone),listening:bool(value.listening),microphoneVolume:number(value.microphoneVolume),
    audioContext:choice(value.audioContext,['running','suspended','interrupted','closed']),visibility:choice(value.visibility,['visible','hidden']),
    player:{...fields(value.player,['readyState','width','height','currentTime','playbackRate']),paused:bool(value.player?.paused),muted:bool(value.player?.muted),hidden:bool(value.player?.hidden)},
    target:fields(value.target,['width','height','fps','bitrate']),priority:choice(value.priority,['fixed','motion','detail']),
    peers:(Array.isArray(value.peers)?value.peers:[]).slice(0,8).map(p=>({
      deviceTag:tag(p.id,'device'),nodeTag:tag(p.nodeId,'node'),state:choice(p.state,STATES),ice:choice(p.ice,STATES),signaling:choice(p.signaling,STATES),
      privateVerified:bool(p.privateVerified),pathTransitions:number(p.pathTransitions),mic:bool(p.mic),localVolume:number(p.localVolume),
      sameAddressAsLocal:bool(p.sameAddressAsLocal),pathReason:choice(p.pathReason,['pair-not-ready','candidate-stats-missing','candidate-fields-missing','multiple-selected-pairs','live-path-not-ready','live-path-unavailable','live-path-ambiguous','overlay-udp','live-transport-missing','live-api-incomplete','live-api-unavailable','live-transport-not-ready','live-pair-not-ready','connection-recovering','stats-unavailable','address-mismatch','non-udp','non-overlay-candidate-type','invalid-overlay-address']),
      txMbps:number(p.txMbps),rxMbps:number(p.rxMbps),voiceRttMs:number(p.rttMs),voiceAvailableOutgoingBps:number(p.availableOutgoingBps),
      iceCounters:fields(p.iceCounters,['localSeen','localSent','localRejected','remoteSeen','remoteAllowed','remoteRejected','remoteApplied','localDescriptionsSent','remoteDescriptionsReceived']),
      rtp:(Array.isArray(p.rtp)?p.rtp:[]).slice(0,10).map(rtp),
    })),
    media:value.media?{
      shareTag:tag(value.media.shareId,'share'),own:bool(value.media.own),codec:choice(value.media.codec,['h264','vp8']),previewState:choice(value.media.previewState,STATES),
      children:number(value.media.children),parentTag:tag(value.media.parent,'device'),mbps:number(value.media.bitrate),playbackMode:choice(value.media.playbackMode,['smooth','realtime']),playbackTargetMs:number(value.media.playbackTargetMs),playbackSupported:bool(value.media.playbackSupported),uploadBudget:number(value.media.uploadBudget),videoCeiling:number(value.media.videoCeiling),
      actual:fields(value.media.actual,['width','height','framesPerSecond']),localPlayback:(Array.isArray(value.media.playback)?value.media.playback:[]).slice(0,4).map(rtp),
      paths:(Array.isArray(value.media.paths)?value.media.paths:[]).slice(0,4).map(p=>({edgeTag:tag(p.connectionId,'edge'),fromTag:tag(p.from,'device'),toTag:tag(p.to,'device'),state:choice(p.state,STATES)})),
      capture:{kind:choice(value.media.capture?.kind,['display','window','picker']),codec:choice(value.media.capture?.codec,['h264','vp8']),adapterIndex:number(value.media.capture?.adapterIndex),encoderIndex:number(value.media.capture?.encoderIndex),audio:bool(value.media.capture?.audio)},
    }:null,
  };
}
function sanitizeEvent(value={}){
  if(!TYPES.includes(value.type))return null;
  return {type:value.type,peerTag:tag(value.peerId,'device'),edgeTag:tag(value.connectionId,'edge'),shareTag:tag(value.shareId,'share'),
    state:choice(value.state,STATES.concat(['healthy','degraded'])),reason:choice(value.reason,['none','bandwidth','cpu','other']),
    mark:choice(value.mark,['blur','stutter','video-stutter-audio-ok','no-video','no-audio','disconnected','other']),
    code:choice(value.code,['RATE_LIMIT','BAD_SIGNAL','NOT_JOINED','ROOM_FULL','UPGRADE_REQUIRED','HOST_UNREACHABLE','JOIN_DENIED','PRESENTER_BUSY','INTERNAL','NOT_PRESENTER','STALE_MEDIA_ROUTE','NotAllowedError','NotFoundError','NotReadableError','AbortError']),
    operation:choice(value.operation,['start-share','stop-share','update-share','prepare-edge','prepare-local-edge','receive-offer','receive-candidate','edge-answer','edge-candidate','list-sources','capture-options']),
    localType:choice(value.localType,['host','prflx','srflx','relay']),remoteType:choice(value.remoteType,['host','prflx','srflx','relay']),
    failed:bool(value.failed),...fields(value,NUMERIC_EVENT_FIELDS),diagnostics:sanitizeNative(value.diagnostics),
    failureStage:choice(value.failureStage,['windows-runtime','unclassified','h264-decoder-create','input-texture-create','codec-probe-timeout','argument-profile','capture-start','capture-frame','d3d-device-create','encoder-create']),
    hresult:typeof value.hresult==='string'&&/^0x[0-9a-f]{8}$/i.test(value.hresult)?value.hresult:null,
  };
}
function sanitizeHost(value={}){
  return {phase:choice(value.phase,['setup','waiting','connected','error']),nativeRunning:bool(value.nativeRunning),
    resources:fields(value.resources,['systemCpuPercent','systemFreeMemoryMiB','electronCpuPercent','nativeCpuPercent','electronMemoryMiB','nativeMemoryMiB','nativeProcesses','logicalProcessors']),
    network:{available:bool(value.network?.available),tcpFallback:bool(value.network?.tcpFallback),peers:(Array.isArray(value.network?.peers)?value.network.peers:[]).slice(0,40).map(p=>({nodeTag:tag(p.nodeId,'node'),direct:bool(p.direct),latencyMs:number(p.latency)}))}};
}
const NOTES='数据来源说明：native[] 与原生事件 diagnostics 按 scope 区分 network（对外视频）和 local-playback（本机播放），按 direction 区分收发；sourceEdgeTag 关联本机播放的上游边。rtp 为 LiveKit 累计计数，markerFrames 不是完整解码帧；packetsLost 可因迟到/修复下降；nackRequests 是请求包计数，nackAcks 是发送端缓存命中，不证明远端收到；ingress.nackMessagesSent 是反馈报文数，不能混算。queue 为本地视频发送队列；overflowDrops 为入队满丢弃，discardedPackets 还包含取消探测和关闭。RTCP RTT 与 ICE 探测 RTT 分开，缺失为 null。peers.rtp/voiceRttMs 是独立麦克风语音；media.localPlayback 的 audio 是共享声音，video 的 framesReceived/framesDecoded/关键帧/冻结用于完整帧恢复对照。screenAudioPackets 是原生共享声音入口，收到包不证明听到声音。原生输出预算不是网速测试。ZeroTier DIRECT 仅表示采样时的直连证据。摘要 FPS 混合角色，只供概览；定位需按 shareTag/edgeTag/streamTag/startedAtMs 分段并检查 ageMs。缺失/过期不能当作零。不保存昵称头像、真实 IP、完整房号、SDP、邀请码、口令、密钥、窗口标题或音视频内容。';
const zipBuffer=files=>new Promise((resolve,reject)=>zip(files,{level:3},(err,result)=>err?reject(err):resolve(Buffer.from(result))));
class DiagnosticsRecorder{
  constructor({desktop,version,onChange=()=>{},maxBytes=20*1024*1024,maxDurationMs=2*60*60*1000}){
    Object.assign(this,{desktop,version,onChange,maxBytes,maxDurationMs});this.base=path.join(desktop,'同屏小屋诊断');this.queue=Promise.resolve();this.active=false;this.busy=false;this.samples=0;this.events=0;this.bytes=0;this.dropped=0;this.error=null;this.last=null;this.fps=[];this.counts={};this.stopReason=null;
  }
  status(){return{active:this.active,busy:this.busy,startedAt:this.startedAt||null,samples:this.samples,events:this.events,bytes:this.bytes,dropped:this.dropped,error:this.error,folder:this.last?.folder||null,zip:this.last?.zip||null,deviceTag:this.deviceTag||null};}
  start(input={}){
    if(this.active||this.busy)return Promise.resolve(this.status());
    this.starting=this.begin(input).finally(()=>{this.starting=null;});return this.starting;
  }
  async begin({deviceId,environment={}}={}){
    if(this.active||this.busy)return this.status();
    this.busy=true;this.error=null;this.onChange();
    try{
      const now=new Date(),name=now.toISOString().replace(/[:.]/g,'-')+'_'+randomBytes(3).toString('hex');
      const folder=path.join(this.base,name);await fs.mkdir(folder,{recursive:true});
      this.last={folder,zip:null};this.startedAt=Date.now();this.deviceTag=tag(deviceId,'device');this.samples=0;this.events=0;this.bytes=0;this.dropped=0;this.fps=[];this.counts={};this.queue=Promise.resolve();this.stopReason=null;this.pending=0;
      const header={schema:'friendscreen-diagnostics-v2',version:this.version,startedAt:new Date(this.startedAt).toISOString(),deviceTag:this.deviceTag,environment:{platform:choice(environment.platform,['win32']),arch:choice(environment.arch,['x64','arm64']),release:typeof environment.release==='string'&&/^[0-9.]+$/.test(environment.release)?environment.release:null,logicalProcessors:number(environment.logicalProcessors),memoryGiB:number(environment.memoryGiB)},sampleIntervalMs:3000,notes:NOTES};
      await fs.writeFile(path.join(folder,'session.json'),JSON.stringify(header,null,2));
      await fs.writeFile(path.join(folder,'samples.jsonl'),'');await fs.writeFile(path.join(folder,'events.jsonl'),'');
      await fs.writeFile(path.join(folder,'说明.txt'),NOTES+'\n请发送本机与朋友同一次测试的诊断 ZIP；同时说明各文件属于谁。');
      await fs.writeFile(path.join(this.base,'latest.json'),JSON.stringify({name}));
      this.active=true;this.recordEvent({type:'recording-started'});
    }catch{this.error='无法创建桌面诊断文件，请检查桌面权限和剩余空间。';}
    finally{this.busy=false;this.onChange();}
    return this.status();
  }
  append(file,value){
    if(!this.active)return false;
    if(Date.now()-this.startedAt>=this.maxDurationMs||this.bytes>=this.maxBytes){void this.stop('limit');return false;}
    if(this.pending>=64){this.dropped++;return false;}
    const line=JSON.stringify({utc:new Date().toISOString(),elapsedMs:Date.now()-this.startedAt,...value})+'\n';
    const length=Buffer.byteLength(line);if(this.bytes+length>this.maxBytes){void this.stop('limit');return false;}
    this.bytes+=length;this.pending++;const folder=this.last.folder;
    this.queue=this.queue.then(()=>fs.appendFile(path.join(folder,file),line)).catch(()=>{this.active=false;this.error='诊断写入失败；已保存的部分仍保留在桌面。';this.onChange();}).finally(()=>{this.pending--;});
    return true;
  }
  recordSample(renderer,host,ageMs,native=[]){
    const sample={renderer:renderer?sanitizeSample(renderer):null,host:sanitizeHost(host),rendererAgeMs:number(ageMs),native:(Array.isArray(native)?native:[]).slice(0,16).map(sanitizeNativeSample)};
    if(this.append('samples.jsonl',sample)){this.samples++;const fps=sample.renderer?.media?.actual?.framesPerSecond;if(fps!==null&&fps!==undefined)this.fps.push(fps);}
  }
  recordEvent(value){
    const event=sanitizeEvent(value);if(!event)return;
    if(this.append('events.jsonl',event)){this.events++;this.counts[event.type]=(this.counts[event.type]||0)+1;}
  }
  async stop(reason='user'){
    if(this.starting)await this.starting;
    if(this.stopping)return this.stopping;
    if(!this.active)return this.status();
    this.stopping=Promise.resolve().then(()=>this.finish(reason)).finally(()=>{this.stopping=null;});return this.stopping;
  }
  async finish(reason){
    this.recordEvent({type:'recording-stopped'});this.active=false;this.busy=true;this.stopReason=reason;this.onChange();
    try{
      await this.queue;
      const sorted=this.fps.filter(Number.isFinite).sort((a,b)=>a-b);
      const summary={schema:'friendscreen-diagnostics-v2',version:this.version,startedAt:new Date(this.startedAt).toISOString(),endedAt:new Date().toISOString(),durationSeconds:(Date.now()-this.startedAt)/1000,deviceTag:this.deviceTag,samples:this.samples,events:this.events,dropped:this.dropped,stopReason:reason,eventCounts:this.counts,fps:sorted.length?{min:sorted[0],median:sorted[Math.floor(sorted.length/2)],max:sorted.at(-1)}:null,notes:NOTES};
      await fs.writeFile(path.join(this.last.folder,'summary.json'),JSON.stringify(summary,null,2));
      await fs.writeFile(path.join(this.last.folder,'概览.txt'),`同屏小屋 ${this.version} 诊断记录\n设备标识：${this.deviceTag||'尚未入网'}\n开始：${summary.startedAt}\n结束：${summary.endedAt}\n采样 ${this.samples} 次，事件 ${this.events} 条，丢弃 ${this.dropped} 条\n停止原因：${reason}\n\n${NOTES}\n\n双方同时开启记录；问题出现时点击“标记问题”。ZIP 不会自动上传。\n`);
      await this.exportFolder(this.last.folder);
    }catch{this.error='压缩导出失败；桌面原始诊断文件仍保留，可手动压缩该文件夹。';}
    finally{this.busy=false;this.onChange();}
    return this.status();
  }
  async exportFolder(folder){
    const names=['session.json','samples.jsonl','events.jsonl','说明.txt','summary.json','概览.txt'];
    const files={};let total=0;
    for(const name of names){const p=path.join(folder,name);const size=await fs.stat(p).then(v=>v.size).catch(()=>0);if(size>this.maxBytes+65536||total+size>this.maxBytes+262144)throw Error('Diagnostic size limit');if(size){files[name]=new Uint8Array(await fs.readFile(p));total+=size;}}
    const output=path.join(this.desktop,'同屏小屋诊断-'+path.basename(folder)+'.zip');
    await fs.writeFile(output,await zipBuffer(files));this.last={folder,zip:output};
  }
  async exportLast(){
    if(this.active)return this.stop('user');
    if(this.busy)return this.status();
    this.busy=true;this.onChange();
    try{
      const raw=await fs.readFile(path.join(this.base,'latest.json'),'utf8');if(raw.length>1024)throw Error();
      const {name}=JSON.parse(raw);if(!/^\d{4}-\d{2}-\d{2}T[0-9TZ-]+_[a-f0-9]{6}$/.test(name))throw Error();
      const folder=path.join(this.base,name);await this.exportFolder(folder);
      this.error=null;
    }catch{this.error='没有可导出的上次记录，或记录文件不完整。原始文件可在桌面诊断目录查看。';}
    finally{this.busy=false;this.onChange();}
    return this.status();
  }
}
module.exports={DiagnosticsRecorder,sanitizeSample,sanitizeEvent,sanitizeHost,sanitizeNative,sanitizeNativeSample,tag,NOTES};
