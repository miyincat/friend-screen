import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, readConfig } from '../server.mjs';

const artifacts = process.env.BROWSER_ARTIFACTS_DIR
  ? path.resolve(process.env.BROWSER_ARTIFACTS_DIR) + path.sep
  : fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const config = readConfig({ PORT: '0' });
config.maxParticipants = 8;
const app = createApp(config);
const port = await app.listen();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const contexts = [];
const errors = [];
const checks = [];
const check = (name) => { checks.push(name); console.log('PASS ' + name); };

// Only this test overrides capture APIs. Production always uses the browser picker.
function installFixture() {
  window.__pcs = []; window.__captures = []; window.__sockets = [];
  window.__delayPeerJoinForLowerId = false;
  window.__reorderedPeerSignal = false;
  window.__orderingLog = [];
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePC {
    constructor(...args) { super(...args); window.__pcs.push(this); }
  };
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(...args) {
      super(...args); window.__sockets.push(this);
      let onmessage = null;
      let selfId = null;
      let heldPeerJoin = null;
      Object.defineProperty(this, 'onmessage', {
        configurable: true,
        get: () => onmessage,
        set: handler => { onmessage = handler; },
      });
      this.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { onmessage?.call(this, event); return; }
        if (message.type === 'joined') { selfId = message.selfId; window.__orderingLog.push({ type: message.type, selfId }); }
        else if (message.type === 'peer-joined') window.__orderingLog.push({ type: message.type, selfId, peerId: message.peer?.id, lower: message.peer?.id < selfId, delaying: window.__delayPeerJoinForLowerId });
        else if (message.type === 'signal') window.__orderingLog.push({ type: message.type, selfId, from: message.from, heldFrom: heldPeerJoin?.peerId || null });
        if (window.__delayPeerJoinForLowerId && selfId && message.type === 'peer-joined' && message.peer?.id < selfId) {
          heldPeerJoin = { event, peerId: message.peer.id };
          return;
        }
        if (heldPeerJoin && message.type === 'signal' && message.from === heldPeerJoin.peerId) {
          onmessage?.call(this, event);
          onmessage?.call(this, heldPeerJoin.event);
          heldPeerJoin = null;
          window.__reorderedPeerSignal = true;
          return;
        }
        onmessage?.call(this, event);
      });
    }
  };
  function audio() {
    const ac = new AudioContext();
    const source = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.015;
    const output = ac.createMediaStreamDestination();
    source.connect(gain); gain.connect(output); source.start();
    ac.resume();
    const track = output.stream.getAudioTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => { source.stop(); ac.close(); stop(); };
    return track;
  }
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => {
    if (window.__rejectCapture) throw new DOMException('Fixture cancelled', 'NotAllowedError');
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      ctx.fillStyle = '#152a31'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#65e8c0'; ctx.fillRect((frame++ * 5) % 540, 90, 100, 100);
      ctx.fillStyle = '#ffffff'; ctx.font = '24px sans-serif';
      ctx.fillText('WebRTC synthetic test frame ' + frame, 35, 270);
    };
    draw();
    const interval = setInterval(draw, 50);
    const stream = canvas.captureStream(20);
    stream.addTrack(audio());
    const track = stream.getVideoTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => { clearInterval(interval); stop(); };
    window.__captures.push({ kind: 'screen', stream });
    return stream;
  }});
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
    const stream = new MediaStream([audio()]);
    window.__captures.push({ kind: 'mic', stream });
    return stream;
  }});
}

async function pageFor(name, roomId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  contexts.push(context);
  await context.addInitScript(installFixture);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push({ name, message: error.message }));
  await page.goto(base + (roomId ? `/#room=${roomId}` : '/'));
  await page.waitForFunction(() => document.querySelector('#network-note-title').textContent !== '正在检查连接环境');
  if (roomId) {
    await page.locator('#join-name').fill(name);
    await page.locator('#join-password').fill('browser-test-password');
    await page.locator('#join-btn').click();
    await page.locator('#room-view').waitFor({ state: 'visible' });
  }
  return page;
}

async function awaitPeers(page, count) {
  await page.waitForFunction(count => {
    const active = window.__pcs.filter(pc => pc.connectionState !== 'closed');
    return active.length === count && active.every(pc => pc.connectionState === 'connected');
  }, count);
}

async function awaitFrames(page) {
  await page.waitForFunction(async () => {
    const video = document.querySelector('#stage-video');
    if (video.hidden || video.videoWidth !== 640 || video.readyState < 2) return false;
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      for (const stat of (await pc.getStats()).values()) {
        if (stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.framesDecoded >= 5) return true;
      }
    }
    return false;
  });
}

