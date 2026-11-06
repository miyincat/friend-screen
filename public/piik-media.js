import {overlayCandidate,overlayDescription} from '/media-policy.js';
import {diagnosticRtp} from '/diagnostic-telemetry.js';
import {PLAYBACK_TARGETS,videoBudget,setPlaybackTarget} from '/media-controls.js';
import {pickNativeSource} from '/source-picker.js';
const id=()=>crypto.randomUUID();
export async function houseCall(method,...args){const result=await window.privateHouse[method](...args);if(!result.ok)throw new Error(result.error);return result.value;}
export function screenAudioAnswer(answer){
  // Piik's local bridge requires an explicit Opus receive ceiling, even for
  // a silent mixed-audio track. Only adjust the negotiated audio section.
  const sections=answer.sdp.split(/(?=^m=)/m);
  for(let i=0;i<sections.length;i++){
    if(!sections[i].startsWith('m=audio ')||sections[i].startsWith('m=audio 0 '))continue;
    const codec=sections[i].match(/^a=rtpmap:(\d+) opus\/48000\/2\r?$/im);if(!codec)continue;
    const prefix='a=fmtp:'+codec[1]+' ',lines=sections[i].split('\r\n');const at=lines.findIndex(l=>l.startsWith(prefix));
    const params=(at<0?[]:lines[at].slice(prefix.length).split(';')).filter(p=>p.trim()&&!/^(stereo|maxaveragebitrate)\s*=/i.test(p.trim()));
    params.push('stereo=1','maxaveragebitrate=510000');const line=prefix+params.join(';');if(at>=0)lines[at]=line;else lines.splice(lines.length-1,0,line);sections[i]=lines.join('\r\n');
  }
  return {type:answer.type,sdp:sections.join('')};
}

