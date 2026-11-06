'use strict';
(() => {
  const $=id=>document.getElementById(id), api=window.desktopLauncher;
  let busy=false,initialized=false,avatar='',view={};
  const status=(text,error=false)=>{$('launcher-status').textContent=text;$('launcher-status').classList.toggle('error',error);};
  $('launcher-update-btn').addEventListener('click', () => api.openUpdates().catch(() => status('无法打开更新窗口。', true)));
  function render(value) {
    view=value;$('app-version').textContent='v'+(value.version||'0.3.5');
    if(value.legacy){$('legacy-tests').hidden=false;$('overlay-setup').hidden=true;return;}
    if(!initialized) {
      $('nickname').value=value.profile?.name||'';avatar=value.profile?.avatar||'';
      $('administrator').checked=Boolean(value.administrator || value.administratorPending);$('network-id').value=value.networkId||'';
      if(value.administrator)$('administrator-settings').open=true;renderAvatar();initialized=true;
    }
    $('node-id').textContent=value.nodeId||'先完成 Windows 授权和入网申请';$('device-id').textContent=value.deviceId?.slice(-12)||'未取得';
    $('phase-title').textContent=({setup:'等待首次设置',waiting:'等待管理员批准',connected:'已连接',failed:'连接失败'})[value.phase]||'正在连接';
    $('connection-message').textContent=value.message||'';$('network-state').textContent=value.address||'尚未分配私网地址';
    $('enter-btn').disabled=!value.connected||busy;$('exit-device').hidden=!value.networkId;
    $('admin-panel').hidden=!value.administrator;$('current-invitation').value=value.invitation||'';
    $('invite-field').hidden=$('administrator').checked||value.registered;
    $('setup-btn').hidden=value.registered;$('nickname').disabled=value.registered;
    $('administrator-settings').hidden=value.registered;$('avatar-file').disabled=value.registered;
    if(value.networkId)$('invitation').placeholder='已保存邀请码；留空重试，或粘贴管理员提供的新邀请码';
    const list=$('approved-members');list.replaceChildren();
    for(const member of value.members||[]) {
      const li=document.createElement('li'),label=document.createElement('span');label.textContent=member.name+' · '+member.deviceId.slice(-8)+' · ZeroTier '+member.nodeId;li.append(label);
      if(member.deviceId!==value.deviceId) {const button=document.createElement('button');button.type='button';button.className='text-link';button.textContent='移除设备';button.onclick=()=>{if(confirm('移除 '+member.name+'？之后还需在 ZeroTier 后台取消该设备授权。'))run(()=>api.admin({type:'remove',deviceId:member.deviceId}),'应用凭证已撤销；请立即在平台后台 Deauthorize 相同 ZeroTier ID。');};li.append(button);}list.append(li);
    }
  }
  function renderAvatar(){ $('avatar-preview').hidden=!avatar;$('avatar-placeholder').hidden=Boolean(avatar);if(avatar)$('avatar-preview').src=avatar; }
  async function refresh(){try{render(await api.getSettings());}catch{status('无法读取设备状态，请重启客户端。',true);}}
  async function run(action,success='操作完成。') {
    if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);status('正在处理，请稍候…');
    try{const result=await action();if(!result.ok)throw new Error(result.message);status(success);await refresh();}
    catch(e){status(e.message||'操作失败，请重试。',true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);$('enter-btn').disabled=!view.connected;}
  }
  $('administrator').onchange=()=>{$('invite-field').hidden=$('administrator').checked;};
  $('setup-form').onsubmit=e=>{e.preventDefault();run(()=>api.setup({name:$('nickname').value,avatar,administrator:$('administrator').checked,networkId:$('network-id').value.trim(),invite:$('invitation').value.trim()}),'申请已提交。请把 ZeroTier ID 发给管理员，等待批准。');};
  $('authorize-btn').onclick=()=>run(()=>api.authorize(),'Windows 授权完成，请填写首次设置或重新检查。');
  $('retry-btn').onclick=()=>run(()=>api.retry(),'状态已刷新。');$('enter-btn').onclick=()=>run(()=>api.enter());
  $('exit-device').onclick=()=>run(()=>api.logout(),'设备操作已完成。');
  $('copy-invitation').onclick=()=>navigator.clipboard.writeText($('current-invitation').value).then(()=>status('邀请码已复制，请只私发给朋友。')).catch(()=>{ $('current-invitation').select();status('请按 Ctrl+C 复制已选中的邀请码。');});
  $('rotate-invitation').onclick=()=>{if(confirm('旧邀请码将立即失效；已经批准的设备仍可使用。继续？'))run(()=>api.admin({type:'rotate'}),'旧邀请码已撤销，请复制新邀请码。');};
  $('avatar-file').onchange=async()=>{
    try{const file=$('avatar-file').files[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5242880)throw new Error('请选择 5 MB 以内的 PNG、JPG 或 WebP');
      const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas');canvas.width=canvas.height=128;const size=Math.min(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.fillStyle='#263e35';context.fillRect(0,0,128,128);context.drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,128,128);bitmap.close();
      const next=canvas.toDataURL('image/jpeg',.82);if(next.length>32768)throw new Error('头像过于复杂，请换一张图片');avatar=next;renderAvatar();
    }catch(e){status(e.message,true);}
  };
  $('local-mode-btn').onclick=()=>run(()=>api.startLocal());$('server-form').onsubmit=e=>{e.preventDefault();run(()=>api.connect($('server-origin').value));};
  refresh();setInterval(()=>{if(!busy)refresh();},2500);
})();
