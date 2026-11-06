import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const output = path.resolve(process.env.DESKTOP_ARTIFACTS_DIR || path.join(root, 'artifacts', 'desktop-ice'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'isolated-profile-'));
const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => /zerotier/i.test(name)
  ? list.filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address) : []);
assert.ok(addresses.length, 'This regression requires an existing online ZeroTier IPv4 adapter; no enrollment is performed.');
const packaged = process.env.DESKTOP_EXE;
const archive = process.env.DESKTOP_APP;
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged, args: ['--use-fake-device-for-media-stream'] } : { args: [archive || '.', '--use-fake-device-for-media-stream'] }),
  cwd: root, timeout: 30000,
  env: { ...process.env, FRIEND_SCREEN_LEGACY_TEST: '1', FRIEND_SCREEN_SKIP_AUTO_CONNECT: '1', FRIEND_SCREEN_USER_DATA: profile },
});
const checks = [], errors = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let gather, media, loop;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('#local-mode-btn').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#local-mode-btn').isVisible(), true,
    'Production executable has no local-test entry. Use DESKTOP_APP=<unpacked resources/app.asar> with the matching development Electron runtime; this does not validate the installed executable.');
  await page.locator('#local-mode-btn').click();
  await page.waitForURL(url => url.hostname === '127.0.0.1');
  await app.evaluate(({ dialog }) => {
    globalThis.__icePermissionPrompts = 0;
    dialog.showMessageBox = async () => { globalThis.__icePermissionPrompts++; return { response: 0, checkboxChecked: false }; };
  });
  gather = await page.evaluate(async addresses => {
    const { overlayCandidate } = await import('/media-policy.js');
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const candidates = [];
    let timer;
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ICE gathering timeout')), 10000);
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return resolve();
        const parts = candidate.candidate.split(/\s+/);
        candidates.push({ protocol: parts[2], type: parts[7], overlay: addresses.includes(parts[4]),
          accepted: addresses.some(address => overlayCandidate(candidate.toJSON(), address)) });
      };
    });
    try {
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      await pc.setLocalDescription();
      await done;
      return { candidates, gathering: pc.iceGatheringState };
    } finally { clearTimeout(timer); pc.close(); }
  }, addresses);
  assert.equal(gather.gathering, 'complete');
  assert.ok(gather.candidates.some(c => c.overlay && c.protocol === 'udp' && c.accepted));
  assert.ok(gather.candidates.every(c => c.accepted === (c.overlay && c.protocol === 'udp' && c.type === 'host')));
  assert.equal(await app.evaluate(() => globalThis.__icePermissionPrompts), 0);
  pass('Without media capture or a permission prompt, the real ZeroTier UDP host candidate is gathered and only overlay UDP host candidates pass the unchanged filter');

  async function request(constraints) {
    return page.evaluate(async constraints => {
      if (!navigator.mediaDevices?.getUserMedia) return { error: 'Unavailable', liveTracks: 0 };
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const liveTracks = stream.getTracks().filter(t => t.readyState === 'live').length;
        stream.getTracks().forEach(t => t.stop());
        return { error: null, liveTracks };
      } catch (e) { return { error: e.name, liveTracks: 0 }; }
    }, constraints);
  }
  media = { microphone: await request({ audio: true }) };
  assert.deepEqual(media.microphone, { error: 'NotAllowedError', liveTracks: 0 });
  assert.equal(await app.evaluate(() => globalThis.__icePermissionPrompts), 1);
  pass('A real getUserMedia microphone request still reaches the dedicated prompt, and denial creates no live audio track');
  media.camera = await request({ video: true });
  assert.deepEqual(media.camera, { error: 'NotAllowedError', liveTracks: 0 });
  assert.equal(await app.evaluate(() => globalThis.__icePermissionPrompts), 1);
  pass('Camera capture remains denied without prompting');

  loop = await page.evaluate(async address => {
    const { overlayCandidate, overlayDescription, verifiedPair } = await import('/media-policy.js');
    const peers = [new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' }), new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })];
    const accepted = [[], []];
    const candidates = [[], []];
    const deadlines = [];
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const paint = canvas.getContext('2d');
    const paintTimer = setInterval(() => { paint.fillStyle = '#163238'; paint.fillRect(0, 0, 320, 180); paint.fillStyle = '#a1e9c6'; paint.fillText(String(Date.now()), 20, 40); }, 70);
    const video = canvas.captureStream(10);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start(); await audioContext.resume();
    const stream = new MediaStream([...video.getTracks(), ...destination.stream.getTracks()]);
    const receivers = [];
    peers[1].ontrack = ({ track }) => receivers.push(track);
    const ready = peers.map((pc, i) => new Promise((resolve, reject) => {
      deadlines.push(setTimeout(() => reject(new Error('Overlay loop ICE gathering timeout')), 10000));
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return resolve();
        candidates[i].push(candidate.toJSON());
        if (overlayCandidate(candidate.toJSON(), address)) accepted[i].push(candidate.toJSON());
      };
    }));
    try {
      stream.getTracks().forEach(track => peers[0].addTrack(track, stream));
      const channel = peers[0].createDataChannel('overlay-regression');
      const message = new Promise(resolve => { peers[1].ondatachannel = ({ channel }) => { channel.onmessage = e => resolve(e.data); }; });
      await peers[0].setLocalDescription();
      await peers[1].setRemoteDescription(overlayDescription(peers[0].localDescription.toJSON(), address));
      await peers[1].setLocalDescription();
      await peers[0].setRemoteDescription(overlayDescription(peers[1].localDescription.toJSON(), address));
      await Promise.all(ready);
      for (const candidate of accepted[0]) await peers[1].addIceCandidate(candidate);
      for (const candidate of accepted[1]) await peers[0].addIceCandidate(candidate);
      const timeout = new Promise((_, reject) => deadlines.push(setTimeout(() => reject(new Error('Overlay self-connection timeout')), 15000)));
      await Promise.race([new Promise(resolve => { if (channel.readyState === 'open') resolve(); else channel.onopen = resolve; }), timeout]);
      channel.send('overlay-only');
      const received = await Promise.race([message, timeout]);
      let report;
      const until = performance.now() + 5000;
      do {
        const stats = await peers[1].getStats();
        const inbound = [...stats.values()].filter(s => s.type === 'inbound-rtp');
        report = { received, accepted: accepted.map(a => a.length), seen: candidates.map(a => a.length), verified: await Promise.all(peers.map(async pc => verifiedPair(await pc.getStats(), address, address))),
          videoFrames: inbound.filter(s => s.kind === 'video').reduce((n, s) => n + (s.framesDecoded || 0), 0),
          audioBytes: inbound.filter(s => s.kind === 'audio').reduce((n, s) => n + (s.bytesReceived || 0), 0) };
        if (report.videoFrames > 0 && report.audioBytes > 0 && report.verified.every(Boolean)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() < until);
      return report;
    } finally {
      deadlines.forEach(clearTimeout); clearInterval(paintTimer); peers.forEach(pc => pc.close());
      stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await audioContext.close();
    }
  }, addresses[0]);
  assert.equal(loop.received, 'overlay-only');
  assert.ok(loop.accepted.every(n => n > 0));
  assert.ok(loop.verified.every(Boolean));
  assert.ok(loop.videoFrames > 0 && loop.audioBytes > 0);
  pass('Two real RTCPeerConnections exchange data, decoded synthetic video and synthetic audio RTP over the verified local ZeroTier IPv4 UDP path');

  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('connection-settings').click());
  await page.waitForURL(url => url.protocol === 'friend-screen:');
  media.launcher = await request({ audio: true });
  assert.ok(['NotAllowedError', 'Unavailable'].includes(media.launcher.error));
  assert.equal(media.launcher.liveTracks, 0);
  assert.equal(await app.evaluate(() => globalThis.__icePermissionPrompts), 1);
  pass('Returning to the launcher disables capture and does not prompt');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), archive: Boolean(archive), packagedExecutable: Boolean(packaged), passed: true, checks, gather, media, loop, errors,
    environment: 'One Windows host with an existing ZeroTier IPv4 adapter; isolated development-mode Electron profile; fake capture devices; synthetic canvas and oscillator inputs only.',
    limits: 'Same-host adapter self-connection only. No cross-network, second physical device, actual microphone/system audio or clean install was validated. DESKTOP_APP runs packaged app.asar under the development Electron runtime; it is not installed-executable validation.' }, null, 2));
} finally { await app.close(); }
