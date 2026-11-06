import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const userData = await mkdtemp(path.join(artifacts, 'account-restart-'));
let app;
const checks = [], pass = text => { checks.push(text); console.log('PASS ' + text); };
async function launch() {
  app = await electron.launch({ ...(process.env.DESKTOP_EXE ? { executablePath: process.env.DESKTOP_EXE, args: [] } : { args: ['.'] }), cwd: root,
    env: { ...process.env, FRIEND_SCREEN_USER_DATA: userData, FRIEND_SCREEN_SKIP_AUTO_CONNECT: '' }, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); return page;
}
try {
  let page = await launch(); await page.locator('#local-mode-btn').click(); await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  await page.locator('#account-open').click(); await page.locator('#register-tab').click();
  await page.locator('#account-username').fill('desktop_friend'); await page.locator('#register-name').fill('我的小屋账号');
  await page.locator('#account-password').fill('desktop-account-test'); await page.locator('#account-confirm').fill('desktop-account-test');
  await page.locator('#account-submit').click(); await page.locator('#account-dialog').waitFor({ state: 'hidden' });
  await page.locator('#mic-volume').evaluate(el => { el.value = 73; el.dispatchEvent(new Event('input')); });
  await page.waitForFunction(async () => (await (await fetch('/api/account')).json()).user?.micVolume === 73);
  await page.locator('#profile-details summary').click();
  const buffer = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.fillStyle = '#9ee8c0'; x.fillRect(0,0,128,128); return c.toDataURL().split(',')[1]; }), 'base64');
  await page.locator('#avatar-file').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer }); await page.locator('#self-avatar img').waitFor();
  await app.close(); app = null;
  page = await launch(); await page.waitForURL(/^http:\/\/127\.0\.0\.1:/); await page.waitForFunction(() => window.friendProfile?.user?.username === 'desktop_friend');
  assert.equal(await page.locator('#mic-volume').inputValue(), '73'); await page.locator('#self-avatar img').waitFor();
  assert.equal(await page.locator('#profile-mic-btn').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#room-view').isVisible(), false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.locator('#voice-settings summary').click();
  await page.screenshot({ path: path.join(artifacts, process.env.DESKTOP_EXE ? 'account-client-packaged.png' : 'account-client-desktop.png'), fullPage: true });
  pass('Full client restart reconnects local service and restores account, avatar and microphone volume; devices remain off');
  await page.locator('#profile-details summary').click(); await page.locator('#account-logout').click(); await page.waitForFunction(() => !window.friendProfile.user);
  await app.close(); app = null; page = await launch(); await page.waitForURL(/^http:\/\/127\.0\.0\.1:/); await page.evaluate(() => window.friendProfile.ready);
  assert.equal(await page.evaluate(() => window.friendProfile.user), null);
  pass('Signing out remains signed out after a complete restart');
  await page.locator('#account-open').click(); await page.locator('#account-username').fill('desktop_friend'); await page.locator('#account-password').fill('desktop-account-test'); await page.locator('#account-remember').uncheck();
  await page.locator('#account-submit').click(); await page.locator('#account-dialog').waitFor({ state: 'hidden' });
  await app.close(); app = null; page = await launch(); await page.waitForURL(/^http:\/\/127\.0\.0\.1:/); await page.evaluate(() => window.friendProfile.ready);
  assert.equal(await page.evaluate(() => window.friendProfile.user), null);
  pass('Unchecking remember-login does not persist the session across client restarts');
  await writeFile(path.join(artifacts, process.env.DESKTOP_EXE ? 'account-packaged-results.json' : 'account-desktop-results.json'), JSON.stringify({ checks, userData }, null, 2));
} finally { await app?.close(); }
