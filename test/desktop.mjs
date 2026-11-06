import { _electron as electron, chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const packaged = process.env.DESKTOP_EXE;
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }),
  cwd: root, timeout: 30000,
  env: { ...process.env, FRIEND_SCREEN_SKIP_AUTO_CONNECT: '1', FRIEND_SCREEN_USER_DATA: path.join(output, packaged ? 'client-profile-packaged' : 'client-profile-development') },
});
let browser;
const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator('#local-mode-btn').waitFor();
  await page.screenshot({ path: path.join(output, packaged ? 'client-packaged-launcher.png' : 'client-launcher.png') });
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences();
    return { nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, sandbox: p.sandbox };
  });
  assert.deepEqual(prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  pass('Client launcher renders with Node disabled, context isolation and sandbox enabled');
  await page.locator('#server-origin').fill('http://example.com');
  await page.locator('#connect-server-btn').click();
  await page.waitForFunction(() => /HTTPS/i.test(document.querySelector('#launcher-status').textContent));
  assert.match(page.url(), /^friend-screen:/);
  pass('Client rejects insecure Internet server addresses');
  await page.locator('#local-mode-btn').click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  await page.evaluate(() => {
    window.__testClicks = [];
    document.addEventListener('click', event => window.__testClicks.push({ id: event.target.closest('button')?.id, x: event.clientX, y: event.clientY }), true);
  });
  const base = new URL(page.url()).origin;
  await page.locator('#create-name').fill('客户端房主');
  await page.locator('#create-password').fill('desktop-capture-test');
  await page.locator('#create-btn').click();
  await page.locator('#room-view').waitFor({ state: 'visible' });
  pass('Bundled local server starts and creates a room');
  const windowsBefore = app.windows().length;
  await page.evaluate(() => { window.open('https://example.com'); });
  assert.equal(app.windows().length, windowsBefore);
  pass('Room renderer cannot create an external popup');

  const pickerPromise = app.waitForEvent('window');
  await page.locator('#share-btn').click();
  const picker = await pickerPromise;
  await picker.locator('#system-audio').waitFor();
  assert.equal(await picker.locator('#system-audio').isChecked(), false);
  await picker.locator('#cancel-share-btn').click();
  await page.waitForFunction(() => !document.querySelector('#share-btn').disabled);
  assert.equal(await page.locator('#stage-video').evaluate(v => v.srcObject), null);
  pass('Native source picker defaults system audio off; cancel does not capture');

  // Create and capture only our own test window, not the user's desktop.
  await app.evaluate(async ({ BrowserWindow }) => {
    const fixture = new BrowserWindow({ width: 880, height: 560, title: 'Friend Screen Desktop Fixture',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    fixture.setMenu(null);
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>Friend Screen Desktop Fixture</title><body style="background:#163238;color:#a1e9c6;font:30px sans-serif;padding:40px"><h1>Owned test window</h1><p>Native Windows capture test</p><div id="clock"></div><script>setInterval(()=>document.getElementById("clock").textContent=Date.now(),100)</script></body>'));
  });
  await page.bringToFront();
  const pickerAgain = app.waitForEvent('window');
  await page.locator('#share-btn').click();
  const selection = await pickerAgain;
  const source = selection.locator('.source-option[data-kind="window"][data-name="Friend Screen Desktop Fixture"]');
  await source.waitFor({ timeout: 20000 });
  await source.click();
  // Selection destroys this modal immediately. The main window assertions below
  // establish success even if Playwright's click acknowledgement loses that race.
  await selection.locator('#confirm-share-btn').click().catch(error => {
    if (!selection.isClosed() || !/closed/i.test(error.message)) throw error;
  });
  await page.waitForFunction(() => {
    const v = document.querySelector('#stage-video');
    return !v.hidden && v.videoWidth > 0 && v.readyState >= 2;
  }, null, { timeout: 20000 });
  const capture = await page.locator('#stage-video').evaluate(v => ({ settings: v.srcObject.getVideoTracks()[0].getSettings(), tracks: v.srcObject.getTracks().map(t => t.kind) }));
  assert.deepEqual(capture.tracks, ['video']);
  pass('Native Windows capture returns live video from the explicitly selected test window, without audio');

  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const watcher = await browser.newPage();
  const room = await page.locator('#room-code').textContent();
  await watcher.goto(base + '/#room=' + room);
  await watcher.locator('#join-name').fill('浏览器观看者');
  await watcher.locator('#join-password').fill('desktop-capture-test');
  await watcher.locator('#join-btn').click();
  await watcher.waitForFunction(() => {
    const v = document.querySelector('#stage-video');
    return !v.hidden && v.videoWidth > 0 && v.readyState >= 2;
  }, null, { timeout: 20000 });
  // Capture the receiving browser for media evidence. CDP screenshots of an
  // occluded native Electron window can stall while Windows capture is active.
  await watcher.screenshot({ path: path.join(output, packaged ? 'client-packaged-received.png' : 'client-received.png'), fullPage: true });
  pass('Separate browser receives the client native window capture over WebRTC');
  await page.locator('#stage-video').evaluate(v => { window.__testCapturedTrack = v.srcObject.getVideoTracks()[0]; });
  await page.bringToFront();
  await page.locator('#share-btn').click();
  await watcher.waitForFunction(() => document.querySelector('#stage-video').hidden);
  assert.equal(await page.evaluate(() => window.__testCapturedTrack.readyState), 'ended');
  pass('Stopping native sharing ends the capture track and clears the remote stage');
  await writeFile(path.join(output, packaged ? 'desktop-packaged-results.json' : 'desktop-results.json'), JSON.stringify({ date: '2026-11-04', packaged: Boolean(packaged), checks, capture, limits: 'No real microphone/system-audio listening test or Internet/TURN deployment validation.' }, null, 2));
} catch (error) {
  const page = app.windows().find(p => /^http:/.test(p.url()));
  if (page) console.error('Desktop interaction trace', await page.evaluate(() => ({ clicks: window.__testClicks, accountDialog: document.querySelector('#account-dialog')?.open })).catch(() => ({})));
  throw error;
} finally {
  if (browser) await browser.close();
  await app.close();
}
