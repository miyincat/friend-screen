function captureKey(source) {
  return [source.kind, source.sourceId, source.pid, source.creationTime].join(':');
}

function encoderChoices(adapters, capabilities, preference) {
  const hardware = adapters.flatMap(adapter => adapter.hardwareH264.map(encoder => ({
    adapterIndex: adapter.index,
    encoderIndex: encoder.index,
    codec: 'h264',
    name: adapter.name + ' · ' + encoder.name,
  })));
  const software = capabilities.softwareVP8 ? [{
    adapterIndex: adapters[0]?.index ?? 0,
    encoderIndex: 0,
    codec: 'vp8',
    name: '软件 VP8',
  }] : [];
  const paths = [...hardware, ...software];
  return preference === 'auto' ? paths : paths.filter(path => path.codec === preference);
}

export async function pickNativeSource({ request, health, preferences, signal }) {
  if (signal?.aborted) return null;
  const dialog = document.getElementById('native-source-dialog');
  const grid = dialog.querySelector('.source-grid');
  const status = dialog.querySelector('.source-status');
  const refresh = dialog.querySelector('.source-refresh');
  const confirm = dialog.querySelector('button[value="share"]');
  const encoder = dialog.querySelector('#native-encoder');
  const audio = dialog.querySelector('#native-audio');
  const border = dialog.querySelector('#native-border');
  const categories = [...dialog.querySelectorAll('[data-source-kind]')];
  const events = new AbortController();
  const listeners = { signal: events.signal };
  let sources = [], paths = [], capabilities = {}, ownWindowId, selected = null;
  let kind = 'window', busy = false, readingPreview = false;
  const pending = [];
  const active = () => dialog.open && !events.signal.aborted;

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !active()) continue;
      observer.unobserve(entry.target);
      pending.push(entry.target);
    }
    void showNextPreview();
  }, { root: grid });
  const cardSources = new Map();

  async function showNextPreview() {
    if (readingPreview) return;
    readingPreview = true;
    try {
      while (active() && pending.length) {
        const card = pending.shift();
        const source = cardSources.get(card);
        if (!source) continue;
        const image = card.querySelector('img');
        const placeholder = card.querySelector('.source-placeholder');
        try {
          const preview = await request('source-preview', { source });
          if (!active() || !cardSources.has(card)) continue;
          if (preview.mime !== 'image/bmp' || !preview.data ||
              preview.data.length > 512 * 1024 || !/^[A-Za-z0-9+/]+=*$/.test(preview.data)) {
            throw new Error('Preview unavailable');
          }
          image.src = 'data:image/bmp;base64,' + preview.data;
          await image.decode();
          if (!active() || !cardSources.has(card)) continue;
          image.hidden = false;
          placeholder.hidden = true;
        } catch {
          placeholder.textContent = '暂无预览';
        }
      }
    } finally {
      readingPreview = false;
    }
  }

  function syncControls() {
    for (const tab of categories) tab.setAttribute('aria-pressed', String(tab.dataset.sourceKind === kind));
    for (const [card, source] of cardSources) card.setAttribute('aria-pressed', String(source === selected));
    confirm.disabled = busy || !selected || !paths.length;
    audio.disabled = busy || !(kind === 'display' ? capabilities.systemAudio : capabilities.processAudio);
    border.disabled = busy || !capabilities.captureBorderControl;
    encoder.disabled = busy || !paths.length;
    refresh.disabled = busy;
  }

  function drawCards() {
    observer.disconnect();
    pending.length = 0;
    cardSources.clear();
    grid.replaceChildren();
    const visible = sources.filter(source => source.kind === kind);
    selected = selected ? visible.find(source => captureKey(source) === captureKey(selected)) ?? null : null;
    for (const source of visible) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'source-card';
      const title = document.createElement('span');
      title.className = 'source-card-title';
      title.textContent = source.title;
      const preview = document.createElement('span');
      preview.className = 'source-card-preview';
      const image = document.createElement('img');
      image.alt = '';
      image.hidden = true;
      const placeholder = document.createElement('span');
      placeholder.className = 'source-placeholder';
      placeholder.textContent = '正在加载预览…';
      preview.append(image, placeholder);
      card.append(title, preview);
      cardSources.set(card, source);
      grid.append(card);
      observer.observe(card);
    }
    if (!visible.length) status.textContent = kind === 'display' ? '暂无可共享的屏幕。' : '暂无可共享的窗口。';
    else if (!paths.length) status.textContent = '所选编码器不可用，请返回分享设置选择自动或其他编码。';
    else status.textContent = '选中卡片后，点「开始共享」。';
    syncControls();
  }

  async function load() {
    if (busy || !active()) return;
    busy = true;
    status.textContent = '正在查找可共享的画面…';
    syncControls();
    try {
      const [list, options, engine] = await Promise.all([
        request('list-sources'),
        request('capture-options'),
        health(),
      ]);
      if (!active()) return;
      capabilities = engine.nativeMedia || {};
      paths = encoderChoices(options.adapters, capabilities, preferences.codec);
      sources = list.sources.filter(source => source.kind === 'window' || source.kind === 'display');
      ownWindowId = list.houseWindowId;
      encoder.replaceChildren(...paths.map((path, index) => new Option(path.name, String(index))));
      if (!sources.some(source => source.kind === kind)) {
        kind = sources.some(source => source.kind === 'window') ? 'window' : 'display';
      }
      drawCards();
    } catch (error) {
      if (!active()) return;
      selected = null;
      status.textContent = error.message || '无法读取来源，请刷新重试。';
    } finally {
      busy = false;
      if (active()) syncControls();
    }
  }
  grid.addEventListener('click', event => {
    const source = cardSources.get(event.target.closest('.source-card'));
    if (busy || !source) return;
    selected = source;
    syncControls();
  }, listeners);

  for (const tab of categories) {
    tab.addEventListener('click', () => {
      if (busy || tab.dataset.sourceKind === kind) return;
      kind = tab.dataset.sourceKind;
      selected = null;
      grid.scrollTop = 0;
      drawCards();
    }, listeners);
  }
  refresh.addEventListener('click', load, listeners);
  for (const button of dialog.querySelectorAll('[data-close-source]')) {
    button.addEventListener('click', () => dialog.close('cancel'), listeners);
  }
  dialog.querySelector('form').addEventListener('submit', event => {
    if (busy || !selected || !paths[Number(encoder.value)]) event.preventDefault();
  }, listeners);
  signal?.addEventListener('abort', () => {
    if (dialog.open) dialog.close('cancel');
  }, listeners);

  audio.checked = preferences.audio;
  border.checked = preferences.showCaptureBorder;
  encoder.replaceChildren();
  dialog.returnValue = '';
  const closed = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
  dialog.showModal();
  void load();
  await closed;
  events.abort();
  observer.disconnect();
  pending.length = 0;
  cardSources.clear();
  grid.replaceChildren();
  if (signal?.aborted || dialog.returnValue !== 'share' || !selected) return null;
  const path = paths[Number(encoder.value)];
  const shareAudio = audio.checked && !audio.disabled;
  const ownWindow = sources.find(source => source.kind === 'window' && source.sourceId === ownWindowId);
  return {
    source: selected,
    ...path,
    audio: shareAudio,
    showCaptureBorder: border.checked,
    excludeAudio: shareAudio && selected.kind === 'display' && capabilities.processAudioExclusion ? ownWindow : undefined,
  };
}
