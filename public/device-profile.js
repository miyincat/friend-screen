'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let value={name:'',avatar:'',micVolume:100}, deviceId='', saving=Promise.resolve(), timer;
  const status=text=>{$('profile-status').textContent=text;};
  async function api(route,data) {
    const res=await fetch('/api/device'+route,{cache:'no-store',...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})});
    const result=await res.json();if(!res.ok)throw new Error(result.error||'资料保存失败');return result;
  }
  function avatar(element,data,name) {
    element.replaceChildren();
    if(/^data:image\/jpeg;base64,/.test(data||'') && data.length<=32768) {const image=document.createElement('img');image.src=data;image.alt=(name||'我')+'的头像';element.append(image);}
    else element.textContent=Array.from(name||'我')[0];
  }
  function render() {
    avatar($('self-avatar'),value.avatar,value.name);$('self-name').textContent=value.name;
    $('account-label').textContent='本机设备 · '+deviceId.slice(-8);$('account-open').textContent='资料';
    $('account-logout').hidden=false;$('account-logout').textContent='退出当前设备（需要重新批准）';
    $('profile-name').value=value.name;$('mic-volume').value=value.micVolume;$('mic-volume-value').textContent=value.micVolume+'%';
    for(const kind of ['create','join']) {$(kind+'-name').value=value.name;$(kind+'-name').readOnly=true;}
    window.dispatchEvent(new CustomEvent('friend-profile',{detail:{...value,signedIn:false}}));
  }
  function save(patch) {
    saving=saving.catch(()=>{}).then(async()=>{const result=await api('/profile',{...value,...patch});value=result.profile;render();});return saving;
  }
  window.friendProfile={get value(){return {...value};},get user(){return {id:deviceId,...value};},avatar,setGuestName(){},saveVolume(v){value.micVolume=v;clearTimeout(timer);timer=setTimeout(()=>save({micVolume:v}).catch(e=>status(e.message)),350);}};
  $('account-open').onclick=()=>{$('profile-details').open=true;$('profile-name').focus();};
  $('profile-form').onsubmit=e=>{e.preventDefault();save({name:$('profile-name').value.trim()}).then(()=>status('昵称已保存')).catch(e=>status(e.message));};
  $('avatar-upload').onclick=()=>$('avatar-file').click();
  $('avatar-reset').onclick=()=>save({avatar:''}).catch(e=>status(e.message));
  $('avatar-file').onchange=async()=>{
    const file=$('avatar-file').files[0];if(!file)return;$('avatar-upload').disabled=true;
    try {
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024)throw new Error('请选择不超过 5 MB 的 PNG、JPG 或 WebP 图片');
      const bitmap=await createImageBitmap(file), canvas=document.createElement('canvas');canvas.width=canvas.height=128;
      const context=canvas.getContext('2d'), size=Math.min(bitmap.width,bitmap.height);context.fillStyle='#263e35';context.fillRect(0,0,128,128);
      context.drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,128,128);bitmap.close();
      const data=canvas.toDataURL('image/jpeg',.82);if(data.length>32768)throw new Error('头像过于复杂，请换一张图片');await save({avatar:data});status('头像已保存');
    } catch(e){status(e.message);}finally{$('avatar-upload').disabled=false;$('avatar-file').value='';}
  };
  $('account-logout').onclick=()=>api('/exit',{}).catch(e=>status(e.message));
  $('account-dialog').hidden=true;
  window.friendProfile.ready=api('').then(result=>{value=result.profile;deviceId=result.deviceId;render();}).catch(()=>status('无法读取设备身份，请重新打开客户端。'));
})();
