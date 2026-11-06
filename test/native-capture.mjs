// Optional browser-tab capture smoke test. Only captures an owned fixture tab.
// Does not capture the user's desktop, windows, microphone, or other browser profile.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp, readConfig } from '../server.mjs';

const app = createApp(readConfig({ PORT: '0' }));
const port = await app.listen();
const output = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(output, { recursive: true });
const title = 'Friend Screen Capture Fixture';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: [`--auto-select-tab-capture-source-by-title=${title}`, '--enable-usermedia-screen-capturing', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const fixture = await context.newPage();
  await fixture.setContent(`<html><head><title>${title}</title></head><body style="background:#163238;color:white;font:32px sans-serif"><h1>Private test fixture</h1><p>Only this generated tab is being shared.</p><div id="clock"></div><script>setInterval(()=>document.querySelector('#clock').textContent=Date.now(),100)</script></body></html>`);
  const sender = await context.newPage();
  sender.setDefaultTimeout(12000);
  await sender.goto(`http://127.0.0.1:${port}`);
  await sender.locator('#create-name').fill('原生采集测试');
  await sender.locator('#create-password').fill('native-capture-test');
  await sender.locator('#create-btn').click();
  await sender.locator('#room-view').waitFor({ state: 'visible' });
  const room = await sender.locator('#room-code').textContent();
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto(`http://127.0.0.1:${port}/#room=${room}`);
  await viewer.locator('#join-name').fill('原生接收测试');
  await viewer.locator('#join-password').fill('native-capture-test');
  await viewer.locator('#join-btn').click();
  await viewer.locator('#room-view').waitFor({ state: 'visible' });
  await sender.locator('#share-btn').click();
  await sender.waitForFunction(() => document.querySelector('#stage-state').textContent === '共享中', null, { timeout: 15000 });
  await viewer.waitForFunction(() => {
    const video = document.querySelector('#stage-video');
    return !video.hidden && video.videoWidth > 0 && video.readyState >= 2;
  }, null, { timeout: 15000 });
  const settings = await sender.locator('#stage-video').evaluate(video => video.srcObject.getVideoTracks()[0].getSettings());
  const tracks = await sender.locator('#stage-video').evaluate(video => video.srcObject.getTracks().map(t => ({ kind: t.kind, readyState: t.readyState })));
  await viewer.screenshot({ path: output + 'native-tab-capture.png', fullPage: true });
  const result = { passed: true, date: '2026-11-04', browser: browser.version(), source: 'Owned browser fixture tab, selected by browser test flag. Unmodified production getDisplayMedia.', settings, tracks, limits: 'Does not verify desktop/window/game capture, real microphone/system audio, or cross-network TURN.' };
  await writeFile(output + 'native-capture-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await sender.locator('#share-btn').click();
  await viewer.waitForFunction(() => document.querySelector('#stage-video').hidden);
} finally {
  await browser.close();
  await app.close();
}
