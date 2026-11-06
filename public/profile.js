'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let guest = { name: '', avatar: '', micVolume: 100 }, user = null, mode = 'login', busy = false, volumeTimer, saving = Promise.resolve();
  try {
    const saved = JSON.parse(localStorage.getItem('friend-profile') || '{}');
    if (typeof saved.name === 'string') guest.name = saved.name.slice(0, 24);
    if (/^data:image\/jpeg;base64,/.test(saved.avatar) && saved.avatar.length <= 32768) guest.avatar = saved.avatar;
    if (Number.isInteger(saved.micVolume) && saved.micVolume >= 0 && saved.micVolume <= 200) guest.micVolume = saved.micVolume;
  } catch { /* Storage may be disabled. */ }
  const profile = () => user || guest;
  const status = text => { $('profile-status').textContent = text; };
  async function api(route, data) {
    const response = await fetch('/api/account' + route, { credentials: 'same-origin', cache: 'no-store',
      ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '账号服务暂不可用');
    return result;
  }
  function avatar(element, value, name) {
    element.replaceChildren();
    if (value && /^data:image\/jpeg;base64,/.test(value) && value.length <= 32768) {
      const image = document.createElement('img'); image.src = value; image.alt = `${name || '我'}的头像`; element.append(image);
    } else element.textContent = Array.from(name || '我')[0].toUpperCase();
  }
  function render(emit = true) {
    const p = profile();
    avatar($('self-avatar'), p.avatar, p.name);
    $('self-name').textContent = p.name || '我的小屋身份';
    $('account-label').textContent = user ? '@' + user.username : '游客 · 登录后保存资料';
    $('account-open').textContent = user ? '账号' : '登录';
    $('account-logout').hidden = !user;
    $('profile-name').value = p.name;
    $('mic-volume').value = p.micVolume;
    $('mic-volume-value').textContent = p.micVolume + '%';
    for (const kind of ['create', 'join']) {
      if (p.name) $(kind + '-name').value = p.name;
      $(kind + '-name').readOnly = Boolean(user);
    }
    if (emit) window.dispatchEvent(new CustomEvent('friend-profile', { detail: { ...p, signedIn: Boolean(user) } }));
  }
  async function save(patch) {
    const owner = user?.id || null;
    const task = async () => {
      if ((user?.id || null) !== owner) return;
      const next = { ...profile(), ...patch };
      if (user) {
        const volumeAtSend = profile().micVolume;
        const result = await api('/profile', { name: next.name, avatar: next.avatar, micVolume: next.micVolume });
        if (user?.id !== owner) return;
        if (profile().micVolume !== volumeAtSend) result.user.micVolume = profile().micVolume;
        user = result.user;
      } else {
        guest = next;
        try { localStorage.setItem('friend-profile', JSON.stringify(guest)); } catch { status('浏览器未允许保存资料'); }
      }
      render();
    };
    saving = saving.catch(() => {}).then(task);
    return saving;
  }
  window.friendProfile = { get user() { return user; }, get value() { return { ...profile() }; }, avatar,
    setGuestName(name) {
      if (user) return;
      guest.name = name;
      try { localStorage.setItem('friend-profile', JSON.stringify(guest)); } catch { /* Optional guest persistence. */ }
      render();
    },
    saveVolume(value) { profile().micVolume = value; clearTimeout(volumeTimer); volumeTimer = setTimeout(() => save({ micVolume: value }).catch(e => status(e.message)), 350); },
  };
  $('account-open').onclick = () => {
    if (user) { $('profile-details').open = true; $('profile-name').focus(); return; }
    $('account-error').textContent = ''; $('account-dialog').showModal(); $('account-username').focus();
  };
  $('account-close').onclick = () => $('account-dialog').close();
  function selectMode(next) {
    mode = next; const register = mode === 'register';
    $('register-name-field').hidden = !register; $('register-name').required = register;
    $('register-confirm-field').hidden = !register; $('account-confirm').required = register;
    $('account-password').autocomplete = register ? 'new-password' : 'current-password';
    $('account-submit').textContent = register ? '注册并登录' : '登录';
    $('account-title').textContent = register ? '建立你的小屋身份' : '欢迎回到小屋';
    $('login-tab').classList.toggle('active', !register); $('register-tab').classList.toggle('active', register);
    $('account-error').textContent = '';
  }
  $('login-tab').onclick = () => selectMode('login'); $('register-tab').onclick = () => selectMode('register');
  $('account-form').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    if (mode === 'register' && $('account-password').value !== $('account-confirm').value) { $('account-error').textContent = '两次密码不一致'; return; }
    busy = true; $('account-submit').disabled = true;
    try {
      await saving.catch(() => {});
      const result = await api('/' + mode, { username: $('account-username').value, password: $('account-password').value,
        name: $('register-name').value, remember: $('account-remember').checked, accessKey: $('account-access').value });
      window.dispatchEvent(new Event('friend-account-changing'));
      user = result.user; $('account-dialog').close(); $('account-password').value = ''; $('account-confirm').value = '';
      if ($('account-access').value) $('access-key').value = $('account-access').value;
      render(); status('已登录，可在这里修改头像和昵称。');
    } catch (e) { $('account-error').textContent = e.message; }
    finally { busy = false; $('account-submit').disabled = false; }
  };
  $('account-logout').onclick = async () => {
    if (busy) return; busy = true;
    try {
      clearTimeout(volumeTimer); await saving.catch(() => {}); await api('/logout', {});
      window.dispatchEvent(new Event('friend-account-changing')); user = null; guest = { name: '', avatar: '', micVolume: 100 };
      for (const kind of ['create', 'join']) $(kind + '-name').value = '';
      render(); status('已退出账号，下次需要重新登录。');
    } catch (e) { status(e.message); } finally { busy = false; }
  };
  $('profile-form').onsubmit = async event => {
    event.preventDefault();
    try { await save({ name: $('profile-name').value.trim() }); status('昵称已保存'); } catch (e) { status(e.message); }
  };
  $('avatar-upload').onclick = () => $('avatar-file').click();
  $('avatar-reset').onclick = () => save({ avatar: '' }).then(() => status('已恢复默认头像')).catch(e => status(e.message));
  $('avatar-file').onchange = async () => {
    const file = $('avatar-file').files[0]; if (!file) return;
    $('avatar-upload').disabled = true;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的 PNG、JPG 或 WebP 图片');
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d'); context.fillStyle = '#263e35'; context.fillRect(0, 0, 128, 128);
      const size = Math.min(bitmap.width, bitmap.height);
      context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 128, 128); bitmap.close();
      const data = canvas.toDataURL('image/jpeg', 0.82);
      if (data.length > 32768) throw new Error('图片过于复杂，请换一张较简单的头像');
      await save({ avatar: data }); status('新头像已保存');
    } catch (e) { status(e.message || '无法读取这张图片'); }
    finally { $('avatar-file').value = ''; $('avatar-upload').disabled = false; }
  };
  render(false);
  window.friendProfile.ready = api('').then(result => { user = result.user; render(); }).catch(() => status('暂时无法读取账号，请重试登录。'));
})();
