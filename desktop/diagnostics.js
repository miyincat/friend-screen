'use strict';
const $=id=>document.getElementById(id),api=window.desktopDiagnostics;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const format=(v,unit,digits=1)=>finite(v)?v.toFixed(digits)+' '+unit:'—';
let state={},pending=false;
const marks={stutter:'画面卡顿','video-stutter-audio-ok':'画面卡顿，声音正常',blur:'画面模糊','no-video':'没有画面','no-audio':'没有声音',disconnected:'掉线',other:'其他问题'};
function render(s){
  state=s;const r=s.snapshot,m=r?.media,h=s.host;
  $('record-state').textContent=s.busy?'正在保存…':s.active?'● 正在记录':'未记录';$('record-state').classList.toggle('recording',s.active);
  $('record-toggle').textContent=s.active?'停止并保存到桌面':'开始记录';$('record-toggle').disabled=s.busy||pending;
  $('record-toggle').setAttribute('aria-pressed',String(Boolean(s.active)));
  $('mark').disabled=!s.active||s.busy;$('export-last').disabled=s.active||s.busy;$('show-file').disabled=!s.zip&&!s.folder;
  $('record-info').textContent=s.error||`${s.active?'记录中':'已停止'} · ${s.samples||0} 次采样 / ${s.events||0} 条事件 · ${format((s.bytes||0)/1024,'KiB')} · ${s.deviceTag||'设备尚未就绪'}${s.zip?'\n已导出：'+s.zip:s.folder?'\n原始文件：'+s.folder:'。开始后输出到桌面。'}`;
  $('video').textContent=m?.actual?.width?`${m.actual.width} × ${m.actual.height} · ${format(m.actual.framesPerSecond,'帧')}`:'—';
  $('role').textContent=({sharing:'正在共享',viewing:'正在观看',waiting:'房间内等待共享',idle:'尚未加入房间'})[r?.role]||'等待页面数据';
  $('rate').textContent=format(m?.mbps,'Mbps');$('target').textContent=r?.target?.width?`目标 ${r.target.width}×${r.target.height} / ${r.target.fps} 帧${m?.videoCeiling!=null?' · 单路上限 '+format(m.videoCeiling/1e6,'Mbps'):''}`:'目标：—';
  const peers=r?.peers||[],latency=peers.map(p=>p.voiceRttMs).filter(finite),loss=peers.flatMap(p=>p.rtp).filter(t=>t.kind==='audio'&&t.direction==='inbound-rtp').map(t=>t.packetsLost).filter(finite);
  $('rtt').textContent=latency.length?format(Math.max(...latency),'ms',0):'—';$('loss').textContent=loss.length?format(loss.reduce((a,b)=>a+b,0),'包',0):'—';
  $('voice').textContent=r?`麦克风${r.microphone?'开启':'关闭'} / 发送 ${r.microphoneVolume??'—'}% / 收听${r.listening?'开启':'关闭'}`:'麦克风 / 收听状态：—';
  const resources=h?.resources;$('resources').textContent=`${format(resources?.electronCpuPercent,'%')} / ${format(resources?.electronMemoryMiB,'MiB',0)}`;
  $('native-resources').textContent=`原生媒体：${format(resources?.nativeCpuPercent,'%')} / ${format(resources?.nativeMemoryMiB,'MiB',0)}`;
  $('system-resources').textContent=`整机 CPU ${format(resources?.systemCpuPercent,'%')} · 空闲内存 ${format(resources?.systemFreeMemoryMiB,'MiB',0)}`;
  const zt=h?.network,known=peers.map(p=>zt?.peers?.find(n=>n.nodeTag===p.nodeTag)).filter(Boolean);
  $('network').textContent=!zt?.available?'未知':known.length?`${known.filter(p=>p.direct).length} / ${known.length} 条直连`:'等待成员匹配';
  $('fallback').textContent=zt?.tcpFallback?'检测到 TCP 回退启用':'无直连证据不等于一定走中继';
  $('peers').replaceChildren(...peers.map(p=>{const tr=document.createElement('tr'),n=zt?.peers?.find(n=>n.nodeTag===p.nodeTag);for(const text of [p.deviceTag||'未知',`${p.state||'未知'} / ${p.privateVerified?'已验证':'待验证'}${p.sameAddressAsLocal?' · 与本机同址':''}`,format(p.voiceRttMs,'ms',0),`${p.localVolume??'—'}%`,n?n.direct?'DIRECT':'无活动直连':'未知']){const td=document.createElement('td');td.textContent=text;tr.append(td);}return tr;}));
  $('freshness').textContent=s.ageMs==null?'页面数据尚未到达。':s.ageMs>7500?'页面数据已过期，可能已离房、刷新或页面无响应。':`页面数据距今 ${(s.ageMs/1000).toFixed(1)} 秒。丢包和 RTT 属于语音链路。`;
  const native=(s.native||[]).filter(n=>n.diagnostics);
  $('native-paths').replaceChildren(...native.map(n=>{
    const d=n.diagnostics,t=d.rtp,q=d.queue,i=d.ingress,tr=document.createElement('tr'),stale=n.ageMs>7500;
    const values=[`${d.scope==='local-playback'?'本机播放':'对外视频'} · ${d.direction==='inbound'?'接收':'发送'}\n${n.edgeTag||'未知'}${d.sourceEdgeTag?'\n上游 '+d.sourceEdgeTag:''}`,
      `${d.state||'未知'}${stale?' · 数据过期':''}\n采样距今 ${format((n.ageMs??NaN)/1000,'秒')}`,
      `RTCP ${format(d.rtcpRttMs,'ms')}\nICE ${format(d.iceRttMs,'ms')}`,
      `净缺包 ${format(t?.packetsLost,'包',0)}\n乱序 ${format(t?.packetsOutOfOrder,'包',0)} · NACK ${format(t?.nackRequests,'次',0)}`,
      q?`${q.pacing==='local-direct'?'本机直通':q.pacing==='network-paced'?'网络节奏控制':'发送队列'}\n待发 ${format(q.pendingPackets,'包',0)} / 最老 ${format(q.oldestQueuedMs,'ms')}\n队列满丢弃 ${format(q.overflowDrops,'包',0)} · 写错 ${format(q.writeErrors,'次',0)}`:i?`读入 ${format(i.readPackets,'包',0)} / RTX ${format(i.rtxPackets,'包',0)}\n视频最近包 ${format(i.lastVideoPacketAgeMs,'ms')}`:'—'];
    for(const text of values){const td=document.createElement('td');td.textContent=text;tr.append(td);}return tr;
  }));
  $('native-status').textContent=native.length?'原生统计约每 2 秒更新；以下计数为累计值。NACK 表示补包请求，不能直接当成丢包率。':'等待原生视频统计。双方需使用 0.3.8 或更新版本并开始共享。';
  const video=m?.localPlayback?.find(t=>t.kind==='video'&&t.direction==='inbound-rtp'),audio=m?.localPlayback?.find(t=>t.kind==='audio'&&t.direction==='inbound-rtp');
  $('playback-recovery').textContent=`${m?.own?'分享源预览':m?.playbackMode==='smooth'?'流畅观看':m?.playbackMode==='realtime'?'实时观看':'本机视频播放'}：组装 ${format(video?.framesReceived,'帧',0)} · 解码 ${format(video?.framesDecoded,'帧',0)} · 关键帧 ${format(video?.keyFramesDecoded,'帧',0)} · 冻结 ${format(video?.freezeCount,'次',0)} / ${format(video?.totalFreezesDuration,'秒')} · NACK ${format(video?.nackCount,'报文',0)}`;
  $('screen-audio').textContent=`共享声音播放（非麦克风）：收包 ${format(audio?.packetsReceived,'包',0)} · 净缺包 ${format(audio?.packetsLost,'包',0)} · 音频补偿 ${format(audio?.concealedSamples,'采样',0)}`;
  $('events').replaceChildren(...(s.recent||[]).slice().reverse().map(e=>{const li=document.createElement('li');li.textContent=`${new Date(e.utc).toLocaleTimeString()} · ${e.type==='mark'?'问题标记：'+marks[e.mark]:e.type}${e.state?' · '+e.state:''}${e.reason?' · '+e.reason:''}`;return li;}));
}
async function action(name,value){if(pending)return;pending=true;render(state);try{render(await api.action(name,value));}catch{$('record-info').textContent='诊断操作失败，请重试；房间和媒体不受影响。';}finally{pending=false;$('record-toggle').disabled=Boolean(state.busy);}}
$('record-toggle').onclick=()=>action(state.active?'stop':'start');$('mark').onclick=()=>action('mark',$('mark-kind').value);$('show-file').onclick=()=>action('show-file');$('export-last').onclick=()=>action('export-last');
api.onState(render);api.action('state').then(render);
