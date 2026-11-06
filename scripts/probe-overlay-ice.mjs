import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root = process.cwd();
const output = path.join(root, 'artifacts', 'ice-probe');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => /zerotier/i.test(name) ? list.filter(a => a.family === 'IPv4').map(a => a.address) : []);
const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, FRIEND_SCREEN_LEGACY_TEST: '1', FRIEND_SCREEN_SKIP_AUTO_CONNECT: '1', FRIEND_SCREEN_USER_DATA: profile }, timeout: 30000 });
const results = [];
try {
  const page = await app.firstWindow();
  await page.locator('#local-mode-btn').click();
  await page.waitForURL(url => url.hostname === '127.0.0.1');
  async function gather(name) {
    const result = await page.evaluate(async addresses => {
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      const candidates = [];
      const done = new Promise(resolve => {
        pc.onicecandidate = ({ candidate }) => {
          if (!candidate) return resolve();
          const p = candidate.candidate.split(/\s+/);
          candidates.push({ protocol: p[2], type: p[7], addressKind: addresses.includes(p[4]) ? 'overlay' : p[4].endsWith('.local') ? 'mdns' : p[4].includes(':') ? 'ipv6-other' : 'ipv4-other' });
        };
        setTimeout(resolve, 8000);
      });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      await pc.setLocalDescription();
      await done;
      const gathering = pc.iceGatheringState;
      pc.close();
      return { candidates, gathering };
    }, addresses);
    results.push({ name, ...result });
    console.log(JSON.stringify(results.at(-1)));
  }
  await gather('production-permissions');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setWebRTCIPHandlingPolicy('default'));
  await gather('explicit-default-policy');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.setPermissionCheckHandler((_w, permission) => permission === 'media'));
  await gather('media-check-approved-no-capture');
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), overlayInterfacePresent: addresses.length > 0, results }, null, 2));
} finally { await app.close(); }
