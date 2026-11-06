import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp, readConfig } from '../server.mjs';
const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const app = createApp(readConfig({ PORT: '0', ACCOUNT_DATA_DIR: ':memory:' }));
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const errors = [], checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
function fixture() {
  window.__rawTracks = []; window.__speakers = []; window.__pcs = [];
  const Native = window.AudioContext;
  window.AudioContext = class extends Native {
    createGain() {
      const gain = super.createGain(), connect = gain.connect.bind(gain);
      gain.connect = (node, ...rest) => {
        if (node === this.destination) {
          const analyser = this.createAnalyser(); analyser.fftSize = 2048; connect(analyser);
          window.__speakers.push({ gain, analyser, rms() { const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length); } });
        }
        return connect(node, ...rest);
      }; return gain;
    }
  };
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends PC { constructor(...args) { super(...args); window.__pcs.push(this); } };
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
    const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
    gain.gain.value = 0.1; oscillator.connect(gain); gain.connect(output); oscillator.start(); await context.resume();
    const track = output.stream.getAudioTracks()[0], stop = track.stop.bind(track);
    track.stop = () => { stop(); oscillator.stop(); context.close(); }; window.__rawTracks.push(track); return output.stream;
  } });
}
async function page() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); await context.addInitScript(fixture);
  const p = await context.newPage(); p.setDefaultTimeout(12000); p.on('pageerror', e => errors.push(e.message));
  await p.goto(base); await p.evaluate(() => window.friendProfile.ready); return p;
}
async function slider(p, selector, value) { await p.locator(selector).evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
async function rms(p, index = 0) {
  return p.evaluate(async index => { await new Promise(r => setTimeout(r, 250)); let sum = 0; for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 80)); sum += window.__speakers[index].rms(); } return sum / 6; }, index);
}
let host, viewer;
try {
  host = await page(); await host.locator('#account-open').click(); await host.locator('#register-tab').click();
  await host.locator('#account-username').fill('voice_host'); await host.locator('#register-name').fill('薄荷房主');
  await host.locator('#account-password').fill('voice-test-password'); await host.locator('#account-confirm').fill('voice-test-password');
  await host.screenshot({ path: artifacts + 'account-register.png' });
  await host.locator('#account-submit').click(); await host.locator('#account-dialog').waitFor({ state: 'hidden' });
  assert.equal(await host.locator('#create-name').inputValue(), '薄荷房主');
  assert.equal(await host.evaluate(() => document.cookie.includes('friend_session')), false);
  await host.reload(); await host.waitForFunction(() => window.friendProfile.user?.username === 'voice_host');
  pass('Register, HttpOnly session, and automatic sign-in after reload');
  await host.locator('#profile-details summary').click(); await host.locator('#profile-name').fill('薄荷同学'); await host.locator('#profile-form button').click();
  await host.waitForFunction(() => window.friendProfile.user?.name === '薄荷同学');
  const png = await host.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.fillStyle = '#9ee8c0'; x.fillRect(0, 0, 128, 128); x.fillStyle = '#1c4131'; x.font = '68px sans-serif'; x.fillText('M', 31, 89); return c.toDataURL().split(',')[1]; });
  await host.locator('#avatar-file').setInputFiles({ name: 'mint.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await host.locator('#self-avatar img').waitFor(); await host.locator('#profile-details summary').click();
  await host.locator('#create-password').fill('voice-room-password'); await host.locator('#create-btn').click(); await host.locator('#room-view').waitFor({ state: 'visible' });
  const roomId = await host.locator('#room-code').textContent();
  viewer = await page(); await viewer.goto(base + '/#room=' + roomId); await viewer.locator('#join-name').fill('听众'); await viewer.locator('#join-password').fill('voice-room-password'); await viewer.locator('#join-btn').click();
  await viewer.waitForFunction(() => window.__pcs.some(pc => pc.connectionState === 'connected'));
  await viewer.locator('.member .avatar img').waitFor(); pass('Profile name and cropped avatar synchronize to a new room member');
  await host.locator('#profile-mic-btn').click(); await host.waitForFunction(() => document.querySelector('#profile-mic-btn').getAttribute('aria-pressed') === 'true');
  await viewer.locator('#sound-btn').click(); await viewer.waitForFunction(() => window.__speakers.some(s => s.rms() > 0.02));
  const full = await rms(viewer);
  await slider(host, '#mic-volume', 50); await new Promise(r => setTimeout(r, 350)); const half = await rms(viewer);
  assert.ok(half / full > 0.35 && half / full < 0.65, `Sending half: ${half / full}`);
  await slider(host, '#mic-volume', 0); await new Promise(r => setTimeout(r, 350)); assert.ok(await rms(viewer) < 0.002);
  await slider(host, '#mic-volume', 100); await new Promise(r => setTimeout(r, 350));
  await slider(viewer, '.friend-volume input', 50); const localHalf = await rms(viewer); assert.ok(localHalf / full > 0.35 && localHalf / full < 0.65);
  await slider(viewer, '.friend-volume input', 200); const localDouble = await rms(viewer); assert.ok(localDouble / full > 1.7 && localDouble / full < 2.3);
  await viewer.locator('.friend-mute').click(); assert.ok(await rms(viewer) < 0.002);
  assert.equal(await host.locator('#profile-mic-btn').getAttribute('aria-pressed'), 'true');
  await viewer.locator('.friend-mute').click(); assert.equal(await viewer.locator('.friend-volume input').inputValue(), '200');
  pass('Measured received audio: own 50% / 0%, friend 50% / 200%, local mute and restore');
  const third = await page(); await third.goto(base + '/#room=' + roomId); await third.locator('#join-name').fill('另一位朋友'); await third.locator('#join-password').fill('voice-room-password'); await third.locator('#join-btn').click();
  await third.locator('#room-view').waitFor({ state: 'visible' }); await third.locator('#profile-mic-btn').click();
  await viewer.waitForFunction(() => window.__speakers.length === 2 && window.__speakers.every(s => s.rms() > 0.02));
  const sliders = viewer.locator('.friend-volume input'); await sliders.nth(0).evaluate(el => { el.value = 0; el.dispatchEvent(new Event('input')); });
  assert.ok(await rms(viewer, 0) < 0.002); assert.ok(await rms(viewer, 1) > 0.02);
  await viewer.locator('#sound-btn').click(); assert.ok(await rms(viewer, 1) < 0.002);
  await viewer.locator('#sound-btn').click(); assert.ok(await rms(viewer, 1) > 0.02);
  pass('Two friends have independent audio gains; global listening mute preserves preferences');
  await host.locator('#profile-details summary').click(); await host.locator('#avatar-reset').click();
  await viewer.waitForFunction(() => document.querySelectorAll('.member .avatar img').length === 0);
  await host.locator('#profile-details summary').click();
  await viewer.screenshot({ path: artifacts + 'voice-room-desktop.png', fullPage: true });
  await viewer.setViewportSize({ width: 390, height: 844 }); await viewer.screenshot({ path: artifacts + 'voice-room-mobile.png', fullPage: true });
  assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await host.locator('#profile-mic-btn').click(); assert.ok(await host.evaluate(() => window.__rawTracks.every(t => t.readyState === 'ended')));
  await third.locator('#leave-btn').click(); assert.ok(await third.evaluate(() => window.__rawTracks.every(t => t.readyState === 'ended')));
  pass('Avatar reset broadcasts, mobile fits, closing mic and leaving release raw devices');
  await host.locator('#profile-details summary').click(); await host.locator('#account-logout').click(); await host.waitForFunction(() => !window.friendProfile.user);
  await host.reload(); await host.evaluate(() => window.friendProfile.ready); assert.equal(await host.evaluate(() => window.friendProfile.user), null);
  assert.deepEqual(errors, []); pass('Logout revokes automatic login; no browser exceptions');
  await writeFile(artifacts + 'profile-voice-results.json', JSON.stringify({ checks, errors, rms: { full, half, localHalf, localDouble } }, null, 2));
 } catch (e) {
  if (host) await host.screenshot({ path: artifacts + 'profile-failure.png', fullPage: true }).catch(() => {});
  for (const p of [host, viewer].filter(Boolean)) {
    console.error(JSON.stringify(await p.evaluate(async () => {
      const stats = [];
      for (const pc of window.__pcs) for (const s of (await pc.getStats()).values()) {
        if (s.kind === 'audio' && ['inbound-rtp', 'media-source'].includes(s.type)) stats.push(s);
      }
      return { status: document.querySelector('#status-message').textContent,
        speakers: window.__speakers.map(s => ({ gain: s.gain.gain.value, rms: s.rms(), context: s.gain.context.state })), connections: window.__pcs.map(pc => ({ state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, transceivers: pc.getTransceivers().map(t => ({ mid: t.mid, direction: t.currentDirection })) })), stats };
    }).catch(() => ({})), null, 2));
  }
  console.error(errors); throw e;
}
finally { await browser.close(); await app.close(); }