export class PiikMedia {
  constructor({send,onStream,onStatus,onStopped}){
    Object.assign(this,{send,onStream,onStatus,onStopped});this.shareId=null;this.own=false;this.edges=new Map();this.preview=null;this.topology=null;this.incoming=null;this.queue=Promise.resolve();this.metrics=new Map();this.readyCandidates=new Map();this.disposed=false;
    window.privateHouse.onNative(event=>this.event(event));
    this.uploadBudget=8000000;this.playbackMode='smooth';this.expectedChildren=0;
  }
  request(type,payload={}){return houseCall('native',type,payload);}
  profile(quality,priority,bitrate){return {resolution:{width:quality.width,height:quality.height},maxFramerate:quality.fps,maxBitrate:bitrate,degradationPreference:priority==='motion'?'maintain-framerate':priority==='detail'?'maintain-resolution':'balanced',maxAudioBitrate:192000};}
  configure({uploadBudget,playbackMode,children}={}){
    if(uploadBudget!==undefined)this.uploadBudget=uploadBudget;
    if(children!==undefined)this.expectedChildren=Math.min(2,Math.max(0,children));
    if(playbackMode!==undefined){if(!Object.hasOwn(PLAYBACK_TARGETS,playbackMode))throw new Error('观看方式无效');this.playbackMode=playbackMode;}
    if(this.preview)this.preview.playback=setPlaybackTarget(this.preview.pc,this.playbackMode,this.own);
    return this.enqueue(()=>this.applyProfile());
  }
  async applyProfile(){
    if(!this.shareId||!this.requestedProfile||(!this.own&&!this.incoming?.ready))return;
    const children=this.topology?this.topology.edges.filter(e=>e.from===this.selfId).length:this.expectedChildren;
    const next={...this.requestedProfile,maxBitrate:videoBudget(this.requestedProfile.maxBitrate,this.uploadBudget,children)};
    if(JSON.stringify(next)===JSON.stringify(this.currentProfile))return;
    await this.request('update-share',{shareId:this.shareId,profile:next});this.currentProfile=next;this.sendProfile();
  }
  choose(preferences, signal) {
    return pickNativeSource({
      request: (type, payload) => this.request(type, payload),
      health: () => houseCall('health'),
      preferences: { codec: 'auto', audio: false, showCaptureBorder: true, ...preferences },
      signal,
    });
  }
  async start(quality,priority,bitrate,preferences){
    const picker = new AbortController();
    this.sourcePicker = picker;
    let selection;
    try { selection = await this.choose(preferences, picker.signal); }
    finally { if (this.sourcePicker === picker) this.sourcePicker = null; }
    if (!selection || picker.signal.aborted) return null;
    return this.enqueue(async()=>{await this.stopNow();this.shareId=id();this.own=true;this.codec=selection.codec;this.sourceTitle=selection.source.title;this.capture={kind:selection.source.kind,codec:selection.codec,adapterIndex:selection.adapterIndex,encoderIndex:selection.encoderIndex,audio:selection.audio};this.requestedProfile=this.profile(quality,priority,bitrate);this.currentProfile={...this.requestedProfile,maxBitrate:videoBudget(bitrate,this.uploadBudget,this.expectedChildren)};
    try{const {name,showCaptureBorder=true,...input}=selection;const response=await this.request('start-share',{...input,shareId:this.shareId,edgeCapacity:2,profile:this.currentProfile,showCaptureBorder,microphoneMixing:true,reportCaptureFailure:true});this.hasAudio=response.audio;this.codec=response.codec;await this.createPreview();return {shareId:this.shareId,stream:this.preview.stream,audio:this.hasAudio,codec:this.codec};}
    catch(error){await this.stopNow();throw error;}});
  }
  enqueue(task){const job=this.queue.catch(()=>{}).then(task);this.queue=job.catch(()=>{});return job;}
  update(quality,priority,bitrate){return this.enqueue(async()=>{if(this.own&&this.shareId){this.requestedProfile=this.profile(quality,priority,bitrate);await this.applyProfile();}});}
  sendProfile(){for(const edge of this.edges.values())this.sendSignal(edge.to,edge.connectionId,{profile:this.currentProfile});}
  setTree(tree,selfId,iceServers){
    return this.enqueue(()=>this.applyTree(tree,selfId,iceServers)).catch(error=>this.onStatus('媒体路径准备失败：'+error.message,'error'));
  }
  async applyTree(tree,selfId,iceServers){
    if(!tree.shareId){if(!this.own)await this.stopNow();else await this.closeNetwork();return;}
    if(tree.shareId!==this.shareId){await this.stopNow();this.shareId=tree.shareId;this.own=false;}
    this.selfId=selfId;this.iceServers=[];this.addresses=tree.addresses||{};this.address=this.addresses[selfId];this.topology=tree;if(!this.address)throw new Error('缺少已认证私网地址');
    const parent=tree.edges.find(e=>e.to===selfId)||null;
    const desired=tree.edges.filter(e=>e.from===selfId);
    if(this.incoming?.connectionId!==parent?.connectionId){
      await this.closeNetwork();if(!this.own)this.closePreview();this.incoming=parent?{...parent,ready:false,candidates:[]}:null;
    }
    for(const [key,edge] of this.edges)if(!desired.some(e=>e.connectionId===key)){this.edges.delete(key);await this.request('close-edge',{shareId:this.shareId,connectionId:key}).catch(()=>{});}
    await this.applyProfile();
    if(this.own||this.incoming?.ready)await this.prepareChildren();
  }
  async prepareChildren(){
    if(!this.topology||!this.shareId)return;
    for(const route of this.topology.edges.filter(e=>e.from===this.selfId)){
      if(this.edges.has(route.connectionId))continue;
      const edge={...route,ready:false,candidates:[],state:'connecting'};this.edges.set(route.connectionId,edge);
      try{const offer=await this.request('prepare-edge',{shareId:this.shareId,connectionId:route.connectionId,iceServers:this.iceServers.map(s=>({urls:Array.isArray(s.urls)?s.urls:[s.urls]})),...(this.own?{}:{sourceConnectionId:this.incoming.connectionId})});
        if(this.edges.get(route.connectionId)!==edge)continue;
        this.sendSignal(route.to,route.connectionId,{description:{type:'offer',sdp:offer.sdp,profile:this.currentProfile}});edge.ready=true;for(const candidate of edge.candidates.splice(0))this.sendSignal(route.to,route.connectionId,{candidate});
      }catch(error){this.edges.delete(route.connectionId);this.onStatus('无法向朋友建立原生视频连接：'+error.message,'error');}
    }
  }
  sendSignal(to,connectionId,payload){if(payload.description)payload={description:{...payload.description,...overlayDescription(payload.description,this.address)}};if(Object.hasOwn(payload,'candidate')&&!overlayCandidate(payload.candidate,this.address))return;this.send({type:'screen-signal',to,shareId:this.shareId,connectionId,payload});}
  signal(message){return this.enqueue(()=>this.acceptSignal(message)).catch(error=>this.onStatus('视频协商失败：'+error.message,'warning'));}
  async acceptSignal(message){
    if(message.shareId!==this.shareId)return;
    const input=this.incoming,output=this.edges.get(message.connectionId),p={...message.payload};
    const address=this.addresses?.[message.from];if(!address)return;
    if(p.description)p.description={...p.description,...overlayDescription(p.description,address)};
    if(Object.hasOwn(p,'candidate')&&!overlayCandidate(p.candidate,address))return;
    if(input&&message.connectionId===input.connectionId&&message.from===input.from){
      if(p.description?.type==='offer'){
        const answer=await this.request('receive-offer',{shareId:this.shareId,connectionId:input.connectionId,sdp:p.description.sdp,edgeCapacity:2,iceServers:this.iceServers.map(s=>({urls:Array.isArray(s.urls)?s.urls:[s.urls]})),reuseReceiver:true});
        if(this.incoming!==input)return;input.ready=true;this.hasAudio=answer.audio;this.codec=answer.codec;
        this.requestedProfile=p.description.profile;this.currentProfile=null;await this.applyProfile();
        this.sendSignal(input.from,input.connectionId,{description:{type:'answer',sdp:answer.sdp}});
        for(const candidate of input.candidates.splice(0))await this.request('receive-candidate',{shareId:this.shareId,connectionId:input.connectionId,candidate});
        for(const candidate of (input.localCandidates||[]))this.sendSignal(input.from,input.connectionId,{candidate});input.localCandidates=[];
        await this.createPreview(input.connectionId);await this.prepareChildren();
      }else if(p.profile&&input.ready){this.requestedProfile=p.profile;await this.applyProfile();}
      else if(Object.hasOwn(p,'candidate')){if(!input.ready){if(input.candidates.length<128)input.candidates.push(p.candidate);}else await this.request('receive-candidate',{shareId:this.shareId,connectionId:input.connectionId,candidate:p.candidate});}
    }else if(output&&message.from===output.to){
      if(p.description?.type==='answer'){await this.request('edge-answer',{shareId:this.shareId,connectionId:output.connectionId,sdp:p.description.sdp});output.answered=true;for(const candidate of (output.remoteCandidates||[]))await this.request('edge-candidate',{shareId:this.shareId,connectionId:output.connectionId,candidate});output.remoteCandidates=[];}
      else if(Object.hasOwn(p,'candidate')){if(output.answered)await this.request('edge-candidate',{shareId:this.shareId,connectionId:output.connectionId,candidate:p.candidate});else{output.remoteCandidates??=[];if(output.remoteCandidates.length<128)output.remoteCandidates.push(p.candidate);}}
    }
  }
  async createPreview(sourceConnectionId){
    this.closePreview();const connectionId=id(),pc=new RTCPeerConnection({iceServers:[],bundlePolicy:'max-bundle'}),stream=new MediaStream();
    const preview={pc,stream,connectionId,remoteReady:false,candidates:[],sourceConnectionId};this.preview=preview;
    pc.onconnectionstatechange=()=>{if(this.preview===preview&&pc.connectionState==='failed')this.onStatus('本机播放器连接失败，请停止共享后重试，或重新加入房间。','error');};
    pc.ontrack=({track})=>{stream.addTrack(track);preview.playback=setPlaybackTarget(pc,this.playbackMode,this.own);track.onunmute=()=>this.onStream(stream,this.own);this.onStream(stream,this.own);};
    // Local Piik preview uses non-trickle ICE: its candidates go in the SDP.
    const offer=await this.request('prepare-local-edge',{shareId:this.shareId,connectionId,restart:false,...(sourceConnectionId?{sourceConnectionId}:{})});
    if(this.preview!==preview)return;
    await pc.setRemoteDescription({type:'offer',sdp:offer.sdp});preview.remoteReady=true;for(const c of preview.candidates)await pc.addIceCandidate(c);preview.candidates=[];
    await pc.setLocalDescription(screenAudioAnswer(await pc.createAnswer()));
    if(pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',check);reject(new Error('本机视频候选收集超时'));},7000);const check=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);resolve();}};pc.addEventListener('icegatheringstatechange',check);check();});
    if(this.preview!==preview)return;
    await this.request('edge-answer',{shareId:this.shareId,connectionId,sdp:overlayDescription(pc.localDescription,offer.privateAddress).sdp,offerId:offer.id});
  }
  event(event){
    if(event.type==='engine-disconnected'){this.onStatus('Piik 原生引擎退出，请重新打开客户端。','error');this.onStopped();return;}
    if(event.shareId!==this.shareId)return;
    if(event.type==='share-ended'){this.onStatus(event.failed?'采集来源中断，请重新选择屏幕或窗口。':'共享来源已关闭。',event.failed?'error':'');this.onStopped();return;}
    const preview=this.preview,output=this.edges.get(event.connectionId),input=this.incoming?.connectionId===event.connectionId?this.incoming:null;
    if(event.type==='edge-candidate'){
      if(preview?.connectionId===event.connectionId){if(preview.remoteReady)preview.pc.addIceCandidate(event.candidate).catch(()=>{});else if(preview.candidates.length<128)preview.candidates.push(event.candidate);}
      else if(output){if(output.ready)this.sendSignal(output.to,output.connectionId,{candidate:event.candidate});else if(output.candidates.length<128)output.candidates.push(event.candidate);}
      else if(input){if(input.ready)this.sendSignal(input.from,input.connectionId,{candidate:event.candidate});else{input.localCandidates??=[];if(input.localCandidates.length<128)input.localCandidates.push(event.candidate);}}
    }else if(event.type==='edge-quality'&&output){this.metrics.set(event.connectionId,event);}
    else if(event.type==='edge-state'&&(output||input)){
      const edge=output||input;edge.state=event.state;
      if(event.state==='connected'){clearTimeout(edge.repairTimer);this.onStatus('原生私网媒体已连通。实际画质与帧率见下方诊断。','success');}
      else if(['disconnected','failed'].includes(event.state)&&!edge.repairTimer){edge.repairTimer=setTimeout(()=>{if(edge.state!=='connected'){this.send({type:'screen-repair',connectionId:edge.connectionId});this.onStatus('原生私网视频中断，正在重新协商；若持续失败，请检查 ZeroTier 连接及朋友是否仍在线。','warning');}},event.state==='failed'?1000:6000);}
    }else if(event.type==='edge-path'&&(output||input)){(output||input).path=event.localType+' ↔ '+event.remoteType;}
  }
  async stats(includeDiagnostics=false){
    if(!this.shareId)return null;
    const tracks=[];let bitrate=0;let previewStat=null;let playback=[];
    for(const edge of this.edges.values()){const value=this.metrics.get(edge.connectionId);if(value&&Date.now()-value.sampleTimestampMs<15000){bitrate+=(value.bitrateKbps||0)/1000;tracks.push(value);}}
    if(this.preview){const reports=await this.preview.pc.getStats();if(includeDiagnostics)playback=diagnosticRtp(reports);for(const r of reports.values())if(r.type==='inbound-rtp'&&r.kind==='video'){const prior=this.preview.lastStat;const seconds=prior?(r.timestamp-prior.timestamp)/1000:0;previewStat={width:r.frameWidth,height:r.frameHeight,framesPerSecond:seconds>0?(r.framesDecoded-prior.framesDecoded)/seconds:r.framesPerSecond,bitrate:seconds>0?(r.bytesReceived-prior.bytesReceived)*8/seconds/1e6:null};this.preview.lastStat={timestamp:r.timestamp,framesDecoded:r.framesDecoded,bytesReceived:r.bytesReceived};}}
    const actual=this.own?(tracks[0]||previewStat):previewStat;
    return {shareId:this.shareId,own:this.own,codec:this.codec,actual,playback,playbackMode:this.playbackMode,playbackTargetMs:this.preview?.playback?.targetMs??null,playbackSupported:this.preview?.playback?.supported??null,uploadBudget:this.uploadBudget,videoCeiling:this.currentProfile?.maxBitrate??null,capture:this.own?this.capture:null,previewState:this.preview?.pc.connectionState,bitrate:this.own?bitrate:previewStat?.bitrate,children:this.edges.size,parent:this.incoming?.from||null,paths:[...(this.incoming?[this.incoming]:[]),...this.edges.values()].map(e=>({from:e.from,to:e.to,state:e.state||'connecting',path:e.path||'正在探测',connectionId:e.connectionId}))};
  }
  closePreview(){const p=this.preview;this.preview=null;if(!p)return;p.pc.close();p.stream.getTracks().forEach(t=>t.stop());if(this.shareId)this.request('close-edge',{shareId:this.shareId,connectionId:p.connectionId}).catch(()=>{});this.onStream(null,this.own);}
  async closeNetwork(){
    const requests=[];for(const e of this.edges.values()){clearTimeout(e.repairTimer);requests.push(this.request('close-edge',{shareId:this.shareId,connectionId:e.connectionId}).catch(()=>{}));}this.edges.clear();this.metrics.clear();
    if(this.incoming){clearTimeout(this.incoming.repairTimer);requests.push(this.request('close-receiver',{shareId:this.shareId,connectionId:this.incoming.connectionId}).catch(()=>{}));this.incoming=null;}
    await Promise.all(requests);
  }
  stop(){this.sourcePicker?.abort();return this.enqueue(()=>this.stopNow());}
  async stopNow(){this.topology=null;const share=this.shareId,own=this.own;this.closePreview();await this.closeNetwork();this.shareId=null;this.own=false;this.requestedProfile=null;this.currentProfile=null;if(share)await this.request(own?'stop-share':'stop-receive',{shareId:share}).catch(()=>{});}
}
