'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  let sources = [];
  let selectedId = null;
  let filter = 'all';
  let busy = false;
  function status(message, error = false) { $('picker-status').textContent = message; $('picker-status').classList.toggle('error', error); }
  function render() {
    const list = $('sources-list');
    list.replaceChildren();
    const visible = sources.filter((source) => filter === 'all' || source.kind === filter);
    $('source-count').textContent = `${visible.length} 个来源`;
    for (const source of visible) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'source-option';
      button.dataset.sourceId = source.id; button.dataset.kind = source.kind; button.dataset.name = source.name;
      button.setAttribute('aria-pressed', String(source.id === selectedId));
      const preview = document.createElement('div'); preview.className = 'source-preview';
      if (source.thumbnail) {
        const image = document.createElement('img'); image.src = source.thumbnail; image.alt = ''; image.draggable = false;
        preview.append(image);
      } else { const unavailable = document.createElement('span'); unavailable.textContent = '暂无预览'; preview.append(unavailable); }
      const kind = document.createElement('span'); kind.className = 'source-kind'; kind.textContent = source.kind === 'screen' ? '整个屏幕' : '窗口';
      preview.append(kind);
      const name = document.createElement('span'); name.className = 'source-name'; name.textContent = source.name; name.title = source.name;
      button.append(preview, name);
      button.addEventListener('click', () => { if (busy) return; selectedId = source.id; render(); status(`已选择：${source.name}。确认后才会共享。`); });
      list.append(button);
    }
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'source-empty'; empty.textContent = '没有找到此类来源。请打开需要共享的窗口后取消并重试。'; list.append(empty); }
    $('confirm-share-btn').disabled = busy || !selectedId;
  }
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      for (const tab of document.querySelectorAll('[data-filter]')) { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); }
      render();
    });
  }
  async function cancel() { if (busy) return; busy = true; try { await window.desktopPicker.cancel(); } catch { window.close(); } }
  $('cancel-share-btn').addEventListener('click', cancel);
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } });
  $('confirm-share-btn').addEventListener('click', async () => {
    if (!selectedId || busy) return;
    busy = true; $('confirm-share-btn').disabled = true; $('cancel-share-btn').disabled = true;
    status('正在开始共享所选来源…');
    try { await window.desktopPicker.select(selectedId, $('system-audio').checked); }
    catch { busy = false; $('cancel-share-btn').disabled = false; render(); status('未能共享此来源，请取消后重试。', true); }
  });
  if (!window.desktopPicker) { status('选择器初始化失败，请关闭此窗口后重试。', true); return; }
  window.desktopPicker.getSources().then((result) => {
    sources = result.sources;
    $('system-audio').checked = false;
    $('system-audio').disabled = !result.audioAllowed;
    if (!result.audioAllowed) $('audio-note').textContent = '当前请求或系统不支持共享系统声音。';
    render();
    status(sources.length ? '选择一个来源。缩略图只用于本次选择，不会保存。' : '没有找到可共享的来源，请取消后重试。');
  }).catch(() => status('无法取得共享来源，请取消后重试。', true));
})();
