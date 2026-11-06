'use strict';

const byId = id => document.getElementById(id);
const channel = window.desktopUpdates;
const messages = {
  unavailable: '当前运行方式无法安装客户端更新。',
  unconfigured: '填写你的 GitHub 发布仓库地址，即可检查更新。',
  idle: '可以检查客户端更新。',
  configuring: '正在保存仓库…',
  checking: '正在检查更新…',
  current: '当前已是最新版本。',
  available: '有新版本可下载。',
  downloading: '正在后台下载更新，可以关闭此窗口继续使用。',
  ready: '下载完成。停止共享后，可以重启并更新。',
  installing: '正在启动更新安装，Windows 可能请求管理员授权。',
  error: '检查更新遇到问题。',
};

function render(state) {
  byId('current-version').textContent = '当前版本 ' + state.current;
  byId('update-status').textContent = messages[state.phase] ?? '';
  byId('update-error').textContent = state.error;
  byId('update-error').hidden = !state.error;
  byId('release').hidden = !state.version;
  byId('release-version').textContent = state.version ? '版本 ' + state.version : '';
  byId('release-notes').textContent = state.notes;
  byId('progress-box').hidden = !['downloading', 'ready', 'installing'].includes(state.phase);
  byId('update-progress').value = state.progress;
  byId('progress-value').textContent = state.progress + '%';
  byId('check-update').disabled = !['idle', 'current', 'error', 'available'].includes(state.phase);
  byId('download-update').hidden = state.phase !== 'available';
  byId('install-update').hidden = !['ready', 'installing'].includes(state.phase);
  byId('install-update').disabled = state.phase === 'installing';
  byId('update-repository').hidden = state.phase === 'unavailable';
  byId('save-repository').disabled = ['configuring', 'checking', 'downloading', 'installing'].includes(state.phase);
  if (state.phase === 'unconfigured') byId('update-repository').open = true;
  const url = byId('repository-url');
  if (document.activeElement !== url && state.repository) url.value = state.repository;
}

async function perform(action, value) {
  try {
    const state = await channel.action(action, value);
    render(state);
    return state;
  }
  catch {
    byId('update-error').textContent = '更新窗口连接中断，请关闭后重试。';
    byId('update-error').hidden = false;
  }
}

channel.onState(render);
for (const action of ['check', 'download', 'install']) {
  byId(action + '-update').addEventListener('click', () => perform(action));
}
byId('update-repository-form').addEventListener('submit', async event => {
  event.preventDefault();
  const state = await perform('configure', byId('repository-url').value);
  if (state?.phase === 'idle' && !state.error) await perform('check');
});
perform('state');