let host;
const participants = [];
try {
  host = await pageFor('房主');
  assert.equal(await host.locator('#network-note-title').textContent(), '公网中继尚未配置');
  assert.equal(await host.locator('#mic-btn').getAttribute('aria-pressed'), 'false');
  assert.equal(await host.evaluate(() => window.__captures.length), 0);
  await host.screenshot({ path: artifacts + 'home-desktop.png', fullPage: true });
  check('No capture before user action; unconfigured TURN is clearly shown');

  await host.evaluate(() => { window.__delayPeerJoinForLowerId = true; });
  await host.locator('#create-name').fill('测试房主');
  await host.locator('#create-password').fill('browser-test-password');
  await host.locator('#create-btn').click();
  await host.locator('#room-view').waitFor({ state: 'visible' });
  const roomId = await host.locator('#room-code').textContent();
  assert.match(roomId, /^[A-F0-9]{12}$/);
  const viewer = await pageFor('观看者', roomId);
  participants.push(viewer);
  await awaitPeers(host, 1); await awaitPeers(viewer, 1);
  assert.equal(await host.locator('#members-list li').count(), 2);
  check('Two isolated browser contexts join and establish real WebRTC connections');
  await viewer.waitForFunction(() => document.querySelector('#connection-diagnostics').textContent.includes('候选 本机发送'));
  assert.match(await viewer.locator('#connection-diagnostics').textContent(), /SDP 1\/1/);
  check('Connection diagnostics report local and remote ICE candidate counts and SDP exchange');

  await host.evaluate(() => { window.__rejectCapture = true; });
  await host.locator('#share-btn').click();
  await host.waitForFunction(() => !document.querySelector('#share-btn').disabled);
  assert.equal(await host.evaluate(() => window.__captures.length), 0);
  await host.evaluate(() => { window.__rejectCapture = false; });
  check('Cancelled capture leaves no active stream or stuck share button');

  await host.locator('#share-btn').click();
  await awaitFrames(viewer);
  assert.equal(await host.locator('#stage-video').evaluate(video => video.muted), true);
  assert.equal(await viewer.locator('#share-btn').isDisabled(), true);
  await viewer.locator('#sound-btn').click();
  await viewer.waitForFunction(() => !document.querySelector('#stage-video').muted);
  await host.locator('#mic-btn').click();
  await host.waitForFunction(() => document.querySelector('#mic-btn').getAttribute('aria-pressed') === 'true');
  await viewer.waitForFunction(async () => {
    let activeAudio = 0;
    for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values()) {
      if (stat.type === 'inbound-rtp' && stat.kind === 'audio' && stat.bytesReceived > 0) activeAudio++;
    }
    return activeAudio >= 2;
  });
  assert.equal(await viewer.locator('#remote-audio-container audio').count(), 1);
  check('Video frames and distinct screen-audio / microphone RTP streams arrive');

  let later;
  for (let attempt = 1; attempt < 32; attempt++) {
    later = await pageFor('顺序测试' + attempt, roomId);
    participants.push(later);
    await awaitPeers(later, 2); await awaitPeers(host, 2); await awaitFrames(later);
    if (await host.evaluate(() => window.__reorderedPeerSignal)) break;
    await later.locator('#leave-btn').click();
    await later.locator('#setup-view').waitFor({ state: 'visible' });
    await later.context().close();
    participants.pop();
  }
  assert.equal(await host.evaluate(() => window.__reorderedPeerSignal), true, JSON.stringify(await host.evaluate(() => window.__orderingLog.slice(-35))));
  await viewer.screenshot({ path: artifacts + 'watching-desktop.png', fullPage: true });
  check('A new peer offer/ICE signal arriving before peer-joined is queued and all late peers connect');

  await host.locator('#quality-select').selectOption('1080p60');
  await host.locator('#share-btn').click();
  await viewer.waitForFunction(() => document.querySelector('#stage-video').hidden);
  assert.equal(await host.evaluate(() => window.__captures.filter(c => c.kind === 'screen').every(c => c.stream.getTracks().every(t => t.readyState === 'ended'))), true);
  await host.locator('#share-btn').click();
  await awaitFrames(viewer);
  check('Quality selection and stop/restart sharing work without reconnecting room');

  // Exercise the browser's native Stop callback without capturing the desktop.
  await host.evaluate(() => {
    const capture = window.__captures.filter(c => c.kind === 'screen').at(-1);
    const track = capture.stream.getVideoTracks()[0];
    const callback = track.onended;
    track.stop();
    callback?.(new Event('ended'));
  });
  await viewer.waitForFunction(() => document.querySelector('#stage-video').hidden);
  await viewer.locator('#share-btn').click();
  await awaitFrames(host);
  check('Native Stop callback releases ownership; another participant can share');

  await host.locator('#leave-btn').click();
  await host.locator('#setup-view').waitFor({ state: 'visible' });
  assert.equal(await host.evaluate(() => window.__captures.every(c => c.stream.getTracks().every(t => t.readyState === 'ended'))), true);
  await Promise.all(participants.map(page => page.waitForFunction(count => document.querySelectorAll('#members-list li').length === count, participants.length)));
  check('Leaving closes all local tracks and removes the member');

  await viewer.evaluate(() => window.__sockets.at(-1).close());
  await viewer.locator('#setup-view').waitFor({ state: 'visible' });
  assert.equal(await viewer.evaluate(() => window.__captures.every(c => c.stream.getTracks().every(t => t.readyState === 'ended'))), true);
  await later.waitForFunction(() => document.querySelector('#stage-video').hidden);
  check('Signaling disconnect stops capture and clears remote presentation');

  await host.setViewportSize({ width: 390, height: 844 });
  await host.screenshot({ path: artifacts + 'home-mobile.png', fullPage: true });
  assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  check('390px layout has no horizontal overflow; no uncaught browser exceptions');
  await writeFile(artifacts + 'browser-results.json', JSON.stringify({ date: '2026-11-04', engine: browser.version(), media: 'synthetic canvas and oscillator; real RTCPeerConnection', checks, errors }, null, 2));
} catch (error) {
  if (host) {
    await host.screenshot({ path: artifacts + 'browser-failure.png', fullPage: true }).catch(() => {});
    console.error(await host.evaluate(async () => ({ status: document.querySelector('#status-message').textContent, pcs: window.__pcs.map(pc => ({ state: pc.connectionState, signaling: pc.signalingState, transceivers: pc.getTransceivers().map(t => ({ mid: t.mid, dir: t.currentDirection, send: t.sender.track?.kind, recv: t.receiver.track.kind })) })) })).catch(() => ({})));
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await app.close();
}
