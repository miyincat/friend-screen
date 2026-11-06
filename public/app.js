'use strict';
import { overlayCandidate, overlayDescription, inspectMediaPath } from '/media-policy.js';
import { PendingSignals } from '/pending-signals.js';
import { PiikMedia } from '/piik-media.js';
import { diagnosticRtp } from '/diagnostic-telemetry.js';
import { bindShareSettings } from '/share-settings.js';

(() => {
  const $ = (id) => document.getElementById(id);
  if (!window.friendProfile) {
    document.querySelector('.network-note').hidden = false;
    $('network-note-title').textContent='资料组件未能加载';
    $('status-message').textContent='客户端资料组件加载失败，请关闭后重新打开；当前无法安全进入房间。';
    for (const id of ['create-btn','join-btn','share-btn','mic-btn']) $(id).disabled=true;
    return;
  }
  const qualityPresets = {
    '720p30': { width: 1280, height: 720, fps: 30, bitrate: 1500000 },
    '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 5000000 },
    '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8000000 },
    '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 12000000 },
  };
  const state = {
    ws: null, connecting: null, joining: false, joined: false, selfId: null, overlay:false, address:null,
    roomId: null, name: '', password: '', presenterId: null, peers: new Map(), pendingSignals: new PendingSignals(),
    iceServers: [], iceTransportPolicy: 'all', maxParticipants: 6,
    screen: null, mic: null, captureBusy: false, micBusy: false,
    presentationPending: false, presentationTimer: null,
    soundEnabled: false, epoch: 0, config: null, statsBusy: false,
    lastTotalBytes: null, lastStatsTime: null, joinTimer: null,
    audioContext: null, rawMic: null, micSource: null, micGain: null, micAnalyser: null, micVolume: window.friendProfile.value.micVolume,
  };
  const native = window.privateHouse ? new PiikMedia({send, onStatus:setStatus, onStopped:()=>stopSharing(), onStream:(stream,own)=>{
    if(own) state.screen=stream;
    else {const peer=state.peers.get(state.presenterId);if(peer)peer.screenStream=stream||new MediaStream();}
    renderStage();
  }}) : null;
  const shareSettings = native ? bindShareSettings({
    onQuality: changeQuality,
    onVolume: volume => { $('stage-video').volume = volume; },
  }) : null;
  const currentQuality = () => shareSettings?.quality ?? qualityPresets[$('quality-select').value];
  const currentPriority = () => shareSettings?.priority ?? $('sharing-priority').value;
  async function configureMedia(){
    if(!native)return;
    await native.configure({uploadBudget:Number($('upload-budget').value),playbackMode:$('playback-mode').value,children:state.peers.size});
  }
  let diagnosticsEnabled=false;
  function diagnosticEvent(value){if(diagnosticsEnabled)window.privateHouse?.diagnosticsEvent?.(value);}
  function diagnosticSample(peers=[],media=null){
    if(!diagnosticsEnabled)return;
    const video=$('stage-video');
    window.privateHouse?.diagnosticsSample?.({visibility:document.visibilityState,audioContext:state.audioContext?.state,player:{readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,currentTime:video.currentTime,playbackRate:video.playbackRate,paused:video.paused,muted:video.muted,hidden:video.hidden},roomId:state.roomId,selfId:state.selfId,joined:state.joined,role:!state.joined?'idle':state.presenterId===state.selfId?'sharing':state.presenterId?'viewing':'waiting',microphone:Boolean(state.mic),microphoneVolume:state.micVolume,listening:state.soundEnabled,target:currentQuality(),priority:currentPriority(),peers,media});
  }
  if(window.privateHouse?.diagnosticsState){
    const update=s=>{diagnosticsEnabled=Boolean(s.collecting);$('diagnostic-window').textContent=s.active?'● 记录中 · 诊断窗口':'诊断记录窗口';if(diagnosticsEnabled&&!state.joined)diagnosticSample();};
    $('diagnostic-window').hidden=false;
    $('diagnostic-window').onclick=()=>window.privateHouse.openDiagnostics().catch(()=>setStatus('诊断窗口打开失败，请使用“小屋”菜单重试。','warning'));
    window.privateHouse.onDiagnosticsState(update);window.privateHouse.diagnosticsState().then(update).catch(()=>{});
    window.addEventListener('error',()=>diagnosticEvent({type:'renderer-error'}));
    window.addEventListener('unhandledrejection',()=>diagnosticEvent({type:'renderer-error'}));
  }


  function setStatus(message, tone = '') {
    $('status-message').textContent = message;
    $('status-message').dataset.tone = tone;
  }

  function freshPassword() {
    const values = new Uint8Array(12);
    crypto.getRandomValues(values);
    return Array.from(values, (v) => v.toString(16).padStart(2, '0')).join('');
  }

  function selectTab(tab) {
    for (const key of ['create', 'join']) {
      const selected = key === tab;
      $(`${key}-tab`).classList.toggle('active', selected);
      $(`${key}-tab`).setAttribute('aria-selected', String(selected));
      $(`${key}-form`).hidden = !selected;
    }
  }

  function parseInvitation() {
    const room = new URLSearchParams(location.hash.slice(1)).get('room');
    if (room && /^[a-f0-9]{12}$/i.test(room)) {
      $('join-room').value = room.toUpperCase();
      selectTab('join');
    }
  }

  function canCapture() {
    if(native)return true;
    return Boolean(window.isSecureContext && navigator.mediaDevices?.getDisplayMedia);
  }

  function canVoice() {
    return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
  }

  function updateEnvironment() {
    const note = document.querySelector('.network-note');
    note.hidden = Boolean(native && state.config?.overlay && window.isSecureContext);
    if (note.hidden) return;
    const title = $('network-note-title');
    const body = $('network-note-text');
    note.classList.remove('warning');
    if (!window.isSecureContext) {
      note.classList.add('warning');
      title.textContent = '当前地址不能采集屏幕';
      body.textContent = '屏幕和麦克风权限需要 HTTPS。本机请用 localhost；局域网 IP 的普通 HTTP 地址不具备采集权限。';
    } else if (!navigator.mediaDevices?.getDisplayMedia) {
      note.classList.add('warning');
      title.textContent = '此浏览器不支持屏幕采集';
      body.textContent = '可尝试观看朋友的共享。发起共享请使用电脑上的新版 Chrome 或 Edge。';
    } else if (!state.config) {
      title.textContent = '未取得服务器配置';
      body.textContent = '请确认服务器正在运行，然后刷新页面。';
    } else if (state.config.overlay) {
      title.textContent = '已加入私有网络';
      body.textContent = '仅批准设备可加入。音视频必须经过私有网卡；底层可能直连或使用 ZeroTier 免费中继。网络拥堵时请选 720p。';
    } else if (!state.config.hasTurn) {
      note.classList.add('warning');
      title.textContent = '公网中继尚未配置';
      body.textContent = '当前适合本机测试。邀请异地朋友前，请按部署说明配置 HTTPS 和 TURN；否则跨网络连接可能失败。';
    } else {
      title.textContent = '已配置公网中继';
      body.textContent = '需要时会经 TURN 转发媒体。实际连接仍取决于中继可达性、双方网络和上行带宽。';
    }
  }

  function send(message) {
    if (state.ws?.readyState !== WebSocket.OPEN) return false;
    state.ws.send(JSON.stringify(message));
    return true;
  }

  function stopStream(stream) {
    stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  }

  function audioContext() {
    if (!state.audioContext || state.audioContext.state === 'closed') state.audioContext = new AudioContext();
    return state.audioContext;
  }

  function setGain(node, value) {
    if (node && state.audioContext?.state !== 'closed') node.gain.setTargetAtTime(value, state.audioContext.currentTime, 0.025);
  }

  function updatePeerVolume(peer) {
    setGain(peer.gain, state.soundEnabled && (!state.overlay || peer.pathVerified) ? peer.volume / 100 : 0);
  }

  function connectPeerAudio(peer) {
    peer.source?.disconnect(); peer.gain?.disconnect();
    const context = audioContext();
    peer.source = context.createMediaStreamSource(peer.micStream);
    peer.gain = context.createGain();
    peer.gain.gain.value = state.soundEnabled && (!state.overlay || peer.pathVerified) ? peer.volume / 100 : 0;
    peer.source.connect(peer.gain); peer.gain.connect(context.destination);
  }

  function stopMic() {
    stopStream(state.rawMic); stopStream(state.mic);
    state.micSource?.disconnect(); state.micGain?.disconnect(); state.micAnalyser?.disconnect();
    state.rawMic = state.mic = state.micSource = state.micGain = state.micAnalyser = null;
    $('mic-level').value = 0;
  }

  function displayName(id) {
    if (id === state.selfId) return `${state.name}（你）`;
    return state.peers.get(id)?.name || '朋友';
  }

  function connectionLabel(peer) {
    const labels = { new: '尚未建立', connecting: '正在连接', connected: '已连接', disconnected: '网络中断', failed: '连接失败', closed: '已关闭' };
    return labels[peer.pc.connectionState] || '等待连接';
  }

  function peerStateDetails(peer) {
    const signaling = {
      stable: '稳定', 'have-local-offer': '已发送本地提议', 'have-remote-offer': '已收到对方提议',
      'have-local-pranswer': '等待最终应答', 'have-remote-pranswer': '已收到临时应答', closed: '已关闭',
    }[peer.pc.signalingState] || peer.pc.signalingState;
    const ice = {
      new: '未开始', checking: '检查中', connected: '已连通', completed: '完成',
      disconnected: '断开', failed: '失败', closed: '已关闭',
    }[peer.pc.iceConnectionState] || peer.pc.iceConnectionState;
    const gathering = { new: '未开始', gathering: '收集中', complete: '完成' }[peer.pc.iceGatheringState] || peer.pc.iceGatheringState;
    return `信令 ${signaling} · ICE ${ice} · 候选 ${gathering}`;
  }

  function renderMembers() {
    const list = $('members-list');
    if (!state.joined) { list.replaceChildren(); return; }
    const members = [{ id: state.selfId, name: state.name, avatar: window.friendProfile.value.avatar, mic: Boolean(state.mic), self: true }, ...state.peers.values()];
    const ids = new Set(members.map(m => m.id));
    for (const li of [...list.children]) if (!ids.has(li.dataset.peerId)) li.remove();
    $('member-count').textContent = `${members.length} / ${state.maxParticipants}`;
    members.forEach((member, index) => {
      let li = [...list.children].find(el => el.dataset.peerId === member.id);
      if (!li) {
        li = document.createElement('li'); li.className = 'member'; li.dataset.peerId = member.id;
        li.innerHTML = '<span class="avatar"></span><div class="member-info"><div class="member-name"></div><div class="member-detail"></div></div><span class="mic-indicator"></span>';
        if (!member.self) {
          const controls = document.createElement('div'); controls.className = 'friend-volume';
          const label = document.createElement('label'); label.textContent = '本地收听';
          const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '200'; range.value = String(member.volume); range.className = 'volume-slider';
          range.id = 'volume-' + member.id; label.htmlFor = range.id;
          const value = document.createElement('output'); value.className = 'friend-volume-value'; value.htmlFor = range.id; value.textContent = member.volume + '%';
          const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'text-button friend-mute';
          const update = () => {
            value.textContent = member.volume + '%'; range.value = member.volume;
            mute.textContent = member.volume === 0 ? '恢复' : '静音'; mute.setAttribute('aria-pressed', String(member.volume === 0));
            updatePeerVolume(member);
          };
          range.oninput = () => { member.volume = Number(range.value); if (member.volume) member.lastVolume = member.volume; update(); };
          mute.onclick = () => { member.volume = member.volume === 0 ? member.lastVolume || 100 : 0; update(); };
          controls.append(label, value, range, mute); li.append(controls); update();
        }
        list.append(li);
      }
      const avatar = li.querySelector('.avatar');
      avatar.className = `avatar color-${index % 4}`;
      window.friendProfile.avatar(avatar, member.avatar, member.name);
      const name = li.querySelector('.member-name');
      name.textContent = member.name + (member.self ? '（你）' : ''); name.title = member.name;
      const detail = li.querySelector('.member-detail');
      const sharing = state.presenterId === member.id;
      detail.textContent = (sharing ? '正在分享屏幕' : member.self ? '已加入房间' : connectionLabel(member)) + (state.overlay ? ' · '+member.id.slice(-6) : '');
      detail.classList.toggle('sharing', sharing);
      const mic = li.querySelector('.mic-indicator');
      mic.className = `mic-indicator${member.mic ? ' active' : ''}`;
      mic.textContent = member.mic ? '开麦' : '闭麦';
      if (!member.self) {
        li.querySelector('input[type=range]').setAttribute('aria-label', `${member.name}的麦克风收听音量`);
        li.querySelector('.friend-mute').setAttribute('aria-label', `${member.volume === 0 ? '恢复' : '静音'}${member.name}的声音（仅本地）`);
      }
      /* Keep each slider node stable while other members' state changes. */
    });
  }

  function playQuietly(element) {
    const attempt = element.play();
    if (attempt?.catch) attempt.catch(() => {
      if (state.soundEnabled) setStatus('浏览器暂停了自动播放。请点击“关闭声音”再“打开声音”，或点击画面恢复播放。', 'warning');
    });
  }

  function renderStage() {
    const video = $('stage-video');
    const isSelf = state.presenterId === state.selfId && state.joined;
    const remote = state.peers.get(state.presenterId);
    const stream = isSelf ? state.screen : (!state.overlay || remote?.pathVerified) ? remote?.screenStream : null;
    const hasVideo = stream && stream.getVideoTracks().length > 0;
    if (hasVideo && state.presenterId) {
      if (video.srcObject !== stream) video.srcObject = stream;
      video.muted = isSelf || !state.soundEnabled;
      video.hidden = false;
      $('stage-empty').hidden = true;
      $('stage-caption').hidden = false;
      $('fullscreen-btn').hidden = false;
      $('stage-title').textContent = isSelf ? '你的屏幕，正在分享' : `正在观看 ${displayName(state.presenterId)}`;
      $('presenter-label').textContent = isSelf ? '你的共享 · 本地预览已静音' : `${displayName(state.presenterId)} 的屏幕`;
      $('stage-state').textContent = isSelf ? '共享中' : '观看中';
      $('stage-state').classList.add('live');
      const settings = stream.getVideoTracks()[0].getSettings();
      const dimensions = settings.width && settings.height ? `${settings.width} × ${settings.height}` : '';
      $('capture-details').textContent = dimensions;
      playQuietly(video);
    } else {
      const pausedStream = !isSelf && state.presenterId && remote?.screenStream;
      if (!pausedStream || video.srcObject !== pausedStream) video.srcObject = null;
      video.pause();
      video.muted = true;
      video.hidden = true;
      $('stage-empty').hidden = false;
      $('stage-caption').hidden = true;
      $('fullscreen-btn').hidden = true;
      $('stage-state').classList.remove('live');
      $('capture-details').textContent = '';
      if (state.presenterId) {
        const rechecking = state.overlay && remote && !remote.pathVerified && remote.pathTransitions > 0;
        $('stage-title').textContent = rechecking ? '私网路径正在重新验证' : '画面正在路上';
        $('stage-state').textContent = '连接中';
        $('empty-title').textContent = `${displayName(state.presenterId)} 正在分享`;
        $('empty-text').textContent = rechecking ? `音视频已暂停，仍在房间中；${pathReasonLabel(remote.pathReason)}。验证通过后自动恢复。` : '正在等待媒体连接和共享画面。若等待较久，请查看下方连接诊断。';
      } else if (state.joined) {
        $('stage-title').textContent = '小屋已就绪，一起看点什么';
        $('stage-state').textContent = '等待分享';
        $('empty-title').textContent = '让朋友看看你的屏幕';
        $('empty-text').textContent = native ? '点击「开始共享」，从缩略图选中窗口或屏幕。' : '点击“开始共享”，选择窗口、标签页或整个屏幕。一次由一位朋友分享。';
      } else {
        $('stage-title').textContent = '好内容，值得一起看';
        $('stage-state').textContent = '等待开始';
        $('empty-title').textContent = native ? '准备好了，等你分享' : '屏幕准备好了，等你来分享';
        $('empty-text').textContent = native ? '创建或加入房间，再从缩略图选择你想分享的窗口或屏幕。' : '先创建或加入房间，再选择想分享的窗口、标签页或整个屏幕。';
      }
    }
  }

  function renderControls() {
    const sharing = Boolean(state.screen || state.presentationPending);
    const anotherPresenter = state.presenterId && state.presenterId !== state.selfId;
    const share = $('share-btn');
    share.disabled = !state.joined || state.captureBusy || !canCapture() || Boolean(anotherPresenter);
    share.classList.toggle('stopping', sharing);
    share.querySelector('span').textContent = state.captureBusy ? '正在选择…' : sharing ? '停止共享' : anotherPresenter ? '朋友正在共享' : '开始共享';
    const mic = $('mic-btn');
    mic.disabled = !state.joined || state.micBusy || !canVoice();
    mic.setAttribute('aria-pressed', String(Boolean(state.mic)));
    mic.querySelector('span').textContent = state.micBusy ? '请求权限…' : state.mic ? '关闭麦克风' : '打开麦克风';
    $('profile-mic-btn').disabled = mic.disabled;
    $('profile-mic-btn').setAttribute('aria-pressed', String(Boolean(state.mic)));
    $('profile-mic-btn').textContent = state.micBusy ? '请求中…' : state.mic ? '闭麦' : '开麦';
    $('quality-select').disabled = Boolean(anotherPresenter);
    $('sharing-priority').disabled = Boolean(anotherPresenter);
    shareSettings?.setViewing(Boolean(anotherPresenter));
    $('quality-select').title = anotherPresenter ? '画质由正在共享的朋友设置；此处不改变对方发送画质。' : '这是目标画质；实际尺寸、帧率和速率会显示在诊断中。';
    $('self-mic-state').textContent = state.mic ? state.micVolume === 0 ? '已开麦 · 发送音量为 0' : '麦克风已开启' : '麦克风已关闭';
    $('self-mic-state').classList.toggle('active', Boolean(state.mic));
    const sound = $('sound-btn');
    sound.disabled = !state.joined;
    sound.setAttribute('aria-pressed', String(state.soundEnabled));
    sound.querySelector('span').textContent = state.soundEnabled ? '关闭声音' : '打开声音';
    $('create-btn').disabled = state.joining;
    $('join-btn').disabled = state.joining;
    $('connection-badge').textContent = state.joined ? '房间已连接' : state.joining ? '正在连接…' : '尚未连接';
    $('connection-badge').classList.toggle('connected', state.joined);
  }

  function render() {
    if ($('voice-settings').dataset.joined !== String(state.joined)) {
      $('voice-settings').open = state.joined; $('voice-settings').dataset.joined = String(state.joined);
    }
    $('setup-view').hidden = state.joined;
    $('room-view').hidden = !state.joined;
    if (state.roomId) $('room-code').textContent = state.roomId;
    renderMembers();
    renderStage();
    renderControls();
  }

  function closePeer(id) {
    state.pendingSignals.delete(id);
    const peer = state.peers.get(id);
    if (!peer) return;
    peer.closed = true;
    clearInterval(peer.pathTimer);
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.source?.disconnect(); peer.gain?.disconnect();
    peer.audio.srcObject = null;
    peer.audio.remove();
    state.peers.delete(id);
  }

  function recordPathTransition(peer, verified) {
    peer.pathTransitions++;
    peer.pathEvents.push(`${new Date().toLocaleTimeString()} ${verified ? '通过' : '暂停'}：${pathReasonLabel(peer.pathReason)}`);
    if (peer.pathEvents.length > 6) peer.pathEvents.shift();
  }

  async function applySenderQuality(peer) {
    if (peer.closed || peer.pc.connectionState === 'closed') return;
    const sender = peer.transceivers[0]?.sender;
    if (!sender?.track) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const quality = qualityPresets[$('quality-select').value];
    const preference = $('sharing-priority').value;
    const motion = preference === 'motion';
    sender.track.contentHint = preference === 'detail' ? 'detail' : 'motion';
    params.degradationPreference = motion ? 'maintain-framerate' : 'maintain-resolution';
    params.encodings[0].maxBitrate = quality.bitrate;
    params.encodings[0].maxFramerate = quality.fps;
    params.encodings[0].scaleResolutionDownBy = motion ? (peer.videoScale || 1) : 1;
    try { await sender.setParameters(params); peer.qualityApplied=true; return true; }
    catch { peer.qualityApplied=false; return false; }
  }

  function syncTracks(peer) {
    peer.trackQueue = peer.trackQueue.then(async () => {
      if (peer.closed || peer.transceivers.length !== 3) return;
      const allowed = !state.overlay || peer.pathVerified;
      const tracks = allowed ? [
        !native && state.presenterId === state.selfId ? state.screen?.getVideoTracks()[0] || null : null,
        !native && state.presenterId === state.selfId ? state.screen?.getAudioTracks()[0] || null : null,
        state.mic?.getAudioTracks()[0] || null,
      ] : [null,null,null];
      await Promise.all(peer.transceivers.map((t, i) => t.sender.track === tracks[i] ? undefined : t.sender.replaceTrack(tracks[i])));
      if (await applySenderQuality(peer) === false) setStatus('当前设备未接受全部画质参数，共享仍在继续；请查看实际发送尺寸。','warning');
    }).catch(() => {
      if (!peer.closed) setStatus(`与 ${peer.name} 的媒体更新失败，请离开后重新加入。`, 'error');
    });
    return peer.trackQueue;
  }

  function syncAllTracks() {
    return Promise.all([...state.peers.values()].map(syncTracks));
  }

  function preferVideoCodec(peer) {
    const video=peer.transceivers[0];
    if (!video?.setCodecPreferences || !globalThis.RTCRtpReceiver?.getCapabilities) return;
    try {
      const codecs=RTCRtpReceiver.getCapabilities('video')?.codecs || [];
      const h264=codecs.filter(codec=>codec.mimeType.toLowerCase()==='video/h264');
      if (!h264.length) return;
      // Reorder the native objects only. Preserve VP8/VP9 and repair codecs as
      // fallbacks; never edit SDP profiles or claim hardware encoding from MIME.
      video.setCodecPreferences([...h264,...codecs.filter(codec=>!h264.includes(codec))]);
    } catch { /* Keep the browser's compatible default if reordering is unsupported. */ }
  }

  function createPeer(info) {
    if (!state.joined || info.id === state.selfId || state.peers.has(info.id)) return;
    const pc = new RTCPeerConnection({ iceServers: state.overlay ? [] : state.iceServers, iceTransportPolicy: state.iceTransportPolicy, bundlePolicy: 'max-bundle' });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = true;
    $('remote-audio-container').append(audio);
    const peer = {
      ...info, pc, audio, polite: state.selfId.localeCompare(info.id) > 0,
      makingOffer: false, ignoreOffer: false, settingAnswer: false, pendingCandidates: [],
      iceDebug: { localSeen: 0, localAllowed: 0, localSent: 0, localRejected: 0, remoteSeen: 0, remoteAllowed: 0, remoteRejected: 0, remoteQueued: 0, remoteApplied: 0, localDescriptionsSent: 0, remoteDescriptionsReceived: 0 },
      signalQueue: Promise.resolve(), trackQueue: Promise.resolve(), transceivers: [], pathVerified:false, pathChecking:false, pathState:'pending', pathReason:'pair-not-ready', statsSample:new Map(), pathTransitions:0, pathEvents:[], videoScale:1, qualityStress:0, qualityRecovery:0,
      screenStream: new MediaStream(), micStream: new MediaStream(), closed: false, restarts: 0, volume: 100, lastVolume: 100, source: null, gain: null,
    };
    state.peers.set(info.id, peer);
    // Only the initial offerer creates m-lines. The answerer adopts the incoming
    // transceivers: pre-creating both sides can yield six mismatched m-lines.
    peer.negotiationReady = !peer.polite;
    if (!peer.polite) {
      peer.transceivers = ['video', 'audio', 'audio'].map((kind) => pc.addTransceiver(kind, { direction: 'sendrecv' }));
      preferVideoCodec(peer);
    }
    pc.onicecandidate = ({ candidate }) => {
      if (peer.closed) return;
      const value = candidate?.toJSON() || null;
      if (candidate?.candidate) {
        peer.iceDebug.localSeen++;
        if (state.overlay && !overlayCandidate(value,state.address)) {
          peer.iceDebug.localRejected++;
          refreshDiagnostics();
          return;
        }
        peer.iceDebug.localAllowed++;
      }
      if (send({ type: 'signal', to: peer.id, payload: { candidate: value } }) && candidate?.candidate) peer.iceDebug.localSent++;
      refreshDiagnostics();
    };
    pc.onnegotiationneeded = async () => {
      if (!peer.negotiationReady) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (!peer.closed && send({ type: 'signal', to: peer.id, payload: { description: state.overlay ? overlayDescription(pc.localDescription.toJSON(),state.address) : pc.localDescription.toJSON() } })) peer.iceDebug.localDescriptionsSent++;
      } catch {
        if (!peer.closed) setStatus(`正在重新协商与 ${peer.name} 的连接。`, 'warning');
      } finally { peer.makingOffer = false; }
    };
    pc.ontrack = ({ track, transceiver }) => {
      const index = pc.getTransceivers().indexOf(transceiver);
      if(native && index!==2)return;
      if (index < 0 || index > 2) return;
      const stream = index === 2 ? peer.micStream : peer.screenStream;
      stream.getTracks().filter((old) => old.kind === track.kind).forEach((old) => stream.removeTrack(old));
      stream.addTrack(track);
      if (index === 2) {
        audio.srcObject = peer.micStream;
        connectPeerAudio(peer);
        playQuietly(audio);
      }
      track.onunmute = () => { if (!peer.closed) renderStage(); };
      renderStage();
    };
    const checkPath = async () => {
      if (!state.overlay || peer.closed || peer.pathChecking) return;
      peer.pathChecking=true;
      try {
        const reports = await pc.getStats().catch(() => new Map());
        const result=inspectMediaPath(pc,reports,state.address,peer.address);
        if (peer.closed) return;
        const connected=pc.connectionState==='connected' && ['connected','completed'].includes(pc.iceConnectionState);
        const ok=connected && result.status==='verified';
        peer.pathState=connected ? result.status : 'pending';peer.pathReason=connected ? result.reason : 'connection-recovering';
        if (connected && result.status==='rejected') {
          peer.pathVerified=false;updatePeerVolume(peer);
          closePeer(peer.id);render();setStatus(`媒体路径明确不符合私网规则（${pathReasonLabel(result.reason)}），已阻止传输。`,'error');
          return;
        }
        if (peer.pathVerified!==ok) {
          const recovering=peer.pathVerified;peer.pathVerified=ok;
          recordPathTransition(peer,ok);updatePeerVolume(peer);renderStage();await syncTracks(peer);
          if (recovering && !ok) setStatus('正在重新验证私网路径，音视频暂时暂停；仍在房间中，将自动恢复。','warning');
          else if (ok) setStatus(peer.qualityApplied===false ? '私网路径已验证，但当前设备未接受全部画质参数；请查看实际发送尺寸。' : '私网媒体路径已验证，音视频可以传输。',peer.qualityApplied===false ? 'warning' : 'success');
        }
      } catch {
        if (!peer.closed) {peer.pathState='pending';peer.pathReason='stats-unavailable';if(peer.pathVerified)recordPathTransition(peer,false);peer.pathVerified=false;updatePeerVolume(peer);renderStage();await syncTracks(peer);}
      }
      finally {peer.pathChecking=false;}
    };
    if (state.overlay) peer.pathTimer=setInterval(checkPath,1000);
    pc.oniceconnectionstatechange=()=>{
      if(state.overlay && !['connected','completed'].includes(pc.iceConnectionState)) {peer.pathState='pending';peer.pathReason='connection-recovering';if(peer.pathVerified)recordPathTransition(peer,false);peer.pathVerified=false;updatePeerVolume(peer);renderStage();syncTracks(peer);}
      refreshDiagnostics();
    };
    pc.onicegatheringstatechange=refreshDiagnostics;
    pc.onsignalingstatechange=refreshDiagnostics;
    pc.onconnectionstatechange = () => {
      if (peer.closed) return;
      renderMembers();
      if (pc.connectionState === 'connected') {
        if (state.overlay) checkPath(); else applySenderQuality(peer);
      } else if (pc.connectionState === 'failed' && peer.restarts < 1) {
        peer.restarts += 1;
        pc.restartIce();
        setStatus(`与 ${peer.name} 的连接中断，正在尝试恢复。若仍失败，请检查双方网络。`, 'warning');
      }
      refreshDiagnostics();
    };
    syncTracks(peer);
    for (const payload of state.pendingSignals.drain(peer.id)) receiveSignal(peer, payload);
    refreshDiagnostics();
  }

  function receiveSignal(peer, payload) {
    peer.signalQueue = peer.signalQueue.then(async () => {
      if (peer.closed) return;
      const pc = peer.pc;
      if (payload.description) {
        const description = state.overlay ? overlayDescription(payload.description,peer.address) : payload.description;
        const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
        const collision = description.type === 'offer' && !readyForOffer;
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        peer.settingAnswer = description.type === 'answer';
        try { await pc.setRemoteDescription(description); } finally { peer.settingAnswer = false; }
        peer.iceDebug.remoteDescriptionsReceived++;
        if (!peer.transceivers.length) {
          peer.transceivers = pc.getTransceivers();
          for (const transceiver of peer.transceivers) transceiver.direction = 'sendrecv';
          preferVideoCodec(peer);
          await syncTracks(peer);
        }
        const waiting = peer.pendingCandidates.splice(0);
        for (const candidate of waiting) {
          try { await pc.addIceCandidate(candidate); if (candidate?.candidate) peer.iceDebug.remoteApplied++; } catch { /* Stale candidates can follow a rolled-back offer. */ }
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          peer.negotiationReady = true;
          if (!peer.closed && send({ type: 'signal', to: peer.id, payload: { description: state.overlay ? overlayDescription(pc.localDescription.toJSON(),state.address) : pc.localDescription.toJSON() } })) peer.iceDebug.localDescriptionsSent++;
        }
      } else if (Object.hasOwn(payload, 'candidate')) {
        if (payload.candidate?.candidate) {
          peer.iceDebug.remoteSeen++;
          if (state.overlay && !overlayCandidate(payload.candidate,peer.address)) {
            peer.iceDebug.remoteRejected++;
            refreshDiagnostics();
            return;
          }
          peer.iceDebug.remoteAllowed++;
        }
        if (peer.ignoreOffer) return;
        if (!pc.remoteDescription) { peer.pendingCandidates.push(payload.candidate); if (payload.candidate?.candidate) peer.iceDebug.remoteQueued++; }
        else {
          try { await pc.addIceCandidate(payload.candidate); if (payload.candidate?.candidate) peer.iceDebug.remoteApplied++; } catch (error) { if (!peer.ignoreOffer) throw error; }
        }
      }
    }).catch(() => {
      if (!peer.closed) setStatus(`与 ${peer.name} 的连接协商出现问题。请查看连接诊断，必要时重新加入房间。`, 'warning');
    });
  }

  function clearPresentationTimer() {
    clearTimeout(state.presentationTimer);
    state.presentationTimer = null;
  }

  function stopSharing({ notify = true, message = true } = {}) {
    const wasSharing = Boolean(state.screen || state.presentationPending);
    if(native)native.stop().catch(()=>{});
    clearPresentationTimer();
    state.presentationPending = false;
    stopStream(state.screen);
    state.screen = null;
    if (notify && (state.presenterId === state.selfId || wasSharing)) send({ type: 'present', active: false });
    if (state.presenterId === state.selfId) state.presenterId = null;
    syncAllTracks();
    render();
    if (wasSharing && message) setStatus('屏幕共享已停止。你仍在房间中。');
  }

  function cleanupRoom() {
    diagnosticEvent({type:'room-left'});
    if($('native-source-dialog')?.open)$('native-source-dialog').close('cancel');
    if ($('share-settings-dialog').open) $('share-settings-dialog').close();
    if(native)native.stop().catch(()=>{});
    state.epoch += 1;
    clearTimeout(state.joinTimer);
    clearPresentationTimer();
    stopStream(state.screen);
    stopMic();
    state.screen = null;
    state.mic = null;
    state.captureBusy = false;
    state.micBusy = false;
    state.presentationPending = false;
    state.joined = false;
    state.joining = false;
    state.presenterId = null;
    state.selfId = null;
    state.roomId = null;
    state.password = '';
    state.soundEnabled = false;
    state.pendingSignals.clear();
    state.lastTotalBytes = null;
    state.lastStatsTime = null;
    for (const id of [...state.peers.keys()]) closePeer(id);
    state.audioContext?.close().catch(() => {}); state.audioContext = null;
    for (const id of ['metric-rtt', 'metric-bitrate', 'metric-quality']) $(id).textContent = '—';
    $('path-status').textContent = '尚未连接';
    $('connection-diagnostics').textContent = '加入房间后，可以在这里查看每位朋友的连接情况。';
    render();
    diagnosticSample();
  }

  function receiveMessage(message) {
    const diagnosticType={joined:'room-joined','room-closed':'room-closed','peer-joined':'peer-joined','peer-left':'peer-left',presenter:'presenter',error:'signal-error'}[message.type];
    if(diagnosticType)diagnosticEvent({type:diagnosticType,peerId:message.peer?.id||message.peerId,code:message.code});
    switch (message.type) {
      case 'joined': {
        if(native&&message.nativeMedia!==true){const socket=state.ws;state.ws=null;socket?.close();cleanupRoom();setStatus('房主仍在使用旧版媒体协议，请双方升级到 0.3.6 后重新开房。','error');break;}
        clearTimeout(state.joinTimer);
        state.joining = false;
        state.joined = true;
        state.selfId = message.selfId;
        state.overlay=Boolean(message.overlay);state.address=message.address;
        if(message.displayName)state.name=message.displayName;
        state.roomId = message.roomId;
        state.presenterId = message.presenterId;
        state.iceServers = message.iceServers || [];
        state.iceTransportPolicy = message.iceTransportPolicy || 'all';
        state.maxParticipants = message.maxParticipants || 6;
        history.replaceState(null, '', `#room=${state.roomId}`);
        $('join-room').value = state.roomId;
        for (const info of message.peers || []) createPeer(info);
        render();
        setStatus('已进入房间。点击“开始共享”选择画面；点击“打开声音”收听朋友。', 'success');
        if(state.overlay) {toggleSound();toggleMic();}
        break;
      }
      case 'room-closed': {
        const socket=state.ws;state.ws=null;socket?.close();cleanupRoom();
        setStatus(message.message || '房主已离开，房间结束。','warning');break;
      }
      case 'peer-joined':
        createPeer(message.peer);
        renderMembers();
        setStatus(`${message.peer.name} 来到小屋。`, 'success');
        break;
      case 'peer-left': {
        const name = displayName(message.peerId);
        closePeer(message.peerId);
        if (state.presenterId === message.peerId) state.presenterId = null;
        render();
        setStatus(`${name} 已离开房间。`);
        break;
      }
      case 'signal': {
        const peer = state.peers.get(message.from);
        if (peer) receiveSignal(peer, message.payload || {});
        else if (!state.pendingSignals.enqueue(message.from, message.payload || {})) {
          setStatus('过早到达的连接信令过多，请重新加入房间。', 'warning');
        }
        break;
      }
      case 'media-tree':
        if(native)native.setTree(message,state.selfId,state.iceServers);
        break;
      case 'screen-signal':
        if(native)native.signal(message);
        break;
      case 'presenter': {
        state.presenterId = message.peerId;
        if (message.peerId === state.selfId && state.joined) {
          clearPresentationTimer();
          state.presentationPending = false;
          if (!state.screen) { send({ type: 'present', active: false }); state.presenterId = null; }
          else {
            syncAllTracks();
            const withAudio = state.screen.getAudioTracks().length > 0;
            setStatus(native ? 'Piik 原生采集已启动，正在连接观看者。发送指标与本地预览不同，请查看诊断。' : withAudio ? '屏幕与共享声音正在传输。本地预览静音，避免回声。' : '屏幕正在传输；此次选择未包含声音。如需声音，请重新共享并勾选浏览器中的“共享音频”。', withAudio ? 'success' : 'warning');
          }
        } else if (state.screen && !state.presentationPending) {
          stopSharing({ notify: false, message: false });
        }
        render();
        break;
      }
      case 'peer-state': {
        const peer = state.peers.get(message.peerId);
        if (peer) peer.mic = Boolean(message.mic);
        renderMembers();
        break;
      }
      case 'peer-profile': {
        const peer = state.peers.get(message.peerId);
        if (peer) { peer.name = message.name; peer.avatar = message.avatar; }
        if (message.peerId === state.selfId) state.name = message.name;
        renderMembers(); renderStage(); break;
      }
      case 'error':
        if(message.code==='STALE_MEDIA_ROUTE')break;
        clearTimeout(state.joinTimer);
        state.joining = false;
        if (state.presentationPending || message.code === 'PRESENTER_BUSY') stopSharing({ notify: false, message: false });
        setStatus(message.message || '操作未能完成，请重试。', 'error');
        renderControls();
        break;
    }
  }

  function ensureSocket(room) {
    if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (state.connecting) return state.connecting;
    state.connecting = new Promise((resolve, reject) => {
      const url = new URL('/ws', location.href);
      if(state.config?.overlay && room)url.searchParams.set('room',room);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      state.ws = socket;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('连接服务器超时，请确认服务已启动。')); }, 10000);
      socket.onopen = () => { clearTimeout(timeout); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('无法连接服务器，请检查地址和服务状态。')); };
      socket.onmessage = ({ data }) => {
        if (state.ws !== socket) return;
        try { receiveMessage(JSON.parse(data)); } catch { setStatus('收到无法处理的服务器消息，请刷新重试。', 'error'); }
      };
      socket.onclose = event => {
        diagnosticEvent({type:'socket-close',closeCode:event.code});
        clearTimeout(timeout);
        reject(new Error('服务器连接已关闭。'));
        if (state.ws !== socket) return;
        const wasActive = state.joined || state.joining;
        state.ws = null;
        cleanupRoom();
        if (wasActive) setStatus('与服务器的连接已断开，屏幕和麦克风已停止。请重新加入房间。', 'error');
      };
    }).finally(() => { state.connecting = null; });
    return state.connecting;
  }

  async function enterRoom(event, type) {
    event.preventDefault();
    await Promise.all([window.friendProfile.ready,configReady]);
    if (state.joining || state.joined) return;
    if (typeof RTCPeerConnection === 'undefined') { setStatus('此浏览器不支持 WebRTC，请使用新版 Chrome 或 Edge。', 'error'); return; }
    const name = $(`${type}-name`).value.trim();
    const password = $(`${type}-password`).value;
    if (!name || name.length > 24 || (!state.config?.overlay && (password.length < 8 || password.length > 128))) {
      setStatus('请填写昵称和 8 至 128 字符的房间口令。', 'error'); return;
    }
    const accessKey = $('access-key').value;
    if (state.config?.requiresAccessKey && !accessKey) { setStatus('请填写服务器管理员提供的站点口令。', 'error'); return; }
    state.joining = true;
    state.name = name;
    window.friendProfile.setGuestName(name);
    state.password = password;
    renderControls();
    try {
      let room=type==='join' ? $('join-room').value.trim() : '';
      if((native||state.config?.overlay) && state.ws) {const old=state.ws;state.ws=null;old.close();}
      if(native)await native.stop();
      await ensureSocket(room);
      const request = { type, name, password, accessKey, avatar: window.friendProfile.value.avatar, ...(native?{nativeMediaVersion:1}:{}) };
      if (type === 'join') request.roomId = state.config?.overlay ? room : room.toUpperCase();
      if (!send(request)) throw new Error('服务器连接不可用，请重试。');
      setStatus('正在进入房间…');
      state.joinTimer = setTimeout(() => {
        if (!state.joining) return;
        state.ws?.close();
        setStatus('房间操作超时，请重新连接。', 'error');
      }, 15000);
    } catch (error) {
      state.joining = false;
      state.password = '';
      renderControls();
      setStatus(error.message || '进入房间失败。', 'error');
    }
  }

  async function startSharing() {
    if (!state.joined || state.captureBusy) return;
    if (state.screen || state.presentationPending) { stopSharing(); return; }
    if (state.presenterId) { setStatus('已有朋友正在共享，请等对方停止后再开始。', 'warning'); return; }
    const epoch = state.epoch;
    const quality = currentQuality();
    state.captureBusy = true;
    renderControls();
    try {
      if(native){
        await configureMedia();
        const share=await native.start(quality,currentPriority(),quality.bitrate,shareSettings.capture);
        if(!share)return;
        if(epoch!==state.epoch||!state.joined){await native.stop();return;}
        state.screen=share.stream;state.presentationPending=true;
        if(!send({type:'present',active:true,shareId:share.shareId}))throw new Error('房间已断开，请重新加入');
        state.presentationTimer=setTimeout(()=>{if(state.presentationPending){stopSharing();setStatus('未获得共享位置，已停止采集。','warning');}},10000);
        setStatus('已选择原生采集来源，正在申请共享位置…');return;
      }
      // This call stays directly in the button's user activation, before any await.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.fps, max: quality.fps } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
      if (epoch !== state.epoch || !state.joined) { stopStream(stream); return; }
      if (state.presenterId && state.presenterId !== state.selfId) {
        stopStream(stream); setStatus('另一位朋友刚开始共享，已停止此次采集。', 'warning'); return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') { stopStream(stream); throw new Error('未获得可用的屏幕画面。'); }
      track.contentHint = $('sharing-priority').value === 'detail' ? 'detail' : 'motion';
      state.screen = stream;
      track.onended = () => stopSharing();
      state.presentationPending = true;
      if (!send({ type: 'present', active: true })) throw new Error('服务器已断开，无法开始共享。');
      state.presentationTimer = setTimeout(() => {
        if (!state.presentationPending) return;
        stopSharing({ message: false });
        setStatus('未获得房间共享权限，已停止采集。请重新尝试。', 'error');
      }, 7000);
      setStatus('已选择屏幕，正在申请房间共享位置…');
    } catch (error) {
      if (epoch !== state.epoch) return;
      stopSharing({ message: false });
      const messages = { NotAllowedError: '已取消共享或未授予权限。你可以再次点击“开始共享”。', NotFoundError: '未找到可共享的屏幕或窗口。', NotReadableError: '系统无法读取此画面，请检查权限或尝试其他窗口。', InvalidStateError: '浏览器需要前台页面中的按钮操作，请回到此页再点击“开始共享”。' };
      setStatus(messages[error.name] || error.message || '无法开始屏幕共享。', error.name === 'NotAllowedError' ? '' : 'error');
    } finally {
      if (epoch === state.epoch) { state.captureBusy = false; renderControls(); }
    }
  }

  async function toggleMic() {
    if (!state.joined || state.micBusy) return;
    const epoch = state.epoch;
    if (state.mic) {
      stopMic();
      await syncAllTracks();
      if (epoch !== state.epoch || !state.joined) return;
      send({ type: 'mic', active: false });
      render();
      setStatus('麦克风已关闭。');
      return;
    }
    state.micBusy = true;
    renderControls();
    try {
      const context = audioContext();
      await context.resume();
      if (epoch !== state.epoch || !state.joined) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
      if (epoch !== state.epoch || !state.joined) { stopStream(stream); return; }
      state.rawMic = stream;
      state.micSource = context.createMediaStreamSource(stream);
      state.micGain = context.createGain(); state.micGain.gain.value = state.micVolume / 100;
      state.micAnalyser = context.createAnalyser(); state.micAnalyser.fftSize = 256;
      const destination = context.createMediaStreamDestination();
      state.micSource.connect(state.micGain); state.micGain.connect(destination); state.micGain.connect(state.micAnalyser);
      state.mic = destination.stream;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('没有获得麦克风音轨。');
      track.onended = () => {
        diagnosticEvent({type:'microphone-ended'});
        stopMic(); syncAllTracks(); send({ type: 'mic', active: false }); render(); setStatus('麦克风设备已断开。', 'warning');
      };
      await syncAllTracks();
      if (epoch !== state.epoch || !state.joined) return;
      send({ type: 'mic', active: true });
      render();
      setStatus('麦克风已开启。建议使用耳机，减少扬声器回声。', 'success');
    } catch (error) {
      if (epoch !== state.epoch) return;
      stopMic();
      diagnosticEvent({type:'microphone-error',code:error.name});
      setStatus(error.name === 'NotAllowedError' ? '未获得麦克风权限。你仍可观看或共享屏幕。' : error.message || '无法开启麦克风。', 'warning');
    } finally {
      if (epoch === state.epoch) { state.micBusy = false; renderControls(); }
    }
  }

  async function toggleSound() {
    if (!state.joined) return;
    const epoch = state.epoch;
    try { await audioContext().resume(); } catch { setStatus('音频设备暂不可用，请重试。', 'warning'); return; }
    if (epoch !== state.epoch || !state.joined) return;
    state.soundEnabled = !state.soundEnabled;
    for (const peer of state.peers.values()) {
      updatePeerVolume(peer);
    }
    renderStage();
    renderControls();
    setStatus(state.soundEnabled ? '观看声音和朋友的麦克风声音已开启。' : '所有接收声音已静音；不会影响你的麦克风发送。');
  }

  async function changeQuality() {
    if (native) {
      if (!native.own) return;
      try {
        const quality = currentQuality();
        await native.update(quality, currentPriority(), quality.bitrate);
        setStatus('已更新编码目标，实际画质请看传输指标。', 'success');
      } catch (error) {
        setStatus(error.message, 'error');
      }
      return;
    }
    const track = state.screen?.getVideoTracks()[0];
    if (!track) return;
    const quality = qualityPresets[$('quality-select').value];
    for (const peer of state.peers.values()) { peer.videoScale=1;peer.qualityStress=0;peer.qualityRecovery=0; }
    track.contentHint = $('sharing-priority').value === 'detail' ? 'detail' : 'motion';
    try {
      await track.applyConstraints({ width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.fps, max: quality.fps } });
      const applied=await Promise.all([...state.peers.values()].map(applySenderQuality));
      renderStage();
      setStatus(applied.includes(false) ? '部分连接未接受画质参数；请查看实际发送尺寸，共享仍在继续。' : ($('sharing-priority').value === 'motion' ? '已切换为流畅优先：允许网络不足时降低尺寸。' : $('sharing-priority').value === 'detail' ? '已切换为文字细节优先；请查看实际帧率。' : '已保持目标尺寸；是否达到目标帧率请查看实际传输指标，受带宽和编码性能限制。'), applied.includes(false) ? 'warning' : 'success');
    } catch { setStatus('此分享来源无法切换到该画质，当前共享仍在继续。', 'warning'); }
  }

  async function copyText(value, success) {
    try { await navigator.clipboard.writeText(value); setStatus(success, 'success'); }
    catch { setStatus('浏览器未允许写入剪贴板，请手动选择并复制房间号或输入框中的口令。', 'warning'); }
  }

  function pathReasonLabel(reason) {
    return ({'pair-not-ready':'连接路径统计尚未就绪','candidate-stats-missing':'候选统计暂缺','candidate-fields-missing':'候选地址或协议统计暂缺','multiple-selected-pairs':'路径切换中','live-path-not-ready':'实时私网路径尚未就绪','live-path-unavailable':'实时私网路径暂不可读取','live-path-ambiguous':'实时路径存在歧义','overlay-udp':'指定私网 UDP 已验证','live-transport-missing':'实时传输对象暂缺','live-api-incomplete':'部分实时路径无法验证','live-api-unavailable':'实时路径读取暂缺','live-transport-not-ready':'实时传输尚未连接','live-pair-not-ready':'实时选中路径尚未就绪','connection-recovering':'连接恢复中','stats-unavailable':'暂时未能读取统计','address-mismatch':'地址不匹配','non-udp':'协议不是 UDP','non-overlay-candidate-type':'候选类型不允许','invalid-overlay-address':'私网地址无效'})[reason] || '等待路径验证';
  }

  async function refreshDiagnostics() {
    if (state.statsBusy || !state.joined) return;
    state.statsBusy = true;
    const epoch = state.epoch;
    try {
      let txRate=0,rxRate=0,hasRate=false;
      let maxRtt = null;
      let dimensions = '';
      const paths = new Set();
      const lines = [];
      const diagnosticPeers=[];
      for (const peer of state.peers.values()) {
        const reports = await peer.pc.getStats();
        let peerTx=0,peerRx=0,actualVideo=null,actualFps=null;
        let pair;
        reports.forEach((item) => {
          if (item.type === 'transport' && item.selectedCandidatePairId) pair = reports.get(item.selectedCandidatePairId);
          if (!pair && item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') pair = item;
          if (['outbound-rtp','inbound-rtp'].includes(item.type) && !item.isRemote) {
            const bytes=item.type==='outbound-rtp' ? item.bytesSent : item.bytesReceived;
            const previous=peer.statsSample.get(item.id);
            if (typeof bytes==='number' && previous && item.timestamp>previous.time && bytes>=previous.bytes) {
              const rate=(bytes-previous.bytes)*8/(item.timestamp-previous.time)/1000;
              if(item.type==='outbound-rtp')peerTx+=rate;else peerRx+=rate;hasRate=true;
            }
            const frames=item.type==='outbound-rtp' ? item.framesEncoded : item.framesDecoded;
            const frameSample=peer.frameSample ||= new Map();
            const priorFrame=frameSample.get(item.id);
            let measuredFps=priorFrame?.fps ?? null;
            if(Number.isFinite(frames) && (!priorFrame || item.timestamp-priorFrame.time>=500)) {
              measuredFps=priorFrame && frames>=priorFrame.frames ? (frames-priorFrame.frames)*1000/(item.timestamp-priorFrame.time) : null;
              frameSample.set(item.id,{time:item.timestamp,frames,fps:measuredFps});
            }
            if(typeof bytes==='number')peer.statsSample.set(item.id,{time:item.timestamp,bytes,frames});
            const isVideo=(item.kind || item.mediaType)==='video';
            if(isVideo && item.frameWidth && ((state.presenterId===state.selfId && item.type==='outbound-rtp') || (peer.id===state.presenterId && item.type==='inbound-rtp'))) {actualVideo=item;actualFps=measuredFps ?? item.framesPerSecond ?? null;}
          }
        });
        txRate+=peerTx;rxRate+=peerRx;
        if(diagnosticsEnabled)diagnosticPeers.push({id:peer.id,nodeId:peer.nodeId,state:peer.pc.connectionState,ice:peer.pc.iceConnectionState,signaling:peer.pc.signalingState,pathReason:peer.pathReason,sameAddressAsLocal:Boolean(state.address&&peer.address===state.address),privateVerified:peer.pathVerified,pathTransitions:peer.pathTransitions,mic:Boolean(peer.mic),localVolume:peer.volume,txMbps:peerTx,rxMbps:peerRx,rttMs:typeof pair?.currentRoundTripTime==='number'?pair.currentRoundTripTime*1000:null,availableOutgoingBps:pair?.availableOutgoingBitrate,iceCounters:peer.iceDebug,rtp:diagnosticRtp(reports)});
        let path = '等待连接';
        if (pair) {
          const local = reports.get(pair.localCandidateId);
          const remote = reports.get(pair.remoteCandidateId);
          path = state.overlay ? (peer.pathVerified && inspectMediaPath(peer.pc,reports,state.address,peer.address).status==='verified' ? '私有网卡（已验证）' : `私网验证中：${pathReasonLabel(peer.pathReason)}`) : local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN 中继' : '点对点直连';
          paths.add(path);
          if (typeof pair.currentRoundTripTime === 'number') maxRtt = Math.max(maxRtt || 0, pair.currentRoundTripTime * 1000);
        }
        else if(state.overlay) {
          path=peer.pathVerified && inspectMediaPath(peer.pc,reports,state.address,peer.address).status==='verified' ? '私有网卡（实时验证）' : `私网验证中：${pathReasonLabel(peer.pathReason)}`;
          paths.add(path);
        }
        const ice = peer.iceDebug;
        const candidateDetail = ` · 候选 本机发送${ice.localSent}/${ice.localSeen}（过滤${ice.localRejected}），对端收到${ice.remoteAllowed}/${ice.remoteSeen}（过滤${ice.remoteRejected}、已加${ice.remoteApplied}） · SDP ${ice.localDescriptionsSent}/${ice.remoteDescriptionsReceived}`;
        const direction=state.presenterId===state.selfId ? '发送' : '接收';
        let videoDetail='';
        if(actualVideo) {
          const size=`${actualVideo.frameWidth} × ${actualVideo.frameHeight}`;
          const display=`${size}${actualFps===null ? '' : ' / '+Math.round(actualFps)+' 帧'}`;
          dimensions=dimensions && dimensions!==display ? '各连接尺寸/帧率见诊断' : display;
          if(state.presenterId===state.selfId) {
            const target=qualityPresets[$('quality-select').value];
            const expectedWidth=target.width,expectedHeight=target.height;
            if(actualVideo.frameWidth<expectedWidth || actualVideo.frameHeight<expectedHeight || (actualFps!==null && actualFps<target.fps*0.95)) videoDetail=' · 未达共享目标';
          }
          const limitation=({bandwidth:'带宽受限',cpu:'编码性能受限',other:'其他限制',none:'未报告限制'})[actualVideo.qualityLimitationReason];
          const codec=reports.get(actualVideo.codecId)?.mimeType || '未知编码';
          const implementation=actualVideo.encoderImplementation ? ` / ${actualVideo.encoderImplementation}` : '';
          videoDetail+=` · ${codec}${implementation} · 实际${direction} ${size} / ${actualFps===null ? '—' : Math.round(actualFps)} 帧${limitation ? ' · '+limitation : ''}${peer.qualityApplied===false ? ' · 画质参数未完全应用' : ''}`;
        }
        const available=typeof pair?.availableOutgoingBitrate==='number' ? ` · 估计可发送 ${(pair.availableOutgoingBitrate/1e6).toFixed(2)} Mbps` : '';
        const incoming=actualVideo?.type==='inbound-rtp' ? actualVideo : [...reports.values()].find(s=>s.type==='remote-inbound-rtp' && (s.kind || s.mediaType)==='video');
        const loss=typeof incoming?.packetsLost==='number' ? ` · 累计丢包 ${incoming.packetsLost}` : '';
        const freezes=typeof actualVideo?.freezeCount==='number' ? ` · 累计卡顿 ${actualVideo.freezeCount} 次 / ${(actualVideo.totalFreezesDuration || 0).toFixed(1)} 秒` : '';
        const pathChanges=state.overlay ? ` · 路径验证切换 ${peer.pathTransitions} 次${peer.pathEvents.length ? '\n  '+peer.pathEvents.join('；') : ''}` : '';
        lines.push(`${peer.name}：${connectionLabel(peer)} · ${peerStateDetails(peer)}${candidateDetail} · ${path} · 发送 ${peerTx.toFixed(2)} / 接收 ${peerRx.toFixed(2)} Mbps${videoDetail}${available}${loss}${freezes}${pathChanges}${peer.restarts ? ' · 已尝试恢复连接' : ''}`);
      }
      if (epoch !== state.epoch) return;
      if(state.overlay&&native){try{const network=await fetch('/api/network-paths').then(r=>r.json());if(network.available){for(const peer of state.peers.values()){const path=network.peers.find(p=>p.nodeId===peer.nodeId);lines.push(`${peer.name} · ZeroTier 底层：${path?.direct?'DIRECT 直连路径可用':path?'未检测到直连（可能中继或尚未连通）':'路径未知'}${path?.latency!=null?' · '+path.latency+' ms':''}`);}if(network.tcpFallback)lines.push('ZeroTier 当前启用了 TCP 回退中继，可能增加延迟。');}else lines.push('ZeroTier 底层路径暂不可读；不能据此判断直连或中继。');}catch{lines.push('ZeroTier 底层路径查询失败。');}}
      const settings = state.screen?.getVideoTracks()[0]?.getSettings();
      if (state.presenterId === state.selfId && settings?.width) lines.push(`本机采集 ${settings.width} × ${settings.height}；上方实际发送尺寸由编码统计提供，可能与采集尺寸不同。`);
      $('metric-rtt').textContent = maxRtt === null ? '—' : `${Math.round(maxRtt)} ms`;
      $('metric-bitrate').textContent = !hasRate ? '—' : `${txRate.toFixed(2)} / ${rxRate.toFixed(2)} Mbps`;
      $('metric-quality').textContent = dimensions || '—';
      $('path-status').textContent = paths.size > 1 ? '多条连接（详见诊断）' : [...paths][0] || (state.peers.size ? '协商中' : '等待朋友');
      $('connection-diagnostics').textContent = lines.length ? lines.join('\n') : '房间里暂时只有你。朋友加入后会显示连接路径和状态。';
      let diagnosticMedia=null;
      if(native){
        const media=await native.stats(diagnosticsEnabled);diagnosticMedia=media;
        if(media){
          const actual=media.actual,frame=actual?.framesPerSecond;
          $('metric-quality').textContent=actual?.width?`${actual.width} × ${actual.height} · ${frame==null?'—':frame.toFixed(1)} 帧`:'等待视频统计';
          $('metric-bitrate').textContent=media.bitrate==null?'等待采样':`${media.bitrate.toFixed(2)} Mbps`;
          if(media.own&&!media.children){$('metric-bitrate').textContent='0 Mbps · 无观看者';$('metric-quality').textContent=(actual?.width?`${actual.width} × ${actual.height} · ${frame?.toFixed(1)||'—'} 帧`:'—')+'（本地预览）';}
          $('path-status').textContent=media.previewState==='failed'?'本机播放连接失败':media.previewState!=='connected'?'正在连接本机播放器':media.paths.some(p=>p.state!=='connected')?'Piik 媒体协商中':media.paths.length?'原生私网媒体已连接':'等待观看者';
          const status=media.paths.map(p=>`${p.state} · ${p.path}`).join('；');
          const mode=media.own?'本机预览不增加观看缓冲':media.playbackSupported===false?'当前播放器无法切换观看缓冲':media.playbackMode==='smooth'?'流畅观看：画面与共享声音允许适度缓冲':'实时观看：由播放器自动调整缓冲';
          const budget=media.videoCeiling==null?'':`\n上传预算 ${(media.uploadBudget/1e6).toFixed(1)} Mbps · 单路编码上限 ${(media.videoCeiling/1e6).toFixed(1)} Mbps；实际流量另含声音、补包和封装。`;
          $('connection-diagnostics').textContent=`Piik ${media.codec||'编码待定'} · ${media.own?'分享源':'原生接收'} · 下游 ${media.children} 人\n${status}\n${mode}${budget}\n原生编码并转发压缩视频；本机播放使用独立回环链路。码率是原生视频路径统计，不代表 ZeroTier 底层直连状态。\n${lines.join('\n')}`;
        }
      }
      diagnosticSample(diagnosticPeers,diagnosticMedia);
    } catch { /* A peer can close while stats are being collected. */ }
    finally { state.statsBusy = false; }
  }

  $('create-password').value = freshPassword();
  $('regenerate-password').addEventListener('click', () => { $('create-password').value = freshPassword(); });
  $('toggle-create-password').addEventListener('click', () => {
    const input = $('create-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggle-create-password').textContent = show ? '隐藏' : '显示';
    $('toggle-create-password').setAttribute('aria-label', show ? '隐藏房间口令' : '显示房间口令');
  });
  $('create-tab').addEventListener('click', () => selectTab('create'));
  $('join-tab').addEventListener('click', () => selectTab('join'));
  $('create-form').addEventListener('submit', (event) => enterRoom(event, 'create'));
  $('join-form').addEventListener('submit', (event) => enterRoom(event, 'join'));
  $('share-btn').addEventListener('click', startSharing);
  $('mic-btn').addEventListener('click', toggleMic);
  $('profile-mic-btn').addEventListener('click', toggleMic);
  $('mic-volume').addEventListener('input', () => {
    state.micVolume = Number($('mic-volume').value);
    $('mic-volume-value').textContent = state.micVolume + '%';
    setGain(state.micGain, state.micVolume / 100);
    window.friendProfile.saveVolume(state.micVolume); renderControls();
  });
  window.addEventListener('friend-profile', event => {
    state.micVolume = event.detail.micVolume; setGain(state.micGain, state.micVolume / 100);
    if (event.detail.name) state.name = event.detail.name;
    if (state.joined && !event.detail.signedIn) send({ type: 'profile', name: state.name, avatar: event.detail.avatar });
    render();
  });
  window.addEventListener('friend-account-changing', () => {
    send({ type: 'leave' }); const socket = state.ws; state.ws = null; socket?.close(); cleanupRoom();
  });
  setInterval(() => {
    if (!state.micAnalyser) return;
    const data = new Float32Array(state.micAnalyser.fftSize); state.micAnalyser.getFloatTimeDomainData(data);
    $('mic-level').value = Math.min(1, Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length) * 4);
  }, 120);
  $('sound-btn').addEventListener('click', toggleSound);
  $('quality-select').addEventListener('change', changeQuality);
  $('sharing-priority').addEventListener('change', changeQuality);
  for(const id of ['upload-budget','playback-mode'])$(id)?.addEventListener('change',()=>configureMedia().then(()=>{
    try{localStorage.setItem('friend-screen-media-preferences',JSON.stringify({uploadBudget:$('upload-budget').value,playbackMode:$('playback-mode').value}));}catch{}
    setStatus(id==='playback-mode'?($('playback-mode').value==='smooth'?'已选择流畅观看：画面和共享声音会有适度延迟，麦克风语音不变。':'已选择实时观看：缓冲较少，网络波动时可能更容易停顿。'):'已更新本机上传预算，视频会按下游人数分配；请查看实际画质与速率。');
  }).catch(error=>setStatus(error.message,'warning')));
  $('leave-btn').addEventListener('click', () => {
    send({ type: 'leave' });
    if(native||state.config?.overlay) {const socket=state.ws;state.ws=null;socket?.close();}

    cleanupRoom();
    selectTab('join');
    $('join-password').value = '';
    setStatus('已离开房间，屏幕与麦克风采集均已停止。');
  });
  $('copy-invite').addEventListener('click', async () => {
    if(state.config?.overlay) {copyText(state.roomId,'房间号已复制。朋友在客户端选择“加入房间”后粘贴。');return;}
    const base = state.config?.publicOrigin || location.origin;
    copyText(`${base}/#room=${state.roomId}`, '邀请链接已复制。请另外私发房间口令。');
  });
  $('copy-password').addEventListener('click', () => copyText(state.password, '房间口令已复制，请只发送给受邀请的朋友。'));
  $('fullscreen-btn').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('stage').requestFullscreen(); }
    catch { setStatus('当前浏览器不支持或未允许全屏。', 'warning'); }
  });
  $('stage-video').addEventListener('click', () => { playQuietly($('stage-video')); });
  window.addEventListener('hashchange', () => { if (!state.joined) parseInvitation(); });
  window.addEventListener('pagehide', () => {
    send({ type: 'leave' });
    cleanupRoom();
    state.ws?.close();
  });
  parseInvitation();
  render();
  const configReady=fetch('/api/config', { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error('config');
    return response.json();
  }).then((config) => {
    state.config = config;
    state.overlay=Boolean(config.overlay);state.address=config.address;
    state.maxParticipants = config.maxParticipants || 6;
    $('max-participants').textContent = state.maxParticipants;
    $('access-key-field').hidden = !config.requiresAccessKey;
    $('account-access-field').hidden = !config.requiresAccessKey;
    if(config.nativeMedia && native){
      document.body.classList.add('native-share-ui');
      $('share-settings-btn').hidden=false;
      try{const saved=JSON.parse(localStorage.getItem('friend-screen-media-preferences')||'{}');if([...$('upload-budget').options].some(o=>o.value===saved.uploadBudget))$('upload-budget').value=saved.uploadBudget;if(['smooth','realtime'].includes(saved.playbackMode))$('playback-mode').value=saved.playbackMode;}catch{}
      configureMedia().catch(error=>setStatus(error.message,'warning'));
      document.querySelector('.detail-card p').textContent='Piik 原生采集与显卡编码；媒体限定在已批准私网。选择整个屏幕时请避免播放敏感内容。';
    }
    if(config.overlay) {
      for(const id of ['create-password','join-password']) {$(id).required=false;$(id).closest('.field').hidden=true;}
      $('join-room').maxLength=61;$('join-room').minLength=61;$('join-room').pattern='FSR1-[A-Za-z0-9_\\-]{56}';$('join-room').placeholder='粘贴 FSR1- 开头的完整房间号';
      $('copy-invite').textContent='复制房间号';$('copy-password').hidden=true;
      document.querySelector('.invite-actions + .field-hint').textContent='只有本小屋已批准的设备才能加入。房主离开后房间结束。';
      document.querySelector('.setup-footnote').textContent='最多 8 人 · 仅批准设备 · 不录制内容';
      $('quality-select').value='1080p60';
      $('status-message').textContent='进房后请求麦克风授权并开启收听；可以随时闭麦或静音。共享始终需要选择来源。';
    }
    updateEnvironment();
  }).catch(() => updateEnvironment());
  setInterval(refreshDiagnostics, 3000);
})();
