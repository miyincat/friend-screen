const widths = { 480: 854, 720: 1280, 1080: 1920, 1440: 2560 };
const presets = {
  light: { height: 720, fps: 30, mbps: 4 },
  hd: { height: 1080, fps: 30, mbps: 6 },
  fast: { height: 1080, fps: 60, mbps: 6 },
  '2k': { height: 1440, fps: 60, mbps: 10 },
};

export function bindShareSettings({ onQuality, onVolume }) {
  const dialog = document.getElementById('share-settings-dialog');
  const open = document.getElementById('share-settings-btn');
  const field = id => dialog.querySelector('#' + id);
  const checked = name => dialog.querySelector('input[name="' + name + '"]:checked');
  const profile = field('share-video-profile');
  const fps = field('native-fps');
  const rate = field('native-bitrate');
  const volume = field('share-volume');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const cards = [...dialog.querySelectorAll('[data-share-preset]')];
  const backgrounds = [...dialog.querySelectorAll('[data-share-art]')];

  const settings = {
    get quality() {
      const height = Number(checked('share-resolution').value);
      return { width: widths[height], height, fps: fps.valueAsNumber, bitrate: rate.valueAsNumber * 1000000 };
    },
    get priority() { return checked('share-priority').value; },
    get capture() {
      return { codec: checked('share-codec').value, audio: field('default-source-audio').checked };
    },
    setViewing(viewing) { profile.disabled = viewing; },
  };

  function render() {
    const quality = settings.quality;
    field('share-format').textContent = quality.height + 'p · ' + quality.fps + ' fps';
    field('share-dimensions').textContent = quality.width + ' × ' + quality.height;
    field('native-fps-value').textContent = quality.fps + ' fps';
    field('native-bitrate-value').textContent = rate.value + ' Mbps';
    field('share-volume-value').textContent = volume.value + '%';
    for (const card of cards) {
      const preset = presets[card.dataset.sharePreset];
      card.setAttribute('aria-pressed', String(preset.height === quality.height &&
        preset.fps === quality.fps && preset.mbps === rate.valueAsNumber));
    }
  }

  function activateTab(active) {
    for (const tab of tabs) {
      const selected = tab === active;
      tab.setAttribute('aria-selected', String(selected));
      field(tab.getAttribute('aria-controls')).hidden = !selected;
    }
  }

  open.addEventListener('click', () => dialog.showModal());
  field('share-update-btn').addEventListener('click', () => window.privateHouse.openUpdates?.().catch(() => {}));
  for (const tab of tabs) tab.addEventListener('click', () => activateTab(tab));
  dialog.querySelector('[role="tablist"]').addEventListener('keydown', event => {
    const target = { ArrowLeft: tabs[0], ArrowRight: tabs[1], Home: tabs[0], End: tabs[1] }[event.key];
    if (!target) return;
    event.preventDefault();
    target.focus();
    activateTab(target);
  });
  function activateBackground(background) {
    document.body.dataset.shareArt = background.dataset.shareArt;
    for (const choice of backgrounds) choice.setAttribute('aria-pressed', String(choice === background));
  }
  for (const background of backgrounds) {
    background.addEventListener('click', () => activateBackground(background));
  }
  activateBackground(backgrounds.find(button => button.getAttribute('aria-pressed') === 'true'));
  for (const card of cards) {
    card.addEventListener('click', () => {
      const preset = presets[card.dataset.sharePreset];
      dialog.querySelector('input[name="share-resolution"][value="' + preset.height + '"]').checked = true;
      fps.value = preset.fps;
      rate.value = preset.mbps;
      render();
      onQuality();
    });
  }
  profile.addEventListener('input', render);
  profile.addEventListener('change', event => {
    if (event.target.name !== 'share-codec') onQuality();
  });
  volume.addEventListener('input', () => {
    render();
    onVolume(volume.valueAsNumber / 100);
  });
  render();
  return settings;
}
