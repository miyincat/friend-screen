import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { privateFixture } from './private-native-fixture.mjs';

const root = process.cwd();
const out = path.join(root, 'artifacts', 'native-picker');
const titlePrefix = 'Share Picker Fixture ';
const apps = [];
const errors = [];
await mkdir(out, { recursive: true });
const fixture = await privateFixture(root);

async function client(name) {
  const data = await mkdtemp(path.join(out, name + '-'));
  const app = await electron.launch({
    args: ['test/private-media-shell.cjs'],
    cwd: root,
    env: {
      ...process.env,
      FRIEND_TEST_ORIGIN: await fixture.gateway(name),
      FRIEND_TEST_ADDRESS: fixture.address,
      FRIEND_TEST_DATA: data,
      FRIEND_TEST_WINDOW_PREFIX: titlePrefix,
    },
  });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.friendProfile?.value.name);
  return { app, page };
}

try {
  const host = await client('sender');
  const viewer = await client('viewer');
  await host.page.locator('body.native-share-ui[data-share-art="sakura"]').waitFor();
  assert.ok(await host.page.locator('.network-note').isHidden());
  const waitingArt = () => host.page.locator('#stage-empty').evaluate(stage => getComputedStyle(stage).backgroundImage);
  assert.match(await waitingArt(), /share-art-sakura\.jpg/);
  const decodedArt = await host.page.evaluate(async () => {
    const image = new Image();
    image.src = '/share-art-sakura.jpg';
    await image.decode();
    return image.naturalWidth;
  });
  assert.equal(decodedArt, 1600);
  await host.page.screenshot({ path: path.join(out, 'home-sakura.png'), fullPage: true });
  await host.page.locator('#create-btn').click();
  await host.page.locator('#room-view').waitFor({ state: 'visible' });
  await viewer.page.locator('#join-tab').click();
  await viewer.page.locator('#join-room').fill(await host.page.locator('#room-code').innerText());
  await viewer.page.locator('#join-btn').click();
  await viewer.page.locator('#room-view').waitFor({ state: 'visible' });
  await host.app.evaluate(async ({ BrowserWindow }, prefix) => {
    globalThis.pickerTestWindows = [];
    for (const [label, color] of [['红色', '#ad2632'], ['绿色', '#22ad62']]) {
      const window = new BrowserWindow({
        width: 1000, height: 640, frame: false,
        webPreferences: { sandbox: true, backgroundThrottling: false },
      });
      globalThis.pickerTestWindows.push(window);
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<title>' + prefix + label + '</title><style>body{margin:0;background:' + color + '}</style>',
      ));
    }
  }, titlePrefix);

  await host.page.bringToFront();
  await host.page.locator('#share-settings-btn').click();
  const settings = host.page.locator('#share-settings-dialog');
  assert.equal(await settings.locator('#share-format').textContent(), '1080p · 60 fps');
  assert.equal(await settings.getByRole('button', { name: '绯樱' }).getAttribute('aria-pressed'), 'true');
  await settings.getByRole('button', { name: '青黛' }).click();
  assert.match(await waitingArt(), /share-art-teal\.jpg/);
  await settings.getByRole('button', { name: '黑金' }).click();
  assert.match(await waitingArt(), /share-art-gold\.jpg/);
  await settings.getByRole('button', { name: '绯樱' }).click();
  assert.match(await waitingArt(), /share-art-sakura\.jpg/);
  const loaded = await settings.evaluate(async () => {
    const image = new Image();
    image.src = '/share-art-teal.jpg';
    await image.decode();
    return image.naturalWidth;
  });
  assert.ok(loaded > 1000);
  await settings.getByRole('button', { name: '2K' }).click();
  for (let i = 0; i < 15; i++) await settings.locator('#native-fps').press('ArrowLeft');
  assert.equal(await settings.locator('#share-format').textContent(), '1440p · 45 fps');
  await settings.locator('#native-fps').blur();
  await settings.screenshot({ path: path.join(out, 'share-settings.png') });
  await settings.getByRole('tab', { name: '声音' }).click();
  await settings.locator('#share-volume').press('Home');
  assert.equal(await host.page.locator('#stage-video').evaluate(video => video.volume), 0);
  await settings.getByRole('button', { name: '关闭分享设置' }).click();

  const picker = host.page.locator('#native-source-dialog');
  const start = picker.getByRole('button', { name: '开始共享' });
  const target = picker.locator('.source-card').filter({ hasText: '绿色' });
  await host.page.locator('#share-btn').click();
  await target.waitFor();
  assert.equal(await picker.locator('.source-card').count(), 2);
  assert.ok(await start.isDisabled());
  await target.locator('img').waitFor({ state: 'visible', timeout: 30000 });
  assert.ok(await target.locator('img').evaluate(img => img.naturalWidth === 320));
  await picker.screenshot({ path: path.join(out, 'source-picker.png') });
  await target.click();
  assert.equal(await target.getAttribute('aria-pressed'), 'true');
  assert.ok(await start.isEnabled());
  await host.page.keyboard.press('Escape');
  await picker.waitFor({ state: 'hidden' });
  assert.ok(await host.page.locator('#stage-video').isHidden());
  await host.page.locator('#share-btn').click();
  await target.click();
  await start.click();
  await viewer.page.waitForFunction(() => {
    const video = document.querySelector('#stage-video');
    if (video.hidden || !video.videoWidth || video.currentTime < .5) return false;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, 1, 1);
    const [red, green] = context.getImageData(0, 0, 1, 1).data;
    return green > red * 1.5;
  }, {}, { timeout: 50000 });
  assert.ok(await viewer.page.locator('#stage-empty').isHidden());
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.errors, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({
    passed: true,
    checks: ['both source cards and native thumbnail', 'explicit selection and Escape cancel',
      'selected green window received by second client at the custom 45-fps target',
      'three wallpapers update the waiting view, normal network note is hidden, playback hides the waiting view',
      'shared playback volume'],
    scope: 'Two clients on one Windows PC. Synthetic window capture, mocked enrollment, private UDP. No campus-network or clean-install validation.',
  }, null, 2));
  console.log('PASS: native source thumbnails, cancellation, selected window playback, themed settings and custom frame-rate negotiation');
} finally {
  for (const app of apps.reverse()) await app.close().catch(() => {});
  await fixture.close();
}
